/**
 * Review UI entry point — `initReview(surfaces, editorApi)` mounts the
 * phase-grouped review & commit panel into the shell's Review side tab. Wired
 * by the coordinator after initEditor/initGit (it reuses the Monaco loader for
 * the diff overlay, like the git panel).
 *
 * Data flow (rootId === absolute rootPath): review:list groups THE WORKING TREE
 * ON SCREEN's changes by plan phase; clicking a file shows its
 * working-tree-vs-HEAD diff; "Commit phase" commits that group's files via
 * git:commit. Refreshes on git:changed, project:fileChanged, and root
 * changes.
 *
 * That root comes from `bindPrimaryRoot`, not from `activeProject` alone: a
 * thread that owns a git worktree has its changes in THAT tree, and a review
 * panel listing the project's tree instead would show the user a diff of work
 * their thread never did — and offer to commit it.
 */
import '../components'
import type { FlowNotification, ReviewFile, ReviewGroup } from '../../shared/ipc-contract'
import type { ShellSurfaces } from '../shell'
import { DiffView, type GitEditorApi } from '../git'
import { resolveOpenDiffFate } from '../git/diff-lifecycle'
import { ReviewPanel } from './review-panel'
import { invariantFlagsByFile } from './invariant-flags'
import { commitPaths, filePathsWithRenameSources } from './review-approval'
import { canDispatchCommit } from './commit-guard'
import { rejectGuard } from './reject-guard'
import { isProjectSwitch } from './project-switch'
import { bindPrimaryRoot } from '../primary-root'
import {
  approveSyncFailedToast,
  commitFailedToast,
  commitSucceededToast,
  conflictBlockedToast,
  diffFailedToast,
  discardFailedToast,
  discardSucceededToast,
  rejectFailedToast,
  reviewListFailedToast,
  type ReviewToast,
} from './review-feedback'

const FILE_CHANGE_REFRESH_DEBOUNCE_MS = 500

