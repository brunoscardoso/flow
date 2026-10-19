/**
 * Git panel — read-only per-root git viewer content:
 *
 *   ┌ root section ──────────────────────────────┐
 *   │ ⑂ main  ↑1 ↓2                    3 changed │  ← branch header
 *   │ CHANGES (3)                                │
 *   │  M src/foo.ts                              │  ← fl-list, click → diff
 *   │  ?? notes.md                               │
 *   │ COMMITS                                    │
 *   │  feat: add thing      devuser · 3h         │  ← fl-list, click → commit diff
 *   └─────────────────────────────────────────────┘
 *
 * Pure view: the coordinator (src/renderer/git/index.ts) owns IPC and the
 * diff view and drives rendering through `setState(...)`; clicks call back
 * into it via the callbacks.
 * Status letters: M → warning, A → success, D → error, U (untracked) → muted,
 * R → accent, C (conflict) → error. Dense 28px fl-list rows; the lists get
 * explicit pixel heights (rows × 28, capped) so they stay virtualized inside
 * the panel's scrollable body.
 */
import '../components'
import type { FlList, ListItemDetail } from '../components'
import type {
  GitCommit,
  GitFileChange,
  GitFileState,
  GitMergeState,
  GitStatus,
  ThreadScopeEntry,
} from '../../shared/ipc-contract'
import { ensureAccentProperty } from '../project-accent'
import { showRevealMenu, type RevealMenuItem } from '../reveal-menu'
import { revealRelForRow } from './git-reveal'
import { deriveGitGroups, groupCollapseKey, groupHeaderTitle, type GitGroup } from './git-groups'
import { deriveMergeBanner, panelRenderSignature, type GitPanelState } from './git-panel-state'
import { captureMessageFocus, type MessageFocus } from '../review/message-focus'
import { assignSections } from './git-status-model'
import {
  bulkActions,
  fileActions,
  isMergeBulkAction,
  mergeBulkControl,
  mergeBulkChoice,
  mergeLegend,
  conflictRiskLabel,
  mergeSideControl,
  nextSidePress,
  selectionMenuItems,
  type SelectionAction,
  type SourceControlSection,
} from './source-control-actions'
import {
  EMPTY_SELECTION,
  gestureFor,
  nextSelection,
  reconcileSelection,
  type Selection,
} from './source-control-selection'
import type { ConflictHunkChoice } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'
import {
  COLLAPSED_SECTIONS_KEY,
  dropLegacySectionKeys,
  parseCollapsedSections,
  sectionCollapseKey,
  serializeCollapsedSections,
  toggleSection,
} from './git-section-collapse'
import {
  hasResolvableConflicts,
  deriveConflictOverview,
  fileResolutionStatusLabel,
  type FileResolutionStatus,
} from './conflict-section'
import { commitLogWindow, nextPageCursor } from './commit-log-window'
import { CONFLICT_ROW_HEIGHT, GP_STYLES, ROW_HEIGHT } from './git-panel-styles'
import { getHunkResolutions } from '../editor/merge-resolution-record'
import { resolveAllControl, type ConflictResolvePhase } from '../editor/conflict-resolve-state'
import { fileConflictRisk, type ConflictBadge } from './conflict-risk'
import { commitBoxState, shouldApplyGeneratedMessage } from './commit-box'
import {
  interleaveUntrackedChildren,
  isUntrackedDir,
  sameStringList,
  type UntrackedDisplayRow,
} from './untracked-expand'

export interface GitRootView {
  /** Absolute rootPath (=== the git domain's rootId). */
  rootPath: string
  /** null → the root is not a git repository. */
  status: GitStatus | null
  commits: GitCommit[]
  /** In-progress merge/rebase state, for the conflict banner (#335, P6). null → unknown/none. */
  mergeState?: GitMergeState | null
  /** True once git has been shown to hold nothing older than `commits` (#1438):
   *  a page came back short, or a refresh got fewer commits than it asked for.
   *  Retires the paging affordance and makes the header an exact count. */
  commitsExhausted?: boolean
}

export interface GitPanelCallbacks {
  /** Changed-file row activated → working tree vs HEAD diff. */
  onFileDiff(rootPath: string, change: GitFileChange, staged: boolean): void
  /** Commit row activated → commit vs parent diff. */
  onCommitDiff(rootPath: string, commit: GitCommit): void
  /** Stage the given files into the index (#335). */
  onStage(rootPath: string, filePaths: string[]): void
  /** Unstage the given files from the index (#335). */
  onUnstage(rootPath: string, filePaths: string[]): void
  /** Discard a file's working-tree changes (revert to HEAD / delete untracked). */
  onDiscard(rootPath: string, change: GitFileChange): void
  /** Revert ALL working-tree changes in the section (one confirm, then each). */
  onDiscardAll(rootPath: string, changes: GitFileChange[]): void
  /** Commit the staged index with `message`; resolves true on success (#335). */
  onCommit(rootPath: string, message: string): Promise<boolean>
  /** Generate a commit message over the staged files (AI ✨); null if unavailable. */
  onGenerateMessage(rootPath: string, filePaths: string[]): Promise<string | null>
  /** Start the Resolve-with-AI flow for the open projects' merge conflicts (#335, P6). */
  onResolveConflict(): void
  /** Interrupt the in-flight Resolve-with-AI turn (#1134). */
  onStopResolveConflict(): void
  /** Fetch the page of commits older than `cursor` (#1335). */
  onLoadOlderCommits(rootPath: string, cursor: string): void
  /** Re-run the failed status load — the error state's way out (the file
   *  tree's #1464 pattern: same condition, same answer). */
  onRetryLoad(): void
  /** Read a conflicted file's marker-laden content for structural risk badging
   *  (#335, P6). Resolves to the markered text, or null on error/oversize. */
  onConflictContent(rootPath: string, filePath: string): Promise<string | null>
  /** Take one whole side of a conflict (ours/theirs) → `git add` it (#335, P6). */
  onResolveSide(rootPath: string, filePath: string, side: 'ours' | 'theirs'): void
  /** Show what that side's version of the file looks like, WITHOUT resolving.
   *  The first press of a side button previews; the second resolves. */
  onPreviewSide?(rootPath: string, filePath: string, side: 'ours' | 'theirs'): void
  /** Keep-all bulk conflict resolution over a set of files (Phase 5, Task 3):
   *  splice EVERY hunk in each file with `choice` (mine / incoming / both). */
  /** `actionLabel` is the button's identity-labelled text (e.g. "Keep all
   *  from main") — the coordinator's confirm names the action with it. */
  onKeepAll(
    rootPath: string,
    filePaths: string[],
    choice: ConflictHunkChoice,
    actionLabel: string,
  ): void
  /** Open the Monaco 3-way merge editor for a conflicted file (#335, P5). */
  onOpenMergeEditor(rootPath: string, filePath: string): void
  /** Finalize the in-progress merge/rebase with the prepared message (#335, P6). */
  onCompleteMerge(rootPath: string, message: string): void
  /** Abort the in-progress merge/rebase (#335, P6). */
  onAbortMerge(rootPath: string): void
  /** Local branch names (current excluded) for the "Merge branch…" picker (#66, P9). */
  onListBranches(rootPath: string): Promise<string[]>
  /** Merge `ref` into the current branch (#66, P9). A conflict outcome is not an
   *  error — it lands in the normal conflicted state for the existing resolver. */
  onMergeBranch(rootPath: string, ref: string): void
  /** Pull the current branch's tracked upstream (#66, P9). Same conflict-as-
   *  outcome contract as onMergeBranch. */
  onPull(rootPath: string): void
  /**
   * An extra block this repo group carries, or null.
   *
   * Nothing supplies one since the thread-landing block was removed
   * (2026-09-04); the seam stays because the panel's group renderer is the
   * right place for a per-repository block and re-deriving it later is worse
   * than an unused parameter now.
   *
   * The panel does not own it and does not build it: `ThreadLandingControls`
   * mints one persistent element per repository the thread has a worktree in,
   * and this asks for the one belonging to `rootPath`. Absent → the panel is
   * running without a landing controller (it is optional, and the git panel is
   * constructed in contexts that have none).
   */
  landingBlockFor?(rootPath: string): HTMLElement | null
  /** A branch was renamed — re-read this root (and anything scoped to it). */
  onBranchRenamed?(rootPath: string): void
  /** Say something to the person. Optional: the panel is constructed in
   *  contexts with no toaster, and a rename there still happens. */
  onNotify?(toast: { title: string; body: string; level: 'info' | 'error' }): void
}

/**
 * FLOOR row counts, not caps (#1184). These used to be hard maximums: a
 * 40-file changeset showed 8 rows in a 224px peephole while ~370px of panel sat
 * empty below it, and since macOS overlay scrollbars are invisible at rest the
 * list simply looked like it held 8 files. The lists now grow into whatever
 * height the panel actually has, never showing FEWER rows than these.
 */
const MIN_VISIBLE_CHANGE_ROWS = 8
const MIN_VISIBLE_COMMIT_ROWS = 10
/** Height left for the panel's own chrome (branch header, section headers,
 *  commit box) when dividing the remaining space between lists. Deliberately
 *  generous: over-reserving costs a row, under-reserving costs a scrollbar on
 *  the panel itself. */
const PANEL_CHROME_ALLOWANCE_PX = 260

/** Single-letter status badge per state — VS Code SCM style ('U' untracked,
 *  'C' conflict) rather than raw porcelain codes like '??' (#581). */
const STATE_LETTERS: Record<GitFileState, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
}

/** Accessible name per state — the colored letter alone says nothing a
 *  screen reader can repeat, and M/A/D/U/R/C is jargon even sighted. */
const STATE_NAMES: Record<GitFileState, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  conflicted: 'Conflicted',
}

/** Human section names for list aria-labels. */
const SECTION_NAMES: Record<SourceControlSection, string> = {
  merge: 'Merge changes',
  staged: 'Staged changes',
  changes: 'Changes',
}

/** CSS class (→ Stark token color) per contract state. */
const STATE_CLASSES: Record<GitFileState, string> = {
  modified: 'gp-state-modified',
  added: 'gp-state-added',
  deleted: 'gp-state-deleted',
  renamed: 'gp-state-renamed',
  untracked: 'gp-state-untracked',
  conflicted: 'gp-state-conflicted',
}

