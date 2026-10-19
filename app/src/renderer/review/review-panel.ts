/**
 * Review panel — phase-grouped review & commit. Renders the review:list
 * groups (each plan phase, plus "Other changes") as collapsible sections of
 * changed files. Clicking a file opens its working-tree diff; each group has an
 * editable commit message and a "Commit phase" action that commits that group's
 * files as whole files. Reject sends a file back to the agent to redo (wired by
 * the coordinator).
 *
 * Pure view: it renders `setGroups(...)` and calls back into the coordinator
 * (renderer/review/index.ts), which owns IPC, the diff surface, and refresh.
 */
import '../components'
import type { ReviewFile, ReviewGroup } from '../../shared/ipc-contract'
import { reviewEmptyMessage } from './review-empty'
import {
  approvedFilePaths,
  commitButtonState,
  effectiveGroupApprovals,
  pathsClaimedBySeveralGroups,
  reconcileInGroupApprovals,
} from './review-approval'
import { mayFireArmedAction } from './armed-root'
import { dropCommittedDraft, pruneVanishedDrafts } from './phase-drafts'
import { shouldApplyGeneratedMessage } from '../git/commit-box'
import { discardAllConfirmMessage, discardConfirmMessage } from '../git/discard-all'
import { ReviewRefreshGate } from './review-refresh-gate'
import { captureMessageFocus, type MessageFocus } from './message-focus'
import type { InvariantFlag } from './invariant-flags'

export interface ReviewPanelCallbacks {
  /** A changed-file row was activated → show its working-tree diff. */
  onOpenDiff(file: ReviewFile): void
  /** Commit every file in a group with the given message. */
  onCommitGroup(group: ReviewGroup, message: string): void
  /** Discard a group → revert every file to HEAD (no agent redo) (#124). */
  onDiscardGroup(group: ReviewGroup): void
  /** Reject a file → revert + send back to the agent to redo (with feedback). */
  onRejectFile(file: ReviewFile, feedback: string): void
  /** Approval mirrored into git staging (#857): stage (true) / unstage (false)
   *  the files, so the Source Control panel and this surface agree. */
  onApproveToggle(files: ReviewFile[], approved: boolean): void
  /** An approve/commit was refused because these files still carry unresolved
   *  merge conflicts (#986) — surface the refusal + point at the resolver. */
  onConflictBlocked(files: ReviewFile[]): void
  /** ✨ Generate a commit message for this group's files (#1141) — the same
   *  generator the sibling Changes box uses. Resolves null when it failed (the
   *  coordinator has already surfaced the failure). */
  onGenerateMessage(group: ReviewGroup, filePaths: string[]): Promise<string | null>
  /** Manual refresh request. */
  onRefresh(): void
}

const STATE_LETTER: Record<ReviewFile['state'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '??',
  conflicted: 'U',
}

export class ReviewPanel {
  #container: HTMLElement
  #callbacks: ReviewPanelCallbacks
  /** File paths approved IN each group (keyed by group label, survive
   *  re-render). Grows only via this group's own ✓ / "Approve all" clicks —
   *  never from git staged-ness, so a sibling group staging a file claimed by
   *  several groups cannot arm this group's gate (#1432). Entries drop when
   *  the file leaves the group's listing, when the user un-approves, and on
   *  clearDraft/reset; the EFFECTIVE approved set is re-derived every render
   *  (`effectiveGroupApprovals` — singly-claimed files keep #857's staged ⇒
   *  approved), so an unstage or rewrite (#857/#1052) revokes without erasing
   *  the memory that the approval was given here. */
  #approved = new Map<string, Set<string>>()
  /** Per-group commit-message drafts, keyed by group label (survive re-render). */
  #drafts = new Map<string, string>()
  /** Latest groups, re-rendered on setGroups. */
  #groups: ReviewGroup[] = []
  /** #1332: what the empty state may honestly claim. */
  #hasProject = true
  #gitState: 'ok' | 'no-repo' | undefined = undefined
  /** Defers background re-renders while a reject/discard prompt is open (#182). */
  #refreshGate = new ReviewRefreshGate<ReviewGroup[]>()
  /** Advisory invariant flags per file path (#898 FR10) — informational only. */
  #invariantFlags = new Map<string, InvariantFlag>()
  /** In-flight ✨ generations per group label (#1141). Held on the PANEL, not
   *  the button, so a rebuild mid-generation still renders the wand disabled —
   *  the ~5s wait must never read as a dead click (#1020's lesson). */
  #generating = new Map<string, { seq: number; draftAtClick: string }>()
  #generateSeq = 0
  /** The active project root the coordinator keeps in sync (#951). Destructive
   *  armed actions stamp it at arm time and re-check it at fire time. */
  #activeRoot: string | null = null

  constructor(container: HTMLElement, callbacks: ReviewPanelCallbacks) {
    this.#container = container
    this.#callbacks = callbacks
    injectReviewStyles()
    this.#container.classList.add('fl-review')
    this.#render()
  }

