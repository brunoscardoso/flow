/**
 * Conflict review card (conflict-UX v2, Phase 3) — an inline (never modal) card
 * that summarizes the AI's proposed conflict resolutions and lets the user
 * Accept / Reject each one, plus Accept all / Reject all.
 *
 * Cloned from permission-card.ts: a light-DOM <fl-card tone="accent" dense> with
 * a slot="header" header, one row per proposal, and per-row / footer action
 * buttons wired to an injected async responder. When a decision lands the row's
 * buttons collapse into a muted resolution line so the card stays in the
 * transcript as a record of what was decided; once every row is resolved an
 * overall resolution line appears. On a responder error the row's buttons
 * re-enable so the decision can be retried (mirrors PermissionCard.#resolve).
 *
 * This is the COMPONENT only — the wiring into the resolve flow is Phase 4. The
 * DOM-free shaping + immutable transitions live in conflict-review-card-model.ts;
 * this file owns the DOM and never mutates the model in place (it swaps in the
 * new view-model each transition returns).
 */
import '../components'
import {
  buildConflictReviewViewModel,
  decideAll,
  failureText,
  decideRow,
  type ConflictReviewDecision,
  type ConflictReviewInput,
  type ConflictReviewRow,
  type ConflictReviewViewModel,
} from './conflict-review-card-model'

/** Responds to a single-row Accept / Reject. Rejects to signal a failure the
 *  card should recover from (re-enable the row). */
export type ConflictDecisionFn = (
  rowId: string,
  decision: ConflictReviewDecision,
) => Promise<void>

/**
 * Responds to a footer Accept all / Reject all. Resolves with the rowIds it
 * actually decided (accepted or rejected). Rejects to signal a mid-loop failure —
 * the rejection error carries the rowIds decided BEFORE it threw on a
 * `decidedRowIds` property, so the card can reconcile the partial progress
 * (collapse the already-applied rows) instead of re-enabling them.
 */
export type ConflictDecisionAllFn = (decision: ConflictReviewDecision) => Promise<string[]>

/** Pull the rowIds a partially-failed Accept all / Reject all managed to decide
 *  off the thrown error, so the card can mark them resolved (they are already
 *  applied to disk) rather than re-enabling them. Defensive on any error shape. */
function decidedRowIdsFromError(error: unknown): string[] {
  if (error && typeof error === 'object' && 'decidedRowIds' in error) {
    const ids = (error as { decidedRowIds?: unknown }).decidedRowIds
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string')
  }
  return []
}

/** The muted resolution wording for a decided row / the whole card. */
const DECISION_LABELS: Record<ConflictReviewDecision, string> = {
  accept: 'Accepted',
  reject: 'Rejected',
}

/** The per-row DOM handles the card keeps to flip a row between its
 *  interactive (buttons) and resolved (muted line) states. */
interface RowElements {
  actions: HTMLDivElement
  resolution: HTMLDivElement
  buttons: HTMLElement[]
}

export class ConflictReviewCard {
  readonly element: HTMLElement
  #model: ConflictReviewViewModel
  #onDecision: ConflictDecisionFn
  #onDecisionAll: ConflictDecisionAllFn
  #rowEls = new Map<string, RowElements>()
  #footer: HTMLDivElement
  #footerButtons: HTMLElement[] = []
  #overall: HTMLDivElement

  constructor(
    inputs: readonly ConflictReviewInput[],
    onDecision: ConflictDecisionFn,
    onDecisionAll: ConflictDecisionAllFn,
  ) {
    injectConflictReviewCardStyles()
    this.#model = buildConflictReviewViewModel(inputs)
    this.#onDecision = onDecision
    this.#onDecisionAll = onDecisionAll

    const card = document.createElement('fl-card')
    card.setAttribute('tone', 'accent')
    card.setAttribute('dense', '')
    card.className = 'fl-conflict-card'
    this.element = card

    // Header
    const header = document.createElement('div')
    header.slot = 'header'
    header.className = 'fl-conflict-head'
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'git-merge')
    icon.setAttribute('size', '14')
    icon.style.color = 'var(--fl-color-accent)'
    const title = document.createElement('span')
    title.textContent = this.#headerText()
    header.appendChild(icon)
    header.appendChild(title)
    card.appendChild(header)

