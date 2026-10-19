/**
 * NodePopover — the compact drafting popover the board opens on a single click of
 * any node (blueprint-v2 Phase 3). ONE popover at a time, anchored to the clicked
 * card inside the board stage. It renders a pure PopoverContent (popover-model.ts)
 * — kind eyebrow, label + mono id, capped annotation lines, feature membership,
 * ghost/plan badge, must-review reason lines — and an actions row: [Drill ▸]
 * (modules with children only) and [Attach to chat ⊕].
 *
 * The popover owns only DOM + placement + outside-click dismissal; the board owns
 * Esc precedence (popover before drill) and content assembly. Its styles live in
 * the board's scoped style root (`.flow-board-root .fb-popover*`), so it inherits
 * the drafting-identity token layer. All text is set via textContent — never
 * innerHTML — so node ids / annotation text can't inject markup.
 *
 * PEEK ENTRY POINTS (Phase 5, #568): an Annotation line whose `peekPath` is
 * non-null gets a small file-icon affordance that fires `handlers.onPeekFile`.
 * A module node's Files section is NOT part of the synchronous content — the
 * board fetches its directory listing async (project:listDir) and patches
 * it in afterwards via `showFiles()`, keyed by the `key` passed to `open()` so
 * a stale response for a since-closed/re-anchored popover is a no-op.
 */
import type { BlueprintProposalState, GitFileState } from '../../shared/ipc-contract'
import type { FileListResult } from './files-model'
import {
  LEARN_ACTION_LABEL,
  LEARN_STATUS_LABEL,
  resolveActiveTab,
  type PopoverContent,
  type PopoverGround,
  type PopoverLearning,
} from './popover-model'
import { attachTabBarKeys, syncTabSelection } from './tab-bar'

/** Route a file row's click: plain → the peek drawer; ⌘/Ctrl → a real editor
 *  tab. Falls back to the peek when no open handler is wired, so the modifier
 *  can never turn a working row into a dead one. */
function openOrPeek(
  event: MouseEvent,
  relPath: string,
  open: ((relPath: string) => void) | undefined,
  peek: (relPath: string) => void,
): void {
  if ((event.metaKey || event.ctrlKey) && open !== undefined) {
    open(relPath)
    return
  }
  peek(relPath)
}
import type { Connections, ConnectionRow } from './connections-model'

/** Git working-tree state → the file row's status class (Review Mode, #609).
 *  Colors + strike-through live in the board's scoped BOARD_STYLES. A file with
 *  no gitState gets no class (clean / un-joined). `conflicted` reuses the
 *  deleted red for a strong "needs attention" cue without a new token. */
const GIT_STATE_CLASS: Record<GitFileState, string> = {
  added: 'fb-git-added',
  modified: 'fb-git-modified',
  deleted: 'fb-git-deleted',
  renamed: 'fb-git-renamed',
  untracked: 'fb-git-untracked',
  conflicted: 'fb-git-deleted',
}

/** Gap (px) between the anchor card and the popover, and viewport clamp inset. */
const ANCHOR_GAP = 10
const EDGE_INSET = 8

/** Human labels for the ghost lifecycle line. */
const GHOST_STATE_LABEL: Record<BlueprintProposalState, string> = {
  proposed: 'proposed',
  accepted: 'accepted',
  rejected: 'rejected',
  confirmed: 'confirmed',
  stale: 'stale',
  cleared: 'cleared',
}

// Learning status/action words come from popover-model's LEARN_STATUS_LABEL /
// LEARN_ACTION_LABEL — the one vocabulary every learning surface reads.

/** One changed file of the module, for the Changes tab (#898). */
export interface PopoverChangeRow {
  filePath: string
  name: string
  state: GitFileState
  staged: boolean
}

/** One advisory invariant finding shown inside the Changes tab (#898 FR9). */
export interface PopoverInvariantFinding {
  filePath: string
  verdict: 'violates' | 'touches'
  invariant: string
  evidence: string
}

/** Advisory extras for the Changes tab — findings + module-level notes
 *  ("no invariants learned yet", "not checked (too large)", staleness). */
export interface PopoverChangesExtras {
  findings: PopoverInvariantFinding[]
  notes: string[]
}

export interface PopoverChangesHandlers {
  /** Stage (approve) or unstage a single file — writes real git staging (#857). */
  onToggleStage: (filePath: string, nextStaged: boolean) => void
  /** Reject: revert the file + send the agent a redo with feedback (review flow). */
  onReject: (filePath: string, feedback: string) => void
  /** Open the working-tree diff overlay for the file. */
  onOpenDiff: (filePath: string) => void
  /** Stage every unstaged changed file of the module. */
  onApproveAll: (filePaths: string[]) => void
}

/**
 * A popover action that runs an ASYNC generation in the main process (#1028).
 * The popover owns the pending state, keyed by node, so a mid-flight rebuild
 * can neither lose it nor freeze it: the button is re-rendered from the state,
 * and the board clears the state on BOTH the success and failure branch.
 */
export type PopoverAsyncAction = 'review-summary' | 'explain-usage'

/** Trigger state → button label. `retry` is the failure terminal state: the
 *  action is offered again rather than left wedged mid-flight. */
const ASYNC_ACTION_LABEL: Record<PopoverAsyncAction, Record<'idle' | 'busy' | 'retry', string>> = {
  'review-summary': { idle: 'Review in depth', busy: 'Generating…', retry: 'Retry review' },
  'explain-usage': { idle: 'Explain usage ✎', busy: 'Generating…', retry: 'Retry explain' },
}

const ASYNC_ACTION_CLASS: Record<PopoverAsyncAction, string> = {
  'review-summary': 'fb-popover-review-summary',
  'explain-usage': 'fb-popover-explain-usage',
}

export type PopoverAsyncActionState = 'idle' | 'busy' | 'retry'

export interface PopoverHandlers {
  /** Drill into the node's children (only wired when content.canDrill). */
  onDrill: () => void
  /** Attach the node to chat (dispatches flow:blueprint-selected). */
  onAttach: () => void
  /** Learn / re-learn the module (fire-and-forget; only wired for modules with a
   *  learning action). The dot flips to pulsing via the watcher round-trip. */
  onLearn: () => void
  /** Learn every module under a FEATURE that nobody has read yet (Phase 8's
   *  Ground block) — one `learn:learnModule` per module, fire-and-forget, the
   *  same act the panel's per-row Learn performs. Absent → no action offered. */
  onLearnGround?: (modules: readonly string[]) => void
  /** Peek a file an annotation anchor names (Phase 5, #568). */
  onPeekFile: (relPath: string) => void
  /** ⌘/Ctrl-click on the same rows: skip the peek drawer and open a real
   *  editor tab (the drawer's "Open in editor", without the stop). */
  onOpenFile?: (relPath: string) => void
  /** Open a feature's story card from its FEATURE pill — the board compiles the
   *  plan's `## Story` and shows it in the story panel (falls back to peeking the
   *  plan doc when it has no story). `docPath` is the feature's plan doc path. */
  onOpenStory: (docPath: string) => void
  /** Mark this node's must-review items acknowledged (#910) — records the
   *  review so the agent learns; wired only when review rows exist. */
  onMarkReviewed?: () => void
  /** Integrations/datastores (#orphan cards): generate + peek a usage doc —
   *  what this dependency is, which modules use it, what to know. */
  onExplainUsage?: () => void
  /** Generate + peek a markdown review summary for the items (#must-review
   *  substance) — a one-liner is not a review; this builds the material. */
  onReviewSummary?: () => void
  /** Popover dismissed by outside-click (board clears its own reference). */
  onClose: () => void
}