export class GitPanel {
  #container: HTMLElement
  #callbacks: GitPanelCallbacks
  /** Per-root commit-message draft, so a typed message survives the full
   *  re-render an index-watch refresh triggers after staging (#335). */
  #commitDrafts = new Map<string, string>()
  /** Roots whose commit is in flight. Held on the panel, not the button: a
   *  background refresh rebuilds the box mid-commit (#1093), and a busy state
   *  kept on the old node would vanish with it. */
  #committing = new Set<string>()
  /** In-flight ✨ generations per root (#1020). Held on the PANEL, not the
   *  render closure, so a mid-flight rebuild keeps the wand busy and the
   *  result can address the live draft instead of a detached textarea. `seq`
   *  drops a result superseded by a newer click; `draftAtClick` detects the
   *  user typing in between (their words always win). */
  #generating = new Map<string, { seq: number; draftAtClick: string }>()
  /** Monotonic generation counter for #generating's supersede check (#1020). */
  #generateSeq = 0
  /** Snapshot of the last setState call, so a purely-local UI toggle (the
   *  branch picker) can re-render without waiting on the next IPC-driven
   *  refresh from the coordinator (#66, P9). */
  #lastState: GitPanelState | null = null
  /** Expanded rolled-up untracked dirs (key: `<rootPath>\0<dirPath>`), so their
   *  individual files show as child rows (#615). */
  #expandedUntrackedDirs = new Set<string>()
  /** Fetched untracked children per expanded dir (same key) — undefined while the
   *  ls-files fetch is in flight. */
  #untrackedChildren = new Map<string, string[]>()
  /** Risk verdicts (or the shared in-flight read) per `root\0file` — see
   *  #renderRiskBadge. Cleared on external refresh, like the paging flags. */
  #riskVerdicts = new Map<string, ConflictBadge | Promise<ConflictBadge>>()
  /** Collapsed Source Control sections (Staged/Changes/Merge/Commits), restored
   *  from localStorage so the fold state survives re-renders AND restart (#693).
   *  Repo-group folds (Phase 4) share the store under `root:<rootPath>` keys. */
  /** The one checkout whose branch field is open, or null. Survives a rebuild
   *  so a repaint mid-edit does not drop what someone was typing. */
  #renamingRoot: string | null = null
  #collapsedSections: Set<string>
  /** The thread-scope entries backing the current render (Phase 4) — names,
   *  primary flag, availability for the repo-group headers. Null → legacy
   *  active-root binding (groups fall back to path-segment names). */
  #scope: ThreadScopeEntry[] | null = null
  /** Where the Resolve-with-AI run is, for the merge section's control (#1134). */
  #resolvePhase: ConflictResolvePhase = 'idle'
  /** #1335: roots with an older-commits page in flight. PER ROOT — a single
   *  boolean rendered repo B's button as "Loading…" while repo A paged. */
  #loadingOlderCommits = new Set<string>()
  /** Unique-id source for commit-hint aria-describedby pairing. */
  #commitHintSeq = 0
  /** Signature of the last rendered state (#1094) — an externally-driven
   *  setState whose signature matches is a no-op refresh and skips the rebuild
   *  (scroll/selection/focus untouched). Null until the first render. */
  #lastSignature: string | null = null
  /** Multi-select staging selection, per `rootPath\x00section` (#SCMS). Held on
   *  the panel so it survives the wholesale rebuild each git refresh triggers
   *  (mirroring the #1094 scroll/selection preservation), and reconciled against
   *  the live file set on every section render so vanished files drop out (FR-10).
   *  Keyed by section because a file can be both staged and edited; merge rows and
   *  rolled-up untracked dir rows never enter it (FR-11). */
  #selections = new Map<string, Selection>()