  /** Advisory per-file invariant flags (#898) — re-renders; never gates. Uses
   *  the same defer gate as setGroups so an open reject prompt survives. */
  setInvariantFlags(flags: Map<string, InvariantFlag>): void {
    this.#invariantFlags = flags
    const toRender = this.#refreshGate.receive(this.#groups)
    if (toRender) this.#applyGroups(toRender)
  }

  /** #1332: what the empty state may honestly claim about this root. */
  setEmptyContext(context: { hasProject: boolean; gitState?: 'ok' | 'no-repo' }): void {
    this.#hasProject = context.hasProject
    this.#gitState = context.gitState
  }

  setGroups(groups: ReviewGroup[]): void {
    // Defer while a reject prompt / discard confirm is open, so a background
    // file change doesn't tear down the DOM and lose typed feedback (#182).
    const toRender = this.#refreshGate.receive(groups)
    if (toRender) this.#applyGroups(toRender)
  }

  /** The coordinator's active project root — kept in sync on init and on every
   *  project:activeChanged, so armed destructive actions can verify at
   *  fire time that they still target the root they were armed on (#951). */
  setRoot(root: string | null): void {
    this.#activeRoot = root
  }

  /**
   * Clear all per-project draft/approval state — called on a PROJECT SWITCH so a
   * commit message (or approval) entered for one project can't leak into another
   * project's same-labeled group ("Other changes", "Phase 1", …) and be committed
   * there (#281). Not called on same-project background refreshes.
   *
   * Also tears down any open transient interaction (#951): the #182 refresh gate
   * would otherwise DEFER the switch's rebuild, leaving the previous project's
   * files listed with a still-armed "Discard N" confirm over the new project.
   * The forced render destroys the transient UI and lowers the gate, so the
   * switch's own refresh repaints with the new project's changes; the panel is
   * emptied in the meantime so no stale rows are actionable.
   */
  reset(): void {
    this.#drafts.clear()
    this.#approved.clear()
    // #1380: and the IN-FLIGHT generations. This teardown exists so a commit
    // message belonging to one project can never be committed in another
    // (#281) — but a ✨ started in project A outlived the switch and, ~10s
    // later, wrote its result into project B's same-labelled group ("Other
    // changes", "Phase 1"), pre-filled and one click from being committed over
    // B's unrelated work.
    this.#generating.clear()
    this.#groups = []
    this.#render() // markRendered() inside lowers the #182 gate
  }

  /**
   * Drop a committed group's Phase-mode message draft (+ its approvals) after a
   * SUCCESSFUL commit, so a later, unrelated changeset that reuses the label
   * ("Other changes", "Phase N") shows its own fresh suggested message instead of
   * the stale, already-committed one (#342). Mirrors manual mode's #183 reset; the
   * coordinator calls this only on the commit-resolved path, never on failure.
   */
  clearDraft(label: string): void {
    this.#drafts = dropCommittedDraft(this.#drafts, label)
    this.#approved.delete(label)
  }

  /**
   * A ✨ generation resolved (#1141) — the same contract as the Changes box
   * (#1020): write through the DRAFT store and re-render, never the click-time
   * input (a rebuild may have detached it); drop a superseded result; and leave
   * the user's own words alone if they typed while it ran. A null result means
   * the coordinator already surfaced the failure — only the busy state clears.
   */
  #settleGeneration(label: string, seq: number, message: string | null): void {
    const pending = this.#generating.get(label)
    if (!pending || pending.seq !== seq) return
    this.#generating.delete(label)
    const draftNow = this.#drafts.get(label) ?? pending.draftAtClick
    if (message !== null && shouldApplyGeneratedMessage(pending.draftAtClick, draftNow, message)) {
      this.#drafts.set(label, message)
    }
    // #1379: DON'T BULLDOZE AN OPEN INTERACTION. This was the one re-render
    // path in the panel that skipped the #182 refresh gate, and the
    // generation takes 10-13s — so whatever the user opened in the meantime
    // was destroyed without a word: an open reject (✕) prompt AND the
    // feedback they had typed into it for the agent, or an armed
    // "Discard N changes?" confirm.
    //
    // The draft is already stored above, so deferring costs nothing: the
    // commit row picks the message up when the interaction closes and the
    // gate flushes.
    if (this.#refreshGate.isOpen) return
    this.#render()
  }

  #applyGroups(groups: ReviewGroup[]): void {
    // #1140: a draft belongs to the changeset it was typed for. Once that group
    // is no longer listed — discarded, rejected away, committed from the sibling
    // Changes view — its message must not survive to be pre-filled over the next
    // changeset that recycles the label. Presence is the lifetime; the explicit
    // clearDraft on the commit path (#342) stays as the immediate, intent-level
    // signal, and this backstops every other exit.
    const labels = groups.map((group) => group.label)
    this.#drafts = pruneVanishedDrafts(this.#drafts, labels)
    for (const label of [...this.#approved.keys()]) {
      if (!labels.includes(label)) this.#approved.delete(label)
    }
    this.#groups = groups
    this.#render()
  }