    // Rows
    const rows = document.createElement('div')
    rows.className = 'fl-conflict-rows'
    for (const row of this.#model.rows) {
      rows.appendChild(this.#renderRow(row))
    }
    card.appendChild(rows)

    // Footer — Accept all / Reject all
    this.#footer = document.createElement('div')
    this.#footer.className = 'fl-conflict-footer'
    this.#footerButtons = [
      this.#footerButton('Accept all', 'accept', 'primary'),
      this.#footerButton('Reject all', 'reject'),
    ]
    for (const button of this.#footerButtons) {
      this.#footer.appendChild(button)
    }
    card.appendChild(this.#footer)

    // Overall resolution line (shown once every row is resolved).
    this.#overall = document.createElement('div')
    this.#overall.className = 'fl-conflict-overall'
    this.#overall.hidden = true
    card.appendChild(this.#overall)

    // An empty proposal set is already resolved — reflect that immediately.
    this.#reflectOverall()
  }

  /** True once every row is accepted / rejected. */
  get resolved(): boolean {
    return this.#model.resolved
  }

  /** Reflect a decision made elsewhere (e.g. resolved from another surface):
   *  mark one row, or every row when `rowId` is omitted, without responding. */
  markResolved(decision: ConflictReviewDecision, rowId?: string): void {
    this.#model = rowId
      ? decideRow(this.#model, rowId, decision)
      : decideAll(this.#model, decision)
    if (rowId) {
      const row = this.#model.rows.find((candidate) => candidate.id === rowId)
      if (row) this.#showRowResolution(row)
    } else {
      for (const row of this.#model.rows) this.#showRowResolution(row)
    }
    this.#reflectOverall()
  }

  #headerText(): string {
    const count = this.#model.summary.proposalCount
    const noun = count === 1 ? 'proposal' : 'proposals'
    return `Resolve with AI — review ${count} ${noun}`
  }

  #renderRow(row: ConflictReviewRow): HTMLElement {
    const el = document.createElement('div')
    el.className = 'fl-conflict-row'
    el.dataset.rowId = row.id

    // Line 1: side chip + choice label + location.
    const head = document.createElement('div')
    head.className = 'fl-conflict-row-head'
    const chip = document.createElement('span')
    chip.className = 'fl-conflict-side'
    chip.textContent = row.sideLabel
    const choice = document.createElement('span')
    choice.className = 'fl-conflict-choice'
    choice.textContent = row.choiceLabel
    // The location doubles as a "jump to hunk" control — clicking opens the file
    // and scrolls the conflict into view so the user reads it in context before
    // Accept/Reject. A real <button> keeps it keyboard-reachable and distinct from
    // the Accept/Reject controls (stopPropagation guards against any bubbling).
    const location = document.createElement('button')
    location.type = 'button'
    location.className = 'fl-conflict-location'
    location.title = 'View in file'
    location.textContent = row.hunkId ? `${row.filePath} · ${row.hunkId}` : row.filePath
    location.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#navigateToRow(row)
    })
    head.append(chip, choice, location)
    el.appendChild(head)

    // Line 2: rationale (why).
    if (row.rationale) {
      const rationale = document.createElement('div')
      rationale.className = 'fl-conflict-rationale'
      rationale.textContent = row.rationale
      el.appendChild(rationale)
    }

    // Line 3: confidence + risk meta.
    const meta = document.createElement('div')
    meta.className = 'fl-conflict-meta'
    const confidence = document.createElement('span')
    confidence.className = 'fl-conflict-confidence'
    confidence.textContent = `confidence ${formatConfidence(row.confidence)}`
    const risk = document.createElement('span')
    risk.className = row.risk === 'safe' ? 'fl-conflict-risk-safe' : 'fl-conflict-risk-warn'
    risk.textContent = row.risk === 'safe' ? 'safe' : 'needs review'
    meta.append(confidence, risk)
    el.appendChild(meta)

    // Actions — Accept / Reject.
    const actions = document.createElement('div')
    actions.className = 'fl-conflict-row-actions'
    const accept = this.#rowButton('Accept', row.id, 'accept', 'primary')
    const reject = this.#rowButton('Reject', row.id, 'reject')
    actions.append(accept, reject)
    el.appendChild(actions)

    const resolution = document.createElement('div')
    resolution.className = 'fl-conflict-row-resolution'
    resolution.hidden = true
    el.appendChild(resolution)

    this.#rowEls.set(row.id, { actions, resolution, buttons: [accept, reject] })
    return el
  }