  /** The selection map key for a section within a root. */
  #selectionKey(rootPath: string, section: SourceControlSection): string {
    return `${rootPath}\x00${section}`
  }

  /** The current selection for a section (empty when none). */
  #selectionFor(rootPath: string, section: SourceControlSection): Selection {
    return this.#selections.get(this.#selectionKey(rootPath, section)) ?? EMPTY_SELECTION
  }

  /** Store a section's selection, pruning the key when it empties. */
  #setSelection(rootPath: string, section: SourceControlSection, next: Selection): void {
    const key = this.#selectionKey(rootPath, section)
    if (next.selected.size === 0) this.#selections.delete(key)
    else this.#selections.set(key, next)
  }

  /** Path → change for each rendered section (#SCMS), so a selection-scoped action
   *  can resolve its paths to the GitFileChange records discard needs. Rebuilt per
   *  render (cleared in #renderRoots); includes expanded untracked child rows. */
  #sectionChanges = new Map<string, Map<string, GitFileChange>>()

  /** The selected paths for a section, in no particular order. */
  #selectedPathsFor(rootPath: string, section: SourceControlSection): string[] {
    return [...this.#selectionFor(rootPath, section).selected]
  }

  /** The selected rows' change records for a section (for discard). */
  #selectedChangesFor(rootPath: string, section: SourceControlSection): GitFileChange[] {
    const byPath = this.#sectionChanges.get(this.#selectionKey(rootPath, section))
    if (byPath === undefined) return []
    const result: GitFileChange[] = []
    for (const path of this.#selectionFor(rootPath, section).selected) {
      const change = byPath.get(path)
      if (change !== undefined) result.push(change)
    }
    return result
  }

  /** Apply a selection-scoped action (#SCMS) to the section's current selection.
   *  Stage/Unstage route through the already-array-ready callbacks; Discard reuses
   *  onDiscardAll (confirm-once + lock-safe sequential discard) over the selected
   *  subset — the one multi-file-discard code path. */
  #runSelectionAction(rootPath: string, section: SourceControlSection, action: SelectionAction): void {
    const paths = this.#selectedPathsFor(rootPath, section)
    if (paths.length === 0) return
    if (action === 'stage-selected') this.#callbacks.onStage(rootPath, paths)
    else if (action === 'unstage-selected') this.#callbacks.onUnstage(rootPath, paths)
    else this.#callbacks.onDiscardAll(rootPath, this.#selectedChangesFor(rootPath, section))
  }

  constructor(container: HTMLElement, callbacks: GitPanelCallbacks) {
    this.#container = container
    this.#callbacks = callbacks
    // #1143: pre-namespace folds ('changes', 'commits') can't say which repo
    // they belonged to, so they're dropped rather than applied to every repo.
    this.#collapsedSections = dropLegacySectionKeys(
      parseCollapsedSections(safeReadStorage(COLLAPSED_SECTIONS_KEY)),
    )
    injectGitPanelStyles()
    this.#container.classList.add('gp-root')
    // #1184: the lists size themselves from the panel's height, so a resize has
    // to repaint them — otherwise dragging the sidebar wider/taller leaves the
    // same peephole it had before. Debounced to a frame: a drag fires this
    // continuously, and setState rebuilds the whole panel.
    if (typeof ResizeObserver !== 'undefined') {
      let frame: number | null = null
      this.#resizeObserver = new ResizeObserver(() => {
        if (frame !== null) return
        frame = requestAnimationFrame(() => {
          frame = null
          const rows = this.#visibleChangeRows()
          // Only repaint when the row budget actually changed — a 1px drag must
          // not rebuild the DOM under the user's cursor.
          if (rows !== this.#lastRowBudget) {
            this.#lastRowBudget = rows
            this.#rerender()
          }
        })
      })
      this.#resizeObserver.observe(this.#container)
    }
    this.renderNoProject()
  }

  /** Repaints the lists when the panel's height changes the row budget (#1184). */
  #resizeObserver: ResizeObserver | null = null
  #lastRowBudget = 0

  /**
   * How many rows the Changes/Commits lists may show (#1184).
   *
   * The panel's own height decides, with the MIN_ constants as floors — so a
   * tall panel fills, a short one behaves exactly as before, and an unmeasurable
   * container (detached, hidden, zero-height during boot) falls back to the old
   * fixed behaviour rather than collapsing to nothing.
   *
   * Commits get the smaller share: on a dirty tree the changes are what the user
   * came for, and the commit log is reference.
   */
  #availableListHeight(): number {
    const panelHeight = this.#container.clientHeight
    if (!Number.isFinite(panelHeight) || panelHeight <= 0) return 0
    return Math.max(0, panelHeight - PANEL_CHROME_ALLOWANCE_PX)
  }

  /** How many change rows fit in the changes half — in rows of `rowHeight`, so a
   *  taller conflict row costs the pane the same space, not 1.8× of it. */
  #visibleChangeRows(rowHeight: number = ROW_HEIGHT): number {
    const rows = Math.floor((this.#availableListHeight() * 0.6) / rowHeight)
    return Math.max(MIN_VISIBLE_CHANGE_ROWS, rows)
  }

  #visibleCommitRows(): number {
    const rows = Math.floor((this.#availableListHeight() * 0.4) / ROW_HEIGHT)
    return Math.max(MIN_VISIBLE_COMMIT_ROWS, rows)
  }

  /** Fold/unfold a Source Control section, persist the change, and re-render. */
  #toggleSection(key: string): void {
    this.#collapsedSections = toggleSection(this.#collapsedSections, key)
    safeWriteStorage(COLLAPSED_SECTIONS_KEY, serializeCollapsedSections(this.#collapsedSections))
    this.#rerender()
  }

  /**
   * A collapsible section header (#693): a chevron + label in a left cluster the
   * user clicks to fold/unfold, keeping the count visible when collapsed. Callers
   * append their right-aligned actions to `.head` and skip the body when
   * `collapsed`. Keyboard-operable (Enter/Space) for the header itself.
   */
  #sectionHeader(
    key: string,
    labelText: string,
  ): { head: HTMLElement; collapsed: boolean } {
    const collapsed = this.#collapsedSections.has(key)
    const head = document.createElement('div')
    head.className = 'gp-subheader gp-section-head'
    head.classList.toggle('gp-collapsed', collapsed)
    const trigger = document.createElement('div')
    trigger.className = 'gp-section-toggle'
    trigger.setAttribute('role', 'button')
    trigger.tabIndex = 0
    trigger.setAttribute('aria-expanded', String(!collapsed))
    trigger.title = collapsed ? 'Expand section' : 'Collapse section'
    const chevron = iconEl(collapsed ? 'chevron-right' : 'chevron-down', 12)
    chevron.classList.add('gp-section-chevron')
    const label = document.createElement('span')
    label.textContent = labelText
    trigger.append(chevron, label)
    const toggle = (): void => this.#toggleSection(key)
    trigger.addEventListener('click', toggle)
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })
    head.appendChild(trigger)
    return { head, collapsed }
  }

  /**
   * Render the panel from a resolved state. The active-root scoping distinguishes
   * loading and error from a genuinely-empty project list, so a refresh in flight or
   * a failed refresh no longer shows the misleading "No project roots" (#289).
   */
  setState(state: GitPanelState): void {
    this.#lastState = state
    // #1438: fresh state from the coordinator ANSWERS an in-flight "load older"
    // request, so it clears the busy flag. This used to live in setRoots(),
    // which nothing in production calls — the coordinator's render() comes
    // through here — so the flag latched true and the button spent the rest of
    // the panel's life disabled at "Loading…". Invariants belong in the path
    // everyone takes. Cleared BEFORE the unchanged short-circuit below: a page
    // that comes back empty leaves the render inputs identical, and that is
    // exactly the case that must not stay stuck. A self-triggered #rerender
    // (a local fold/toggle) is not an answer to anything, so it doesn't clear.
    if (!this.#rerendering) this.#loadingOlderCommits.clear()
    // Same rule for the risk verdicts: an external refresh means the conflicted
    // files may have changed on disk, so the cached triage no longer holds. A
    // self-triggered rerender (fold, picker, filter) changes no content and
    // keeps the cache — that churn is exactly what the cache exists for.
    if (!this.#rerendering) this.#riskVerdicts.clear()
    // #1094: a refresh that resolves to the exact same render inputs is a no-op
    // — skip the DOM rebuild entirely so a background write that leaves `git
    // status` byte-identical can't yank the user's scroll/selection/focus.
    // Local UI toggles re-render through #rerender, which bypasses this check.
    const signature = panelRenderSignature(state, this.#scope)
    const unchanged = !this.#rerendering && signature === this.#lastSignature
    this.#lastSignature = signature
    switch (state.kind) {
      case 'roots':
        if (unchanged) {
          // Still re-fetch expanded untracked folders' children (#647) — their
          // contents can change without moving the status payload.
          this.#refreshExpandedUntrackedDirs(state.views)
          return
        }
        this.#renderRoots(state.views)
        // An EXTERNAL git refresh (not a self-triggered #rerender) may have
        // changed an expanded untracked folder's contents — re-fetch its
        // children + prune folders no longer untracked, so new files surface and
        // a stale/blank list is corrected (#647). Guarded so the refetch's own
        // re-render can't loop.
        if (!this.#rerendering) {
          this.#refreshExpandedUntrackedDirs(state.views)
          // Real git movement invalidates a pending choice: the file it was
          // armed for may already be resolved, or be a different conflict now.
          this.#armedSide.clear()
        }
        return
      case 'loading':
        this.renderEmpty('Loading git status…')
        return
      case 'error':
        this.renderEmpty("Couldn't load git status", 'error')
        return
      case 'empty':
        this.renderNoProject()
        return
    }
  }

  /** Re-render the whole panel from fresh per-root data. */
  setRoots(views: GitRootView[]): void {
    // The busy-flag reset lives in setState (#1438) — every render lands there.
    this.setState(views.length === 0 ? { kind: 'empty' } : { kind: 'roots', views })
  }

  /** Provide the thread-scope entries the next renders should group by
   *  (Phase 4). Does not render — the coordinator always follows with
   *  setState; #rerender reuses the stored scope automatically. */
  setScope(scope: ThreadScopeEntry[] | null): void {
    this.#scope = scope
  }

  /**
   * A landing block appeared or went away — lay the groups out again so it is
   * attached to (or gone from) the right one (landing-per-project).
   *
   * NOT a status read and NOT a data change: the panel's own inputs are
   * untouched, which is why this goes through `#rerender` (whose `#rerendering`
   * flag is what gets it past the identical-signature short-circuit) rather
   * than pretending git moved. Called ONLY when the SET of blocks changes — a
   * block updating its own contents never reaches here.
   */
  refreshLandingBlocks(): void {
    this.#rerender()
  }

  /** Move the Resolve-with-AI control between action / spinner+Stop (#1134).
   *  Re-renders itself: the phase arrives from the orchestration's own event,
   *  not from a status refresh, so nothing else will. */
  setResolvePhase(phase: ConflictResolvePhase): void {
    if (this.#resolvePhase === phase) return
    this.#resolvePhase = phase
    this.#rerender()
  }

  #renderRoots(views: GitRootView[]): void {
    // #SCMS: drop any multi-selection whose root is no longer on screen — a
    // project switch clears the selection (FR-10). Per-section reconcile (in
    // #renderFileSection) handles files vanishing WITHIN a still-present root;
    // this handles the root itself going away, whose sections never re-render.
    if (this.#selections.size > 0) {
      const liveRoots = new Set(views.map((view) => view.rootPath))
      for (const key of [...this.#selections.keys()]) {
        const root = key.slice(0, key.indexOf('\x00'))
        if (!liveRoots.has(root)) this.#selections.delete(key)
      }
    }
    // #SCMS: the path→change lookup is rebuilt from this render's rows.
    this.#sectionChanges.clear()
    // #1093: the rebuild destroys the focused commit textarea mid-typing —
    // capture which one is focused (+ caret) and restore it on the recreated
    // element, the same #282 pattern the Review panel uses.
    const focus = this.#captureCommitFocus()
    // #1094: the rebuild recreates every fl-list at scrollTop 0 with no
    // selection — capture each list's scroll offset + keyboard selection keyed
    // by its stable list key, and reapply after.
    const listState = this.#captureListState()
    this.#container.textContent = ''
    for (const group of deriveGitGroups(views, this.#scope)) {
      this.#container.appendChild(this.#renderGroup(group))
    }
    this.#restoreListState(listState)
    this.#restoreCommitFocus(focus)
  }

  /** Snapshot the focused commit-box textarea's root key + caret before a
   *  rebuild (#1093) — null when focus is elsewhere. */
  #captureCommitFocus(): MessageFocus | null {
    const active = document.activeElement
    if (!(active instanceof HTMLTextAreaElement)) return null
    return captureMessageFocus(
      active.dataset['msgKey'],
      this.#container.contains(active),
      active.selectionStart,
      active.selectionEnd,
    )
  }

  /** Re-focus the recreated commit textarea and restore its caret (#1093). */
  #restoreCommitFocus(focus: MessageFocus | null): void {
    if (!focus) return
    for (const el of this.#container.querySelectorAll('textarea[data-msg-key]')) {
      if (el instanceof HTMLTextAreaElement && el.dataset['msgKey'] === focus.key) {
        el.focus()
        try {
          el.setSelectionRange(focus.start, focus.end)
        } catch {
          // Selection restore is best-effort — focus alone already saves the typing.
        }
        return
      }
    }
  }

  /** Capture every keyed list's scroll offset + keyboard selection (#1094). */
  #captureListState(): Map<string, { scrollTop: number; selectedIndex: number }> {
    const state = new Map<string, { scrollTop: number; selectedIndex: number }>()
    for (const el of this.#container.querySelectorAll('fl-list[data-list-key]')) {
      const list = el as FlList
      const key = list.getAttribute('data-list-key')
      if (key === null) continue
      const scroller = list.shadowRoot?.querySelector('.scroller')
      state.set(key, {
        scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0,
        selectedIndex: list.selectedIndex,
      })
    }
    return state
  }

  /** Reapply captured list state to the recreated lists (#1094). The scroll
   *  offset is reapplied on the next frame too: fl-list sizes its spacer in a
   *  rAF, so a synchronous set can clamp to 0 before the content has height. */
  #restoreListState(state: Map<string, { scrollTop: number; selectedIndex: number }>): void {
    if (state.size === 0) return
    for (const el of this.#container.querySelectorAll('fl-list[data-list-key]')) {
      const list = el as FlList
      const saved = state.get(list.getAttribute('data-list-key') ?? '')
      if (!saved) continue
      if (saved.selectedIndex >= 0) list.selectedIndex = saved.selectedIndex
      const scroller = list.shadowRoot?.querySelector('.scroller')
      if (!(scroller instanceof HTMLElement) || saved.scrollTop <= 0) continue
      scroller.scrollTop = saved.scrollTop
      requestAnimationFrame(() => {
        scroller.scrollTop = saved.scrollTop
      })
    }
  }

  /**
   * One repo group (Phase 4): a collapsible header — 3px left accent border +
   * project name (unavailable tag per #263) + current branch + ahead/behind —
   * above the root's full Source Control section. A null header (single-root
   * scope) renders the section chromeless, byte-identical to the pre-scope
   * panel.
   */
  #renderGroup(group: GitGroup): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'gp-group'
    // THE THREAD'S LANDING, IN THE GROUP IT ACTS ON (landing-per-project). Null
    // for every group that is not a thread worktree — which is what the panel
    // was failing to say when this lived in one bar above all of them.
    const landing = this.#callbacks.landingBlockFor?.(group.view.rootPath) ?? null
    if (!group.header) {
      if (landing !== null) wrap.appendChild(landing)
      wrap.appendChild(this.#renderSection(group.view))
      return wrap
    }
    // A BAND, not a run-on. Only with headers — a single-repo panel keeps the
    // chrome-free rendering it has always had, and a lone group needs no
    // separator from a group that is not there.
    wrap.classList.add('gp-group-boxed')

    const header = group.header
    const key = groupCollapseKey(header.rootPath)
    const collapsed = this.#collapsedSections.has(key)
    const head = document.createElement('div')
    head.className = 'gp-group-head'
    head.classList.toggle('gp-collapsed', collapsed)
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    head.setAttribute('aria-expanded', String(!collapsed))
    // What the group IS, in a person's words — never where it sits on disk
    // (forbidden-pattern #12). One code path for both roles: git-groups.ts.
    head.title = groupHeaderTitle(header)

    const chevron = iconEl(collapsed ? 'chevron-right' : 'chevron-down', 12)
    chevron.classList.add('gp-section-chevron')
    head.appendChild(chevron)

    // Project accent — a clean 3px left border on the head (user call
    // 2026-07-28: no circles), same grammar as the tree's section headers.
    // Override-aware: the scope entry's user-picked accent wins over the
    // hash. Primary and secondary roots carry the SAME border; the primary
    // is marked by the head tooltip below.
    const accentRef = ensureAccentProperty(header.rootPath, header.accent ?? null)
    head.style.borderLeftColor = accentRef

    const name = document.createElement('span')
    name.className = 'gp-group-name'
    name.textContent = header.name
    head.appendChild(name)

    // No 'main' TEXT tag — beside a real branch label it reads as the main
    // BRANCH (user call 2026-07-28, same ambiguity as the tree header). The
    // primary is marked by the head tooltip alone (the accent border is the
    // same on every root), which `groupHeaderTitle` set above.
    if (!header.available) {
      const tag = document.createElement('span')
      tag.className = 'gp-group-tag gp-group-unavailable'
      tag.textContent = 'unavailable'
      head.appendChild(tag)
    }

    // ONE BRANCH NAME PER GROUP. This printed the branch one line above the
    // section's own branch line, which prints the same value read the same way
    // — `feat/data-contract-guard-fe` twice, adjacent, for every group on
    // screen. The header keeps it only while the group is FOLDED, where the
    // section below is not there to say it and a summary is the whole point.
    if (header.branch && collapsed) {
      const branchIcon = iconEl('git-branch', 12)
      branchIcon.classList.add('gp-group-branch-icon')
      head.appendChild(branchIcon)
      const branch = document.createElement('span')
      branch.className = 'gp-group-branch'
      branch.textContent = header.branch
      branch.title = header.branch
      head.appendChild(branch)
    }
    if (header.aheadBehind && collapsed) {
      const aheadBehind = document.createElement('span')
      aheadBehind.className = 'gp-ahead-behind'
      aheadBehind.textContent = header.aheadBehind
      head.appendChild(aheadBehind)
    }

    const toggle = (): void => this.#toggleSection(key)
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    wrap.appendChild(head)
    if (!collapsed) {
      // Under this project's own header, above this project's own changes.
      if (landing !== null) wrap.appendChild(landing)
      wrap.appendChild(this.#renderSection(group.view))
    }
    return wrap
  }

  /**
   * Which side, if any, is one press away from being applied — keyed by
   * `<root>\0<file>`. Cleared when it fires, when the other side is armed, and
   * whenever git state changes underneath (a resolved file must not keep a
   * loaded trigger).
   */
  #armedSide = new Map<string, 'ours' | 'theirs'>()

  /** True while a self-triggered #rerender is in flight — suppresses the
   *  untracked-children refetch so it only fires on an external git refresh. */
  #rerendering = false

  /** Re-render from the last state — used by purely-local UI toggles (branch
   *  picker, expanded untracked dirs) without waiting on the next IPC refresh. */
  #rerender(): void {
    if (this.#lastState === null) return
    this.#rerendering = true
    try {
      this.setState(this.#lastState)
    } finally {
      this.#rerendering = false
    }
  }

  /** Stable per-(root, dir) key for the expand set + children cache (#615). */
  #dirKey(rootPath: string, dirPath: string): string {
    return `${rootPath}\x00${dirPath}`
  }

  /**
   * Toggle a rolled-up untracked directory row open/closed (#615). Expanding
   * fetches its untracked files (git:listUntrackedDir) and caches them; the
   * re-render interleaves them as child rows. The cache is refreshed on every
   * git-status refresh (#refreshExpandedUntrackedDirs), so files added after the
   * first expand still surface (#647). A fetch error does NOT cache an empty list
   * — it leaves the entry unset so a later expand/refresh retries.
   */
  #toggleUntrackedDir(rootPath: string, dirPath: string): void {
    const key = this.#dirKey(rootPath, dirPath)
    if (this.#expandedUntrackedDirs.has(key)) {
      this.#expandedUntrackedDirs.delete(key)
      this.#rerender()
      return
    }
    this.#expandedUntrackedDirs.add(key)
    if (!this.#untrackedChildren.has(key)) this.#fetchUntrackedChildren(rootPath, dirPath, key)
    this.#rerender()
  }

  /** Fetch (or re-fetch) a dir's untracked children into the cache and re-render
   *  on change. A fetch error DELETES the key (never caches `[]`) so the folder
   *  isn't permanently blanked by a transient failure (#647). */
  #fetchUntrackedChildren(rootPath: string, dirPath: string, key: string): void {
    void window.flow.git
      .listUntrackedDir({ rootId: rootPath, dirPath })
      .then((result) => {
        if (!this.#expandedUntrackedDirs.has(key)) return
        const prev = this.#untrackedChildren.get(key)
        if (prev !== undefined && sameStringList(prev, result.files)) return
        this.#untrackedChildren.set(key, result.files)
        this.#rerender()
      })
      .catch((error: unknown) => {
        console.warn('flow: failed to list untracked dir', { rootPath, dirPath, error })
        this.#untrackedChildren.delete(key) // retry on the next expand / refresh
      })
  }

  /**
   * Refresh the children of currently-expanded untracked folders on each git
   * refresh (#647), and prune expand/cache state for dirs that are no longer a
   * rolled-up untracked row (staged/committed/deleted). Called only from
   * setRoots (the git-refresh entry) — never from #rerender — so it can't loop.
   */
  #refreshExpandedUntrackedDirs(views: GitRootView[]): void {
    const live = new Set<string>()
    for (const view of views) {
      for (const change of view.status?.changes ?? []) {
        if (!isUntrackedDir(change)) continue
        const key = this.#dirKey(view.rootPath, change.filePath)
        if (!this.#expandedUntrackedDirs.has(key)) continue
        live.add(key)
        this.#fetchUntrackedChildren(view.rootPath, change.filePath, key)
      }
    }
    for (const key of [...this.#expandedUntrackedDirs]) {
      if (live.has(key)) continue
      this.#expandedUntrackedDirs.delete(key)
      this.#untrackedChildren.delete(key)
    }
  }

  dispose(): void {
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = null
    this.#container.textContent = ''
    this.#container.classList.remove('gp-root')
    this.#lastSignature = null // the DOM is gone — a same-signature setState must rebuild
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private renderEmpty(message: string, variant: 'muted' | 'error' = 'muted'): void {
    this.#container.textContent = ''
    const empty = document.createElement('div')
    empty.className = variant === 'error' ? 'gp-empty gp-error' : 'gp-empty'
    empty.textContent = message
    // An error that offers nothing to click is a dead end — same condition as
    // the file tree's #1464, same answer: a Try again that re-runs the load.
    if (variant === 'error') {
      const retry = document.createElement('fl-button')
      retry.setAttribute('variant', 'default')
      retry.setAttribute('small', '')
      const text = document.createElement('span')
      text.textContent = 'Try again'
      retry.appendChild(text)
      retry.addEventListener('click', () => this.#callbacks.onRetryLoad())
      empty.appendChild(retry)
    }
    this.#container.appendChild(empty)
  }

  /**
   * #1359: the no-project state, in the app's own words and with a way out.
   *
   * It read "No project roots" — internal jargon naming a concept the UI
   * never uses ("project root" appears nowhere a user can see) — and offered
   * nothing to click, while the Files pane beside it says "No project open"
   * with an Open Folder… button and Threads says "Open a project to start".
   * Three panes, one condition, three different answers, and the one that both
   * named it wrongly and dead-ended.
   */
  private renderNoProject(): void {
    this.#container.textContent = ''
    const empty = document.createElement('div')
    empty.className = 'gp-empty gp-no-project'
    const label = document.createElement('span')
    label.textContent = 'No project open'
    const openButton = document.createElement('fl-button')
    openButton.setAttribute('variant', 'default')
    openButton.setAttribute('small', '')
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'folder')
    icon.setAttribute('size', '13')
    const text = document.createElement('span')
    text.textContent = 'Open Folder…'
    openButton.append(icon, text)
    openButton.addEventListener('click', () => {
      void window.flow.project.open().catch((error: unknown) => {
        console.error('flow: failed to open project', error)
      })
    })
    empty.append(label, openButton)
    this.#container.appendChild(empty)
  }

  #renderSection(view: GitRootView): HTMLElement {
    const section = document.createElement('div')
    section.className = 'gp-section'

    if (!view.status) {
      const noRepo = document.createElement('div')
      noRepo.className = 'gp-empty'
      noRepo.textContent = 'Not a git repository'
      section.appendChild(noRepo)
      return section
    }

    section.appendChild(this.#renderBranchHeader(view.status, view.rootPath))

    // ── Merge/rebase in-progress banner (#335, P6) ─────────────────────────
    const banner = this.#renderMergeBanner(view.rootPath, view.mergeState)
    if (banner) section.appendChild(banner)

    // NO Merge branch… / Pull row. It sat between the branch line and the
    // commit box — two buttons for operations nobody reaches for mid-review,
    // in the space the panel wants for what actually changed. Removed on the
    // user's call (2026-09-04). The merge/rebase BANNER above stays: that one
    // appears only when a merge is already in progress and is how you finish
    // it.

    // ── Changed files, split into Merge / Staged / Changes (#335) ──────────
    const { merge, staged, changes } = assignSections(view.status.changes)

    // Commit box at the top (VS Code layout): message + Commit + AI ✨ (#335).
    section.appendChild(this.#renderCommitBox(view.rootPath, staged))

    if (merge.length === 0 && staged.length === 0 && changes.length === 0) {
      const clean = document.createElement('div')
      clean.className = 'gp-empty'
      clean.textContent = 'Working tree clean'
      section.appendChild(clean)
    } else {
      // Order matches VS Code: conflicts first, then staged, then the rest.
      // Merge keep-all labels come from branch names, not per-file identity: one
      // op ⇒ both branches are known from the status + merge state.
      this.#renderFileSection(
        section,
        view.rootPath,
        'merge',
        'Merge Changes',
        merge,
        this.#mergeSideIdentity(view),
      )
      this.#renderFileSection(section, view.rootPath, 'staged', 'Staged Changes', staged)
      this.#renderFileSection(section, view.rootPath, 'changes', 'Changes', changes)
    }

    // ── Commit log ───────────────────────────────────────────────────────
    // #1143: keyed per REPO — a bare 'commits' key folded every group at once.
    // #1335: the header printed a capped PAGE SIZE in the same grammar as
    // `Changes (N)` / `Staged Changes (N)`, which are exact — so it read as a
    // fact about the repo, and every repo over 100 commits said COMMITS (100)
    // forever with no route to anything older.
    const logWindow = commitLogWindow(
      view.commits.length,
      undefined,
      view.commitsExhausted === true,
    )
    const commitsSection = this.#sectionHeader(
      sectionCollapseKey(view.rootPath, 'commits'),
      logWindow.label,
    )
    section.appendChild(commitsSection.head)
    if (!commitsSection.collapsed) {
      if (view.commits.length === 0) {
        const none = document.createElement('div')
        none.className = 'gp-empty'
        none.textContent = 'No commits'
        section.appendChild(none)
      } else {
        const list = createList<GitCommit>(
          view.commits,
          this.#visibleCommitRows(),
          (commit) => this.#renderCommitRow(commit),
          `Commits, ${view.commits.length}`,
        )
        // Stable key so scroll/selection survive the full rebuild (#1094).
        list.setAttribute('data-list-key', `${view.rootPath}\x00commits`)
        list.addEventListener('fl-list-activate', (event) => {
          const detail = (event as CustomEvent<ListItemDetail<GitCommit>>).detail
          this.#callbacks.onCommitDiff(view.rootPath, detail.item)
        })
        section.appendChild(list)
        // #1335: the route to older history. `GitManager.log` has always taken
        // a `before` cursor; nothing ever asked for the next page.
        if (logWindow.canLoadOlder) {
          const older = document.createElement('button')
          older.type = 'button'
          older.className = 'gp-load-older'
          const loadingThis = this.#loadingOlderCommits.has(view.rootPath)
          older.textContent = loadingThis ? 'Loading…' : 'Load older commits'
          older.disabled = loadingThis
          older.addEventListener('click', (event) => {
            event.stopPropagation()
            const cursor = nextPageCursor(view.commits)
            if (cursor === null || this.#loadingOlderCommits.has(view.rootPath)) return
            this.#loadingOlderCommits.add(view.rootPath)
            older.textContent = 'Loading…'
            older.disabled = true
            this.#callbacks.onLoadOlderCommits(view.rootPath, cursor)
          })
          section.appendChild(older)
        }
      }
    }

    return section
  }

  /** One file section (Merge / Staged / Changes) — a subheader with a count + an
   *  optional bulk Stage all / Unstage all, then the file rows (#335). Skipped
   *  when empty so clean sections don't clutter the panel. */
  #renderFileSection(
    parent: HTMLElement,
    rootPath: string,
    section: SourceControlSection,
    title: string,
    files: GitFileChange[],
    mergeIdentity?: { ours?: SideIdentity; theirs?: SideIdentity },
  ): void {
    if (files.length === 0) return

    // #1143: per-repo fold — see sectionCollapseKey.
    const { head, collapsed } = this.#sectionHeader(
      sectionCollapseKey(rootPath, section),
      `${title} (${files.length})`,
    )

    // The merge section is its own query CONTAINER (see GP_NARROW_PANEL_PX):
    // every control inside it sizes itself to the PANEL's dragged width, not to
    // the window's. Other sections need no wrapper and get none.
    const host = section === 'merge' ? document.createElement('div') : parent
    if (host !== parent) host.className = 'gp-merge-section'

    // Header actions live in one right-aligned cluster: bulk approve/revert/unstage
    // (icon + label), plus "Resolve all with AI" for the merge section.
    const headActions = document.createElement('div')
    headActions.className = 'gp-bulk-actions'
    // The three conflict choices are NOT header actions. They are one decision
    // taken three ways, and they belong under the legend that says what
    // "current" and "incoming" are — putting them in the header put three
    // branch-name sentences on the same line as the section title.
    const mergeBulk = document.createElement('div')
    mergeBulk.className = 'gp-merge-bulk'

    for (const bulk of bulkActions(section)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'gp-bulk-btn'
      // Merge keep-all conflict actions (Phase 5, Task 3): fixed labels, wired to
      // the whole-set splice via onKeepAll. Rendered in the toolbar below the head.
      if (isMergeBulkAction(bulk)) {
        const choice = mergeBulkChoice(bulk)
        btn.classList.add('gp-bulk-keepall')
        const control = mergeBulkControl(bulk, mergeIdentity?.ours, mergeIdentity?.theirs)
        const icon = iconEl(control.icon, 12)
        icon.classList.add('gp-bulk-icon', `gp-side-${control.accent}`)
        btn.append(icon, labelEl(control.text))
        btn.title = control.title
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#callbacks.onKeepAll(
            rootPath,
            files.map((file) => file.filePath),
            choice,
            control.confirmLabel,
          )
        })
        mergeBulk.appendChild(btn)
        continue
      }
      let iconName: string
      let text: string
      if (bulk === 'stage-all') {
        iconName = 'check'
        text = 'Approve all'
        btn.title = 'Stage all changes'
        btn.classList.add('gp-bulk-approve')
      } else if (bulk === 'discard-all') {
        iconName = 'discard'
        text = 'Revert all'
        btn.title = 'Discard all changes — cannot be undone'
        btn.classList.add('gp-bulk-revert')
      } else {
        iconName = 'minus'
        text = 'Unstage all'
        btn.title = 'Unstage all'
      }
      btn.append(iconEl(iconName, 13), labelEl(text))
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        const paths = files.map((file) => file.filePath)
        if (bulk === 'stage-all') this.#callbacks.onStage(rootPath, paths)
        else if (bulk === 'unstage-all') this.#callbacks.onUnstage(rootPath, paths)
        else this.#callbacks.onDiscardAll(rootPath, files)
      })
      headActions.appendChild(btn)
    }

    // Merge Changes: a section-level "Resolve all with AI" that hands off to the
    // whole-window Resolve-with-AI flow (#335, P6). Held proposals aren't a
    // separate store in v1 — held == still-conflicted rows, which this section
    // already lists, so they stay visible (with badges) after each resolve pass.
    if (section === 'merge' && hasResolvableConflicts(files)) {
      // #1134: while the agent is running this is a spinner + Stop, not an
      // idle-looking button. The run was startable from here, so it is
      // stoppable from here too.
      const control = resolveAllControl(this.#resolvePhase)
      const resolveAll = document.createElement('button')
      resolveAll.type = 'button'
      resolveAll.className = `gp-bulk-btn gp-action-resolve${control.busy ? ' gp-resolve-busy' : ''}`
      resolveAll.title = control.title
      if (control.busy) {
        const spinner = document.createElement('span')
        spinner.className = 'gp-resolve-spinner'
        spinner.setAttribute('aria-hidden', 'true')
        resolveAll.append(spinner, document.createTextNode(control.label))
        // Busy is not a second entry point — re-firing would supersede the very
        // run it is reporting on.
        resolveAll.disabled = true
      } else {
        // A glyph marks it as the one action here that DELEGATES rather than
        // decides; the three choices below it are deterministic.
        resolveAll.append(iconEl('sparkles', 12), labelEl(control.label))
        resolveAll.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#callbacks.onResolveConflict()
        })
      }
      headActions.appendChild(resolveAll)
      if (control.canStop) {
        const stop = document.createElement('button')
        stop.type = 'button'
        stop.className = 'gp-bulk-btn gp-action-resolve-stop'
        stop.textContent = 'Stop'
        stop.title = 'Stop the agent resolving these conflicts'
        stop.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#callbacks.onStopResolveConflict()
        })
        headActions.appendChild(stop)
      }
    }

    if (headActions.childElementCount > 0) head.appendChild(headActions)
    host.appendChild(head)
    if (host !== parent) parent.appendChild(host)

    // Collapsed: the header (with its count + Resolve all with AI) stands alone (#693).
    if (collapsed) return

    // The merge toolbar: identity ONCE as a legend, then the three choices.
    if (section === 'merge') {
      const toolbar = document.createElement('div')
      toolbar.className = 'gp-merge-toolbar'
      toolbar.appendChild(this.#renderMergeLegend(mergeIdentity))
      if (mergeBulk.childElementCount > 0) toolbar.appendChild(mergeBulk)
      host.appendChild(toolbar)
    }

    // Interleave the fetched children of any EXPANDED rolled-up untracked dir as
    // child rows right after it (#615), so new files under a new folder are
    // visible/peekable without losing the folder row's discard/commit actions.
    const expandedHere = new Set<string>()
    const childrenHere = new Map<string, string[]>()
    for (const change of files) {
      if (!isUntrackedDir(change)) continue
      const key = this.#dirKey(rootPath, change.filePath)
      if (this.#expandedUntrackedDirs.has(key)) expandedHere.add(change.filePath)
      const kids = this.#untrackedChildren.get(key)
      if (kids !== undefined) childrenHere.set(change.filePath, kids)
    }
    const rows = interleaveUntrackedChildren(files, expandedHere, childrenHere)

    // #SCMS: the section's selectable file paths in display order — the universe a
    // Shift-range spans. Rolled-up untracked dir rows are excluded (they toggle
    // expand, not select); merge rows are never selectable (FR-11). Reconcile the
    // stored selection against this live set so files that vanished since the last
    // render drop out of the highlight and any subsequent action (FR-10).
    const selectablePaths =
      section === 'merge' ? [] : rows.filter((row) => row.kind !== 'dir').map((row) => row.change.filePath)
    if (section !== 'merge') {
      this.#setSelection(
        rootPath,
        section,
        reconcileSelection(this.#selectionFor(rootPath, section), selectablePaths),
      )
      // #SCMS: path → change for this section (incl. untracked children), so a
      // selection-scoped Discard can resolve its paths to the records it needs.
      const changeByPath = new Map<string, GitFileChange>()
      for (const row of rows) if (row.kind !== 'dir') changeByPath.set(row.change.filePath, row.change)
      this.#sectionChanges.set(this.#selectionKey(rootPath, section), changeByPath)
    }

    const list = createList<UntrackedDisplayRow>(
      rows,
      this.#visibleChangeRows(section === 'merge' ? CONFLICT_ROW_HEIGHT : ROW_HEIGHT),
      (row) => this.#renderChangeRow(rootPath, row, section, mergeIdentity),
      `${SECTION_NAMES[section]}, ${files.length} file${files.length === 1 ? '' : 's'}`,
      // A conflicted file gets two lines: the file, then the choice about it.
      section === 'merge' ? CONFLICT_ROW_HEIGHT : ROW_HEIGHT,
    )
    // Tag the list with its section so a row click can open the RIGHT diff — the
    // Staged Changes section shows the staged (index-vs-HEAD) diff, not the working
    // tree, so a partially-staged file reflects what the commit will contain (#694).
    list.setAttribute('data-section', section)
    // Stable key so scroll/selection survive the full rebuild (#1094).
    list.setAttribute('data-list-key', `${rootPath}\x00${section}`)
    list.addEventListener('fl-list-activate', (event) => {
      const detail = (event as CustomEvent<ListItemDetail<UntrackedDisplayRow>>).detail
      // Clicking a rolled-up untracked dir toggles it open.
      if (detail.item.kind === 'dir') {
        this.#toggleUntrackedDir(rootPath, detail.item.change.filePath)
        return
      }
      // A conflicted (merge-section) row opens the file in the REAL editor tab via
      // the same `flow:open-file` channel the Files tree uses — the inline per-hunk
      // resolver (side tints, identity annotations, Accept/Compare CodeLens) lives on
      // the `file:` model, which the old working-tree-vs-HEAD diff (flow-git: models)
      // never carries. open-diff/open-merge stay available as explicit hover actions.
      // Non-conflicted sections (Changes/Staged) keep their diff-on-activate behavior.
      if (section === 'merge') {
        document.dispatchEvent(
          new CustomEvent('flow:open-file', {
            detail: { rootPath, relPath: detail.item.change.filePath },
          }),
        )
        return
      }
      // #SCMS: a Changes/Staged click updates the multi-selection from its
      // modifiers (plain / Cmd-toggle / Shift-range), then — for a PLAIN click —
      // still opens the diff (select AND preview, FR-1). A toggle/range click only
      // adjusts the selection: swapping the diff view on a Cmd/Shift-click would
      // fight the multi-select intent. A full #rerender repaints the marked rows
      // (the same pattern the merge side-press uses).
      const gesture = gestureFor({ multiSelect: detail.multiSelect, range: detail.range })
      this.#setSelection(
        rootPath,
        section,
        nextSelection(this.#selectionFor(rootPath, section), {
          items: selectablePaths,
          path: detail.item.change.filePath,
          gesture,
        }),
      )
      if (gesture === 'plain') {
        this.#callbacks.onFileDiff(rootPath, detail.item.change, section === 'staged')
      }
      this.#rerender()
    })
    host.appendChild(list)
  }

  /**
   * The merge legend — the ONE place a branch name is rendered in this section.
   *
   * Every control here says "current" or "incoming"; this says which branch each
   * of those words is. Before it existed, each control carried its own wording of
   * the name, so a 53-character branch was written five times across a 500px
   * panel and truncated differently in each. A caption can ellipsize without
   * losing a verb, which is why identity lives here and nowhere else.
   */
  #renderMergeLegend(
    mergeIdentity?: { ours?: SideIdentity; theirs?: SideIdentity },
  ): HTMLElement {
    const legend = document.createElement('div')
    legend.className = 'gp-merge-legend'
    for (const chip of mergeLegend(mergeIdentity?.ours, mergeIdentity?.theirs)) {
      const el = document.createElement('span')
      el.className = `gp-legend-chip gp-legend-${chip.accent}`
      el.title = chip.title
      const icon = iconEl(chip.icon, 12)
      icon.classList.add('gp-legend-icon')
      const role = document.createElement('span')
      role.className = 'gp-legend-role'
      role.textContent = chip.role
      const branch = document.createElement('span')
      branch.className = 'gp-legend-branch'
      branch.textContent = chip.branch
      el.append(icon, role, branch)
      legend.appendChild(el)
    }
    return legend
  }

  /** Commit box (#335): message textarea + Commit + AI ✨ Generate. The Commit
   *  button is gated by the pure commitBoxState(stagedCount, message); the draft
   *  persists per-root across re-renders; ⌘/Ctrl+Enter commits. */
  #renderCommitBox(rootPath: string, staged: GitFileChange[]): HTMLElement {
    const stagedCount = staged.length
    const box = document.createElement('div')
    box.className = 'gp-commit-box'

    const textarea = document.createElement('textarea')
    textarea.className = 'gp-commit-msg'
    textarea.rows = 2
    textarea.placeholder = 'Message (⌘/Ctrl+Enter to commit)'
    textarea.dataset['msgKey'] = rootPath // focus survives a rebuild (#1093)
    textarea.value = this.#commitDrafts.get(rootPath) ?? ''

    const commit = document.createElement('button')
    commit.type = 'button'
    commit.className = 'gp-commit-btn'
    commit.textContent = 'Commit'

    // WHY the button is off, where a user can actually read it: a title on a
    // disabled button never surfaces in Chromium, and no screen-reader path
    // reached it at all. The hint doubles as the box's validation feedback.
    const hint = document.createElement('div')
    hint.className = 'gp-commit-hint'
    hint.id = `gp-commit-hint-${this.#commitHintSeq++}`
    textarea.setAttribute('aria-describedby', hint.id)

    const syncEnabled = (): void => {
      // A commit in flight SAYS so. A bare disabled button reads as a dead
      // click (and invites a second one) for as long as git and its hooks take.
      if (this.#committing.has(rootPath)) {
        commit.disabled = true
        commit.classList.add('gp-busy')
        commit.textContent = 'Committing…'
        commit.title = 'Committing the staged changes'
        hint.hidden = true
        return
      }
      commit.classList.remove('gp-busy')
      commit.textContent = 'Commit'
      const state = commitBoxState(stagedCount, textarea.value)
      commit.disabled = !state.canCommit
      commit.title = state.disabledReason ?? 'Commit staged changes'
      hint.textContent = state.disabledReason ?? ''
      hint.hidden = state.disabledReason === null
    }
    syncEnabled()

    textarea.addEventListener('input', () => {
      this.#commitDrafts.set(rootPath, textarea.value)
      syncEnabled()
    })

    const doCommit = async (): Promise<void> => {
      if (this.#committing.has(rootPath)) return
      if (!commitBoxState(stagedCount, textarea.value).canCommit) return
      this.#committing.add(rootPath)
      syncEnabled()
      let ok = false
      try {
        ok = await this.#callbacks.onCommit(rootPath, textarea.value.trim())
      } finally {
        this.#committing.delete(rootPath)
      }
      if (ok) {
        this.#commitDrafts.delete(rootPath)
        textarea.value = ''
      }
      syncEnabled()
      // A rebuild during the commit drew a busy box this closure does not own.
      this.#rerender()
    }
    commit.addEventListener('click', () => void doCommit())
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void doCommit()
      }
    })

    const generate = document.createElement('button')
    generate.type = 'button'
    generate.className = 'gp-commit-generate'
    generate.appendChild(iconEl('sparkles', 16))
    generate.title = 'Generate commit message with AI'
    generate.setAttribute('aria-label', 'Generate commit message with AI')
    // Busy state survives re-renders (#1020): a rebuild mid-generation renders
    // the wand disabled again, so the ~5s wait never reads as a dead click.
    generate.disabled = stagedCount === 0 || this.#generating.has(rootPath)
    generate.addEventListener('click', () => {
      if (this.#generating.has(rootPath)) return
      const seq = ++this.#generateSeq
      this.#generating.set(rootPath, {
        seq,
        draftAtClick: this.#commitDrafts.get(rootPath) ?? '',
      })
      generate.disabled = true
      void this.#callbacks
        .onGenerateMessage(rootPath, staged.map((file) => file.filePath))
        .then((message) => this.#settleGeneration(rootPath, seq, message))
        .catch(() => this.#settleGeneration(rootPath, seq, null))
    })

    const actions = document.createElement('div')
    actions.className = 'gp-commit-actions'
    actions.appendChild(generate)
    actions.appendChild(commit)

    box.appendChild(textarea)
    box.appendChild(hint)
    box.appendChild(actions)
    return box
  }

  /**
   * A ✨ generation resolved (#1020). Writes through the DRAFT store + a
   * re-render — never the click-time textarea, which any intervening rebuild
   * has detached — so the result lands in the live box. Superseded results
   * (a newer click took over) are dropped; so is a result the user has typed
   * past (shouldApplyGeneratedMessage — their words win). A null result means
   * the coordinator already toasted the failure; we only clear the busy state.
   */
  #settleGeneration(rootPath: string, seq: number, message: string | null): void {
    const pending = this.#generating.get(rootPath)
    if (!pending || pending.seq !== seq) return // superseded by a newer click
    this.#generating.delete(rootPath)
    const draftNow = this.#commitDrafts.get(rootPath) ?? ''
    if (message !== null && shouldApplyGeneratedMessage(pending.draftAtClick, draftNow, message)) {
      this.#commitDrafts.set(rootPath, message)
    }
    // Re-render paints the (possibly updated) draft into the live textarea and
    // re-enables the wand; #renderRoots preserves focus/scroll across it.
    this.#rerender()
  }

  /**
   * The pencil beside a branch name, and the field it turns into.
   *
   * ON SCREEN, NOT ON HOVER. It shipped fully transparent until the row was
   * hovered and was reported as "there is no option to edit the branch" from a
   * screenshot of the line it was sitting on. Dimmed, brightening on hover or
   * focus (`.gp-branch-edit-btn`).
   *
   * `#renamingRoot` is the one checkout whose field is open, so a rebuild of
   * the panel puts it back rather than dropping what someone was typing.
   */
  #branchEdit(rootPath: string, branch: string): HTMLElement {
    const host = document.createElement('span')
    host.className = 'gp-branch-edit'
    const editing = this.#renamingRoot === rootPath
    host.dataset['editing'] = editing ? 'true' : 'false'

    if (!editing) {
      const pencil = document.createElement('button')
      pencil.type = 'button'
      pencil.className = 'gp-branch-edit-btn'
      pencil.title = 'Rename this branch'
      pencil.setAttribute('aria-label', 'Rename this branch')
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', 'pencil')
      glyph.setAttribute('size', '12')
      pencil.appendChild(glyph)
      pencil.addEventListener('click', () => {
        this.#renamingRoot = rootPath
        this.#rerender()
      })
      host.appendChild(pencil)
      return host
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'gp-branch-edit-input'
    input.value = branch
    input.placeholder = 'Branch name'
    input.setAttribute('aria-label', 'Branch name')
    const done = document.createElement('button')
    done.type = 'button'
    done.className = 'gp-branch-edit-done'
    done.textContent = 'Done'
    const commit = (): void => {
      void this.#renameBranch(rootPath, input.value)
    }
    done.addEventListener('click', commit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.#renamingRoot = null
        this.#rerender()
      }
    })
    host.append(input, done)
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
    return host
  }

  /**
   * Move the branch, and say what happened either way.
   *
   * `confirmed: true` is set HERE, in the handler of the control a person
   * pressed, and nowhere else (forbidden-pattern #15). Everything that could
   * refuse — a name a branch cannot have, a name already taken, a detached
   * HEAD — is decided in main, so this surface never has a second opinion
   * about the rules (allowed-pattern #14).
   */
  async #renameBranch(rootPath: string, name: string): Promise<void> {
    this.#renamingRoot = null
    try {
      const result = await window.flow.git.renameBranch({
        rootId: rootPath,
        name,
        confirmed: true,
      })
      this.#callbacks.onNotify?.({
        title: result.status === 'renamed' ? 'Renamed' : 'Not renamed',
        body: result.detail,
        level: result.status === 'failed' || result.status === 'refused' ? 'error' : 'info',
      })
      if (result.status === 'renamed') this.#callbacks.onBranchRenamed?.(rootPath)
    } catch (error) {
      console.error('flow: renaming a branch failed', { rootPath, error })
      this.#callbacks.onNotify?.({
        title: 'Not renamed',
        body: 'Flow couldn\u2019t rename it. It is exactly where it was.',
        level: 'error',
      })
    }
    this.#rerender()
  }

  #renderBranchHeader(status: GitStatus, rootPath: string): HTMLElement {
    const header = document.createElement('div')
    header.className = 'gp-branch'

    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'git-branch')
    icon.setAttribute('size', '13')
    header.appendChild(icon)

    const branch = document.createElement('span')
    branch.className = 'gp-branch-name'
    // #1382: name the STATE, not git's placeholder. A detached HEAD printed
    // `(detached)` into the same slot that otherwise says `main`, while every
    // mutating action stayed enabled and reported ordinary success — a commit
    // made here is reachable from no branch, so the panel said "clean" about
    // work one checkout away from being unreferenced.
    if (status.detached === true) {
      const at = status.headCommit === undefined ? '' : ` at ${status.headCommit.slice(0, 7)}`
      branch.textContent = `detached HEAD${at}`
      branch.title =
        'HEAD is on a commit, not a branch. Commits made here belong to no branch — ' +
        'create one (git switch -c <name>) before committing, or they become hard to find.'
      branch.classList.add('gp-branch-detached')
    } else {
      branch.textContent = status.branch || '(unknown)'
      branch.title = status.branch
      branch.classList.remove('gp-branch-detached')
    }
    header.appendChild(branch)

    // THE ONE PLACE THIS BRANCH IS NAMED, so it is where renaming it lives —
    // on EVERY branch line, not only a thread's own.
    //
    // It used to be offered only where the checkout belonged to a thread, and
    // refused on a project's branch as "not this thread's to change". Nobody
    // reading the panel could see that rule: a pencil on one line and none on
    // the next, with no way to tell why. `git branch -m` is a local move of a
    // local ref — it publishes nothing and deletes nothing — so the answer is
    // to offer it wherever there is a branch.
    //
    // A detached HEAD still gets none: that label is a state, not a name.
    if (status.detached !== true) {
      header.appendChild(this.#branchEdit(rootPath, status.branch || ''))
    }

    if (status.ahead > 0 || status.behind > 0) {
      const aheadBehind = document.createElement('span')
      aheadBehind.className = 'gp-ahead-behind'
      const parts: string[] = []
      if (status.ahead > 0) parts.push(`↑${status.ahead}`)
      if (status.behind > 0) parts.push(`↓${status.behind}`)
      aheadBehind.textContent = parts.join(' ')
      header.appendChild(aheadBehind)
    }

    // A COUNT WHEN THERE IS ONE, and nothing when there is not. "clean" was a
    // label announcing the absence of news, permanently, on a header whose job
    // is to name the branch — and the panel already says it below, in the one
    // place it means something ("Working tree clean", where the file list would
    // otherwise be).
    if (status.dirty) {
      const dirty = document.createElement('span')
      dirty.className = 'gp-dirty gp-dirty-active'
      dirty.textContent = `${String(status.changes.length)} changed`
      header.appendChild(dirty)
    }

    return header
  }

  #renderChangeRow(
    rootPath: string,
    displayRow: UntrackedDisplayRow,
    section: SourceControlSection,
    mergeIdentity?: { ours?: SideIdentity; theirs?: SideIdentity },
  ): HTMLElement {
    const change = displayRow.change
    const row = document.createElement('div')
    row.className = 'gp-row'
    if (displayRow.kind === 'child') row.classList.add('gp-row-child')
    row.title = change.filePath

    // #SCMS: a multi-selected Changes/Staged row wears .fl-row-marked — the
    // accent-muted highlight fl-list defines for multi-selection, distinct from
    // hover and the neutral current row (NFR-3). The class sits on this element,
    // the direct child of fl-list's own .row (which its `:has(> .fl-row-marked)`
    // rule targets). Merge + rolled-up dir rows are never selectable (FR-11).
    if (
      section !== 'merge' &&
      displayRow.kind !== 'dir' &&
      this.#selectionFor(rootPath, section).selected.has(change.filePath)
    ) {
      row.classList.add('fl-row-marked')
    }

    // #1063: right-click reveals the file in the OS file manager. filePath is
    // repo-root-relative and the repo root is a project root, so it flows
    // through the same root-contained project:revealPath guard the file-tree
    // uses. A rolled-up dir row carries a trailing slash — strip it so the
    // folder itself (not an empty relPath) is revealed (FR-2).
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const relPath = revealRelForRow(displayRow.kind, change.filePath)
      const reveal = (): void => {
        void window.flow.project
          .revealPath({ rootPath, relPath })
          .catch((error: unknown) => console.warn('flow: reveal failed', error))
      }
      // #SCMS: for a selectable row, prepend selection-scoped Stage/Unstage/Discard
      // Selected above Reveal (FR-5). Right-clicking a row outside the current
      // selection makes it the sole selection first, so the menu acts on what was
      // pointed at. Merge + rolled-up dir rows get Reveal only.
      const items: RevealMenuItem[] = []
      if (section !== 'merge' && displayRow.kind !== 'dir') {
        if (!this.#selectionFor(rootPath, section).selected.has(change.filePath)) {
          this.#setSelection(rootPath, section, {
            selected: new Set<string>([change.filePath]),
            anchor: change.filePath,
          })
          this.#rerender()
        }
        const count = this.#selectionFor(rootPath, section).selected.size
        for (const menuItem of selectionMenuItems(section, count)) {
          items.push({
            label: menuItem.label,
            onSelect: () => this.#runSelectionAction(rootPath, section, menuItem.action),
          })
        }
      }
      showRevealMenu(event.clientX, event.clientY, reveal, items)
    })

    // A rolled-up untracked directory gets an expand chevron (#615) — click it
    // (or the row) to reveal/hide the folder's individual new files.
    if (displayRow.kind === 'dir') {
      const key = this.#dirKey(rootPath, change.filePath)
      const expanded = this.#expandedUntrackedDirs.has(key)
      const chevron = document.createElement('button')
      chevron.type = 'button'
      chevron.className = 'gp-chevron'
      chevron.title = expanded ? 'Collapse folder' : 'Expand folder'
      chevron.setAttribute('aria-expanded', String(expanded))
      chevron.appendChild(iconEl(expanded ? 'chevron-down' : 'chevron-right', 12))
      chevron.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#toggleUntrackedDir(rootPath, change.filePath)
      })
      row.appendChild(chevron)
    }

    const letter = document.createElement('span')
    letter.className = `gp-letter ${STATE_CLASSES[change.state]}`
    letter.textContent = STATE_LETTERS[change.state]
    letter.setAttribute('aria-label', STATE_NAMES[change.state])
    letter.title = STATE_NAMES[change.state]
    row.appendChild(letter)

    // A rolled-up dir path carries a trailing slash — trim it so the row reads as
    // a folder name (`app/` · `(protected)`) rather than an empty name (#615).
    const displayPath =
      displayRow.kind === 'dir' ? change.filePath.replace(/\/$/, '') : change.filePath
    const slash = displayPath.lastIndexOf('/')
    if (slash >= 0) {
      const dir = document.createElement('span')
      dir.className = 'gp-dir'
      dir.textContent = `${displayPath.slice(0, slash + 1)}`
      row.appendChild(dir)
    }
    const name = document.createElement('span')
    name.className = 'gp-name'
    name.textContent = slash >= 0 ? displayPath.slice(slash + 1) : displayPath
    row.appendChild(name)

    // Inline hover actions per section. The row click is open-diff; stopPropagation
    // so an action button doesn't also open the diff. Conflicted (merge) rows lead
    // with a structural risk badge, then per-side + open-merge-editor controls (P6).
    const actions = document.createElement('span')
    actions.className = 'gp-row-actions'

    if (section === 'merge') {
      // THE CHOICE GETS ITS OWN LINE. Squeezed onto the filename's row, the two
      // side buttons read as part of the path in a narrow sidebar — and a click
      // meant to open the file resolved it instead. The row becomes two lines:
      // what the file is, then what you can do about it.
      row.classList.add('gp-row-conflict')
      const autoBadge = this.#renderAutoResolvedBadge(rootPath, change.filePath)
      if (autoBadge) actions.appendChild(autoBadge)
    }

    const sideRow = section === 'merge' ? document.createElement('div') : null
    if (sideRow !== null) {
      sideRow.className = 'gp-conflict-choice'
      sideRow.appendChild(this.#renderRiskBadge(rootPath, change.filePath))
    }
    for (const action of fileActions(section)) {
      if (action === 'open-diff') continue
      const btn = document.createElement('button')
      btn.type = 'button'
      if (action === 'resolve') {
        // A conflicted file: "Resolve with AI" — hands off to the existing
        // whole-window conflict-resolution flow via the coordinator.
        btn.className = 'gp-action-btn gp-action-resolve'
        btn.textContent = 'Resolve'
        btn.title = 'Resolve with AI'
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#callbacks.onResolveConflict()
        })
      } else if (action === 'use-ours' || action === 'use-theirs') {
        // LOOK BEFORE YOU LEAP. One press previews that side in the editor and
        // arms the button; the second press resolves. Taking a whole side drops
        // the other's changes to this file, and it used to happen on a single
        // click of a control that looked like a label.
        const side = action === 'use-ours' ? 'ours' : 'theirs'
        const identity = side === 'ours' ? mergeIdentity?.ours : mergeIdentity?.theirs
        const armedKey = `${rootPath}\u0000${change.filePath}`
        const armed = this.#armedSide.get(armedKey) === side
        const control = mergeSideControl(side, armed, identity)
        btn.className = 'gp-action-btn gp-action-side'
        if (armed) btn.classList.add('gp-action-side-armed')
        const sideIcon = iconEl(control.icon, 12)
        sideIcon.classList.add(`gp-side-${control.accent}`)
        const sideText = document.createElement('span')
        sideText.className = 'gp-side-text'
        sideText.textContent = control.text
        btn.append(sideIcon, sideText)
        btn.title = control.title
        // The label is hidden at narrow widths, so the accessible name is the
        // full sentence at EVERY width — an icon-only control that is silent to
        // a screen reader is not a shorter control, it is an unlabelled one.
        btn.setAttribute('aria-label', control.title)
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          const next = nextSidePress(this.#armedSide.get(armedKey), side)
          if (next.armed === undefined) this.#armedSide.delete(armedKey)
          else this.#armedSide.set(armedKey, next.armed)
          if (next.action === 'apply') {
            this.#callbacks.onResolveSide(rootPath, change.filePath, side)
            return
          }
          this.#callbacks.onPreviewSide?.(rootPath, change.filePath, side)
          this.#rerender()
        })
      } else if (action === 'open-merge') {
        // Open the Monaco 3-way merge editor (P5) for a hands-on resolution.
        btn.className = 'gp-action-btn'
        btn.title = 'Open in merge editor'
        btn.appendChild(iconEl('git-merge', 13))
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#callbacks.onOpenMergeEditor(rootPath, change.filePath)
        })
      } else {
        const iconName = action === 'stage' ? 'plus' : action === 'unstage' ? 'minus' : 'discard'
        btn.className = 'gp-action-btn'
        if (action === 'discard') btn.classList.add('gp-action-discard')
        btn.title = action === 'stage' ? 'Stage' : action === 'unstage' ? 'Unstage' : 'Discard changes'
        btn.appendChild(iconEl(iconName, 13))
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          // #SCMS (FR-8): when this row is part of a multi-selection, the hover
          // action applies to the WHOLE selection; otherwise just to this row.
          const selection = this.#selectionFor(rootPath, section)
          const actOnSelection = selection.selected.size > 1 && selection.selected.has(change.filePath)
          if (action === 'stage') {
            this.#callbacks.onStage(rootPath, actOnSelection ? [...selection.selected] : [change.filePath])
          } else if (action === 'unstage') {
            this.#callbacks.onUnstage(rootPath, actOnSelection ? [...selection.selected] : [change.filePath])
          } else if (actOnSelection) {
            this.#callbacks.onDiscardAll(rootPath, this.#selectedChangesFor(rootPath, section))
          } else {
            this.#callbacks.onDiscard(rootPath, change)
          }
        })
      }
      if (sideRow !== null && btn.classList.contains('gp-action-side')) sideRow.appendChild(btn)
      else actions.appendChild(btn)
    }
    if (actions.childElementCount > 0) row.appendChild(actions)
    if (sideRow !== null && sideRow.childElementCount > 0) {
      const wrap = document.createElement('div')
      wrap.className = 'gp-row-stack'
      wrap.append(row, sideRow)
      return wrap
    }

    return row
  }

  /**
   * An "auto-resolved ✓" pill for a merge row whose file carries AI-applied hunk
   * records (Phase 5, Task 4). Returns null when the file has no auto hunks, so a
   * plain conflict row is unadorned. Title hints at review/undo via the merge
   * editor's per-hunk controls.
   */
  #renderAutoResolvedBadge(rootPath: string, filePath: string): HTMLElement | null {
    const records = getHunkResolutions(rootPath).filter(
      (entry) => entry.filePath === filePath,
    )
    if (!records.some((entry) => entry.auto)) return null
    const status: FileResolutionStatus = 'auto-resolved'
    const badge = document.createElement('span')
    badge.className = 'gp-auto-resolved-badge'
    badge.textContent = fileResolutionStatusLabel(status)
    badge.title = 'Auto-resolved by AI — open in the merge editor to review or undo per hunk'
    return badge
  }

  /** A conflicted file's structural risk badge (#335, P6). Renders 'pending' and
   *  then resolves to safe/risky once its markered content is read + triaged. A
   *  read failure resolves conservatively to 'risky' (never optimistically safe). */
  #renderRiskBadge(rootPath: string, filePath: string): HTMLElement {
    const badge = document.createElement('span')
    const key = `${rootPath}\u0000${filePath}`
    const cached = this.#riskVerdicts.get(key)
    // Settled verdict — paint synchronously, no IPC. Every rebuild used to
    // re-read EVERY conflicted file (20 conflicts = 20 file reads per
    // refresh) and resolve onto badges the next rebuild had detached.
    if (cached === 'safe' || cached === 'risky') {
      applyRiskBadge(badge, cached)
      return badge
    }
    applyRiskBadge(badge, 'pending')
    // Share one in-flight read per (root, file): every rebuild's badge
    // subscribes to the same promise, so late resolutions still land on the
    // CURRENT badge instead of a detached ancestor. Invalidated wholesale on
    // external refresh (setState) — content may have changed by then.
    // ('pending' is never stored — anything non-Promise here means no entry.)
    const inFlight = cached instanceof Promise ? cached : undefined
    const pending =
      inFlight ??
      this.#callbacks
        .onConflictContent(rootPath, filePath)
        .then((markered): ConflictBadge => {
          const verdict = markered === null ? 'risky' : fileConflictRisk(markered)
          this.#riskVerdicts.set(key, verdict)
          return verdict
        })
        .catch((): ConflictBadge => {
          this.#riskVerdicts.set(key, 'risky')
          return 'risky'
        })
    if (inFlight === undefined) this.#riskVerdicts.set(key, pending)
    void pending.then((verdict) => applyRiskBadge(badge, verdict))
    return badge
  }

  /**
   * Branch-level side identity for the merge section.
   *
   * `ours` = the current branch (git stage 2 / HEAD); `theirs` = the incoming
   * branch for a merge, or the replayed branch for a rebase. Only the `branch`
   * field is populated. Undefined when no op is in progress.
   *
   * This feeds `mergeLegend` and the controls' TOOLTIPS only. It no longer
   * reaches a button's visible label: names were briefly put inside the labels
   * themselves, and a 53-character branch name in a resizable sidebar shredded
   * the panel — see the note on `mergeBulkControl`.
   */
  #mergeSideIdentity(
    view: GitRootView,
  ): { ours?: SideIdentity; theirs?: SideIdentity } | undefined {
    const state = view.mergeState
    if (!state || state.op === 'none') return undefined
    const oursBranch = view.status?.branch
    const theirsBranch = state.op === 'rebase' ? state.ontoBranch : state.incomingBranch
    return {
      ours: { kind: 'ours', ref: 'HEAD', branch: oursBranch || undefined, isCurrentUser: true },
      theirs: {
        kind: 'theirs',
        ref: state.incomingRef ?? 'incoming',
        branch: theirsBranch || undefined,
        isCurrentUser: false,
      },
    }
  }

  /** The merge/rebase in-progress banner (#335, P6): op + unresolved count +
   *  Complete merge (enabled only when no conflicts remain) + Abort. */
  #renderMergeBanner(rootPath: string, state: GitMergeState | null | undefined): HTMLElement | null {
    const model = deriveMergeBanner(state)
    if (!model.visible) return null

    const banner = document.createElement('div')
    banner.className = 'gp-merge-banner'

    const label = document.createElement('span')
    label.className = 'gp-merge-banner-label'
    label.append(iconEl('git-merge', 14))
    const text = document.createElement('span')
    text.textContent = model.opLabel
    label.appendChild(text)
    banner.appendChild(label)

    // Conflict Overview counter (Phase 5, Task 2): "N of M resolved" derived from
    // the session per-hunk records + the current unmerged set. M is the union of
    // still-unmerged files and any file with a recorded resolution — a resolved
    // file keeps its place in the denominator.
    const unmergedPaths = state?.unmergedPaths ?? []
    const resolutions = getHunkResolutions(rootPath).map((entry) => ({
      filePath: entry.filePath,
      auto: entry.auto,
    }))
    const overview = deriveConflictOverview({
      files: unmergedPaths,
      unmergedPaths,
      resolutions,
    })

    const count = document.createElement('span')
    count.className = 'gp-merge-banner-count'
    count.textContent =
      overview.total > 0
        ? overview.counterLabel
        : model.unmergedCount === 0
          ? 'all resolved'
          : `${model.unmergedCount} unresolved`
    banner.appendChild(count)

    const bannerActions = document.createElement('div')
    bannerActions.className = 'gp-merge-banner-actions'

    // #571: a rebase must run `git rebase --continue`/`--abort`, not the merge
    // paths — label + wire per op (the coordinator branches on the same op).
    const isRebase = model.op === 'rebase'
    const complete = document.createElement('button')
    complete.type = 'button'
    complete.className = 'gp-merge-banner-btn gp-merge-complete'
    complete.textContent = isRebase ? 'Continue rebase' : 'Complete merge'
    complete.disabled = !model.canComplete
    complete.title = model.canComplete
      ? isRebase
        ? 'Continue the rebase with the resolved conflicts'
        : 'Finalize the merge with the prepared message'
      : `Resolve all conflicts before ${isRebase ? 'continuing' : 'completing'}`
    complete.addEventListener('click', () => {
      if (!model.canComplete) return
      this.#callbacks.onCompleteMerge(rootPath, model.message)
    })
    bannerActions.appendChild(complete)

    const abort = document.createElement('button')
    abort.type = 'button'
    abort.className = 'gp-merge-banner-btn gp-merge-abort'
    abort.textContent = 'Abort'
    abort.title = isRebase ? 'Abort the in-progress rebase' : 'Abort the in-progress merge'
    abort.addEventListener('click', () => this.#callbacks.onAbortMerge(rootPath))
    bannerActions.appendChild(abort)

    banner.appendChild(bannerActions)
    return banner
  }


  #renderCommitRow(commit: GitCommit): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gp-row'
    row.title = `${commit.hash.slice(0, 7)} · ${commit.author} · ${commit.date}\n${commit.subject}`

    const subject = document.createElement('span')
    subject.className = 'gp-subject'
    subject.textContent = commit.subject
    row.appendChild(subject)

    const meta = document.createElement('span')
    meta.className = 'gp-meta'
    meta.textContent = `${commit.author} · ${relativeAge(commit.date)}`
    row.appendChild(meta)

    return row
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createList<T>(
  items: T[],
  maxRows: number,
  render: (item: T) => HTMLElement,
  label: string,
  // fl-list positions each row at index * rowHeight and CLIPS it there (#1489),
  // so a taller row is a property of the LIST, never CSS on the row.
  rowHeight: number = ROW_HEIGHT,
): FlList<T> {
  const list = document.createElement('fl-list') as FlList<T>
  // Name the list for the accessibility tree — without it every section is an
  // anonymous scroll of identical rows.
  list.setAttribute('aria-label', label)
  list.style.height = `${Math.min(items.length, maxRows) * rowHeight}px`
  list.rowHeight = rowHeight
  list.renderItem = render
  list.items = items
  // fl-list renders rows inside its (open) shadow DOM, which document.head styles
  // can't reach — inject the panel sheet there so .gp-row/.gp-action-btn/etc. apply
  // (right-alignment, icon-button sizing, letter colours). Guarded so repeated
  // renders don't stack duplicate <style> nodes.
  const shadow = list.shadowRoot
  if (shadow && !shadow.querySelector('style[data-gp]')) {
    const rowStyle = document.createElement('style')
    rowStyle.setAttribute('data-gp', '')
    rowStyle.textContent = GP_STYLES
    shadow.appendChild(rowStyle)
  }
  return list
}