  /**
   * Exit an inline prompt WITHOUT firing it (Cancel/Escape) (#1018): close this
   * interaction and flush any deferred update. While a SIBLING prompt still
   * holds the ref-counted gate (#188), the flush stays deferred and the
   * follow-up refresh defers too — so repaint the host row locally instead,
   * keeping the sibling (and its typed feedback) intact and making sure the
   * dismissal is never a dead click.
   */
  #dismissPrompt(restore: () => void): void {
    const flush = this.#refreshGate.close()
    if (flush) {
      this.#applyGroups(flush) // full repaint — the prompt's DOM goes with it
    } else {
      restore() // scoped repaint of just the host row (#1018)
    }
    this.#callbacks.onRefresh()
  }

  /**
   * Fire a destructive armed action (Discard N / Redo) — the ONE fire-time path
   * (#951, allowed-pattern #14). The action runs only if the active root is
   * still the root it was armed on; after a project switch it is refused and the
   * interaction simply closes (a refresh repaints the current project's state),
   * so a confirm armed in one project can never revert another project's work.
   *
   * The gate is FORCE-closed (#1018): a destructive fire invalidates every row,
   * so deferring its refresh behind a still-open sibling prompt would leave the
   * panel listing already-reverted files with the used confirm still armed.
   */
  #fireArmed(armedRoot: string | null, action: () => void): void {
    const flush = this.#refreshGate.forceClose()
    if (flush) this.#applyGroups(flush)
    if (mayFireArmedAction(armedRoot, this.#activeRoot)) action()
    else this.#callbacks.onRefresh()
  }

  #render(): void {
    // A full render destroys any transient reject/discard UI, so the gate is no
    // longer open — lower it so a later background refresh isn't wrongly deferred.
    this.#refreshGate.markRendered()
    // A background refresh rebuilds the whole DOM; if the user was typing a
    // commit message, capture the focused input + caret so it can be restored on
    // the recreated element instead of ejecting them mid-typing (#282).
    const focus = this.#captureMessageFocus()
    this.#container.textContent = ''
    this.#container.appendChild(this.#toolbar())
    if (this.#groups.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-review-empty'
      // #1332: three materially different situations used to produce the same
      // confident "your tree is clean" sentence — no project open, a folder
      // that is not a repository, and a repo git could no longer read. The
      // Changes view beside this one has always told them apart; these are its
      // strings.
      empty.textContent = reviewEmptyMessage({
        hasProject: this.#hasProject,
        gitState: this.#gitState,
      })
      this.#container.appendChild(empty)
      return
    }
    // Paths several groups claim, computed ONCE over the whole listing: for
    // these a per-file fact (staged-ness) cannot answer the per-group question
    // "was this reviewed here?" (#1432).
    const sharedPaths = pathsClaimedBySeveralGroups(this.#groups)
    for (const group of this.#groups) {
      this.#container.appendChild(this.#renderGroup(group, sharedPaths))
    }
    this.#restoreMessageFocus(focus)
  }

  /** Snapshot the focused commit-message input's key + caret before a rebuild (#282). */
  #captureMessageFocus(): MessageFocus | null {
    const active = document.activeElement
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      return captureMessageFocus(undefined, false, null, null)
    }
    return captureMessageFocus(
      active.dataset['msgKey'],
      this.#container.contains(active),
      active.selectionStart,
      active.selectionEnd,
    )
  }

  /** Re-focus the recreated commit-message input and restore its caret (#282). */
  #restoreMessageFocus(focus: MessageFocus | null): void {
    if (!focus) return
    for (const el of this.#container.querySelectorAll('[data-msg-key]')) {
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        el.dataset['msgKey'] === focus.key
      ) {
        el.focus()
        try {
          el.setSelectionRange(focus.start, focus.end)
        } catch {
          // Some input types don't support selection ranges — focus is enough.
        }
        return
      }
    }
  }

  #toolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'fl-review-toolbar'
    const title = document.createElement('span')
    title.className = 'fl-review-title'
    title.textContent = 'Review changes'

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'fl-review-refresh'
    refresh.title = 'Refresh'
    refresh.textContent = '⟳'
    refresh.addEventListener('click', () => this.#callbacks.onRefresh())
    bar.append(title, refresh)
    return bar
  }

  #renderGroup(group: ReviewGroup, sharedPaths: ReadonlySet<string>): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-review-group'

    const header = document.createElement('div')
    header.className = 'fl-review-group-header'
    const label = document.createElement('span')
    label.className = 'fl-review-group-label'
    label.textContent = group.label
    const count = document.createElement('span')
    count.className = 'fl-review-group-count'
    count.textContent = String(group.files.length)
    header.appendChild(label)
    header.appendChild(count)
    section.appendChild(header)

    // Approved state for this group. A file only this group claims keeps
    // #857's full derivation: staged (and fresh, #1052) means approved. A file
    // SEVERAL groups claim needs an approval GIVEN here (#1432): staged-ness
    // still revokes (unstage / rewrite re-gates), but never grants across
    // groups — a ✓ inside Phase 1 must not arm a Phase 2 the user never
    // opened; there it renders as "approved in another phase" and stays
    // outside this group's gate until clicked here.
    //
    // `given` is the durable memory, reconciled only against the files the
    // listing SHOWS (drop what left; carry a rolled-up `dir/` approval to the
    // staged paths that replace it, #176) plus un-approve clicks and
    // clearDraft/reset — never intersected with a staged-ness snapshot: a
    // listing refresh can arrive mid-staging, and pruning the memory by it
    // would permanently drop approvals whose `git add` had not landed yet.
    // The effective set is re-derived fresh each render, kept as a Set for
    // the optimistic click toggle. The reconciled contents are written back
    // INTO the stored Set — its identity is shared with the row/commit
    // closures below.
    const staged = approvedFilePaths(group.files)
    const given = this.#approved.get(group.label) ?? new Set<string>()
    this.#approved.set(group.label, given)
    const present = new Set(group.files.map((f) => f.filePath))
    const reconciled = reconcileInGroupApprovals(given, present)
    given.clear()
    for (const path of reconciled) given.add(path)
    const approved = effectiveGroupApprovals(given, staged, sharedPaths)

    // Files whose merge conflict is still unresolved (#986) — main-side derived
    // (`state: 'conflicted'` comes from git's unmerged set). They are excluded
    // from Approve all and turn the phase button into "Resolve N conflicts
    // first"; the authoritative gate is GitManager.unresolvedConflictPaths.
    const conflictedFiles = group.files.filter((f) => f.state === 'conflicted')
    const conflicted: ReadonlySet<string> = new Set(conflictedFiles.map((f) => f.filePath))

    // Commit row — the button is gated on ALL files in the phase being approved.
    // Its content is built by a REPAINTABLE painter (#1018): the "Discard all"
    // confirm replaces the row's content in place, and its Cancel must be able
    // to restore the normal row even while a sibling prompt defers re-renders.
    const commitRow = document.createElement('div')
    commitRow.className = 'fl-review-commit'

    // Each file's row exposes its repaint so "Approve all" can refresh them all.
    const paints: Array<() => void> = []
    const filePaths = group.files.map((f) => f.filePath)
    // Rebound by paintCommitRow so approve-driven syncCommit calls always
    // address the CURRENT input/button, even after a scoped restore (#1018).
    let input: HTMLInputElement | null = null
    let commitBtn: HTMLButtonElement | null = null
    // #1285: the ✨ reads the STAGED diff, so it is rebound here too — its
    // availability tracks approvals, not merely "the group lists a file".
    let generateBtn: HTMLButtonElement | null = null
    /** The group's approved (⇒ staged) files — the only thing the wand's
     *  input, the staged diff, can actually contain. */
    const approvedPaths = (): string[] => filePaths.filter((path) => approved.has(path))
    const syncCommit = (): void => {
      if (input !== null && commitBtn !== null) {
        const state = commitButtonState(filePaths, approved, input.value, conflicted)
        commitBtn.disabled = state.disabled
        commitBtn.textContent = state.label
      }
      if (generateBtn !== null) {
        const nothingToDescribe = approvedPaths().length === 0
        generateBtn.disabled = nothingToDescribe || this.#generating.has(group.label)
        generateBtn.title = nothingToDescribe
          ? 'Generate commit message with AI — approve a file first, so there is a change to describe'
          : 'Generate commit message with AI'
      }
    }

    const paintCommitRow = (): void => {
      commitRow.classList.remove('fl-review-discard-confirm')
      commitRow.textContent = ''
      const msgInput = document.createElement('input')
      msgInput.type = 'text'
      msgInput.className = 'fl-review-message'
      // #1141: the field names its shortcut, exactly as the sibling Changes box
      // does — an unadvertised key that does nothing reads as "the app ignored
      // me", and this is the primary action of the flow.
      msgInput.placeholder = 'Commit message (⌘/Ctrl+Enter to commit)'
      msgInput.dataset['msgKey'] = group.label // focus survives a rebuild (#282)
      msgInput.value = this.#drafts.get(group.label) ?? group.suggestedMessage
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fl-review-commit-btn'
      const runCommitAction = (): void => {
        const state = commitButtonState(filePaths, approved, msgInput.value, conflicted)
        if (state.action === 'approve-all') {
          // Conflicted files are never swept into an Approve all (#986) — staging
          // an unmerged path would tell git the conflict is resolved.
          const approvable = group.files.filter((f) => !conflicted.has(f.filePath))
          for (const file of approvable) {
            approved.add(file.filePath) // optimistic paint
            given.add(file.filePath) // the durable in-group memory (#1432)
          }
          for (const paint of paints) paint()
          syncCommit()
          // Mirror into the staging area (#857) — one call for the whole group.
          if (approvable.length > 0) this.#callbacks.onApproveToggle(approvable, true)
        } else if (state.action === 'resolve-conflicts') {
          this.#callbacks.onConflictBlocked(conflictedFiles)
        } else if (state.action === 'commit') {
          this.#callbacks.onCommitGroup(group, msgInput.value.trim())
        }
      }
      btn.addEventListener('click', runCommitAction)
      msgInput.addEventListener('input', () => {
        this.#drafts.set(group.label, msgInput.value)
        syncCommit()
      })
      // #1141: ⌘/Ctrl+Enter commits the armed group (Enter too — this is a
      // single-line input, where Enter has no other meaning). It runs the SAME
      // action the button would, so every gate still applies: an unapproved
      // group approves instead of committing, and a conflicted one is refused.
      msgInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        const state = commitButtonState(filePaths, approved, msgInput.value, conflicted)
        // The keyboard commits; it never silently ARMS. Approving is a
        // deliberate click, so a stray Enter can't approve files unseen.
        if (state.action !== 'commit' || state.disabled) return
        runCommitAction()
      })

      // Discard all — the exit when the user wants to throw the changes away
      // rather than approve them (#124). Reverting is destructive (drops
      // uncommitted work), so it takes an inline two-step confirm instead of
      // acting on the first click.
      const discardBtn = document.createElement('button')
      discardBtn.type = 'button'
      discardBtn.className = 'fl-review-discard-btn'
      discardBtn.title = 'Revert every file in this group to its last committed state'
      discardBtn.textContent = 'Discard all'
      discardBtn.addEventListener('click', () =>
        this.#confirmDiscardGroup(group, commitRow, paintCommitRow),
      )

      // ✨ Generate — the same generator the sibling Changes box calls (#1141),
      // over THIS group's files rather than the whole staged set.
      const generate = document.createElement('button')
      generate.type = 'button'
      generate.className = 'fl-review-generate'
      const wand = document.createElement('fl-icon')
      wand.setAttribute('name', 'sparkles')
      wand.setAttribute('size', '14')
      generate.appendChild(wand)
      generate.setAttribute('aria-label', 'Generate commit message with AI')
      generateBtn = generate
      // #1285: offered only once there is staged content to describe — the
      // sibling Changes wand has always gated this way (`stagedCount === 0`).
      // Ungated, it ran over an empty staged diff and the model wrote a
      // message from the file NAMES alone.
      generate.addEventListener('click', () => {
        if (this.#generating.has(group.label)) return
        const seq = ++this.#generateSeq
        this.#generating.set(group.label, {
          seq,
          draftAtClick: this.#drafts.get(group.label) ?? msgInput.value,
        })
        generate.disabled = true
        void this.#callbacks
          // Only the approved files: the message must describe exactly what
          // the commit will contain (#694), and an unapproved file's staged
          // diff is empty noise in the prompt.
          .onGenerateMessage(group, approvedPaths())
          .then((message) => this.#settleGeneration(group.label, seq, message))
          .catch(() => this.#settleGeneration(group.label, seq, null))
      })

      commitRow.append(msgInput, generate, discardBtn, btn)
      input = msgInput
      commitBtn = btn
      syncCommit()
    }

    for (const file of group.files) {
      section.appendChild(
        this.#renderFile(group, file, approved, given, staged, syncCommit, paints),
      )
    }

    paintCommitRow()
    section.appendChild(commitRow)
    return section
  }

  /** Swap the commit row for an inline "Discard N?" confirm (destructive).
   *  `restore` repaints the normal commit row — used by Cancel so backing out
   *  works even while a sibling prompt is deferring re-renders (#1018). */
  #confirmDiscardGroup(group: ReviewGroup, commitRow: HTMLElement, restore: () => void): void {
    // Defer background refreshes so this two-step confirm isn't wiped mid-flow (#182).
    this.#refreshGate.open()
    // Stamp the root this confirm is armed on — the fire-time guard refuses to
    // discard if a project switch changed the active root in between (#951).
    const armedRoot = this.#activeRoot
    const count = group.files.length
    commitRow.textContent = ''
    commitRow.classList.add('fl-review-discard-confirm')
    const label = document.createElement('span')
    label.className = 'fl-review-discard-label'
    // #1475: say what this actually does. The old copy — "Discard N changes?
    // Files revert to HEAD." — was false for every untracked row in the set:
    // `revertFile` falls through to `git rm --cached` + `git clean -fd` for a
    // path git does not know at HEAD, so the path is DELETED from disk and
    // there is no HEAD version to revert to. It never said "delete", never
    // said the action can't be undone, and counted ROWS — git rolls a wholly
    // new directory up into one `?? newdir/` entry, so "Discard 3 changes?"
    // could destroy any number of files.
    //
    // The behaviour was already right (#136 stopped skipping new directories;
    // `git clean -fd` without -x keeps .gitignore'd files, #1054) — only the
    // sentence lied. This is the copy the sibling Changes surface has carried
    // since #1054/#1144, from the one helper that owns it. No repo name: the
    // Phases panel shows one root at a time, and #1144's clause is deliberately
    // absent for exactly that case.
    label.textContent = discardAllConfirmMessage(group.files)
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-review-commit-btn'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => this.#dismissPrompt(restore))
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-review-discard-btn confirm'
    confirm.textContent = `Discard ${count}`
    confirm.addEventListener('click', () => {
      this.#fireArmed(armedRoot, () => this.#callbacks.onDiscardGroup(group))
    })
    commitRow.append(label, cancel, confirm)
  }

  #renderFile(
    group: ReviewGroup,
    file: ReviewFile,
    approved: Set<string>,
    given: Set<string>,
    staged: ReadonlySet<string>,
    syncCommit: () => void,
    paints: Array<() => void>,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-review-file'
    row.title = file.filePath
    const isApproved = (): boolean => approved.has(file.filePath)

    const letter = document.createElement('span')
    letter.className = `fl-review-state fl-review-state-${file.state}`
    letter.textContent = STATE_LETTER[file.state]

    const name = document.createElement('span')
    name.className = 'fl-review-file-name'
    name.textContent = file.filePath
    name.addEventListener('click', () => this.#callbacks.onOpenDiff(file))

    // Compact advisory invariant flag (#898 FR10): same pushed checker data as
    // the board; click jumps to the diff. Never gates the approve action.
    const invariantFlag = this.#invariantFlags.get(file.filePath)
    let flagEl: HTMLElement | null = null
    if (invariantFlag !== undefined) {
      const flag = document.createElement('button')
      flag.type = 'button'
      flag.className = `fl-review-inv-flag fl-review-inv-${invariantFlag.worst}`
      flag.textContent = `\u26A0${invariantFlag.count > 1 ? ` ${invariantFlag.count}` : ''}`
      flag.title = `Invariant findings (advisory):\n${invariantFlag.title}`
      flag.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#callbacks.onOpenDiff(file)
      })
      flagEl = flag
    }

    const approve = document.createElement('button')
    approve.type = 'button'
    approve.className = 'fl-review-approve'
    // An unresolved conflict is not approvable (#986): ✓ would `git add` the
    // unmerged path, telling git the conflict is resolved and letting the raw
    // markers be committed. The button stays clickable so the refusal explains
    // itself (toast → merge resolver) instead of being a silent dead control.
    const isConflicted = file.state === 'conflicted'
    // Approved-then-rewritten (#1052): the staged blob is what was reviewed but
    // the disk moved on. The ✓ downgrades to an amber ↻ re-approve — clicking it
    // re-stages the CURRENT content (the ordinary approve toggle, which sees the
    // file as unapproved). The optimistic paint clears the downgrade until the
    // refreshed listing confirms it.
    const isStale = file.unreviewedSinceApproval === true
    // Approved in a SIBLING group, never in this one (#1432): the shared file
    // is staged (so a sibling phase's gate counts it), but this group's gate
    // stays unsatisfied until the user clicks it here. Like #1052's stale ↻,
    // it gets its own non-green affordance so "reviewed elsewhere" is never
    // dressed as "reviewed here".
    const isElsewhere = (): boolean =>
      !isConflicted && !isStale && staged.has(file.filePath) && !isApproved()
    if (isConflicted) {
      approve.title = 'Unresolved merge conflict — resolve it before approving'
    } else if (isStale) {
      approve.title = 'Changed since you approved it — click to re-approve the current content'
    } else if (isElsewhere()) {
      approve.title = 'Approved in another phase — review and approve it here too'
    } else {
      approve.title = 'Approve this file'
    }
    if (isConflicted) approve.classList.add('fl-review-approve-blocked')
    const paint = (): void => {
      const on = isApproved()
      const stale = isStale && !on
      approve.classList.toggle('active', on)
      row.classList.toggle('fl-review-file-approved', on)
      approve.classList.toggle('fl-review-approve-stale', stale)
      row.classList.toggle('fl-review-file-stale', stale)
      approve.classList.toggle('fl-review-approve-elsewhere', isElsewhere())
      approve.textContent = stale ? '↻' : '✓'
    }
    paints.push(paint)
    approve.addEventListener('click', (event) => {
      event.stopPropagation()
      if (isConflicted) {
        this.#callbacks.onConflictBlocked([file])
        return
      }
      const next = !isApproved()
      if (next) {
        approved.add(file.filePath) // optimistic paint
        given.add(file.filePath) // the durable in-group memory (#1432)
      } else {
        approved.delete(file.filePath)
        given.delete(file.filePath)
      }
      paint()
      syncCommit()
      // Mirror into the staging area (#857): approve stages, un-approve
      // unstages — the Source Control panel reflects it on git:changed.
      this.#callbacks.onApproveToggle([file], next)
    })

    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = 'fl-review-reject'
    // #1476: there is nothing to "revert" a never-committed file TO — the
    // reject deletes it. The tooltip said otherwise on every row.
    reject.title =
      file.state === 'untracked'
        ? 'Reject — DELETE this new file and ask the agent to redo it'
        : 'Reject — revert and ask the agent to redo'
    reject.textContent = '✕'
    reject.addEventListener('click', (event) => {
      event.stopPropagation()
      // The restore closure rebuilds THIS row from scratch so a Cancel/Escape
      // can repaint it locally while a sibling prompt defers re-renders
      // (#1018). The replacement row registers its own fresh paint; the old
      // row's entry in `paints` only touches detached DOM, which is inert.
      this.#openRejectPrompt(row, file, () =>
        row.replaceWith(
          this.#renderFile(group, file, approved, given, staged, syncCommit, paints),
        ),
      )
    })

    row.appendChild(letter)
    row.appendChild(name)
    if (flagEl !== null) row.appendChild(flagEl)
    row.appendChild(approve)
    row.appendChild(reject)
    paint()
    return row
  }

  /** Swap a file row for an inline "why reject?" feedback prompt. `restore`
   *  rebuilds the host row for a Cancel/Escape while a sibling prompt still
   *  defers re-renders (#1018). */
  #openRejectPrompt(row: HTMLElement, file: ReviewFile, restore: () => void): void {
    // Defer background refreshes so typed feedback isn't wiped mid-entry (#182).
    this.#refreshGate.open()
    // Redo reverts the file — like the discard confirm, it must never fire
    // against a root it wasn't armed on (#951).
    const armedRoot = this.#activeRoot
    row.textContent = ''
    row.classList.add('fl-review-reject-prompt')
    // #1476: NAME THE TARGET, and say what happens to it.
    //
    // Opening this prompt replaces the file's own row, so what was left on
    // screen was a nameless strip — an input, Cancel, Redo — and one click on
    // Redo runs `git rm --cached` + `git clean -fd` for a path git does not
    // know at HEAD. Brand-new work that exists in exactly one place was
    // destroyed with no confirm, no toast, no undo, and no mention of which
    // file it was. (The button's own tooltip promised a "revert", of which
    // there is none: there is no HEAD version to revert to.)
    //
    // The sentence is the sibling Changes view's, from the helper that owns it
    // (#1054/#1144) — so this surface asks the same question about the same
    // operation. Untracked rows get "Delete untracked file X? This can't be
    // undone."; a rolled-up `newdir/` gets the directory wording, .gitignore
    // scoping included; a tracked file gets the discard wording.
    const destroysFile = file.state === 'untracked'
    const target = document.createElement('span')
    target.className = 'fl-review-reject-target'
    target.textContent = discardConfirmMessage(file)
    row.appendChild(target)
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'fl-review-message'
    input.placeholder = 'Why reject? (feedback for the agent)'
    // A non-destructive back-out (#697). Without it the prompt is a trap: once the
    // user clicks away from the input, the input-bound Escape is dead and the #182
    // refresh gate blocks ⟳ — leaving only the destructive "Redo". A Cancel button
    // dismisses regardless of focus, mirroring #confirmDiscardGroup's Cancel.
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-review-commit-btn'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => this.#dismissPrompt(restore))
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'fl-review-commit-btn'
    // The primary button says the destructive half out loud (#1476) — "Redo"
    // alone reads as a rebuild, not a delete.
    send.textContent = destroysFile ? 'Delete & redo' : 'Redo'
    // Capture the feedback BEFORE closing — #fireArmed's close may re-render and
    // tear down this input while flushing a deferred update.
    const submit = (): void => {
      const feedback = input.value.trim()
      this.#fireArmed(armedRoot, () => this.#callbacks.onRejectFile(file, feedback))
    }
    send.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit()
      else if (event.key === 'Escape') this.#dismissPrompt(restore)
    })
    row.appendChild(input)
    row.appendChild(cancel)
    row.appendChild(send)
    input.focus()
  }

}