export function initReview(surfaces: ShellSurfaces, editorApi: GitEditorApi): void {
  const api = window.flow
  if (!api?.review || !api?.git || !api?.project) {
    console.warn('flow: preload bridge missing — review UI disabled')
    return
  }

  const panelHost = document.createElement('div')
  panelHost.style.cssText = 'height:100%;min-height:0;overflow-y:auto;'
  surfaces.reviewPanel.replaceChildren(panelHost)

  const diffView = new DiffView(surfaces.editor, () => editorApi.monaco())
  // The open working-tree diff's file path + owning root (null when closed), so
  // a review refresh can re-sync or close it (#659 — the review-surface port of
  // the git panel's #402 fix) and a project switch can't strand it (#191 class).
  let diffFilePath: string | null = null
  let diffRoot: string | null = null

  function closeDiff(): void {
    diffView.hide()
    diffFilePath = null
    diffRoot = null
  }

  let activeRoot: string | null = null
  // Roots with a commit in flight — drops redundant concurrent commits (#434).
  const committing = new Set<string>()
  // Mirror the selected thread (broadcast by threads/index.ts) so reject can
  // refuse when there's no thread to deliver the agent-redo to (#397).
  let activeThreadId: string | null = null
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId: string | null }>).detail
    activeThreadId = detail?.threadId ?? null
  })

  async function openDiff(file: ReviewFile): Promise<void> {
    // Directory rows (trailing slash — git's rolled-up `??` entry) are NOT a
    // dead-end: git:diff returns a file LISTING for them (directoryDiff, #247),
    // same as the git panel's Changes view — the review surface must match (#854).
    if (!activeRoot) return
    const root = activeRoot
    try {
      const diff = await api.git.diff({ rootId: root, filePath: file.filePath })
      await diffView.show({
        title: diff.filePath,
        subtitle: 'Working tree vs HEAD',
        diff,
        languagePath: diff.filePath,
      })
      diffFilePath = file.filePath
      diffRoot = root
    } catch (error) {
      console.error('flow: review diff failed', { filePath: file.filePath, error })
      // Not console-only (#659): a dead file click must say why, like the git
      // panel's #192 toast.
      notify(diffFailedToast(file.filePath, error))
    }
  }

  /** Re-sync the open working-tree diff to a fresh review listing (#659): still
   *  changed → re-issue it live; committed/reverted away → close it, so the
   *  overlay never contradicts the review list beside it. */
  function syncOpenDiff(groups: readonly ReviewGroup[], root: string): void {
    if (diffFilePath === null) return
    if (!diffView.isOpen) {
      // The user ✕/Esc-closed it — forget the path so a later refresh can't
      // resurrect a diff they dismissed.
      diffFilePath = null
      diffRoot = null
      return
    }
    if (diffRoot !== root) return // another project's diff — the switch handler owns it
    const files = groups.flatMap((group) => group.files)
    const fate = resolveOpenDiffFate(
      diffFilePath,
      new Set(files.map((file) => file.filePath)),
    )
    if (fate === 'close') {
      closeDiff()
    } else if (fate === 'refresh') {
      const file = files.find((candidate) => candidate.filePath === diffFilePath)
      if (file) void openDiff(file)
    }
  }

  /** Raise a toast via the flow:notify bridge (→ NotificationCenter). */
  function notify(toast: ReviewToast): void {
    document.dispatchEvent(
      new CustomEvent<FlowNotification>('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: activeRoot ?? '',
          title: toast.title,
          body: toast.body,
          timestamp: new Date().toISOString(),
          level: toast.level === 'error' ? 'error' : 'info',
        },
      }),
    )
  }

  async function commitGroup(group: ReviewGroup, message: string): Promise<void> {
    const root = activeRoot
    if (!root) return
    // Keep trailing-slash directory entries so a new-directory group commits
    // instead of no-op'ing silently (#176 — mirrors discardGroup).
    // #1182: a renamed file contributes BOTH its paths, so the path-scoped
    // commit records the rename intact instead of only its new half.
    const filePaths = commitPaths(filePathsWithRenameSources(group.files))
    if (filePaths.length === 0) return
    // Drop a double-click / Enter double-fire while a commit is already in flight
    // for this repo — two concurrent git:commit calls race index.lock and surface
    // a misleading "Commit failed" though the commit succeeded (#434).
    if (!canDispatchCommit(committing, root)) return
    committing.add(root)
    try {
      // PATH-SCOPED commit (#1051): `git commit -- <phase files>` (git:commit)
      // commits exactly this group's files, whatever else sits in the index.
      // Approving mirrors into the index (#857), so with several phases
      // approved the index legitimately holds OTHER phases' files — the old
      // stage → commitIndex flow swept them all into this phase's commit under
      // this phase's message. Scoped, each sibling stays staged and pending for
      // its own commit, and the #335 "other staged changes" confirm became
      // moot here (a stray staged file is simply left alone).
      const { hash } = await api.git.commit({ rootId: root, message, filePaths })
      // The message was consumed by the commit — drop the group's draft so a later
      // unrelated changeset reusing the label doesn't re-show this stale message
      // (#342). Only on success; the error path keeps the draft for retry.
      panel.clearDraft(group.label)
      // #1433: the SUCCESS says so, with the hash the work landed as — the
      // sibling Changes box's contract (#1144). "The rows vanished" is what a
      // discard shows too, so it must never be a commit's only signal.
      notify(commitSucceededToast(group.label, hash))
      refresh()
    } catch (error) {
      console.error('flow: review commit failed', { group: group.label, error })
      notify(commitFailedToast(error)) // #73: surface it (drafts/approvals survive refresh)
      // #1090: re-list from the REAL working tree even on failure — a commit can
      // fail precisely because git has already gone clean (e.g. a phantom staged
      // deletion emptied the diff), and without a refresh the panel keeps
      // asserting rows that no longer exist. Drafts live in #drafts and approval
      // derives from staged state, so the refresh loses nothing.
      refresh()
    } finally {
      committing.delete(root)
    }
  }

  const panel = new ReviewPanel(panelHost, {
    onOpenDiff: (file) => void openDiff(file),
    onCommitGroup: (group, message) => void commitGroup(group, message),
    onDiscardGroup: (group) => void discardGroup(group),
    onRejectFile: (file, feedback) => void rejectFile(file, feedback),
    onApproveToggle: (files, approved) => void mirrorApprovalToIndex(files, approved),
    // #986: approve/commit refused on unresolved conflicts — the panel blocks
    // renderer-side from the listing's main-derived `conflicted` state, and
    // GitManager.unresolvedConflictPaths backstops every other path to stage/
    // commit (its refusals surface via the existing failure toasts).
    onConflictBlocked: (files) => notify(conflictBlockedToast(files.length)),
    // ✨ (#1141) — the same generator the Changes box calls (#335), scoped to
    // this group's files. Failure is surfaced here, so the panel only has to
    // clear its busy state on null.
    onGenerateMessage: async (group, filePaths) => {
      if (!activeRoot) return null
      try {
        const { message } = await api.review.generateCommitMessage({
          rootPath: activeRoot,
          filePaths,
        })
        if (!message) {
          notify({ title: 'No message generated', body: 'Try writing one manually.', level: 'info' })
        }
        return message
      } catch (error) {
        console.error('flow: review generate commit message failed', { group: group.label, error })
        notify({
          title: "Couldn't generate message",
          body: error instanceof Error ? error.message : String(error),
          level: 'error',
        })
        return null
      }
    },
    onRefresh: () => refresh(),
  })

  // Approve ↔ stage sync (#857): approving stages the file, un-approving
  // unstages it. The resulting git:changed refreshes BOTH this listing (which
  // re-derives approved from staged) and the Source Control panel.
  async function mirrorApprovalToIndex(files: ReviewFile[], approved: boolean): Promise<void> {
    if (!activeRoot) return
    // #1182: stage/unstage a rename's two paths TOGETHER. Un-approving only the
    // new path shattered git's `R old -> new` into `D old` + `?? new`, and the
    // group could then never get past "Approve all (1/2)".
    const filePaths = filePathsWithRenameSources(files)
    try {
      if (approved) await api.git.stage({ rootId: activeRoot, filePaths })
      else await api.git.unstage({ rootId: activeRoot, filePaths })
    } catch (error) {
      console.error('flow: review approve-stage sync failed', { filePaths, approved, error })
      notify(approveSyncFailedToast(error))
      refresh() // re-derive from real staged state so the ✓ doesn't lie
    }
  }

  // Discard all → revert every file in the group to HEAD (throw the changes
  // away). Unlike reject, it does NOT re-engage the agent — it's the "I don't
  // want any of this" exit the commit gate never offered (#124).
  async function discardGroup(group: ReviewGroup): Promise<void> {
    if (!activeRoot) return
    // Revert EVERY entry — including trailing-slash untracked directories, which
    // revertFile removes recursively (#136), scoped to non-ignored files so
    // .gitignored content survives (#1054). Filtering them out silently
    // skipped new directories while the confirm still counted them.
    const filePaths = group.files.map((file) => file.filePath)
    let failed = 0
    for (const filePath of filePaths) {
      try {
        await api.review.reject({ rootPath: activeRoot, filePath })
      } catch (error) {
        console.error('flow: review discard failed', { filePath, error })
        failed += 1
      }
    }
    if (failed > 0) notify(discardFailedToast(failed))
    // #1140: the changeset was deliberately thrown away, so its message dies
    // with it — exactly as the committed one does (#342). Without this the
    // discarded work's message was re-offered, pre-filled, over the next
    // changeset that recycled the label, and committing it was two clicks away.
    // Only when every file went: a partial failure leaves the group listed and
    // its draft still applies to what's left.
    if (failed === 0) {
      panel.clearDraft(group.label)
      // #1433: the destructive exit names what it destroyed — otherwise it is
      // indistinguishable from a successful commit (both just empty the rows).
      notify(discardSucceededToast(filePaths.length, group.label))
    }
    refresh()
  }

  // Reject → revert the file to HEAD, then ask the active thread's agent to
  // redo it with the user's feedback (threads/index.ts turns the event into a
  // sendMessage on the selected thread — decoupled, no cross-import).
  async function rejectFile(file: ReviewFile, feedback: string): Promise<void> {
    if (!activeRoot) return
    // The revert is DESTRUCTIVE and the redo needs a thread to receive it. With
    // none, refuse BEFORE reverting so the user never silently loses uncommitted
    // work while believing a redo was queued (#397).
    const guard = rejectGuard(activeThreadId !== null)
    if (!guard.allowed) {
      notify({ title: 'No active thread', body: guard.blockedReason ?? '', level: 'error' })
      return
    }
    try {
      await api.review.reject({ rootPath: activeRoot, filePath: file.filePath })
    } catch (error) {
      console.error('flow: review reject failed', { filePath: file.filePath, error })
      // #103: surface the failure — the file was preserved (#102) but the reject
      // did not take, so the user must know (and no agent-redo is dispatched).
      notify(rejectFailedToast(error))
      return
    }
    document.dispatchEvent(
      new CustomEvent('flow:agent-redo', { detail: { filePath: file.filePath, feedback } }),
    )
    refresh()
  }

  // The board's Changes tab ✕ (#898) hands rejects here — ONE implementation
  // of revert + agent-redo (guard, toasts, refresh included).
  document.addEventListener('flow:review-reject-file', (event) => {
    const detail = (event as CustomEvent<{ filePath?: string; feedback?: string }>).detail
    if (!detail || typeof detail.filePath !== 'string' || typeof detail.feedback !== 'string') return
    void rejectFile({ filePath: detail.filePath, state: 'modified', staged: false }, detail.feedback)
  })

  // Advisory invariant flags (#898 FR10): same pushed checker data as the
  // board — seed on refresh, follow pushes. Informational; never gates.
  function loadInvariantFlags(): void {
    if (!activeRoot) return
    const root = activeRoot
    void api.blueprint
      ?.listInvariantVerdicts?.({ rootId: root })
      .then((snapshot) => {
        if (root !== activeRoot || snapshot.result === null) return
        panel.setInvariantFlags(invariantFlagsByFile(snapshot.result.verdicts))
      })
      .catch(() => undefined)
  }
  api.blueprint?.onInvariantVerdicts?.((event) => {
    if (event.rootId !== activeRoot) return
    panel.setInvariantFlags(invariantFlagsByFile(event.result.verdicts))
  })

  let refreshTimer: number | null = null
  function refresh(): void {
    if (!activeRoot) {
      // #1332: no project is not a clean tree — say which it is.
      panel.setEmptyContext({ hasProject: false })
      panel.setGroups([])
      return
    }
    const root = activeRoot
    void api.review
      .list({ rootPath: root })
      .then((result) => {
        if (root === activeRoot) {
          // #1332: tell the panel WHY the list may be empty, so it stops
          // claiming a clean tree for a folder git cannot read.
          panel.setEmptyContext({ hasProject: true, gitState: result.gitState })
          panel.setGroups(result.groups)
          syncOpenDiff(result.groups, root)
          loadInvariantFlags()
        }
      })
      .catch((error: unknown) => {
        console.warn('flow: review list failed', error)
        // #1333: say so. The stale listing stays on screen and stays
        // actionable, so silence let the user act on a state git could no
        // longer confirm.
        notify(reviewListFailedToast(error))
      })
  }

  function queueRefresh(): void {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      refresh()
    }, FILE_CHANGE_REFRESH_DEBOUNCE_MS)
  }

  api.git.onChanged(({ rootId }) => {
    // git:changed arrives in bursts — the index rewrites repeatedly during a
    // commit and under agent-driven staging. Coalesce through the SAME debounce
    // the file watcher already uses instead of a full review refresh per event
    // (#1666; the adjacent onFileChanged has debounced this since #898).
    if (rootId === activeRoot) queueRefresh()
  })
  api.project.onFileChanged(({ rootPath }) => {
    if (rootPath === activeRoot) queueRefresh()
  })
  // One binding for both kinds of move — switching project, and switching to a
  // thread that owns its own checkout. Both land here as "the working tree
  // changed", which is the only thing this panel ever cared about.
  bindPrimaryRoot(api.project, (nextRoot) => {
    // Disarm any destructive confirm/prompt BEFORE the panel learns the new
    // root (#951): setRoot after reset, so an armed action could never observe
    // the new root as its own.
    // Clear per-root draft/approval state on a genuine switch so a commit
    // message typed for one tree can't leak into another's group (#281) —
    // reset() also tears down an open transient interaction, whose deferred
    // rebuild would otherwise keep the OLD tree's files actionable (#951).
    if (isProjectSwitch(activeRoot, nextRoot)) panel.reset()
    // A diff opened for another tree must not linger over the new one
    // (#191 class, review surface).
    if (diffRoot !== null && diffRoot !== nextRoot) closeDiff()
    activeRoot = nextRoot
    panel.setRoot(nextRoot)
    refresh()
  })
}