/** Read a localStorage key, tolerating storage being unavailable/blocked (#693). */
function safeReadStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Write a localStorage key, silently tolerating unavailable/full storage (#693). */
function safeWriteStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode / quota) — fold state just won't persist */
  }
}

/** An <fl-icon> element at the given pixel size — the button icon primitive. */
function iconEl(name: string, size: number): HTMLElement {
  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', name)
  icon.setAttribute('size', String(size))
  return icon
}

/** A text label span for a header bulk button. */
function labelEl(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'gp-bulk-label'
  span.textContent = text
  return span
}

/**
 * Paint a risk badge (idempotent — used for the async update).
 *
 * The badge NAMES what was found rather than grading it: a colour plus the word
 * RISKY tells you to be careful without telling you what about, and the reader
 * is about to decide whether one side can be taken whole.
 */
function applyRiskBadge(el: HTMLElement, badge: ConflictBadge): void {
  const { text, detail } = conflictRiskLabel(badge)
  el.className = `gp-risk-badge gp-risk-${badge}`
  // A dot plus a word. The word is what a narrow panel gives up (the container
  // query hides it), and it used to give up half of it instead — "Separate ed".
  // The dot never goes, and `detail` carries the fact in a sentence either way.
  const dot = document.createElement('span')
  dot.className = 'gp-risk-dot'
  dot.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'gp-risk-text'
  label.textContent = text
  el.replaceChildren(dot, label)
  el.title = detail
  // A bare span's aria-label is ignored by most screen readers; role="img" is
  // what makes the badge announce its sentence at the widths where the word is
  // hidden and only the dot is left.
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', detail)
}

/** Compact relative age: 45s, 12m, 3h, 5d, 2w, 4mo, 1y. */
export function relativeAge(isoDate: string, now: number = Date.now()): string {
  const then = Date.parse(isoDate)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

// ── Styles (light DOM, injected once — same pattern as shell.ts) ─────────

let stylesInjected = false

function injectGitPanelStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = GP_STYLES
  document.head.appendChild(style)
}