  /** Open the row's file and scroll its conflict hunk into view. Dispatches the
   *  shared `flow:open-file` navigation channel (the editor module reveals by the
   *  content-derived hunkId) — one navigation path, never a bespoke reveal here. */
  #navigateToRow(row: ConflictReviewRow): void {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', {
        detail: {
          rootPath: row.rootPath,
          relPath: row.filePath,
          ...(row.hunkId !== undefined ? { revealConflictHunkId: row.hunkId } : {}),
        },
      }),
    )
  }

  #rowButton(
    label: string,
    rowId: string,
    decision: ConflictReviewDecision,
    variant?: string,
  ): HTMLElement {
    const button = document.createElement('fl-button')
    button.setAttribute('small', '')
    if (variant) button.setAttribute('variant', variant)
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      void this.#decideRow(rowId, decision)
    })
    return button
  }

  #footerButton(
    label: string,
    decision: ConflictReviewDecision,
    variant?: string,
  ): HTMLElement {
    const button = document.createElement('fl-button')
    button.setAttribute('small', '')
    if (variant) button.setAttribute('variant', variant)
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      void this.#decideAll(decision)
    })
    return button
  }

  async #decideRow(rowId: string, decision: ConflictReviewDecision): Promise<void> {
    const row = this.#model.rows.find((candidate) => candidate.id === rowId)
    const handles = this.#rowEls.get(rowId)
    if (!row || !handles || row.state !== 'pending') return

    this.#setRowDisabled(handles, true)
    try {
      await this.#onDecision(rowId, decision)
    } catch (error) {
      console.error('flow: failed to record conflict decision', error)
      this.#setRowDisabled(handles, false)
      this.#showRowError(handles, error)
      return
    }
    this.#model = decideRow(this.#model, rowId, decision)
    const updated = this.#model.rows.find((candidate) => candidate.id === rowId)
    if (updated) this.#showRowResolution(updated)
    this.#reflectOverall()
  }

  async #decideAll(decision: ConflictReviewDecision): Promise<void> {
    if (this.#model.resolved) return
    this.#setFooterDisabled(true)
    for (const handles of this.#rowEls.values()) {
      this.#setRowDisabled(handles, true)
    }
    try {
      await this.#onDecisionAll(decision)
    } catch (error) {
      console.error('flow: failed to record conflict decision (all)', error)
      // Reconcile partial progress FIRST: any rows the responder actually decided
      // before it threw are already applied to disk. Mark them resolved in the
      // model so they collapse — never re-enable them (a later Reject on an
      // already-accepted row would no-op in the orchestrator while the card lied).
      for (const rowId of decidedRowIdsFromError(error)) {
        this.#model = decideRow(this.#model, rowId, decision)
        const resolvedRow = this.#model.rows.find((candidate) => candidate.id === rowId)
        if (resolvedRow) this.#showRowResolution(resolvedRow)
      }
      this.#setFooterDisabled(false)
      // Re-enable only rows that are still pending — reconciled + previously
      // resolved rows stay collapsed on their decision.
      for (const row of this.#model.rows) {
        if (row.state === 'pending') {
          const handles = this.#rowEls.get(row.id)
          if (handles) this.#setRowDisabled(handles, false)
        }
      }
      this.#showOverallError()
      return
    }
    this.#model = decideAll(this.#model, decision)
    for (const row of this.#model.rows) {
      this.#showRowResolution(row)
    }
    this.#reflectOverall()
  }

  #setRowDisabled(handles: RowElements, disabled: boolean): void {
    for (const button of handles.buttons) {
      if (disabled) button.setAttribute('disabled', '')
      else button.removeAttribute('disabled')
    }
  }

  #setFooterDisabled(disabled: boolean): void {
    for (const button of this.#footerButtons) {
      if (disabled) button.setAttribute('disabled', '')
      else button.removeAttribute('disabled')
    }
  }

  /** Collapse a resolved row's buttons into a muted resolution line. */
  #showRowResolution(row: ConflictReviewRow): void {
    if (row.state === 'pending') return
    const handles = this.#rowEls.get(row.id)
    if (!handles) return
    const decision: ConflictReviewDecision = row.state === 'accepted' ? 'accept' : 'reject'
    handles.actions.hidden = true
    handles.resolution.hidden = false
    handles.resolution.style.color = ''
    handles.resolution.textContent = DECISION_LABELS[decision]
  }

  /** Render a per-row failure WITHOUT collapsing the buttons — the row stays
   *  pending so the decision can be retried.
   *
   *  The responder's OWN message is what the row shows when it has one. This
   *  read "try again" unconditionally, which is wrong precisely when it matters
   *  most: a hunk that no longer exists in the file cannot be retried into
   *  succeeding, and the real fix is re-running Resolve with AI. `failureText`
   *  owns that choice, including the fallback and the length cap. */
  #showRowError(handles: RowElements, error: unknown): void {
    handles.resolution.hidden = false
    handles.resolution.textContent = failureText(error)
    handles.resolution.style.color = 'var(--fl-color-error)'
  }

  /** Once every row is resolved, hide the footer + show the overall line. */
  #reflectOverall(): void {
    if (!this.#model.resolved) return
    this.#footer.hidden = true
    this.#overall.hidden = false
    this.#overall.style.color = ''
    this.#overall.textContent = this.#overallText()
  }

  #overallText(): string {
    const total = this.#model.rows.length
    if (total === 0) return 'No proposals to review'
    const accepted = this.#model.rows.filter((row) => row.state === 'accepted').length
    const rejected = total - accepted
    return `Resolved ${total} — ${accepted} accepted, ${rejected} rejected`
  }

  #showOverallError(): void {
    this.#overall.hidden = false
    this.#overall.textContent = 'Failed to record decisions — try again'
    this.#overall.style.color = 'var(--fl-color-error)'
  }
}

