/**
 * Git UI entry point — `initGit(surfaces, editorApi)` is wired by the
 * coordinator after the wave (never self-mounted), after `initEditor` since
 * it needs the returned EditorApi for Monaco.
 *
 * MOUNT: the shell exposes a Files|Git tabbed side panel; the full git panel
 * renders into its Git body (surfaces.gitPanel). The diff surface is an
 * overlay over surfaces.editor (see diff-view.ts). Ordering is safe because
 * initGit's EditorApi parameter only exists after initEditor ran.
 *
 * Data flow (rootId === absolute rootPath everywhere):
 *   boot / project:listChanged → status + log per root
 *   git:changed (main watches .git) → refresh that root
 *   project:fileChanged          → refresh that root (debounced) — working
 *                                    tree edits don't touch .git, so the
 *                                    dirty list would go stale without this
 *
 * Click-to-diff:
 *   changed file → git:diff { rootId, filePath }            (tree vs HEAD)
 *   commit       → git:diff { rootId, filePath: '', commit } (whole commit,
 *                  '' filePath = whole-commit convention, see git-manager.ts)
 */
import type * as Monaco from 'monaco-editor'

import '../components'
import type {
  FlowNotification,
  GitCommit,
  GitFileChange,
  MergeSummaryConflict,
  MergeSummaryInput,
  ThreadScope,
  ThreadScopeEntry,
  RegisteredProject,
} from '../../shared/ipc-contract'
import type { ShellSurfaces } from '../shell'
import { DiffView } from './diff-view'
import {
  discardAllConfirmMessage,
  discardAllSequential,
  discardConfirmMessage,
  discardFailureMessage,
} from './discard-all'
import { resolveOpenDiffFate } from './diff-lifecycle'
import { keepAllConfirmMessage, resolveSideConfirmMessage } from './conflict-section'
// The one page size — commit-log-window owns it; a private copy here once
// drifted a divergence away from mislabeling the Commits header.
import { LOG_PAGE_SIZE } from './commit-log-window'
import { diffRootStillVisible, mayFireGroupAction, repoConfirmName } from './git-groups'
import {
  commitDiffFailedToast,
  gitErrorMessage,
  fileDiffFailedToast,
  gitStatusFailedToast,
  type GitToast,
} from './git-feedback'
import { GitPanel, type GitRootView } from './git-panel'
import { pullToast } from './pull-outcome'
import { RESOLVE_CONFLICT_EVENT } from '../editor/conflict-codelens'
import {
  CONFLICT_RESOLVE_STATE_EVENT,
  CONFLICT_RESOLVE_STOP_EVENT,
  type ConflictResolveStateDetail,
} from '../editor/conflict-resolve-state'
import { openConflictInMergeEditor } from '../editor/conflict-merge-editor'
import {
  landingRefreshOnThreadEvents,
  landingRefreshOnVisibility,
} from './landing-refresh-model'
import { panelRootDomain, panelVisibleRoots } from './panel-root-domain'
import { SOURCE_CONTROL_VISIBILITY_EVENT } from '../layout-state'
import { openConflictSidePreview } from '../editor/conflict-side-preview'
import {
  clearMergeResolutionSession,
  getMergeResolutionSession,
  getHunkResolutions,
  recordWholeFileResolution,
  WHOLE_FILE_HUNK_ID,
  type HunkResolution,
} from '../editor/merge-resolution-record'
import { buildMergeCompletionReview, keptLabel } from '../editor/merge-completion-review'
import { resolvePanelState, type RootLoadStatus } from './git-panel-state'
import { spliceAllConflictHunks } from '../../shared/conflict-hunks'
import { runInWantedScope } from '../tab-scope-gate'

export { DiffView, type DiffViewRequest } from './diff-view'
export { GitPanel, type GitRootView, type GitPanelCallbacks } from './git-panel'

/** Matches EditorApi (renderer/editor/index.ts) structurally — only the
 *  Monaco loader is needed here, so the git domain doesn't import editor/. */
export interface GitEditorApi {
  monaco(): Promise<typeof Monaco>
}

/** Quiet window after project file events before re-running git status. */
const FILE_CHANGE_REFRESH_DEBOUNCE_MS = 500

/**
 * Filename timestamp for a merge summary — the ONLY clock in the summary path.
 * The rendered doc itself stays clock-free (deterministic); this stamp only
 * names the file. Format: `YYYYMMDD-HHMMSS` (local time).
 */
function mergeSummaryStamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