export class NodePopover {
  #stage: HTMLElement
  #element: HTMLElement | null = null
  #anchor: HTMLElement | null = null
  #handlers: PopoverHandlers | null = null
  /** Identity of the node the open popover shows — lets a late-arriving async
   *  Files fetch (`showFiles`) detect it now targets a closed/different
   *  popover and no-op instead of injecting into the wrong content. */
  #openKey: string | null = null
  /** The tab currently showing, and whether the USER put it there. Both survive
   *  a same-node rebuild so a background refresh can't steal the reader's tab
   *  (#1029) — `resolveActiveTab` (popover-model) is the one decision point. */
  #activeTab: string | null = null
  #tabUserSelected = false
  /** The node the tab/scroll memory above belongs to. Set on open, kept across
   *  a REBUILD teardown (`close({ preserveState: true })`, which the board uses
   *  when it re-renders the stage under an open popover) and dropped on a real
   *  dismissal — so the memory can never leak onto a different card. */
  #stateKey: string | null = null
  /** Scroll offset carried across a same-node rebuild (#1029) — a refresh must
   *  not jump the reader back to the top of the panel they were reading.
   *  Re-applied once the synchronous content fills land (the popover is short
   *  and unscrollable at the moment `open()` returns). */
  #carriedScroll = 0
  #scrollPending = false
  /** Async triggers mid-flight for `#pendingKey`'s node (#1028). */
  #pending = new Map<PopoverAsyncAction, PopoverAsyncActionState>()
  #pendingKey: string | null = null
  /** Outside-click dismissal — bound once, attached only while open. */
  #onDocMousedown: (event: MouseEvent) => void
  #onDocMouseup: (event: MouseEvent) => void
  /** Where an in-stage background gesture started — a small-move mouseup there
   *  is a CLICK (dismiss, #906); a large move was a camera pan (keep open). */
  #stagePressStart: { x: number; y: number } | null = null