/** Format a 0..1 confidence as a whole percentage, clamped into range. */
function formatConfidence(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return `${Math.round(clamped * 100)}%`
}

// Styles (light DOM)

let conflictReviewCardStylesInjected = false

export function injectConflictReviewCardStyles(): void {
  if (conflictReviewCardStylesInjected) {
    return
  }
  conflictReviewCardStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-conflict-head {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      font-size: var(--fl-text-ui-size);
    }
    .fl-conflict-rows {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
    }
    .fl-conflict-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--fl-space-sm);
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
    }
    .fl-conflict-row-head {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--fl-space-sm);
    }
    .fl-conflict-side {
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-conflict-side-a);
      background: var(--fl-color-conflict-side-a-bg);
      border-radius: var(--fl-radius-sm);
      padding: 1px var(--fl-space-sm);
    }
    .fl-conflict-choice {
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .fl-conflict-location {
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      color: var(--fl-color-text-secondary);
      margin-left: auto;
      appearance: none;
      border: var(--fl-border-width) solid transparent;
      background: transparent;
      padding: 1px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      cursor: pointer;
      transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    .fl-conflict-location:hover {
      color: var(--fl-color-accent);
      background: var(--fl-color-surface-raised);
      border-color: var(--fl-color-border);
      text-decoration: underline;
    }
    .fl-conflict-location:focus-visible {
      outline: none;
      color: var(--fl-color-accent);
      border-color: var(--fl-color-accent);
    }
    .fl-conflict-rationale {
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-conflict-meta {
      display: flex;
      align-items: center;
      gap: var(--fl-space-md);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-conflict-risk-safe { color: var(--fl-color-success); }
    .fl-conflict-risk-warn { color: var(--fl-color-warning); }
    .fl-conflict-row-actions {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      margin-top: 2px;
    }
    .fl-conflict-row-resolution {
      margin-top: 2px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-conflict-footer {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-md);
    }
    .fl-conflict-overall {
      margin-top: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}