export function initGit(surfaces: ShellSurfaces, editorApi: GitEditorApi): void {
  const api = window.flow
  if (!api?.git || !api?.project) {
    console.warn('flow: preload bridge missing — git UI disabled')
    return
  }

  // ── Mount: the Git tab of the right-hand side panel ────────────────────
  // The shell owns the Files|Git tab switcher; we render the full git panel
  // into its dedicated body (surfaces.gitPanel), no longer carving space from
  // the file tree.
  const panelContent = document.createElement('div')
  panelContent.style.cssText = 'flex:1;min-height:0;overflow-y:auto;'
  // NO THREAD-LANDING BLOCK. Source Control opened with "This thread's work",
  // a waiting line, a disk-quota count and two verbs — above the branch name,
  // the commit box and the log, which is what a person opens this panel FOR.
  // It also read as a second subject in a panel that already had one: the
  // repository. Removed on the user's call (2026-09-04).
  //
  // WHAT WENT WITH IT: `Merge` was here and nowhere else, so landing a thread's
  // worktree back into its base is no longer a UI action. Releasing one
  // survives — it is "Let it go" in the worktrees manager, which also renames,
  // re-points and clears them.
  const panelColumn = document.createElement('div')
  panelColumn.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'
  panelColumn.append(panelContent)
  surfaces.gitPanel.replaceChildren(panelColumn)


  // ── Diff view over the editor area ─────────────────────────────────────
  const diffView = new DiffView(surfaces.editor, () => editorApi.monaco())
  // The root the currently-open diff belongs to (null when closed), so we can
  // close a stale diff when focus moves off that project or its root is removed
  // (#191). Kept in sync by openFileDiff/openCommitDiff and closeStaleDiff.
  let diffRoot: string | null = null
  /**
   * WHO the open diff belongs to — and therefore what makes it stale.
   *
   * THE BUG THIS FIXES was a dead click, reported twice ("the files are not
   * opening anymore", "still not working"). There are two surfaces that open a
   * diff into this same overlay, and until now both were judged by the Source
   * Control panel's question: *is this root still one the panel is showing?*
   * That is the right question for the panel and the wrong one for the change
   * review, whose root is a CONVERSATION's checkout — a tree the panel often
   * does not list at all. So the diff was fetched, judged stale by a rule about
   * a different surface, and silently dropped. No error, no overlay, nothing in
   * the log: a file you clicked that simply did not open.
   *
   * Each owner now carries its own staleness test (`diffOwnerCurrent`), which is
   * the only thing that ever differed between the two.
   */
  type DiffOwner =
    | { kind: 'panel'; rootPath: string }
    | { kind: 'thread'; threadId: string }
  let diffOwner: DiffOwner | null = null
  // The path of the open WORKING-TREE file diff (null for a commit diff or when
  // closed), so a status refresh can re-sync it to the live tree (#402).
  let diffFilePath: string | null = null
  // Monotonic diff-request generation. Each open captures its value and bails if a
  // newer request has since started, so a late-resolving diff never paints over — or
  // tears down — a newer, valid one (#315). closeDiff() also bumps it, so a
  // teardown (file opened, project switched) cancels in-flight requests (#953).
  let diffRequestSeq = 0

  function closeDiff(): void {
    // Invalidate any IN-FLIGHT diff request too (#953): a teardown means the
    // overlay must stay down, so a late-resolving openFileDiff/openCommitDiff
    // fails diffCurrent() and never show()s over whatever replaced it.
    diffRequestSeq += 1
    diffView.hide()
    diffRoot = null
    diffOwner = null
    diffFilePath = null
  }

  /** Surface a toast via the flow:notify bridge (→ NotificationCenter) so a
   *  failed diff click isn't a silent dead click (#192). */
  function notify(toast: GitToast): void {
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

  /**
   * Does the diff's owner still hold it?
   *
   * The PANEL's answer is #191's, generalized for multi-root scope: any root it
   * currently displays is valid, and one it has stopped displaying is not.
   * A THREAD's answer cannot be that, because the tree a conversation works in
   * is frequently not a tree the panel lists — its diff goes stale when the
   * conversation is no longer the open one, and at no other time.
   */
  function diffOwnerCurrent(owner: DiffOwner): boolean {
    if (owner.kind === 'thread') return owner.threadId === activeThreadId
    return diffRootStillVisible(owner.rootPath, visibleRoots(), new Set(knownRoots()))
  }

  /** Close the open diff once its owner has let go of it (#191). */
  function closeStaleDiff(): void {
    if (diffOwner !== null && !diffOwnerCurrent(diffOwner)) closeDiff()
  }

  /** Is this diff request still the one that should own the overlay — not superseded
   *  by a newer click, and still held by whoever asked for it? Gates show() (#315). */
  function diffCurrent(gen: number, owner: DiffOwner): boolean {
    if (gen !== diffRequestSeq) return false
    return diffOwnerCurrent(owner)
  }

  /** Commit ownership after show() resolves. A switch can still land DURING show()'s
   *  await: if the owner let go (and no newer request has taken over) close our
   *  just-painted diff; if a newer request superseded us, leave the overlay to it (#315). */
  function settleOpenedDiff(
    gen: number,
    owner: DiffOwner,
    rootPath: string,
    filePath: string | null,
  ): void {
    if (diffCurrent(gen, owner)) {
      diffOwner = owner
      diffRoot = rootPath
      diffFilePath = filePath // the diffed file for a working-tree diff; null for a commit
      return
    }
    if (gen === diffRequestSeq) closeDiff() // the owner let go during show(); no newer owner
  }

  /** `owner` is REQUIRED, and never defaulted: the whole defect above was one
   *  caller silently inheriting the other's idea of what makes a diff stale. */
  async function openFileDiff(
    rootPath: string,
    change: GitFileChange,
    staged: boolean,
    owner: DiffOwner,
  ): Promise<void> {
    // A new untracked directory is one `dir/` entry; git:diff now returns a
    // listing of its files for it (#247), so it's previewable like any row.
    const gen = ++diffRequestSeq
    try {
      const diff = await api.git.diff({ rootId: rootPath, filePath: change.filePath, staged })
      // Superseded by a newer click, or the owner already let go → never paint (#315).
      if (!diffCurrent(gen, owner)) return
      await diffView.show({
        title: diff.filePath,
        subtitle: staged ? 'Staged vs HEAD' : 'Working tree vs HEAD',
        diff,
        languagePath: diff.filePath,
        // A file diff has a real file behind it — the header's ↗ opens it.
        openTarget: { rootPath, relPath: diff.filePath },
      })
      // A staged diff reflects the INDEX, which worktree edits don't change, so it
      // must NOT live-refresh on file changes (like a commit diff → null). A
      // working-tree diff keeps its path so #402's refresh follows the file.
      settleOpenedDiff(gen, owner, rootPath, staged ? null : change.filePath)
    } catch (error) {
      console.error('flow: git file diff failed', { rootPath, filePath: change.filePath, error })
      notify(fileDiffFailedToast(change.filePath, error))
    }
  }

  async function openCommitDiff(rootPath: string, commit: GitCommit): Promise<void> {
    // Always the panel's: a commit history is only ever browsed there.
    const owner: DiffOwner = { kind: 'panel', rootPath }
    const gen = ++diffRequestSeq
    try {
      // '' filePath + commit = whole-commit diff (git-manager.ts convention).
      const diff = await api.git.diff({ rootId: rootPath, filePath: '', commit: commit.hash })
      if (!diffCurrent(gen, owner)) return
      await diffView.show({
        title: commit.subject,
        subtitle: `${commit.hash.slice(0, 7)} vs parent`,
        diff,
      })
      settleOpenedDiff(gen, owner, rootPath, null) // commit diffs don't live-refresh on file changes
    } catch (error) {
      console.error('flow: git commit diff failed', { rootPath, commit: commit.hash, error })
      notify(commitDiffFailedToast(commit.hash, error))
    }
  }

  const panel = new GitPanel(panelContent, {
    onFileDiff: (rootPath, change, staged) => {
      void openFileDiff(rootPath, change, staged === true, { kind: 'panel', rootPath })
    },
    onCommitDiff: (rootPath, commit) => {
      void openCommitDiff(rootPath, commit)
    },
    onRetryLoad: () => {
      void syncRoots()
    },
    onStage: (rootPath, filePaths) => {
      // Refresh explicitly after our OWN action — the .git/index watch can miss the
      // atomic rename-replace `git add` does, leaving the panel stale (#507).
      void api.git
        .stage({ rootId: rootPath, filePaths })
        .then(() => refreshRoot(rootPath))
        .catch((error: unknown) => {
          console.error('flow: git stage failed', { rootPath, error })
          notify({ title: "Couldn't stage", body: gitErrorMessage(error), level: 'error' })
        })
    },
    onUnstage: (rootPath, filePaths) => {
      void api.git
        .unstage({ rootId: rootPath, filePaths })
        .then(() => refreshRoot(rootPath)) // don't rely on the flaky index watch (#507)
        .catch((error: unknown) => {
          console.error('flow: git unstage failed', { rootPath, error })
          notify({ title: "Couldn't unstage", body: gitErrorMessage(error), level: 'error' })
        })
    },
    onDiscard: (rootPath, change) => {
      // Destructive — confirm first. Discard the WORKING-TREE change back to the
      // INDEX (git:discardFile), NOT a full revert-to-HEAD — so a staged-then-edited
      // file keeps its staged snapshot instead of losing it silently (#598).
      // The confirm is ARMED on this row's root (#951 generalized): it may only
      // fire while that root is still part of the panel's visible root set, so a
      // scope/project switch mid-confirm can never discard another repo's work.
      // For an UNTRACKED path the copy says what actually happens — deletion,
      // scoped to what git clean would remove (.gitignored files are kept) (#1054).
      // …and it NAMES the repo when more than one is on screen (#1144): the
      // paths here are repo-relative, so two repos with the same file changed
      // asked byte-identical questions about unrecoverable work.
      if (!window.confirm(discardConfirmMessage(change, repoNameFor(rootPath)))) return
      if (!mayFireGroupAction(rootPath, visibleRoots())) return
      void api.git
        .discardFile({ rootId: rootPath, filePath: change.filePath })
        .then(() => refreshRoot(rootPath)) // explicit refresh after our own action (#507)
        .catch((error: unknown) => {
          console.error('flow: git discard failed', { rootPath, error })
          notify({ title: "Couldn't discard", body: gitErrorMessage(error), level: 'error' })
        })
    },
    onDiscardAll: (rootPath, changes) => {
      // "Discard all" — extra-destructive, so confirm ONCE for the whole set, then
      // discard each file SEQUENTIALLY: each git:discardFile runs a `git checkout`
      // that takes .git/index.lock, so concurrent discards collide on the lock and
      // silently leave files undiscarded (#506). One at a time is reliable. Uses the
      // worktree-only discard so staged snapshots survive (#598).
      if (changes.length === 0) return
      // The copy names the deletion blast radius when untracked paths are in the
      // set — they are deleted, not reverted, scoped to what `git clean` (no
      // `-x`) removes, so .gitignored files are kept (#1054).
      if (!window.confirm(discardAllConfirmMessage(changes, repoNameFor(rootPath)))) {
        return
      }
      // #951 generalized: the bulk discard fires only on the root it was armed on.
      if (!mayFireGroupAction(rootPath, visibleRoots())) return
      void discardAllSequential(
        changes.map((change) => change.filePath),
        (filePath) => api.git.discardFile({ rootId: rootPath, filePath }),
      ).then(({ failed }) => {
        void refreshRoot(rootPath) // explicit refresh after our own action (#507)
        if (failed.length > 0) {
          notify({
            title: "Couldn't discard some changes",
            body: discardFailureMessage(failed, changes.length),
            level: 'error',
          })
        }
      })
    },
    onCommit: async (rootPath, message) => {
      try {
        const { hash } = await api.git.commitIndex({ rootId: rootPath, message })
        // #1144: say WHICH repo took the commit when several are on screen —
        // a bare hash is no signal at all about where the work landed.
        const repo = repoNameFor(rootPath)
        notify({
          title: 'Committed',
          body: repo ? `${repo} · ${hash}` : hash,
          level: 'info',
        })
        // Refresh explicitly — the .git/index watch can miss commit's atomic
        // rename-replace, leaving the just-committed files stale in the panel (#507).
        void refreshRoot(rootPath)
        return true
      } catch (error) {
        console.error('flow: git commit failed', { rootPath, error })
        notify({ title: "Couldn't commit", body: gitErrorMessage(error), level: 'error' })
        return false
      }
    },
    onGenerateMessage: async (rootPath, filePaths) => {
      // AI ✨ — reuse the Review commit-message generator over the staged set (#335).
      try {
        const { message } = await api.review.generateCommitMessage({ rootPath, filePaths })
        if (!message) {
          notify({ title: 'No message generated', body: 'Try writing one manually.', level: 'info' })
        }
        return message
      } catch (error) {
        console.error('flow: generate commit message failed', { rootPath, error })
        notify({ title: "Couldn't generate message", body: gitErrorMessage(error), level: 'error' })
        return null
      }
    },
    onResolveConflict: () => {
      // Hand off to the whole-window Resolve-with-AI flow (#66): conflict-
      // resolve-index gathers conflicts, sends a structured prompt to the ACTIVE
      // thread, and auto-applies the safe resolutions. No payload — it discovers
      // the conflicts itself (#335).
      document.dispatchEvent(new CustomEvent(RESOLVE_CONFLICT_EVENT))
    },
    onLoadOlderCommits: (rootPath, cursor) => {
      // #1438: one page in flight per root. The panel's busy flag is cleared by
      // any incoming render, so a background refresh landing mid-fetch re-enables
      // the button — without this guard a second click would page from the SAME
      // cursor and append the same commits twice.
      if (loadingOlderRoots.has(rootPath)) return
      loadingOlderRoots.add(rootPath)
      // #1335: append the page before `cursor`. GitManager.log pages with
      // `--skip=1 <rev>`, so this returns strictly older commits.
      void api.git
        .log({ rootId: rootPath, limit: LOG_PAGE_SIZE, before: cursor })
        .then((older) => {
          const view = views.get(rootPath)
          if (!view) {
            render() // clears the button's busy state either way
            return
          }
          // A short page (including an empty one) is git telling us it has
          // nothing older — record it so the affordance retires instead of
          // inviting the same nothing again (#1438).
          views.set(rootPath, {
            ...view,
            commits: [...view.commits, ...older],
            commitsExhausted: older.length < LOG_PAGE_SIZE,
          })
          render()
        })
        .catch((error: unknown) => {
          console.error('flow: load older commits failed', { rootPath, error })
          notify({
            title: "Couldn't load older commits",
            body: gitErrorMessage(error),
            level: 'error',
          })
          render()
        })
        .finally(() => {
          loadingOlderRoots.delete(rootPath)
        })
    },
    onStopResolveConflict: () => {
      // #1134: the orchestration owns `pending` and the thread id, so it owns
      // the interrupt — the panel only asks.
      document.dispatchEvent(new CustomEvent(CONFLICT_RESOLVE_STOP_EVENT))
    },
    onConflictContent: async (rootPath, filePath) => {
      // Read the conflicted file's marker-laden working copy so the panel can
      // compute its structural risk badge (#335, P6). Oversize or read failure →
      // null, which the panel renders conservatively as 'risky'.
      try {
        const result = await api.git.readConflicted({ rootId: rootPath, filePath })
        if ('oversize' in result) return null
        return result.markered
      } catch (error) {
        console.error('flow: read conflicted failed', { rootPath, filePath, error })
        return null
      }
    },
    onPreviewSide: (rootPath, filePath, side) => {
      // Arming a side shows what it would do. Nothing is written here, and a
      // preview that can't be built is silent — the panel still asks for the
      // second press, which is the part that actually protects the file.
      void openConflictSidePreview(rootPath, filePath, side, {
        read: async (rootId, path) => {
          try {
            const result = await api.git.readConflicted({ rootId, filePath: path })
            return 'oversize' in result ? null : result.markered
          } catch {
            return null
          }
        },
      }).catch((error: unknown) => {
        console.error('flow: conflict side preview failed', { rootPath, filePath, side, error })
      })
    },
    onResolveSide: (rootPath, filePath, side) => {
      // Accept one whole side (ours/theirs) → resolveConflict (git checkout + add).
      // Overwrites the file's other side — same finality as Discard, same gate.
      if (!window.confirm(resolveSideConfirmMessage(filePath, side))) return
      void api.git
        .resolveConflict({ rootId: rootPath, filePath, resolution: { kind: side } })
        .then(() => {
          // #1288: RECORD it. This button resolved the conflict and wrote
          // nothing, so the completion review that exists to answer "what am I
          // about to commit?" answered "No recorded hunk resolutions" — on the
          // path the panel itself steers you down.
          recordWholeFileResolution(rootPath, { filePath, choice: side })
          refreshRoot(rootPath) // explicit refresh — don't trust the flaky index watch (#507)
        })
        .catch((error: unknown) => {
          console.error('flow: resolve conflict side failed', { rootPath, filePath, side, error })
          notify({ title: "Couldn't resolve conflict", body: gitErrorMessage(error), level: 'error' })
        })
    },
    onKeepAll: (rootPath, filePaths, choice, actionLabel) => {
      // One click used to rewrite EVERY conflicted file with one side while
      // the neighbouring "Revert all" confirmed — same blast radius, no gate.
      if (!window.confirm(keepAllConfirmMessage(filePaths.length, actionLabel))) return
      // Whole-set keep-all (Phase 5, Task 3). `ours`/`theirs` map straight to the
      // whole-file resolveConflict shim; `both` needs the concatenated merged text,
      // so we read each file's markers and splice EVERY hunk with `both` first.
      void (async () => {
        for (const filePath of filePaths) {
          try {
            if (choice === 'ours' || choice === 'theirs') {
              await api.git.resolveConflict({
                rootId: rootPath,
                filePath,
                resolution: { kind: choice },
              })
              recordWholeFileResolution(rootPath, { filePath, choice }) // #1288
              continue
            }
            // choice === 'both': read markers, splice all hunks, write the result.
            const read = await api.git.readConflicted({ rootId: rootPath, filePath })
            if ('oversize' in read) continue // oversize files are never bulk-resolved
            const spliced = spliceAllConflictHunks(read.markered, 'both')
            await api.git.resolveConflict({
              rootId: rootPath,
              filePath,
              resolution: { kind: 'content', text: spliced.text },
            })
            recordWholeFileResolution(rootPath, { filePath, choice: 'both' }) // #1288
          } catch (error) {
            console.error('flow: keep-all resolve failed', { rootPath, filePath, choice, error })
            notify({ title: "Couldn't resolve conflict", body: gitErrorMessage(error), level: 'error' })
          }
        }
        refreshRoot(rootPath)
      })()
    },
    onOpenMergeEditor: (rootPath, filePath) => {
      // Open the Monaco 3-way merge editor (P5). No proposal is passed for now.
      // Into the conversation it was pressed in (`tab-scope-gate.ts`).
      void runInWantedScope(() => openConflictInMergeEditor(rootPath, filePath)).catch((error: unknown) => {
        console.error('flow: open merge editor failed', { rootPath, filePath, error })
        notify({ title: "Couldn't open merge editor", body: gitErrorMessage(error), level: 'error' })
      })
    },
    onCompleteMerge: (rootPath, message) => {
      // Stage-and-confirm (Phase 5, Task 5): before completing, show a final
      // review of every resolved hunk in IDENTITY terms and require an explicit
      // confirm. Never auto-continue the op (Ruled Out). Branches per op below.
      const op = views.get(rootPath)?.mergeState?.op === 'rebase' ? 'rebase' : 'merge'
      if (!confirmCompletion(rootPath, op)) return
      // #571: a rebase must run `git rebase --continue`, NOT a merge commit — a
      // merge commit mid-rebase strands the remaining patches. Branch on the op.
      if (op === 'rebase') {
        void api.git
          .continueRebase({ rootId: rootPath })
          .then((result) => {
            // Always refresh — the panel must show the new state (#590: the
            // previous code skipped refresh on the exit-1 next-conflict step).
            refreshRoot(rootPath)
            // Advancing a multi-commit rebase into the NEXT commit's conflict is
            // normal, not a failure — an info hint, never a red error toast (#590).
            if (result.conflicted) {
              notify({
                title: 'Rebase advanced',
                body: 'Resolve the next commit’s conflicts, then Continue rebase.',
                level: 'info',
              })
            }
          })
          .catch((error: unknown) => {
            console.error('flow: continue rebase failed', { rootPath, error })
            notify({ title: "Couldn't continue rebase", body: gitErrorMessage(error), level: 'error' })
          })
        return
      }
      // Merge: render a merge-resolution summary (Phase 8) BEFORE completing,
      // folding a condensed body into the commit message. Fail-soft — a summary
      // failure never blocks the merge; we fall back to the plain message.
      void completeMergeWithSummary(rootPath, message)
    },
    onAbortMerge: (rootPath) => {
      // #571: `git merge --abort` errors during a rebase ("no merge to abort") —
      // route to `git rebase --abort` when a rebase is in progress.
      const isRebase = views.get(rootPath)?.mergeState?.op === 'rebase'
      const noun = isRebase ? 'rebase' : 'merge'
      // Destructive — abandons the operation and returns to the pre-op state.
      if (
        !window.confirm(
          `Abort the in-progress ${noun}? This discards the ${noun} and returns to the pre-${noun} state.`,
        )
      ) {
        return
      }
      // #951 generalized: abort fires only on the root it was armed on.
      if (!mayFireGroupAction(rootPath, visibleRoots())) return
      const abort = isRebase
        ? api.git.abortRebase({ rootId: rootPath })
        : api.git.abortMerge({ rootId: rootPath })
      void abort
        .then(() => refreshRoot(rootPath)) // explicit refresh after our own action (#507)
        .catch((error: unknown) => {
          console.error(`flow: abort ${noun} failed`, { rootPath, error })
          notify({ title: `Couldn't abort ${noun}`, body: gitErrorMessage(error), level: 'error' })
        })
    },
    onListBranches: (rootPath) =>
      api.git.listBranches({ rootId: rootPath }).catch((error: unknown) => {
        console.error('flow: list branches failed', { rootPath, error })
        notify({ title: "Couldn't list branches", body: gitErrorMessage(error), level: 'error' })
        return []
      }),
    onMergeBranch: (rootPath, ref) => {
      // A conflict outcome is not an error — it lands in the normal conflicted
      // working-tree state; refresh so the Merge Changes section + resolver appear.
      void api.git
        .mergeBranch({ rootId: rootPath, ref })
        .then(({ conflicted }) => {
          notify(
            conflicted
              ? {
                  title: 'Merge has conflicts',
                  body: `Resolve the conflicts from "${ref}" in Merge Changes.`,
                  level: 'info',
                }
              : { title: 'Merged', body: ref, level: 'info' },
          )
          void refreshRoot(rootPath)
        })
        .catch((error: unknown) => {
          console.error('flow: merge branch failed', { rootPath, ref, error })
          notify({ title: "Couldn't merge branch", body: gitErrorMessage(error), level: 'error' })
        })
    },
    onPull: (rootPath) => {
      void api.git
        .pull({ rootId: rootPath })
        .then((result) => {
          // #1336: report what actually moved. This branch used to notify a
          // literal "Pulled / Up to date" for every outcome.
          notify(pullToast(result))
          void refreshRoot(rootPath)
        })
        .catch((error: unknown) => {
          console.error('flow: pull failed', { rootPath, error })
          notify({ title: "Couldn't pull", body: gitErrorMessage(error), level: 'error' })
        })
    },
    // The landing block this group carries, or null. The controller owns the
    // element; the panel only decides where it goes (landing-per-project).
    // Renaming moved INTO the panel: it is a git operation on the line the
    // panel draws, offered for every branch rather than only a thread's own.
    onNotify: (toast) => notify(toast),
    onBranchRenamed: (rootPath) => {
      // The name on screen changed, so this root's status and log re-read.
      void refreshRoot(rootPath)
    },
  })

  // ── State + refresh orchestration ──────────────────────────────────────
  const views = new Map<string, GitRootView>()
  // Per-root refresh lifecycle, so render() can tell loading/error apart from a
  // genuinely-empty project list instead of collapsing all three to "no roots" (#289).
  const refreshStatus = new Map<string, RootLoadStatus>()
  // Roots with a "load older commits" page in flight (#1438) — see onLoadOlderCommits.
  const loadingOlderRoots = new Set<string>()
  let rootOrder: string[] = []
  // The git panel is scoped to the active project (ADR-002): it shows ONLY
  // the selected project's status + commits, never every root at once. Null
  // until the main process reports (or restores) an active project.
  let activeRoot: string | null = null
  // The ACTIVE thread's additional roots (#45) — a thread spanning app + core
  // widens the panel to show BOTH repos' changes, one section per repo.
  let activeThreadId: string | null = null
  let threadRoots: string[] = []
  // The thread-scope layer (multi-project threads Phase 4) — the one scope
  // source of truth (allowed-pattern #14). Once the first scope lands, the
  // panel is scope-driven: one repo group per scope root. Until then — and
  // forever if the scope API is unavailable — the legacy activeRoot +
  // threadRoots binding stays in charge (fail-soft, Phase 3 idiom).
  let scopeDriven = false
  let scopeEntries: ThreadScopeEntry[] | null = null

  /** The roots the panel currently displays — the validity domain for diffs
   *  and the fire-time domain for armed destructive actions (#951). An EMPTY
   *  scope falls back to the legacy binding, exactly mirroring
   *  resolvePanelState — otherwise a boot-time empty scope would blank the
   *  domain and refuse every armed action while the panel renders legacily. */
  /** The repo name to name in destructive copy / commit feedback (#1144), or
   *  null while a single repo is on screen (nothing to disambiguate). Uses the
   *  same identity the group header shows, so the confirm names the repo the
   *  way the user sees it named right above the button. */
  function repoNameFor(rootPath: string): string | null {
    return repoConfirmName(rootPath, scopeEntries, visibleRoots().length)
  }

  /**
   * Every root this panel may address — the project list's registered roots PLUS a
   * root the scope layer itself reports, which is how a thread's own checkout
   * becomes visible without becoming a project (see panel-root-domain.ts).
   *
   * `rootOrder` alone was the old answer, and it is the one that rendered "No
   * project open" for a thread with a whole working tree of its own.
   */
  function knownRoots(): string[] {
    return panelRootDomain(rootOrder, scopeDriven ? scopeEntries : null)
  }

  /** Whether this panel may address `rootPath` at all (see knownRoots). */
  function knowsRoot(rootPath: string): boolean {
    return knownRoots().includes(rootPath)
  }

  function visibleRoots(): string[] {
    if (scopeDriven && scopeEntries !== null && scopeEntries.length > 0) {
      // The scope's roots PLUS the project's own tree when a thread's checkout
      // displaced it from the scope — a checkout is an ADDITIONAL tree in this
      // panel, never a replacement for the one the user's own uncommitted work
      // is sitting in (see panelVisibleRoots).
      return panelVisibleRoots(scopeEntries, knownRoots(), activeRoot)
    }
    const visible: string[] = []
    if (activeRoot !== null) visible.push(activeRoot)
    for (const rootPath of threadRoots) {
      if (!visible.includes(rootPath) && knowsRoot(rootPath)) visible.push(rootPath)
    }
    return visible
  }

  function render(): void {
    panel.setScope(scopeEntries)
    panel.setState(
      resolvePanelState({
        activeRoot,
        rootOrder: knownRoots(),
        threadRoots,
        // The panel renders exactly what it considers visible — one list, not
        // a second derivation that can disagree with the one the refresh and
        // action gates read (allowed-pattern #14).
        ...(scopeDriven && scopeEntries !== null ? { scopeRoots: visibleRoots() } : {}),
        viewFor: (rootPath) => views.get(rootPath),
        statusFor: (rootPath) => refreshStatus.get(rootPath),
      }),
    )
  }

  // #1134: the Resolve-with-AI lifecycle drives the merge section's control.
  // It rides its own event (not a status refresh), so the panel would otherwise
  // never learn a turn had started.
  document.addEventListener(CONFLICT_RESOLVE_STATE_EVENT, (event) => {
    const detail = (event as CustomEvent<ConflictResolveStateDetail>).detail
    if (detail === undefined) return
    panel.setResolvePhase(detail.phase)
  })

  /** Apply a thread scope from the scope layer (Phase 4): re-render the groups
   *  and refresh roots newly in scope. Refresh/diff churn is gated on the root
   *  SET actually changing, so a same-scope re-emission never re-issues diffs. */
  function applyThreadScope(scope: ThreadScope): void {
    // Compared on what the panel SHOWS, not on the scope's own roots: a thread
    // gaining a checkout displaces the project's tree, and both trees are on
    // screen afterwards — a diff of scope paths alone would miss the second one
    // arriving and leave it never refreshed.
    const firstScope = scopeEntries === null
    const previousVisible = visibleRoots()
    scopeDriven = true
    scopeEntries = scope.roots
    const nextVisible = visibleRoots()
    render() // names/availability/primary can change even with the same paths
    const changed =
      firstScope ||
      previousVisible.length !== nextVisible.length ||
      nextVisible.some((rootPath, index) => rootPath !== previousVisible[index])
    if (!changed) return
    closeStaleDiff() // a diff on a root that left the scope is stale now
    for (const rootPath of nextVisible) {
      if (previousVisible.includes(rootPath)) continue // already live + refreshed
      if (knowsRoot(rootPath)) void refreshRoot(rootPath)
    }
  }

  /** Apply the active thread's additional roots and refresh any that are known.
   *  Stored RAW (resolvePanelState filters against rootOrder at render time) so
   *  an event arriving before the boot syncRoots fills rootOrder still counts. */
  function setThreadRoots(threadId: string | null, roots: string[]): void {
    activeThreadId = threadId
    const changed = roots.length !== threadRoots.length || roots.some((r, i) => r !== threadRoots[i])
    threadRoots = roots
    if (!changed) return
    render()
    for (const rootPath of threadRoots) {
      if (rootPath !== activeRoot && knowsRoot(rootPath)) void refreshRoot(rootPath)
    }
  }

  function setActiveRoot(rootPath: string | null): void {
    if (rootPath === activeRoot) return
    activeRoot = rootPath
    render()
    // A diff opened in the previous project is now stale — the panel is scoped
    // to the active project, so close it rather than leave it over the editor (#191).
    closeStaleDiff()
    // Pull fresh status/log for the newly-focused project right away so the
    // panel doesn't sit on stale (or empty) data after a switch.
    if (rootPath !== null && knowsRoot(rootPath)) {
      void refreshRoot(rootPath)
    }
  }

  async function refreshRoot(rootPath: string): Promise<void> {
    // Mark loading and re-render so an active root with no data yet shows a
    // loading placeholder — not "No project roots" — during the IPC round-trip.
    // (A root that already has a view keeps showing it; see resolvePanelState.)
    // PERF: when a loaded view already exists, that intermediate render paints
    // the exact same panel — skip it; the post-fetch render below still lands.
    const hadLoadedView = views.has(rootPath) && refreshStatus.get(rootPath) === 'loaded'
    refreshStatus.set(rootPath, 'loading')
    if (!hadLoadedView) render()
    try {
      // #1335: a refresh re-reads AT LEAST as many commits as the user has
      // paged in, so loading older history isn't undone by the next git event.
      const loadedCommits = views.get(rootPath)?.commits.length ?? 0
      const wanted = Math.max(LOG_PAGE_SIZE, loadedCommits)
      const [status, commits, mergeState] = await Promise.all([
        api.git.status({ rootId: rootPath }),
        api.git.log({ rootId: rootPath, limit: wanted }),
        // In-progress merge/rebase state for the conflict banner (#335, P6). It's
        // fail-soft server-side (op:'none'); still guard the IPC so a merge-state
        // read failure never sinks the whole refresh — the banner just hides.
        api.git.mergeState({ rootId: rootPath }).catch((error: unknown) => {
          console.warn('flow: git merge-state read failed', { rootPath, error })
          return null
        }),
      ])
      // The root may have been removed while the calls were in flight.
      if (!knowsRoot(rootPath)) return
      // #1438: carry the "git has nothing older" conclusion across the refresh.
      // Getting back fewer commits than we asked for proves it outright. Short
      // of that, a previous conclusion still holds as long as the history we're
      // standing on is the same — if the oldest commit moved (rebase, amend,
      // filter-branch), the conclusion was about a history that no longer
      // exists, so it's dropped and the affordance comes back.
      const previous = views.get(rootPath)
      const oldestHash = commits[commits.length - 1]?.hash
      const previousOldestHash = previous?.commits[previous.commits.length - 1]?.hash
      const commitsExhausted =
        commits.length < wanted ||
        (previous?.commitsExhausted === true &&
          oldestHash !== undefined &&
          oldestHash === previousOldestHash)
      views.set(rootPath, { rootPath, status, commits, mergeState, commitsExhausted })
      refreshStatus.set(rootPath, 'loaded')
      render()
      // Re-sync an OPEN working-tree diff to the live tree it claims to show
      // (#402): live-refresh it while its file is still changed, close it once
      // the file leaves the changes list (committed/reverted away) — so the diff
      // never contradicts the CHANGES list beside it.
      if (diffRoot === rootPath && diffFilePath !== null) {
        const changePaths = new Set((status?.changes ?? []).map((change) => change.filePath))
        const fate = resolveOpenDiffFate(diffFilePath, changePaths)
        if (fate === 'close') {
          closeDiff()
        } else if (fate === 'refresh') {
          const change = (status?.changes ?? []).find((c) => c.filePath === diffFilePath)
          // Re-opened under the SAME owner it already had — a live refresh must
          // not quietly hand a conversation's diff to the panel.
          if (change && diffOwner !== null) void openFileDiff(rootPath, change, false, diffOwner)
        }
      }
    } catch (error) {
      console.warn(`flow: git refresh failed for ${rootPath}`, error)
      if (!knowsRoot(rootPath)) return
      refreshStatus.set(rootPath, 'error')
      render()
      // Don't leave the failure console-only (forbidden pattern #2) — but only
      // shout for the project the user is actually looking at.
      if (rootPath === activeRoot) notify(gitStatusFailedToast(error))
    }
  }

  /**
   * Assemble the merge-summary input for a root at completion time (best-effort):
   * the current branch + incoming ref from git, plus the parked resolution set
   * (per-file choice/risk/why/how + verify) recorded by the Resolve-with-AI
   * orchestration. Any still-unmerged path the session didn't cover is added as a
   * bare (risky) record so the doc reflects every conflict. Missing data degrades
   * to empty strings — the summary always renders.
   */
  /** Resolutions bucketed per file, in first-seen order (#1287). */
  function groupResolutionsByFile(
    resolutions: readonly HunkResolution[],
  ): Map<string, HunkResolution[]> {
    const byFile = new Map<string, HunkResolution[]>()
    for (const resolution of resolutions) {
      const list = byFile.get(resolution.filePath)
      if (list) list.push(resolution)
      else byFile.set(resolution.filePath, [resolution])
    }
    return byFile
  }

  async function buildMergeSummaryInput(rootPath: string): Promise<MergeSummaryInput> {
    const [status, mergeState] = await Promise.all([
      api.git.status({ rootId: rootPath }).catch(() => null),
      api.git.mergeState({ rootId: rootPath }).catch(() => null),
    ])
    const branch = status?.branch ?? ''
    const ontoBranch = mergeState?.incomingRef ?? mergeState?.ontoBranch ?? ''

    const session = getMergeResolutionSession(rootPath)
    const conflicts: MergeSummaryConflict[] = session ? [...session.conflicts] : []
    const covered = new Set(conflicts.map((conflict) => conflict.file))
    // #1287: the record described the AI flow's store and nothing else, so a
    // MANUALLY resolved merge always wrote "0 conflict(s) resolved, risk: safe"
    // into the summary doc AND the commit trailer — a false audit trail that
    // contradicted the confirm dialog shown one second earlier, and asserted a
    // risk assessment over conflicts nothing had examined.
    //
    // Fold in the per-resolution store the completion review already renders,
    // so one source of truth feeds the review, the doc and the trailer.
    for (const [file, resolutions] of groupResolutionsByFile(getHunkResolutions(rootPath))) {
      if (covered.has(file)) continue
      covered.add(file)
      conflicts.push({
        file,
        oursIntent: '',
        theirsIntent: '',
        choice: resolutions.map((resolution) => keptLabel(resolution)).join(', '),
        // Manual resolutions are UNASSESSED: a human chose a side, nothing
        // judged the outcome. Claiming `safe` here is the lie this fixes.
        finalRisk: 'unassessed',
        confidence: 0,
        why: resolutions.some((resolution) => resolution.auto)
          ? 'Resolved during this session (some hunks auto-applied).'
          : 'Resolved by hand during this session.',
        how: resolutions.every((resolution) => resolution.hunkId === WHOLE_FILE_HUNK_ID)
          ? 'Whole file kept from one side.'
          : `${resolutions.length} hunk(s) resolved individually.`,
      })
    }
    for (const file of mergeState?.unmergedPaths ?? []) {
      if (covered.has(file)) continue
      conflicts.push({
        file,
        oursIntent: '',
        theirsIntent: '',
        choice: '',
        finalRisk: 'risky',
        confidence: 0,
        why: '',
        how: '',
      })
    }

    return {
      branch,
      ontoBranch,
      conflicts,
      ...(session?.verify ? { verify: session.verify } : {}),
    }
  }

  /**
   * Complete the merge, first writing a deterministic resolution summary and
   * folding its condensed body into the commit message. Fail-soft: a summary
   * write failure logs and falls back to the plain prepared message — it must
   * never block completing the merge (#66, Phase 8).
   */
  /**
   * The stage-and-confirm gate (Phase 5, Task 5). Presents every resolved hunk
   * in identity terms ("kept <branch>") and requires an explicit confirm before
   * the merge/rebase is completed. Returns true to proceed, false to cancel. An
   * empty resolution set still confirms (whole-file / non-hunk resolutions), but
   * the review states so plainly rather than silently completing.
   */
  function confirmCompletion(rootPath: string, op: 'merge' | 'rebase'): boolean {
    const review = buildMergeCompletionReview(getHunkResolutions(rootPath))
    const verb = op === 'rebase' ? 'Continue the rebase' : 'Complete the merge'
    const lines = review.rows.map(
      (row) =>
        `  • ${row.filePath} — kept ${row.kept}` +
        `${row.wholeFile ? ' (whole file)' : ''}${row.auto ? ' (auto)' : ''}`,
    )
    const body = [review.headline, ...(lines.length > 0 ? ['', ...lines] : []), '', `${verb}?`].join(
      '\n',
    )
    return window.confirm(body)
  }

  async function completeMergeWithSummary(rootPath: string, message: string): Promise<void> {
    let finalMessage = message
    let docPath: string | null = null
    try {
      const input = await buildMergeSummaryInput(rootPath)
      const { path, commitBody } = await api.git.writeMergeSummary({
        rootId: rootPath,
        input,
        stamp: mergeSummaryStamp(),
      })
      docPath = path
      if (commitBody) finalMessage = `${message}\n\n${commitBody}`
    } catch (error) {
      console.warn('flow: merge summary write failed; completing with plain message', {
        rootPath,
        error,
      })
    }

    try {
      const { hash } = await api.git.completeMerge({ rootId: rootPath, message: finalMessage })
      clearMergeResolutionSession(rootPath)
      notify({
        title: 'Merge completed',
        body: docPath ? `${hash} · summary: ${docPath}` : hash,
        level: 'info',
      })
      void refreshRoot(rootPath) // explicit refresh after our own action (#507)
    } catch (error) {
      console.error('flow: complete merge failed', { rootPath, error })
      notify({ title: "Couldn't complete merge", body: gitErrorMessage(error), level: 'error' })
    }
  }

  /** `known` is the roots the broadcast already handed us; without it this
   *  asks, which is what the initial bind does. */
  async function syncRoots(known?: readonly RegisteredProject[]): Promise<void> {
    try {
      // Skip unavailable roots (unmounted drives, #263) — running git on a
      // nonexistent path just errors; the sidebar already shows them greyed-out.
      const roots = (known ?? (await api.project.list())).filter(
        (root) => root.available !== false,
      )
      rootOrder = roots.map((root) => root.rootPath)
      // A thread's checkout is in the domain but never in `rootOrder`, so
      // pruning against the raw list would delete its view on every root sync.
      const alive = new Set(knownRoots())
      for (const rootPath of [...views.keys()]) {
        if (!alive.has(rootPath)) views.delete(rootPath)
      }
      for (const rootPath of [...refreshStatus.keys()]) {
        if (!alive.has(rootPath)) refreshStatus.delete(rootPath)
      }
      render()
      // If the diff's own root was just removed, close the now-orphaned overlay (#191).
      closeStaleDiff()
      // THE ACTIVE ROOT FIRST, ALONE, AND THE REST WHEN THEY MATTER.
      //
      // This fanned out status + log + mergeState across EVERY root at once —
      // three git child processes per project, in parallel, at boot. Measured
      // at open: git:status, git:log and five git:mergeState round trips of
      // 250-350 ms each, on the main process, while the thread list and every
      // other surface queued behind them. The panel shows ONE root at a time
      // (plus the active thread's extra roots), so the others were paying for a
      // view nobody was looking at — the same "pay only for what someone can
      // see" rule this repo has now applied five times (#1640, #1666, #1696,
      // the tasks board, and here).
      //
      // A root not refreshed here is not stale-forever: focusing it refreshes
      // it (setActiveRoot), and its own git/file events queue a refresh.
      // THE ROOT ON SCREEN, not the active project: when the active thread
      // works in its own checkout, that checkout is what the panel renders and
      // the project's tree is not in the scope at all — refreshing the project
      // here would fetch a repo nobody is looking at and leave the visible one
      // empty (allowed-pattern #17, and #289's "never show No project roots
      // for a root we have").
      const focus =
        visibleRoots()[0] ??
        (activeRoot !== null && knowsRoot(activeRoot) ? activeRoot : rootOrder[0])
      if (focus !== undefined) await refreshRoot(focus)
    } catch (error) {
      console.warn('flow: git root sync failed', error)
    }
  }

  // Working-tree edits arrive via the project file watcher; collapse bursts.
  const refreshTimers = new Map<string, number>()
  function queueRefresh(rootPath: string): void {
    // ONLY WHAT THE PANEL SHOWS. A save in one project used to refresh EVERY
    // open root — status + log + mergeState each, so four repos meant twelve
    // git processes against 1.7-5.4 GB working trees. The stall log caught the
    // shape of it: four of each channel, all finishing together, wrapped
    // around a main process reporting itself blocked for 27 seconds.
    //
    // A root that is not on screen refreshes when it comes into view
    // (setActiveRoot / setThreadRoots both call refreshRoot).
    if (!visibleRoots().includes(rootPath)) return
    const existing = refreshTimers.get(rootPath)
    if (existing !== undefined) window.clearTimeout(existing)
    refreshTimers.set(
      rootPath,
      window.setTimeout(() => {
        refreshTimers.delete(rootPath)
        void refreshRoot(rootPath)
      }, FILE_CHANGE_REFRESH_DEBOUNCE_MS),
    )
  }

  // PERF: git:changed arrives in bursts too (index rewrites during a commit,
  // agent-driven staging) — route it through the same debounced queue as
  // project file events instead of firing an immediate status+log+merge
  // round-trip per event.
  api.git.onChanged(({ rootId }) => {
    if (knowsRoot(rootId)) queueRefresh(rootId)
  })
  api.project.onFileChanged(({ rootPath }) => {
    if (knowsRoot(rootPath)) queueRefresh(rootPath)
  })
  api.project.onListChanged((roots) => {
    void syncRoots(roots)
  })

  // A file was opened into the editor area the diff overlay covers — step aside so
  // the just-opened file is visible, instead of leaving a stale diff on top (#345).
  // Unconditional (#953): even when no overlay is painted yet, an IN-FLIGHT diff
  // request must be cancelled — the user's last action ("open this file") wins,
  // so a late-resolving diff never covers the just-opened file.
  document.addEventListener('flow:editor-file-opened', () => {
    closeDiff()
  })

  // The thread change-review card (#1906) opens a file's diff through the SAME
  // DiffView the Source Control panel uses — one diff surface, one code path. The
  // card lives in renderer/threads and cannot reach this closure, so it asks via
  // a DOM event carrying the worktree root + the file. A minimal GitFileChange is
  // enough: openFileDiff reads only `filePath` from it.
  document.addEventListener('flow:open-change-review-diff', (event) => {
    const detail = (
      event as CustomEvent<{
        rootPath: string
        filePath: string
        staged?: boolean
        threadId?: string | null
      }>
    ).detail
    if (!detail?.rootPath || !detail?.filePath) return
    const change = { filePath: detail.filePath, state: 'modified', staged: false } as GitFileChange
    // Owned by the CONVERSATION, not by the panel's root scope. This is the
    // whole of the dead-click fix: the checkout a thread works in is often not a
    // tree Source Control lists, and judging this diff by that list threw it
    // away every time.
    const threadId = detail.threadId ?? activeThreadId
    const owner: DiffOwner =
      threadId === null ? { kind: 'panel', rootPath: detail.rootPath } : { kind: 'thread', threadId }
    void openFileDiff(detail.rootPath, change, detail.staged === true, owner)
  })

  // Follow the active THREAD's additional roots (#45) — selecting a thread that
  // spans extra repos widens the panel; clearing/switching narrows it back.
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId: string | null; additionalRoots?: string[] }>).detail
    setThreadRoots(detail.threadId, detail.additionalRoots ?? [])
  })
  // Roots edited mid-thread ("Add projects" on the thread menu).
  document.addEventListener('flow:thread-roots-changed', (event) => {
    const detail = (event as CustomEvent<{ threadId: string; additionalRoots: string[] }>).detail
    if (detail.threadId === activeThreadId) setThreadRoots(detail.threadId, detail.additionalRoots)
  })

  // ── The landing bar's own two triggers (thread-worktrees Phase 9) ────────
  //
  // The bar reads GIT inside the thread's checkout, and a checkout is watched by
  // nothing: it is deliberately never a registered project root, so neither
  // `git:changed` nor `project:fileChanged` ever names it. Nothing can tell
  // the bar its thread wrote something — it has to look. These are the two
  // moments looking is worth it, and both are filtered (landing-refresh-model.ts).

  /** Is the Source Control pane actually on screen? The DOM is the one truth —
   *  a stored boolean beside it is a second copy that can disagree with it. */
  function panelOnScreen(): boolean {
    return surfaces.gitPanel.isConnected && surfaces.gitPanel.getClientRects().length > 0
  }

  /**
   * The roots on screen that NOTHING watches.
   *
   * `rootOrder` is the registered project roots, and registered roots are
   * exactly the ones the git watcher and the file watcher cover — they refresh
   * themselves, so re-reading them here would be work the watchers already did
   * (allowed-pattern #17). A thread's checkout is never registered, so it is
   * never watched, and it is the one that has to be asked.
   */
  function unwatchedVisibleRoots(): string[] {
    return visibleRoots().filter((rootPath) => !rootOrder.includes(rootPath))
  }

  let wasOnScreen = panelOnScreen()

  document.addEventListener(SOURCE_CONTROL_VISIBILITY_EVENT, () => {
    const nowOnScreen = panelOnScreen()
    const action = landingRefreshOnVisibility({
      wasOnScreen,
      nowOnScreen,
      boundThreadId: activeThreadId,
    })
    wasOnScreen = nowOnScreen
    if (action === 'skip') return
    // A person turning to Source Control is asking what is waiting — so re-read
    // the git status of any root nothing watches (a thread's checkout gets no
    // watcher events, so its section would otherwise show the tree as it was
    // when it was cut).
    for (const rootPath of unwatchedVisibleRoots()) void refreshRoot(rootPath)
  })

  if (typeof api.threads?.onUpdated === 'function') {
    api.threads.onUpdated((events) => {
      const action = landingRefreshOnThreadEvents({
        events,
        boundThreadId: activeThreadId,
        panelOnScreen: panelOnScreen(),
      })
      if (action === 'skip') return
      // A turn boundary on the bound thread — the agent has just stopped
      // writing into the checkout, which is the other moment the answer moves.
      for (const rootPath of unwatchedVisibleRoots()) void refreshRoot(rootPath)
    })
  }

  // Scope to the active project and follow project switches (ADR-002 —
  // superseded by the thread scope below once it lands; setActiveRoot keeps
  // maintaining activeRoot for toasts/refresh even in scope-driven mode).
  api.project.onActiveChanged((context) => {
    setActiveRoot(context?.rootPath ?? null)
  })
  void api.project
    .active()
    .then((context) => {
      if (context) setActiveRoot(context.rootPath)
    })
    .catch(() => undefined)

  // ── Thread scope (multi-project threads Phase 4) ─────────────────────────
  // Initial paint from getThreadScope, live updates from threadScopeChanged —
  // the same consumption idiom as the Phase 3 file tree. When the scope API is
  // unavailable (older preload, failed handler) the guards above never flip
  // scopeDriven and the legacy binding keeps working exactly as before.
  if (
    typeof api.project.getThreadScope === 'function' &&
    typeof api.project.onThreadScopeChanged === 'function'
  ) {
    api.project.onThreadScopeChanged((scope) => {
      applyThreadScope(scope)
    })
    void api.project
      .getThreadScope()
      .then((scope) => {
        applyThreadScope(scope)
      })
      .catch(() => {
        // Scope layer unavailable — the active-root fallback stays in charge.
      })
  }

  void syncRoots()
}