  constructor(stage: HTMLElement) {
    this.#stage = stage
    this.#onDocMousedown = (event: MouseEvent): void => {
      if (this.#element === null) return
      const target = event.target as Node | null
      if (target !== null && (this.#element.contains(target) || this.#anchor?.contains(target))) {
        return // click inside the popover or its anchor — keep open
      }
      // In-canvas DRAGS must not dismiss: dragging the background PANS the
      // camera while the popover stays put. But a plain CLICK on the background
      // is the universal "get me out" gesture (#906) — so record where an
      // in-stage background press started and decide on mouseup by movement.
      // Card presses are exempt (clicking another node re-opens via open()).
      if (target !== null && this.#stage.contains(target)) {
        // Only the bare canvas counts as "background": presses on cards or any
        // in-stage control (Fit, zoom, wires toggle…) must not dismiss.
        const interactive =
          target instanceof Element &&
          target.closest('.fb-node, button, fl-button, input, select, textarea, a, [role="button"]') !== null
        this.#stagePressStart = interactive ? null : { x: event.clientX, y: event.clientY }
        return
      }
      this.close()
      this.#handlers?.onClose()
    }
    this.#onDocMouseup = (event: MouseEvent): void => {
      const start = this.#stagePressStart
      this.#stagePressStart = null
      if (start === null || this.#element === null) return
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (moved < 6) {
        this.close()
        this.#handlers?.onClose()
      }
    }
  }

  get isOpen(): boolean {
    return this.#element !== null
  }

  /** Open (or re-anchor) the popover for `content`, anchored to `anchor`.
   *  `key` identifies the underlying node — the board's own node id — so a
   *  later `showFiles(key, ...)` call can confirm it still targets this
   *  same open popover before mutating its DOM. */
  open(anchor: HTMLElement, content: PopoverContent, handlers: PopoverHandlers, key: string): void {
    // A REFRESH of the same node (the board reopens the popover after every git
    // status round, #898 — and a full stage rebuild tears it down in between,
    // #buildBoard) must not read as a new open: carry the reader's tab and
    // scroll across it (#1029). A different node starts clean.
    const live = this.#element !== null && this.#openKey === key
    const sameNode = live || this.#stateKey === key
    const carriedTab = sameNode ? this.#activeTab : null
    const carriedUserSelected = sameNode && this.#tabUserSelected
    const carriedScroll = live ? (this.#element?.scrollTop ?? 0) : sameNode ? this.#carriedScroll : 0
    this.close()
    this.#stateKey = key
    if (this.#pendingKey !== key) {
      this.#pending.clear()
      this.#pendingKey = key
    }
    this.#activeTab = carriedTab
    this.#tabUserSelected = carriedUserSelected
    this.#carriedScroll = carriedScroll
    this.#scrollPending = carriedScroll > 0
    this.#anchor = anchor
    this.#handlers = handlers
    this.#openKey = key
    const element = this.#render(content, handlers)
    this.#element = element
    this.#stage.appendChild(element)
    this.#position(anchor, element)
    this.#restoreCarriedScroll()
    // Defer the outside-click listener so the opening click doesn't self-close.
    document.addEventListener('mousedown', this.#onDocMousedown)
    document.addEventListener('mouseup', this.#onDocMouseup)
    // Move focus to the first action for keyboard reach — on a FRESH open only.
    // A background refresh re-opens the same node; grabbing focus there would
    // yank it out of whatever the user moved it to (the #1045 ownership rule).
    if (!sameNode) element.querySelector<HTMLButtonElement>('.fb-popover-action')?.focus()
  }

  /**
   * Prepend a change-preview header to the popover (blueprint-simulation): the
   * preview walk lives at the TOP of the module it's describing, not a floating
   * card. Keyed like showFiles so a stale call for a since-closed/re-anchored
   * popover no-ops. Replaces any prior header on this open.
   */
  showPreviewHeader(key: string, header: HTMLElement): void {
    if (this.#element === null || this.#openKey !== key) return
    this.#element.querySelector('.fb-preview-header')?.remove()
    this.#element.insertBefore(header, this.#element.firstChild)
    this.#element.classList.add('fb-popover-previewing')
  }

  /**
   * Patch a module node's Files section into the popover — the board fetches
   * `project:listDir` async after `open()` returns and calls this once it
   * resolves. No-ops when the popover has since closed or re-anchored to a
   * different node (`key` mismatch) — the classic "response for a question
   * nobody's asking anymore" race. Inserted just above the actions row.
   */
  showFiles(key: string, result: FileListResult, onFileClick: (relPath: string) => void): void {
    if (this.#element === null || this.#openKey !== key || result.files.length === 0) return
    if (this.#element.querySelector('.fb-popover-files')) return // already shown for this open
    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-files'
    const heading = document.createElement('div')
    heading.className = 'fb-popover-heading'
    heading.textContent = 'Files'
    section.appendChild(heading)
    for (const file of result.files) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'fb-popover-file'
      const gitClass = file.gitState ? GIT_STATE_CLASS[file.gitState] : undefined
      if (gitClass !== undefined) row.classList.add(gitClass)
      row.textContent = file.name
      row.title = file.gitState ? `${file.relPath} · ${file.gitState}` : file.relPath
      row.addEventListener('click', () => onFileClick(file.relPath))
      section.appendChild(row)
    }
    if (result.overflow > 0) {
      const more = document.createElement('div')
      more.className = 'fb-popover-more'
      more.textContent = `…and ${result.overflow} more`
      section.appendChild(more)
    }
    // Files live in the Files tab; drop the section heading (the tab labels it).
    section.querySelector('.fb-popover-heading')?.remove()
    const panel = this.#element.querySelector('.fb-popover-tabpanel[data-tab="files"]')
    panel?.appendChild(section)
    this.#revealTab('files')
  }

  /**
   * Activate a tab by key (no-op when hidden/absent). Every caller is a
   * DELIBERATE user path — clicking a must-review badge to read its items,
   * or being moved off an emptied Review tab after acknowledging it — so the
   * selection is recorded as the user's and survives later refreshes (#1029).
   */
  activateTab(key: string): void {
    if (this.#element === null) return
    const btn = this.#element.querySelector<HTMLElement>(`.fb-popover-tab[data-tab="${key}"]`)
    if (btn === null || btn.hidden) return
    this.#activateTabIn(this.#element, key, { user: true })
  }

  /**
   * Set an async trigger's state (#1028). The popover owns it — keyed by node,
   * re-applied on every rebuild — so a finished action can never leave its
   * button stuck on "Generating…", and a rebuild mid-flight can't lose it.
   */
  setActionState(key: string, action: PopoverAsyncAction, state: PopoverAsyncActionState): void {
    if (this.#pendingKey !== key) {
      this.#pending.clear()
      this.#pendingKey = key
    }
    if (state === 'idle') this.#pending.delete(action)
    else this.#pending.set(action, state)
    if (this.#element === null || this.#openKey !== key) return
    this.#applyActionState(this.#element, action, state)
  }

  /** Paint one async trigger's label + disabled flag from its state. */
  #applyActionState(root: HTMLElement, action: PopoverAsyncAction, state: PopoverAsyncActionState): void {
    const button = root.querySelector<HTMLButtonElement>(`.${ASYNC_ACTION_CLASS[action]}`)
    if (button === null) return
    // The gesture hint (if any) rides the button as a child element — only the
    // leading text node is the label, so rewrite that rather than textContent.
    button.textContent = ASYNC_ACTION_LABEL[action][state]
    button.disabled = state === 'busy'
  }

  /** Re-apply every live pending state onto a freshly built popover (#1028). */
  #applyPendingActions(root: HTMLElement): void {
    for (const [action, state] of this.#pending) this.#applyActionState(root, action, state)
  }

  /** Wire an async trigger: pressing it enters `busy` through the SAME state the
   *  board later clears, so no branch can leave the button lying (#1028). */
  #bindAsyncAction(button: HTMLButtonElement, action: PopoverAsyncAction, run: () => void): void {
    button.addEventListener('click', () => {
      if (button.disabled) return
      if (this.#openKey !== null) this.setActionState(this.#openKey, action, 'busy')
      run()
    })
  }

  /** An actions-row trigger that runs an async generation (#1028). */
  #buildAsyncAction(action: PopoverAsyncAction, title: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `fb-popover-action ${ASYNC_ACTION_CLASS[action]}`
    button.textContent = ASYNC_ACTION_LABEL[action].idle
    button.title = title
    this.#bindAsyncAction(button, action, run)
    return button
  }

  /**
   * Patch (or REFRESH — unlike the other tabs this one re-renders on every
   * call) the module's Changes tab (#898): its changed files with per-file
   * ✓ stage-toggle / ✕ reject-with-feedback / name→diff, plus a module-level
   * "Approve all". Approval IS staging — rows re-render from fresh git state
   * after every action via the board's git:changed refresh.
   *
   * `lead` is the board's #898 "the changeset is engaged, lead with Changes"
   * signal. It is a LEAD, not a command: it wins on a fresh open and loses to a
   * tab the user picked themselves, so a background file write refreshes these
   * rows without yanking the reader off the tab they chose (#1029).
   */
  showChanges(
    key: string,
    rows: PopoverChangeRow[],
    handlers: PopoverChangesHandlers,
    extras?: PopoverChangesExtras,
    lead = false,
  ): void {
    if (this.#element === null || this.#openKey !== key) return
    const panel = this.#element.querySelector<HTMLElement>('.fb-popover-tabpanel[data-tab="changes"]')
    if (panel === null) return
    panel.textContent = ''
    if (rows.length === 0) {
      // Clean module: the tab hides, and whoever was reading it moves on.
      const button = this.#element.querySelector<HTMLElement>('.fb-popover-tab[data-tab="changes"]')
      if (button !== null) button.hidden = true
      this.#applyTabSelection(this.#element, null)
      this.#restoreCarriedScroll()
      this.#scrollPending = false
      return
    }

    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-changes'

    const unstaged = rows.filter((row) => !row.staged)
    const header = document.createElement('div')
    header.className = 'fb-popover-changes-head'
    const stagedCount = rows.length - unstaged.length
    const label = document.createElement('span')
    label.className = 'fb-popover-heading'
    label.textContent = `Changed files (${stagedCount}/${rows.length} approved)`
    header.appendChild(label)
    if (unstaged.length > 0) {
      const approveAll = document.createElement('button')
      approveAll.type = 'button'
      approveAll.className = 'fb-popover-approve-all'
      approveAll.textContent = `Approve all (${unstaged.length})`
      approveAll.title = 'Stage every changed file of this module'
      approveAll.addEventListener('click', () =>
        handlers.onApproveAll(unstaged.map((row) => row.filePath)),
      )
      header.appendChild(approveAll)
    }
    section.appendChild(header)

    for (const row of rows) {
      const line = document.createElement('div')
      line.className = 'fb-popover-change-row'
      if (row.staged) line.classList.add('fb-change-staged')

      const name = document.createElement('button')
      name.type = 'button'
      name.className = 'fb-popover-change-name'
      const gitClass = GIT_STATE_CLASS[row.state]
      if (gitClass !== undefined) name.classList.add(gitClass)
      name.textContent = row.name
      name.title = `${row.filePath} · ${row.state} — open diff`
      name.addEventListener('click', () => handlers.onOpenDiff(row.filePath))

      const stage = document.createElement('button')
      stage.type = 'button'
      stage.className = 'fb-popover-change-stage'
      stage.textContent = '✓'
      stage.title = row.staged ? 'Unstage (un-approve)' : 'Approve — stages the file in git'
      stage.setAttribute('aria-label', `${row.staged ? 'Unstage' : 'Approve'} ${row.filePath}`)
      stage.addEventListener('click', () => handlers.onToggleStage(row.filePath, !row.staged))

      const reject = document.createElement('button')
      reject.type = 'button'
      reject.className = 'fb-popover-change-reject'
      reject.textContent = '✕'
      reject.title = 'Reject — revert and ask the agent to redo (with your feedback)'
      reject.setAttribute('aria-label', `Reject ${row.filePath}`)
      reject.addEventListener('click', () => {
        // Inline feedback: the reject is destructive AND messages the agent, so
        // it always carries the reviewer's words (never a silent revert).
        if (line.querySelector('.fb-popover-reject-form') !== null) return
        const form = document.createElement('div')
        form.className = 'fb-popover-reject-form'
        const input = document.createElement('input')
        input.type = 'text'
        input.placeholder = 'Why? (sent to the agent)'
        input.className = 'fb-popover-reject-input'
        const send = document.createElement('button')
        send.type = 'button'
        send.className = 'fb-popover-reject-send'
        send.textContent = 'Reject'
        send.addEventListener('click', () => {
          const feedback = input.value.trim()
          if (feedback.length === 0) {
            input.focus()
            return
          }
          handlers.onReject(row.filePath, feedback)
          form.remove()
        })
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'fb-popover-reject-cancel'
        cancel.textContent = 'Cancel'
        cancel.addEventListener('click', () => form.remove())
        form.append(input, send, cancel)
        line.appendChild(form)
        input.focus()
      })

      line.append(name, stage, reject)
      section.appendChild(line)
    }

    // Advisory invariant findings (#898 FR9) — amber, informational, never a
    // gate: approval above stays enabled regardless of what the checker found.
    if (extras !== undefined && (extras.findings.length > 0 || extras.notes.length > 0)) {
      const findingsBlock = document.createElement('div')
      findingsBlock.className = 'fb-popover-findings'
      for (const finding of extras.findings) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `fb-popover-finding fb-finding-${finding.verdict}`
        row.title = `${finding.evidence || finding.invariant} — open diff`
        const glyph = document.createElement('span')
        glyph.className = 'fb-popover-finding-glyph'
        glyph.textContent = '\u26A0'
        const text = document.createElement('span')
        text.className = 'fb-popover-finding-text'
        text.textContent = `${finding.verdict}: ${finding.invariant}`
        row.append(glyph, text)
        row.addEventListener('click', () => handlers.onOpenDiff(finding.filePath))
        findingsBlock.appendChild(row)
      }
      for (const note of extras.notes) {
        const line = document.createElement('div')
        line.className = 'fb-popover-invariant-note'
        line.textContent = note
        findingsBlock.appendChild(line)
      }
      section.appendChild(findingsBlock)
    }
    panel.appendChild(section)
    this.#revealTab('changes')
    this.#applyTabSelection(this.#element, lead ? 'changes' : null)
    this.#restoreCarriedScroll()
    this.#scrollPending = false
  }

  /**
   * Fill (async, after open) an endpoint-group card's Routes list (#901): the
   * concrete operations rolled into the card — `GET /api/documents`, `query
   * getChats` — each row peeking its defining file. Appended to the Overview
   * panel (group cards have no module tabs).
   */
  showRoutes(
    key: string,
    routes: Array<{ label: string; sourceFile: string }>,
    onOpenFile: (relPath: string) => void,
  ): void {
    if (this.#element === null || this.#openKey !== key) return
    const panel = this.#element.querySelector<HTMLElement>('.fb-popover-tabpanel[data-tab="overview"]')
    if (panel === null || panel.querySelector('.fb-popover-routes') !== null) return
    if (routes.length === 0) return

    // Big group cards roll up hundreds of routes (#905 follow-up): the list is
    // a bounded SCROLL container with a substring filter; the first page caps
    // at INITIAL_ROWS and "Show all" expands to the full list. Filtering
    // searches the whole set and expands implicitly.
    const INITIAL_ROWS = 40
    let query = ''
    let expanded = false

    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-routes'
    const heading = document.createElement('div')
    heading.className = 'fb-popover-heading'
    section.appendChild(heading)

    if (routes.length > 12) {
      const filter = document.createElement('input')
      filter.type = 'search'
      filter.className = 'fb-popover-route-filter'
      filter.placeholder = `Filter ${routes.length} routes…`
      filter.addEventListener('input', () => {
        query = filter.value
        renderRows()
      })
      section.appendChild(filter)
    }

    const list = document.createElement('div')
    list.className = 'fb-popover-route-list'
    section.appendChild(list)

    const renderRows = (): void => {
      const q = query.trim().toLowerCase()
      const matched = q === '' ? routes : routes.filter((route) => route.label.toLowerCase().includes(q))
      heading.textContent =
        q === '' ? `Routes (${routes.length})` : `Routes (${matched.length}/${routes.length})`
      const visible = expanded || q !== '' ? matched : matched.slice(0, INITIAL_ROWS)

      const rows: HTMLElement[] = []
      for (const route of visible) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'fb-popover-route'
        row.textContent = route.label
        row.title = `${route.sourceFile} — open`
        row.addEventListener('click', () => onOpenFile(route.sourceFile))
        rows.push(row)
      }
      if (matched.length === 0) {
        const none = document.createElement('div')
        none.className = 'fb-popover-invariant-note'
        none.textContent = 'No routes match'
        rows.push(none)
      }
      if (!expanded && q === '' && matched.length > INITIAL_ROWS) {
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'fb-popover-route-more'
        more.textContent = `Show all (${matched.length - INITIAL_ROWS} more)`
        more.addEventListener('click', () => {
          expanded = true
          renderRows()
        })
        rows.push(more)
      }
      list.replaceChildren(...rows)
    }
    renderRows()

    panel.appendChild(section)
    // Routes ARE the group card's content — reveal the overview tab and lead
    // with it even when an async sibling (Connections) claimed the tab first.
    // A LEAD, not a command: a tab the user picked outranks it (#1029).
    this.#revealTab('overview')
    this.#applyTabSelection(this.#element, 'overview')
  }

  /**
   * Peer card panel (federation): every cross-link row is EXPANDABLE — the
   * evidence a confirm decision needs lives one click away: which consumer
   * files make the call (peekable), via which env base, and where the provider
   * exposes it (jumpable into the provider project). ✓/✕ act on informed rows
   * and give immediate in-row feedback.
   */
  showPeerLinks(
    key: string,
    data: {
      provider: string
      proposed: Array<{
        endpoint: string
        confidence: string
        files: string[]
        calls?: Array<{ file: string; base: string; baseIsEnv: boolean; path: string }>
        providerFile?: string
      }>
      confirmed: Array<{
        endpoint: string
        status: string
        files: string[]
        calls?: Array<{ file: string; base: string; baseIsEnv: boolean; path: string }>
        providerFile?: string
      }>
      surfaceDerivedAt: string
      canRefresh: boolean
      canOpenProject: boolean
    },
    handlers: {
      onDecide: (endpoint: string, decide: 'confirm' | 'reject') => void
      onRefreshSibling: () => void
      onPeekFile: (relPath: string) => void
      onOpenFile?: (relPath: string) => void
      onOpenSibling: (providerFile: string | null) => void
    },
  ): void {
    if (this.#element === null || this.#openKey !== key) return
    const panel = this.#element.querySelector<HTMLElement>('.fb-popover-tabpanel[data-tab="overview"]')
    if (panel === null || panel.querySelector('.fb-popover-peer') !== null) return

    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-peer'

    const head = document.createElement('div')
    head.className = 'fb-popover-changes-head'
    const heading = document.createElement('div')
    heading.className = 'fb-popover-heading'
    const vintage = data.surfaceDerivedAt === '' ? 'surface never derived' : `surface ${data.surfaceDerivedAt.slice(0, 10)}`
    heading.textContent = `Consumed (${data.confirmed.length} confirmed · ${data.proposed.length} proposed) · ${vintage}`
    head.appendChild(heading)
    if (data.canOpenProject) {
      const openProject = document.createElement('button')
      openProject.type = 'button'
      openProject.className = 'fb-popover-approve-all'
      openProject.textContent = `Open ${data.provider} ↗`
      openProject.title = `Switch to the ${data.provider} project`
      openProject.addEventListener('click', () => handlers.onOpenSibling(null))
      head.appendChild(openProject)
    }
    if (data.canRefresh) {
      const refresh = document.createElement('button')
      refresh.type = 'button'
      refresh.className = 'fb-popover-approve-all'
      refresh.textContent = '⟳ Refresh'
      refresh.title = 'Re-derive the sibling in the background, then rematch'
      refresh.addEventListener('click', () => handlers.onRefreshSibling())
      head.appendChild(refresh)
    }
    section.appendChild(head)

    const confidenceStory = (confidence: string): string => {
      if (confidence === 'high') return `the env base names ${data.provider} — strong signal`
      if (confidence === 'manual') return 'linked manually by you'
      return 'path match only — check the call before confirming'
    }

    /** One expandable link row: header line (▸ endpoint + actions) + an
     *  evidence block showing both sides of the wire on demand. */
    const buildRow = (
      link: {
        endpoint: string
        files: string[]
        calls?: Array<{ file: string; base: string; baseIsEnv: boolean; path: string }>
        providerFile?: string
      },
      opts: { proposed: boolean; confidence?: string; stale?: boolean },
    ): HTMLElement => {
      const wrap = document.createElement('div')
      wrap.className = `fb-peer-link${opts.proposed ? ' fb-peer-proposed' : ''}`

      const row = document.createElement('div')
      row.className = 'fb-popover-change-row fb-peer-link-head'
      const caret = document.createElement('span')
      caret.className = 'fb-peer-caret'
      caret.textContent = '▸'
      const name = document.createElement('span')
      name.className = 'fb-popover-change-name'
      name.textContent = `${opts.proposed ? '◌' : '●'} ${link.endpoint}${opts.stale ? ' (stale — call no longer found)' : ''}`
      name.title = 'Show the evidence — who calls it, and where it lives'
      row.append(caret, name)

      const evidence = document.createElement('div')
      evidence.className = 'fb-peer-evidence'
      evidence.hidden = true
      const buildEvidence = (): void => {
        if (evidence.childElementCount > 0) return
        if (opts.confidence !== undefined) {
          const why = document.createElement('div')
          why.className = 'fb-peer-why'
          why.textContent = `Why proposed: ${confidenceStory(opts.confidence)}`
          evidence.appendChild(why)
        }
        const calls = link.calls ?? []
        if (calls.length > 0) {
          for (const call of calls.slice(0, 6)) {
            const callRow = document.createElement('button')
            callRow.type = 'button'
            callRow.className = 'fb-peer-call'
            const shortFile = call.file.split('/').slice(-2).join('/')
            callRow.textContent = `↳ ${shortFile} — ${call.baseIsEnv ? `\u0024{env:${call.base}}` : call.base}${call.path}`
            callRow.title = `${call.file} — peek the calling code · ⌘/Ctrl-click opens in editor`
            callRow.addEventListener('click', (event) =>
              openOrPeek(event, call.file, handlers.onOpenFile, handlers.onPeekFile),
            )
            evidence.appendChild(callRow)
          }
          if (calls.length > 6) {
            const more = document.createElement('div')
            more.className = 'fb-peer-why'
            more.textContent = `…and ${calls.length - 6} more call site(s)`
            evidence.appendChild(more)
          }
        } else if (link.files.length > 0) {
          for (const file of link.files.slice(0, 4)) {
            const callRow = document.createElement('button')
            callRow.type = 'button'
            callRow.className = 'fb-peer-call'
            callRow.textContent = `↳ ${file.split('/').slice(-2).join('/')}`
            callRow.title = `${file} — peek the calling code · ⌘/Ctrl-click opens in editor`
            callRow.addEventListener('click', (event) =>
              openOrPeek(event, file, handlers.onOpenFile, handlers.onPeekFile),
            )
            evidence.appendChild(callRow)
          }
        } else {
          const none = document.createElement('div')
          none.className = 'fb-peer-why'
          none.textContent = 'No recorded call sites (linked manually).'
          evidence.appendChild(none)
        }
        const providerRow = document.createElement('button')
        providerRow.type = 'button'
        providerRow.className = 'fb-peer-call fb-peer-provider'
        if (link.providerFile !== undefined) {
          providerRow.textContent = `⇱ ${data.provider} exposes it at ${link.providerFile}`
          providerRow.title = `Open ${data.provider} and peek the exposing code`
          providerRow.addEventListener('click', () => handlers.onOpenSibling(link.providerFile ?? null))
        } else {
          providerRow.textContent = `⇱ not found in ${data.provider}'s current graph — open the project to check`
          providerRow.title = `Switch to the ${data.provider} project`
          providerRow.addEventListener('click', () => handlers.onOpenSibling(null))
        }
        evidence.appendChild(providerRow)
      }

      row.addEventListener('click', () => {
        buildEvidence()
        evidence.hidden = !evidence.hidden
        caret.textContent = evidence.hidden ? '▸' : '▾'
      })

      if (opts.proposed) {
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.className = 'fb-popover-change-stage'
        confirm.textContent = '✓'
        confirm.title = 'Confirm — this project really consumes this endpoint'
        const reject = document.createElement('button')
        reject.type = 'button'
        reject.className = 'fb-popover-change-reject'
        reject.textContent = '✕'
        reject.title = 'Reject — a false match; it will not be re-proposed'
        const decide = (choice: 'confirm' | 'reject') => (event: Event) => {
          event.stopPropagation() // decision buttons never toggle the evidence
          confirm.remove()
          reject.remove()
          const pending = document.createElement('span')
          pending.className = 'fb-peer-pending'
          pending.textContent = choice === 'confirm' ? 'confirming…' : 'rejecting…'
          row.appendChild(pending)
          handlers.onDecide(link.endpoint, choice)
        }
        confirm.addEventListener('click', decide('confirm'))
        reject.addEventListener('click', decide('reject'))
        row.append(confirm, reject)
      }

      wrap.append(row, evidence)
      return wrap
    }

    for (const link of data.proposed) {
      section.appendChild(buildRow(link, { proposed: true, confidence: link.confidence }))
    }
    for (const link of data.confirmed) {
      section.appendChild(buildRow(link, { proposed: false, stale: link.status === 'stale' }))
    }

    panel.appendChild(section)
    this.#revealTab('overview')
    this.#applyTabSelection(this.#element, 'overview')
  }

  /**
   * Patch the Connections section (blueprint-connections) into the popover —
   * "Used by (N)" + "Uses (M)" with per-row usage counts and jump-to-code. The
   * board computes it synchronously right after open() and calls this. No-ops on
   * a key mismatch (popover moved), when there's nothing to show, or when already
   * rendered. Inserted just above the actions row (above any later Files section).
   */
  showConnections(
    key: string,
    connections: Connections,
    onRowClick: (nodeId: string, sourceFile: string | null) => void,
  ): void {
    if (this.#element === null || this.#openKey !== key) return
    if (connections.usedBy.length === 0 && connections.uses.length === 0) return
    if (this.#element.querySelector('.fb-popover-connections')) return

    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-connections'

    const addGroup = (title: string, rows: ConnectionRow[]): void => {
      if (rows.length === 0) return
      const heading = document.createElement('div')
      heading.className = 'fb-popover-heading'
      heading.textContent = `${title} (${rows.length})`
      section.appendChild(heading)
      for (const row of rows) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'fb-popover-conn-row'
        // Provenance (blueprint-connections): graphify `calls`-only connections
        // read secondary; native imports/uses/exposes read as fact.
        if (row.provenance === 'graphify') button.classList.add('fb-conn-graphify')

        const main = document.createElement('span')
        main.className = 'fb-popover-conn-main'
        const label = document.createElement('span')
        label.className = 'fb-popover-conn-label'
        label.textContent = row.label
        main.appendChild(label)
        if (row.detail !== undefined) {
          const detail = document.createElement('span')
          detail.className = 'fb-popover-conn-detail'
          detail.textContent = row.detail
          main.appendChild(detail)
        }

        const count = document.createElement('span')
        count.className = 'fb-popover-conn-count'
        count.textContent = String(row.count)
        count.title = `${row.count} ${row.provenance} connection${row.count === 1 ? '' : 's'}`
        button.append(main, count)
        button.title = row.sourceFile ?? row.nodeId
        button.addEventListener('click', () => onRowClick(row.nodeId, row.sourceFile))
        section.appendChild(button)
      }
    }

    addGroup('Used by', connections.usedBy)
    addGroup('Uses', connections.uses)

    const panel = this.#element.querySelector('.fb-popover-tabpanel[data-tab="connections"]')
    panel?.appendChild(section)
    this.#revealTab('connections')
  }

  /**
   * Patch a learned module's understanding SUMMARY into the Understanding section
   * — the board reads the module doc async (project:readFile) after open() and
   * calls this so the section shows what the module IS, not just "Learned" + a
   * link (#understanding-summary). No-ops on a key mismatch (popover moved), an
   * empty summary, or when a note summary is already shown. Inserted right after
   * the freshness line.
   */
  showLearnSummary(key: string, summary: string): void {
    if (this.#element === null || this.#openKey !== key || summary === '') return
    const section = this.#element.querySelector('.fb-popover-learning')
    if (section === null) return
    if (section.querySelector('.fb-popover-learn-note')) return // a summary is already shown
    const note = document.createElement('div')
    note.className = 'fb-popover-learn-note'
    note.textContent = summary
    const statusRow = section.querySelector('.fb-popover-learn-status')
    if (statusRow?.nextSibling) {
      section.insertBefore(note, statusRow.nextSibling)
    } else {
      section.appendChild(note)
    }
  }

  /** Re-anchor the open popover to its card's current screen position — called
   *  when the board camera pans/zooms, since #position reads getBoundingClientRect
   *  (the anchor's post-transform screen rect) (#514). No-op when closed. */
  reposition(): void {
    if (this.#element === null || this.#anchor === null) return
    this.#position(this.#anchor, this.#element)
  }

  close(options?: { preserveState?: boolean }): void {
    if (this.#element === null) return
    // FOCUS GOES BACK WHERE IT CAME FROM. Removing the element while it holds
    // focus drops a keyboard user onto <body> — Esc out of a popover landed
    // them at the top of the document instead of on the card they opened it
    // from. Only when the popover actually held focus: a click elsewhere has
    // already moved it, and stealing it back would yank the caret out of
    // whatever was clicked into. (A rebuild teardown whose anchor is about to
    // leave the DOM makes this a harmless no-op — a detached focus() does
    // nothing, which is exactly the old behavior.)
    const active = document.activeElement
    const returnTo = active !== null && this.#element.contains(active) ? this.#anchor : null
    document.removeEventListener('mousedown', this.#onDocMousedown)
    document.removeEventListener('mouseup', this.#onDocMouseup)
    this.#stagePressStart = null
    this.#element.remove()
    this.#element = null
    this.#anchor = null
    this.#handlers = null
    this.#openKey = null
    returnTo?.focus({ preventScroll: true })
    // Tab/scroll memory survives a REBUILD teardown (the board re-renders the
    // stage under an open popover and immediately reopens it) but not a real
    // dismissal — `#stateKey` keeps it bound to its own node either way (#1029).
    // Pending async state is keyed by node and outlives the element (#1028).
    if (options?.preserveState !== true) {
      this.#stateKey = null
      this.#activeTab = null
      this.#tabUserSelected = false
      this.#carriedScroll = 0
      this.#scrollPending = false
    }
  }

  dispose(): void {
    this.close()
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  #render(content: PopoverContent, handlers: PopoverHandlers): HTMLElement {
    const root = document.createElement('div')
    root.className = 'fb-popover'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', `${content.label} details`)
    if (content.ghost) root.classList.add('fb-popover-ghost')

    // Eyebrow + label + id.
    const eyebrow = document.createElement('div')
    eyebrow.className = 'fb-popover-eyebrow'
    eyebrow.textContent = content.eyebrow
    root.appendChild(eyebrow)

    const label = document.createElement('div')
    label.className = 'fb-popover-label'
    label.textContent = content.label
    root.appendChild(label)

    if (content.id !== null) {
      const id = document.createElement('div')
      id.className = 'fb-popover-id'
      id.textContent = content.id
      root.appendChild(id)
    }

    // Ghost lifecycle + plan badge.
    if (content.ghost) {
      const ghostRow = document.createElement('div')
      ghostRow.className = 'fb-popover-ghostline'
      const state = content.ghostState ? GHOST_STATE_LABEL[content.ghostState] : 'proposal'
      const dot = document.createElement('span')
      dot.className = 'fb-popover-ghost-state'
      dot.textContent = `◌ ${state}`
      ghostRow.appendChild(dot)
      if (content.planBadge !== null) {
        const plan = document.createElement('span')
        plan.className = 'fb-popover-plan'
        plan.textContent = content.planBadge
        ghostRow.appendChild(plan)
      }
      root.appendChild(ghostRow)
    }

    // ── Tabs (Overview / Connections / Review / Files) — content-gated ────────
    // One component, organized: the module's detail lives in tabs so a god node
    // (14 uses, must-review, files) never renders as a screen-tall list. Overview
    // holds features + understanding; Connections/Files fill in async (their tabs
    // reveal when populated); Review appears only when the node is badged.
    const tabbar = document.createElement('div')
    tabbar.className = 'fb-popover-tabbar'
    // Real tab semantics (shared tab-bar module): tablist/tab roles and
    // Arrow/Home/End roving; selection syncs in #activateTabIn.
    tabbar.setAttribute('role', 'tablist')
    tabbar.setAttribute('aria-label', `${content.label} sections`)
    attachTabBarKeys(tabbar)
    const panels = document.createElement('div')
    panels.className = 'fb-popover-tabpanels'
    const panelOf = (key: string): HTMLElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fb-popover-tab'
      btn.dataset.tab = key
      btn.textContent = key.charAt(0).toUpperCase() + key.slice(1)
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', 'false')
      btn.addEventListener('click', () => this.#activateTabIn(root, key, { user: true }))
      const panel = document.createElement('div')
      panel.className = 'fb-popover-tabpanel'
      panel.dataset.tab = key
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-label', btn.textContent)
      tabbar.appendChild(btn)
      panels.appendChild(panel)
      return panel
    }
    panelOf('changes') // filled by showChanges while the changeset mode is live (#898)
    const overviewPanel = panelOf('overview')
    panelOf('connections') // filled async by showConnections
    const reviewPanel = panelOf('review')
    panelOf('files') // filled async by showFiles

    // Review panel (#910) — rich must-review rows: severity chip + title +
    // detail, plus the acknowledge action that records the review.
    if (content.reviewRows.length > 0) {
      const section = document.createElement('div')
      section.className = 'fb-popover-section fb-popover-review'
      const heading = document.createElement('div')
      heading.className = 'fb-popover-heading'
      heading.textContent = `Must review (${content.reviewRows.length})`
      section.appendChild(heading)
      for (const item of content.reviewRows) {
        const row = document.createElement('div')
        row.className = 'fb-popover-review-row'
        const sev = document.createElement('span')
        sev.className = `fb-popover-review-sev fb-rsev-${item.severity}`
        sev.textContent = item.severity
        const text = document.createElement('div')
        text.className = 'fb-popover-review-text'
        const title = document.createElement('div')
        title.className = 'fb-popover-review-title'
        title.textContent = item.title
        text.appendChild(title)
        if (item.detail !== '') {
          const detail = document.createElement('div')
          detail.className = 'fb-popover-review-detail'
          detail.textContent = item.detail
          detail.title = item.detail
          text.appendChild(detail)
        }
        row.append(sev, text)
        section.appendChild(row)
      }
      if (handlers.onReviewSummary !== undefined) {
        const summarize = document.createElement('button')
        summarize.type = 'button'
        summarize.className = `fb-popover-approve-all ${ASYNC_ACTION_CLASS['review-summary']}`
        summarize.textContent = ASYNC_ACTION_LABEL['review-summary'].idle
        summarize.title =
          'Generate a markdown summary of this change — what it is, where it lives, what to check — saved to flow/brain/reviews/ and opened for reading'
        // Pending state lives in the popover, not on the button (#1028): the
        // board clears it on BOTH branches, so a delivered summary can never
        // leave the trigger reading "Generating…" forever.
        this.#bindAsyncAction(summarize, 'review-summary', () => handlers.onReviewSummary?.())
        section.appendChild(summarize)
      }
      if (handlers.onMarkReviewed !== undefined) {
        const ack = document.createElement('button')
        ack.type = 'button'
        ack.className = 'fb-popover-approve-all fb-popover-mark-reviewed'
        ack.textContent = 'Mark reviewed'
        ack.title = 'Record these as reviewed — the agent learns the change was seen; the badge clears on the next derive'
        ack.addEventListener('click', () => handlers.onMarkReviewed?.())
        section.appendChild(ack)
      }
      reviewPanel.appendChild(section)
    } else if (content.reviewReasons.length > 0) {
      reviewPanel.appendChild(this.#buildSection('Must review', content.reviewReasons, 'fb-popover-review'))
    }

    // Overview panel — annotations, features, understanding.
    if (content.annotations.length > 0) {
      const section = document.createElement('div')
      section.className = 'fb-popover-section'
      const heading = document.createElement('div')
      heading.className = 'fb-popover-heading'
      heading.textContent = 'Annotations'
      section.appendChild(heading)
      for (const annotation of content.annotations) {
        const row = document.createElement('div')
        row.className = 'fb-popover-annotation'
        if (annotation.stale) row.classList.add('fb-popover-stale')
        const type = document.createElement('span')
        type.className = 'fb-popover-anno-type'
        type.textContent = annotation.type
        const text = document.createElement('span')
        text.className = 'fb-popover-anno-text'
        text.textContent = annotation.stale ? `${annotation.text} (stale)` : annotation.text
        row.append(type, text)
        if (annotation.peekPath !== null) {
          const peekPath = annotation.peekPath
          const peek = document.createElement('button')
          peek.type = 'button'
          peek.className = 'fb-popover-anno-peek'
          peek.title = `Peek ${peekPath}`
          peek.setAttribute('aria-label', `Peek ${peekPath}`)
          peek.textContent = '⌕'
          peek.addEventListener('click', (event) => {
            event.stopPropagation()
            // Keep the popover open while previewing so the phase walk survives
            // a file peek (the peek uses a separate pane).
            if (!this.#element?.classList.contains('fb-popover-previewing')) this.close()
            openOrPeek(event, peekPath, handlers.onOpenFile, handlers.onPeekFile)
          })
          row.appendChild(peek)
        }
        section.appendChild(row)
      }
      if (content.moreAnnotations > 0) {
        const more = document.createElement('div')
        more.className = 'fb-popover-more'
        more.textContent = `…and ${content.moreAnnotations} more`
        section.appendChild(more)
      }
      overviewPanel.appendChild(section)
    }
    if (content.features.length > 0) {
      const section = document.createElement('div')
      section.className = 'fb-popover-section'
      const heading = document.createElement('div')
      heading.className = 'fb-popover-heading'
      heading.textContent = content.features.length === 1 ? 'Feature' : 'Features'
      section.appendChild(heading)
      const chips = document.createElement('div')
      chips.className = 'fb-popover-features'
      for (const feature of content.features) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'fb-popover-feature'
        chip.textContent = feature.slug
        chip.title = `Open the ${feature.slug} story`
        chip.addEventListener('click', () => handlers.onOpenStory(feature.docPath))
        chips.appendChild(chip)
      }
      section.appendChild(chips)
      overviewPanel.appendChild(section)
    }
    if (content.learning !== null) {
      overviewPanel.appendChild(this.#buildLearningSection(content.learning, handlers))
    }
    // THE GROUND UNDER A FEATURE (Phase 8) — below Understanding, because it is
    // the question a reader asks NEXT: not "is this understood" but "what is it
    // built on, and does anyone know that code".
    if (content.ground !== null) {
      overviewPanel.appendChild(this.#buildGroundSection(content.ground, handlers))
    }

    root.appendChild(tabbar)
    root.appendChild(panels)
    // Hide empty tabs (connections/files are empty until their async fill), then
    // activate the first visible one.
    for (const btn of tabbar.querySelectorAll<HTMLElement>('.fb-popover-tab')) {
      const panel = panels.querySelector<HTMLElement>(`.fb-popover-tabpanel[data-tab="${btn.dataset.tab}"]`)
      if (panel !== null && panel.childElementCount === 0) btn.hidden = true
    }
    // Fresh open → first visible tab; a same-node rebuild → whatever the reader
    // was on, when it still exists (#1029). No automatic lead at build time —
    // the Changes tab is still empty here; `showChanges` leads once it fills.
    this.#applyTabSelection(root, null)

    // Actions row.
    const actions = document.createElement('div')
    actions.className = 'fb-popover-actions'
    if (content.canDrill) {
      const drill = this.#buildAction('Drill ▸', 'Zoom into this module’s children', () => {
        this.close()
        handlers.onDrill()
      })
      // Teach the shortcut where the user is already looking (live UX ask):
      // the gesture hint rides the button like a menu keyboard hint.
      const hint = document.createElement('span')
      hint.className = 'fb-popover-gesture-hint'
      hint.textContent = 'double-click'
      drill.appendChild(hint)
      actions.appendChild(drill)
    }
    if (handlers.onExplainUsage !== undefined) {
      // Same async-trigger contract as Review in depth (#1028) — it drives the
      // identical reviewSummary pipeline and had the identical wedge risk.
      const explain = this.#buildAsyncAction(
        'explain-usage',
        'Generate a doc: what this is, which modules use it, what to check — saved to flow/brain/reviews/ and opened',
        () => handlers.onExplainUsage?.(),
      )
      actions.appendChild(explain)
    }
    actions.appendChild(
      this.#buildAction('Attach to chat ⊕', 'Attach this node to the chat composer', () => {
        this.close()
        handlers.onAttach()
      }),
    )
    root.appendChild(actions)

    // A generation still in flight for this node keeps its trigger in the busy
    // state across the rebuild — the state is the popover's, not the button's.
    this.#applyPendingActions(root)

    return root
  }

  /** Show one tab's panel, hide the rest; mark the active tab button. Records
   *  WHO chose it — a user click sticks, an automatic lead doesn't (#1029). */
  #activateTabIn(root: HTMLElement, key: string, options?: { user?: boolean }): void {
    const bar = root.querySelector<HTMLElement>('.fb-popover-tabbar')
    if (bar !== null) syncTabSelection(bar, 'fb-popover-tab-active', key)
    for (const panel of root.querySelectorAll<HTMLElement>('.fb-popover-tabpanel')) {
      panel.hidden = panel.dataset.tab !== key
    }
    this.#activeTab = key
    if (options?.user === true) this.#tabUserSelected = true
  }

  /**
   * Put the reader back where they were reading after a same-node rebuild
   * (#1029). Applied twice — once when the element mounts and once when the
   * synchronous Changes fill lands, since the popover is often too short to
   * hold the offset until its tallest panel exists. Only ever runs for a
   * carried offset, so it can never fight a fresh scroll.
   */
  #restoreCarriedScroll(): void {
    if (!this.#scrollPending || this.#element === null) return
    this.#element.scrollTop = this.#carriedScroll
  }

  /** Tab keys whose button is currently selectable, in tab-bar order. */
  #visibleTabs(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll<HTMLElement>('.fb-popover-tab'))
      .filter((btn) => !btn.hidden && btn.dataset.tab !== undefined)
      .map((btn) => btn.dataset.tab as string)
  }

  /**
   * Run the ONE tab decision (`resolveActiveTab`) against the live DOM: an
   * automatic `lead` applies only while the user hasn't picked a tab of their
   * own, and a refresh otherwise holds whatever is showing (#1029).
   */
  #applyTabSelection(root: HTMLElement, lead: string | null): void {
    const next = resolveActiveTab({
      visible: this.#visibleTabs(root),
      active: this.#activeTab,
      userSelected: this.#tabUserSelected,
      lead,
    })
    if (next !== null) this.#activateTabIn(root, next)
  }

  /** Reveal an async-filled tab (connections/files) and activate it if none is. */
  #revealTab(key: string): void {
    if (this.#element === null) return
    const btn = this.#element.querySelector<HTMLElement>(`.fb-popover-tab[data-tab="${key}"]`)
    if (btn === null) return
    btn.hidden = false
    if (this.#element.querySelector('.fb-popover-tab-active') === null) {
      this.#activateTabIn(this.#element, key)
    }
  }

  #buildSection(heading: string, lines: string[], modifier: string): HTMLElement {
    const section = document.createElement('div')
    section.className = `fb-popover-section ${modifier}`
    const head = document.createElement('div')
    head.className = 'fb-popover-heading'
    head.textContent = heading
    section.appendChild(head)
    for (const line of lines) {
      const row = document.createElement('div')
      row.className = 'fb-popover-line'
      row.textContent = line
      section.appendChild(row)
    }
    return section
  }

  /** The "Understanding" section: freshness line, note summary, doc link, and a
   *  Learn / Re-learn button (omitted while a pass is in flight). */
  #buildLearningSection(learning: PopoverLearning, handlers: PopoverHandlers): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-learning'
    const heading = document.createElement('div')
    heading.className = 'fb-popover-heading'
    heading.textContent = 'Understanding'
    section.appendChild(heading)

    // Status / freshness line — status label plus the learned-at date when known.
    const statusRow = document.createElement('div')
    statusRow.className = 'fb-popover-learn-status'
    if (learning.status === 'stale') statusRow.classList.add('fb-popover-learn-stale')
    const label = LEARN_STATUS_LABEL[learning.status ?? 'none']
    statusRow.textContent = learning.learnedAt ? `${label} · ${formatLearnedAt(learning.learnedAt)}` : label
    section.appendChild(statusRow)

    // Active investigation-note summary (a stale note preferred upstream).
    if (learning.noteSummary !== undefined) {
      const note = document.createElement('div')
      note.className = 'fb-popover-learn-note'
      note.textContent = learning.noteSummary
      section.appendChild(note)
    }

    // Module doc link (learned/stale only) — clicking peeks the learned write-up
    // in the read-only drawer, the same affordance the Files rows + annotation
    // peeks use. It was previously an inert <div> (no handler), so the path
    // rendered like a link but clicking it did nothing (#blueprint-doc-open).
    if (learning.docHint !== undefined) {
      const docPath = learning.docHint
      const doc = document.createElement('button')
      doc.type = 'button'
      doc.className = 'fb-popover-learn-doc'
      doc.textContent = docPath
      doc.title = `Peek ${docPath} · ⌘/Ctrl-click opens in editor`
      doc.addEventListener('click', (event) =>
        openOrPeek(event, docPath, handlers.onOpenFile, handlers.onPeekFile),
      )
      section.appendChild(doc)
    }

    // Learn / Update button — fire-and-forget; the dot flips via the watcher.
    if (learning.action !== null) {
      const text = LEARN_ACTION_LABEL[learning.action]
      const title =
        learning.action === 'relearn'
          ? 'Refresh this module’s understanding'
          : 'Build understanding of this module'
      const button = this.#buildAction(text, title, () => {
        this.close()
        handlers.onLearn()
      })
      button.classList.add('fb-popover-learn-btn')
      section.appendChild(button)
    }

    return section
  }

  /**
   * The "Ground" section: the modules this feature stands on, each with the
   * status pill the Learning panel already uses, and one action that learns the
   * ones nobody has read.
   *
   * THE SAME PILLS, DELIBERATELY. A third vocabulary for learned/stale/none on
   * a third surface is how the same fact comes to be stated three ways; these
   * are `.fb-learn-pill fb-learn-<status>`, unchanged from the panel row.
   *
   * The action names its COUNT, so pressing it is a decision rather than a
   * surprise, and it is absent when there is nothing left to learn.
   */
  #buildGroundSection(ground: PopoverGround, handlers: PopoverHandlers): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fb-popover-section fb-popover-ground'
    const heading = document.createElement('div')
    heading.className = 'fb-popover-heading'
    heading.textContent = 'Ground'
    section.appendChild(heading)

    if (ground.emptyNote !== null) {
      const empty = document.createElement('div')
      empty.className = 'fb-popover-line'
      empty.textContent = ground.emptyNote
      section.appendChild(empty)
      return section
    }

    for (const row of ground.modules) {
      const line = document.createElement('div')
      line.className = 'fb-popover-ground-row'
      const pill = document.createElement('span')
      pill.className = `fb-learn-pill fb-learn-${row.status}`
      pill.textContent = row.status
      const name = document.createElement('span')
      name.className = 'fb-popover-ground-module'
      name.textContent = row.module
      line.append(pill, name)
      section.appendChild(line)
    }

    const unlearned = ground.unlearned
    if (unlearned.length > 0 && handlers.onLearnGround !== undefined) {
      const learn = handlers.onLearnGround
      const button = this.#buildAction(
        `Learn ground (${String(unlearned.length)})`,
        'Read the modules under this feature that nobody has read yet',
        () => {
          this.close()
          learn(unlearned)
        },
      )
      button.classList.add('fb-popover-ground-btn')
      section.appendChild(button)
    }
    return section
  }

  #buildAction(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fb-popover-action'
    button.textContent = text
    button.title = title
    button.addEventListener('click', onClick)
    return button
  }

  /**
   * Place the popover to the right of the anchor when it fits, else to its left,
   * clamped inside the stage so it never spills past the drafting sheet edges.
   * All geometry is relative to the stage (both are position:relative/absolute).
   */
  #position(anchor: HTMLElement, element: HTMLElement): void {
    const stageRect = this.#stage.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const popRect = element.getBoundingClientRect()

    const anchorLeft = anchorRect.left - stageRect.left
    const anchorTop = anchorRect.top - stageRect.top
    const anchorRight = anchorLeft + anchorRect.width

    let left = anchorRight + ANCHOR_GAP
    if (left + popRect.width > stageRect.width - EDGE_INSET) {
      left = anchorLeft - ANCHOR_GAP - popRect.width // flip to the left side
    }
    left = clamp(left, EDGE_INSET, Math.max(EDGE_INSET, stageRect.width - popRect.width - EDGE_INSET))

    let top = anchorTop
    top = clamp(top, EDGE_INSET, Math.max(EDGE_INSET, stageRect.height - popRect.height - EDGE_INSET))

    element.style.left = `${left}px`
    element.style.top = `${top}px`
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** ISO timestamp → YYYY-MM-DD for the freshness line; passes junk through raw. */
function formatLearnedAt(iso: string): string {
  const date = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : iso
}
