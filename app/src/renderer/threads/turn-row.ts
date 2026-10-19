/**
 * Turn row — the ONE line a settled turn leaves behind for everything the
 * agent did: `Ran 12 tools · 2 failed · 3 files edited`.
 *
 * The screenshots that started this work (discovery `chat-feed-signal`) show
 * sixteen `Bash grep -n …` rows around four sentences of the agent's own
 * words, with five failed commits hidden among them. `tool-group-card.ts`
 * beside this file already folds a RUN — a contiguous streak of one tool on
 * one file — and it did not move that number, because a reader reads TURNS.
 * So this row folds the other axis, and the group card becomes what it reveals.
 *
 * Two rules the design hangs on:
 *
 *   1. It is the QUIETEST thing in the feed, not another card. Secondary text,
 *      no raised fill, no border — a tool card's 28px line has a ground and an
 *      edge precisely so it reads as an object, and a row that summarises
 *      twelve of them must not shout twelve times as loud. The agent's prose
 *      stays the loudest thing on screen, which is the entire point of folding.
 *
 *   2. Collapsed is not SILENT. Letting failures fold is the risky half of
 *      this design — screenshot 1 is a picture of five failed commits being
 *      missed inside a wall of successes, and a summary row is a smaller wall.
 *      So the `· N failed` segment carries `--fl-color-error` on the row's own
 *      face, and a reader can decide whether to open it without opening it.
 *
 * The words come from `turnSummaryLabel` (`turn-summary.ts`) and are never
 * re-derived here: this file is the view, that one is the model — the same
 * split `tool-group-card.ts` / `tool-group-model.ts` already keep.
 *
 * Like a tool group, a turn row carries NO `dataset.entryId`. The pane's
 * reconcile harvest reuses entry elements by that key, and a row whose
 * contents are a fold over several entries has no single entry to be. It
 * rebuilds every time, and its inner cards stay registered in the pane's
 * `#toolCards` so live update, expand-restore and the withheld-output load
 * (allowed-pattern #18) still reach them through two levels of nesting.
 */
import type { TurnSummary } from './turn-summary'
import { turnSummaryLabel } from './turn-summary'
import { turnRowSegments } from './turn-row-model'

export class TurnRow {
  readonly element: HTMLElement
  #detail: HTMLDivElement
  #label!: HTMLSpanElement
  #header: HTMLElement
  #expanded: boolean
  #onToggle: (expanded: boolean) => void

