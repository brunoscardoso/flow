/**
 * Tool-group card — collapses a contiguous run of the same tool on the same
 * file into one header (#17). Collapsed, it is a single line that reads like a
 * tool card (`Edited foo.ts · 3 changes` + an aggregate status glyph);
 * expanded, it reveals the individual ToolCard rows, each keeping its own
 * input/output detail.
 *
 * The group OWNS its inner cards' elements but not their lifecycle — the pane
 * keeps every inner card registered in `#toolCards` by id, so live updates,
 * the #179 expand-restore, and the withheld-output load-on-open contract
 * (allowed-pattern #18) all keep working through the group.
 *
 * Grouping and its labels are derived by the pure `tool-group-model.ts`; this
 * file is the view.
 */
import '../components'
import type { ToolCallRecord } from '../../shared/ipc-contract'
import type { IconName } from '../components'
import type { ToolCallStatus } from '../../shared/ipc-contract'
import type { ToolCard } from './tool-card'
import { statusGlyph } from './tool-card'
import { groupStatus } from './tool-group-model'

export class ToolGroupCard {
  readonly element: HTMLElement
  #cards: ToolCard[]
  #detail: HTMLDivElement
  #status: HTMLSpanElement
  #expanded = false
  #onToggle: (expanded: boolean) => void
  #relabel: (records: readonly ToolCallRecord[]) => string
  #labelEl: HTMLSpanElement

  /**
   * @param relabel   computes the collapsed header text from the group's current
   *                  count (edit/write groups use groupHeaderLabel; a context
   *                  run uses contextGroupHeaderLabel) -- called again by
   *                  addCard so a live-growing group's header stays correct
   * @param iconName  the header icon (the shared tool's icon for a file
   *                  group; a generic icon for a mixed context run)
   * @param cards     the ordered inner cards (length >= 2)
   * @param onToggle  notified when the header is toggled, so the pane can
   *                  persist group expansion across a history reconcile
   */
  constructor(
    relabel: (records: readonly ToolCallRecord[]) => string,
    iconName: IconName,
    cards: readonly ToolCard[],
    onToggle: (expanded: boolean) => void = () => {},
  ) {
    injectToolGroupStyles()
    this.#cards = [...cards]
    this.#relabel = relabel
    this.#onToggle = onToggle

    this.element = document.createElement('div')
    this.element.className = 'fl-tool-group'

    // ── Collapsed header ─────────────────────────────────────────────────
    const header = document.createElement('div')
    header.className = 'fl-tool-group-header'
    header.setAttribute('role', 'button')
    header.tabIndex = 0

    const icon = document.createElement('fl-icon')
    icon.setAttribute('size', '13')
    icon.setAttribute('name', iconName)
    icon.className = 'fl-tool-group-icon'

    this.#labelEl = document.createElement('span')
    this.#labelEl.className = 'fl-tool-group-label'
    this.#labelEl.textContent = relabel(cards.map((card) => card.record))
    this.#labelEl.title = this.#labelEl.textContent

    const status = document.createElement('span')
    status.className = 'fl-tool-group-status'
    this.#status = status
    this.#renderStatus()

    header.append(icon, this.#labelEl, status)

    const toggle = (): void => this.setExpanded(!this.#expanded)
    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    // ── Expandable detail — the inner cards ──────────────────────────────
    this.#detail = document.createElement('div')
    this.#detail.className = 'fl-tool-group-detail'
    this.#detail.hidden = true
    for (const card of cards) this.#detail.appendChild(card.element)

    this.element.append(header, this.#detail)
  }

  get expanded(): boolean {
    return this.#expanded
  }

  setExpanded(value: boolean): void {
    this.#expanded = value
    this.#detail.hidden = !value
    this.element.classList.toggle('expanded', value)
    this.#onToggle(value)
  }

  /** Grow a live group with one more card (a tool-start continuing the same
   *  run): appends its element, re-derives the header count and status.
   */
  addCard(card: ToolCard): void {
    this.#cards.push(card)
    this.#detail.appendChild(card.element)
    this.#labelEl.textContent = this.#relabel(this.#cards.map((entry) => entry.record))
    this.#labelEl.title = this.#labelEl.textContent
    this.#renderStatus()
  }

  /** Re-derive the header's aggregate glyph from the inner cards' current
   *  records. A group can be built while one of its calls is still running (a
   *  thread opened mid-turn re-groups the persisted rows); a later live
   *  `tool-end` updates the inner card, and this repaints the header so it
   *  stops spinning without waiting for the end-of-turn reconcile. */
  refreshStatus(): void {
    this.#renderStatus()
  }

  #renderStatus(): void {
    const status = this.#aggregateStatus()
    this.#status.textContent = ''
    this.#status.appendChild(statusGlyph(status))
    this.element.dataset['status'] = status
  }

  #aggregateStatus(): ToolCallStatus {
    return groupStatus(this.#cards.map((card) => card.record.status))
  }
}

// ── Styles (light DOM) ───────────────────────────────────────────────────────

let toolGroupStylesInjected = false

function injectToolGroupStyles(): void {
  if (toolGroupStylesInjected) {
    return
  }
  toolGroupStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-tool-group {
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface-raised);
      overflow: hidden;
    }
    .fl-tool-group-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      height: 28px;
      padding: 0 var(--fl-space-sm);
      cursor: pointer;
      user-select: none;
      overflow: hidden;
      white-space: nowrap;
    }
    .fl-tool-group-header:hover { background: var(--fl-color-surface); }
    .fl-tool-group-header::before {
      /* A small disclosure caret so the header reads as "expand me", unlike a
         single tool card whose whole detail is one call. */
      content: '';
      flex: none;
      width: 0;
      height: 0;
      border-left: 4px solid var(--fl-color-text-secondary);
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      transition: transform 0.12s ease;
    }
    .fl-tool-group.expanded .fl-tool-group-header::before {
      transform: rotate(90deg);
    }
    .fl-tool-group-icon { flex: none; color: var(--fl-color-text-secondary); }
    .fl-tool-group-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .fl-tool-group-status { flex: none; display: inline-flex; align-items: center; }
    .fl-tool-group-detail {
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      padding: var(--fl-space-sm);
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      background: var(--fl-color-bg);
    }
  `
  document.head.appendChild(style)
}