let stylesInjected = false

function injectReviewStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-review { display: flex; flex-direction: column; font-size: var(--fl-text-ui-size); color: var(--fl-color-text); overflow-y: auto; }
    .fl-review-toolbar { display: flex; align-items: center; justify-content: space-between; padding: var(--fl-space-xs) var(--fl-space-sm); border-bottom: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-review-title { font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); letter-spacing: 0.06em; text-transform: uppercase; color: var(--fl-color-text-secondary); }
    .fl-review-refresh { border: none; background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; font-size: 13px; }
    .fl-review-refresh:hover { color: var(--fl-color-text); }
    .fl-review-empty { padding: var(--fl-space-md) var(--fl-space-sm); color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-review-group { border-bottom: var(--fl-border-width) solid var(--fl-color-border); padding-bottom: var(--fl-space-xs); }
    .fl-review-group-header { display: flex; align-items: center; gap: var(--fl-space-xs); padding: var(--fl-space-xs) var(--fl-space-sm) 2px; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); letter-spacing: 0.06em; text-transform: uppercase; }
    .fl-review-group-count { margin-left: auto; }
    .fl-review-file { display: flex; align-items: center; gap: var(--fl-space-xs); height: 24px; padding: 0 var(--fl-space-sm); }
    .fl-review-file:hover { background: var(--fl-color-surface); }
    .fl-review-inv-flag { flex: none; background: none; border: none; cursor: pointer; font-size: 10px; padding: 0 2px; color: #d29922; }
    .fl-review-inv-flag.fl-review-inv-touches { opacity: 0.75; }
    .fl-review-state { flex: none; width: 18px; text-align: center; font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); }
    .fl-review-state-modified { color: var(--fl-color-warning); }
    .fl-review-state-added { color: var(--fl-color-success); }
    .fl-review-state-deleted, .fl-review-state-conflicted { color: var(--fl-color-error); }
    .fl-review-state-renamed { color: var(--fl-color-accent); }
    .fl-review-state-untracked { color: var(--fl-color-text-secondary); }
    .fl-review-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .fl-review-file-approved .fl-review-file-name { color: var(--fl-color-success); }
    .fl-review-approve { flex: none; border: none; background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; opacity: 0.6; font-weight: var(--fl-text-ui-weight-medium); }
    .fl-review-approve:hover { color: var(--fl-color-success); opacity: 1; }
    .fl-review-approve.active { color: var(--fl-color-success); opacity: 1; }
    .fl-review-approve-blocked { opacity: 0.35; cursor: not-allowed; }
    .fl-review-file-stale .fl-review-file-name { color: var(--fl-color-warning); }
    .fl-review-approve-stale { color: var(--fl-color-warning); opacity: 1; }
    .fl-review-approve-stale:hover { color: var(--fl-color-warning); }
    .fl-review-approve-elsewhere { color: var(--fl-color-accent); opacity: 0.85; }
    .fl-review-approve-elsewhere:hover { color: var(--fl-color-success); }
    .fl-review-approve-blocked:hover { color: var(--fl-color-error); opacity: 0.7; }
    .fl-review-reject { flex: none; border: none; background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; opacity: 0.6; }
    .fl-review-reject:hover { color: var(--fl-color-error); opacity: 1; }
    .fl-review-commit-btn:disabled { opacity: 0.5; cursor: default; }
    .fl-review-commit { display: flex; gap: var(--fl-space-xs); padding: var(--fl-space-xs) var(--fl-space-sm); }
    /* #1476: the reject prompt names its target, so it wraps onto two lines —
       the sentence across the top, the input + buttons beneath it. */
    /* …and it must GROW to hold them. .fl-review-file is a fixed 24px row;
       left at that height the wrapped prompt overflowed onto the row below,
       whose file name then intercepted the clicks on Cancel/Redo.
       (No backticks in here: this block is a template literal.) */
    .fl-review-reject-prompt { flex-wrap: wrap; height: auto; row-gap: var(--fl-space-xs); padding-top: var(--fl-space-xs); padding-bottom: var(--fl-space-xs); }
    .fl-review-reject-target { flex: 1 0 100%; color: var(--fl-color-text); font-size: var(--fl-text-caption-size); }
    .fl-review-message { flex: 1; min-width: 0; padding: 3px var(--fl-space-sm); background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); color: var(--fl-color-text); font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); outline: none; }
    .fl-review-message:focus { border-color: var(--fl-color-focus-ring); }
    .fl-review-commit-btn { flex: none; border: var(--fl-border-width) solid var(--fl-color-border); background: var(--fl-color-surface-raised); color: var(--fl-color-text); cursor: pointer; padding: 3px var(--fl-space-sm); border-radius: var(--fl-radius-sm); font-size: var(--fl-text-caption-size); }
    .fl-review-commit-btn:hover { border-color: var(--fl-color-focus-ring); }
    .fl-review-generate { flex: none; display: inline-flex; align-items: center; justify-content: center; border: var(--fl-border-width) solid var(--fl-color-border); background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; padding: 3px var(--fl-space-xs); border-radius: var(--fl-radius-sm); }
    .fl-review-generate:hover:not(:disabled) { border-color: var(--fl-color-focus-ring); color: var(--fl-color-text); }
    .fl-review-generate:disabled { opacity: 0.5; cursor: default; }
    .fl-review-discard-btn { flex: none; border: var(--fl-border-width) solid var(--fl-color-border); background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; padding: 3px var(--fl-space-sm); border-radius: var(--fl-radius-sm); font-size: var(--fl-text-caption-size); }
    .fl-review-discard-btn:hover { border-color: var(--fl-color-error); color: var(--fl-color-error); }
    .fl-review-discard-btn.confirm { border-color: var(--fl-color-error); color: #fff; background: var(--fl-color-error); }
    .fl-review-discard-confirm { align-items: center; }
    .fl-review-discard-label { flex: 1; min-width: 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
  `
  document.head.appendChild(style)
}