  /**
   * @param summary   the turn's facts (`turnSummary`) — the row's words and
   *                  its error tint both come from these
   * @param children  the elements an expanded turn reveals: today's grouped
   *                  units and lone tool cards, built by the pane exactly as
   *                  they are built outside a turn (nothing is replaced)
   * @param options   `expanded` is the INITIAL state and is deliberately not
   *                  routed through `onToggle` — a turn is born open because it
   *                  is live (NFR-3: the reader watching an agent work must see
   *                  what they see today) or because the reader opened it
   *                  before a reconcile, and neither is a fresh decision to
   *                  record. Only a click reports through `onToggle`.
   */
  constructor(
    summary: TurnSummary,
    children: readonly HTMLElement[],
    options: { expanded?: boolean; onToggle?: (expanded: boolean) => void } = {},
  ) {
    injectTurnRowStyles()
    this.#onToggle = options.onToggle ?? ((): void => {})
    this.#expanded = options.expanded ?? false

    this.element = document.createElement('div')
    this.element.className = 'fl-turn-row'
    this.element.dataset['status'] = summary.status

    const header = document.createElement('div')
    this.#header = header
    header.className = 'fl-turn-row-header'
    header.setAttribute('role', 'button')
    header.tabIndex = 0

    const label = document.createElement('span')
    label.className = 'fl-turn-row-label'
    this.#label = label
    header.appendChild(label)
    this.#renderLabel(summary)

    const toggle = (): void => this.setExpanded(!this.#expanded)
    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    this.#detail = document.createElement('div')
    this.#detail.className = 'fl-turn-row-detail'
    for (const child of children) this.#detail.appendChild(child)

    this.element.append(header, this.#detail)
    this.#applyExpanded()
  }

  get expanded(): boolean {
    return this.#expanded
  }

  /**
   * Redraw the line from a new summary — a LIVE turn grows while it runs.
   *
   * A running turn used to render every one of its rows, so a reader could
   * watch. Three reports later the answer was the opposite one: show the least
   * that still tells the truth. So the live turn folds like a finished one and
   * this row IS the indicator — its count climbs, its status carries the
   * spinner, and `· N failed` appears the moment something does.
   */
  update(summary: TurnSummary): void {
    this.element.dataset['status'] = summary.status
    this.#renderLabel(summary)
  }

  /** Take one more rendered child into the fold, without reopening it. */
  addChild(child: HTMLElement): void {
    this.#detail.appendChild(child)
  }

  /** Where a live run's cards are appended, so the pane's existing grouping can
   *  fold INSIDE the turn exactly as it folds in the feed. */
  get detail(): HTMLElement {
    return this.#detail
  }

  #renderLabel(summary: TurnSummary): void {
    this.#label.textContent = ''
    const segments = turnRowSegments(summary)
    segments.forEach((segment, index) => {
      if (index > 0) {
        const separator = document.createElement('span')
        separator.className = 'fl-turn-row-sep'
        separator.textContent = String.fromCharCode(183)
        this.#label.appendChild(separator)
      }
      const span = document.createElement('span')
      if (segment.failed) span.className = 'fl-turn-row-failed'
      span.textContent = segment.text
      this.#label.appendChild(span)
    })
    // The whole line as one string for the tooltip and the accessible name —
    // the visual split into spans is presentation, and a screen reader must
    // still hear "Ran 12 tools · 2 failed · 3 files edited" as one sentence.
    const plain = turnSummaryLabel(summary)
    this.#label.title = plain
    this.#header.setAttribute('aria-label', plain)
  }

  /** Open or close the turn. Reports through `onToggle` so the pane can
   *  remember the reader's choice across a history reconcile — a rebuild
   *  mid-read must not slam shut a turn someone opened. */
  setExpanded(value: boolean): void {
    this.#expanded = value
    this.#applyExpanded()
    this.#onToggle(value)
  }

  /**
   * Open the turn WITHOUT reporting it as a choice the reader made.
   *
   * The reconcile re-opens a turn because one of its cards was open before the
   * rebuild — that is restoring a state, not expressing a new one. Routing it
   * through `setExpanded` fired `onToggle` and pinned the turn in
   * `#expandedTurns` for the rest of the session, which contradicts the pane's
   * own rule that a turn opened FOR the reader is never recorded as opened BY
   * them. Same distinction the constructor's `expanded` option already draws.
   */
  reveal(): void {
    if (this.#expanded) return
    this.#expanded = true
    this.#applyExpanded()
  }

  #applyExpanded(): void {
    this.#detail.hidden = !this.#expanded
    this.element.classList.toggle('expanded', this.#expanded)
    this.#header.setAttribute('aria-expanded', String(this.#expanded))
  }
}

// ── Styles (light DOM) ───────────────────────────────────────────────────────

let turnRowStylesInjected = false

function injectTurnRowStyles(): void {
  if (turnRowStylesInjected) {
    return
  }
  turnRowStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-turn-row {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
    }
    .fl-turn-row-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      height: 28px;
      /* No ground and no edge, unlike .fl-tool-group-header: this row stands
         for twelve cards and must read quieter than one of them. */
      padding: 0 var(--fl-space-xs);
      border-radius: var(--fl-radius-row);
      cursor: pointer;
      user-select: none;
      overflow: hidden;
      white-space: nowrap;
      color: var(--fl-color-text-secondary);
    }
    .fl-turn-row-header:hover { background: var(--fl-color-surface-raised); }
    .fl-turn-row-header::before {
      /* The same disclosure caret the group header uses, so two levels of fold
         read as the same affordance rather than two inventions. */
      content: '';
      flex: none;
      width: 0;
      height: 0;
      border-left: 4px solid var(--fl-color-text-secondary);
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      transition: transform 0.12s ease;
    }
    .fl-turn-row.expanded .fl-turn-row-header::before {
      transform: rotate(90deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .fl-turn-row-header::before { transition: none; }
    }
    .fl-turn-row-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-turn-row-sep { padding: 0 var(--fl-space-xs); }
    .fl-turn-row-failed { color: var(--fl-color-error); }
    .fl-turn-row-detail {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      /* A hairline for the nesting, on the container rather than the row —
         the row itself stays unadorned. */
      margin-left: var(--fl-space-xs);
      padding-left: var(--fl-space-sm);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
    }
  `
  document.head.appendChild(style)
}
