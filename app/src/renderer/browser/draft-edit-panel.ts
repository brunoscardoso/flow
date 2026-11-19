/**
 * THE DRAFT EDIT PANEL — beside the built-in browser's page, outside the
 * webview, for one picked element of a UI draft.
 *
 * It shows the element's kind and screen, then Text (when the text can change
 * in place), Background, Text colour and Border (a colour swatch and a hex
 * field each), Padding and Margin (four small number fields each), an "Ask the
 * agent" button and a status line. Each field commits on its own: text on blur
 * or Enter, a swatch when the picker closes, a hex field on blur or Enter, a
 * number on change. What to send and what to say is decided by
 * `draft-edit-model.ts`; this file only draws and reports.
 */
import type { DraftElementFacts } from '../../shared/draft-pick'
import type { DraftEdit, DraftWriteAnswer } from '../../shared/ui-drafts'
import {
  DRAFT_SIDES,
  draftColourEdit,
  draftKindLabel,
  draftPanelFields,
  draftPanelSeed,
  draftSpacingEdit,
  draftStatusText,
  draftTextEdit,
  hexOfColour,
  type DraftEditResult,
} from './draft-edit-model'

export interface DraftEditPanelCallbacks {
  /** Send one edit to main; answers what main said. */
  onEdit(edit: DraftEdit): Promise<DraftWriteAnswer>
  onAsk(): void
  onClose(): void
}

/** What the panel shows: the element and the screen it is on. */
export interface DraftPanelContent {
  facts: DraftElementFacts
  screenTitle: string
}

export class DraftEditPanel {
  readonly element: HTMLElement
  #body: HTMLElement
  #status: HTMLElement
  #callbacks: DraftEditPanelCallbacks
  #content: DraftPanelContent | null = null
  /** Bumped on every show, so a late answer for a previous element is dropped. */
  #generation = 0

  constructor(callbacks: DraftEditPanelCallbacks) {
    ensurePanelStyles()
    this.#callbacks = callbacks
    this.element = document.createElement('aside')
    this.element.className = 'fl-draft-panel'
    this.element.hidden = true
    this.element.setAttribute('aria-label', 'Change this element')
    this.#body = document.createElement('div')
    this.#body.className = 'fl-draft-panel-body'
    this.#status = document.createElement('div')
    this.#status.className = 'fl-draft-panel-status'
    this.#status.setAttribute('role', 'status')
    this.element.append(this.#body, this.#status)
  }

  get open(): boolean {
    return !this.element.hidden
  }

  /** The element on show, if any. */
  get content(): DraftPanelContent | null {
    return this.#content
  }

  show(content: DraftPanelContent): void {
    this.#content = content
    this.#generation += 1
    this.#render(content)
    this.#setStatus('')
    this.element.hidden = false
  }

  hide(): void {
    this.#content = null
    this.#generation += 1
    this.element.hidden = true
    this.#body.textContent = ''
  }

  #setStatus(text: string, bad = false): void {
    this.#status.textContent = text
    this.#status.classList.toggle('bad', bad)
  }

  /** Validate, send, and say what happened. */
  #commit(result: DraftEditResult): void {
    if (!result.ok) {
      this.#setStatus(result.reason, true)
      return
    }
    const generation = this.#generation
    this.#setStatus('Saving…')
    void this.#callbacks
      .onEdit(result.edit)
      .catch((): DraftWriteAnswer => ({ ok: false, reason: 'The change could not be saved.' }))
      .then((answer) => {
        if (generation !== this.#generation) return
        this.#setStatus(draftStatusText(answer), !answer.ok)
      })
  }

  #render(content: DraftPanelContent): void {
    const { facts } = content
    const fields = draftPanelFields(facts)
    const seed = draftPanelSeed(facts)
    this.#body.textContent = ''

    const head = document.createElement('div')
    head.className = 'fl-draft-panel-head'
    const titles = document.createElement('div')
    titles.className = 'fl-draft-panel-titles'
    const kind = document.createElement('div')
    kind.className = 'fl-draft-panel-kind'
    kind.textContent = draftKindLabel(facts)
    const screen = document.createElement('div')
    screen.className = 'fl-draft-panel-screen'
    screen.textContent = content.screenTitle
    titles.append(kind, screen)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'fl-draft-panel-close'
    close.setAttribute('aria-label', 'Close')
    close.title = 'Close'
    close.textContent = '×'
    close.addEventListener('click', () => this.#callbacks.onClose())
    head.append(titles, close)
    this.#body.append(head)

    if (fields.text) {
      const text = document.createElement('textarea')
      text.className = 'fl-draft-panel-text'
      text.rows = 2
      text.value = seed.text
      text.spellcheck = false
      let committed = seed.text
      const commitText = (): void => {
        if (text.value === committed) return
        committed = text.value
        this.#commit(draftTextEdit(facts.id, text.value))
      }
      text.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          commitText()
        }
      })
      text.addEventListener('blur', commitText)
      this.#body.append(section('Text', text))
    }

    for (const field of fields.colours) {
      const row = document.createElement('div')
      row.className = 'fl-draft-panel-colour'
      const swatch = document.createElement('input')
      swatch.type = 'color'
      swatch.className = 'fl-draft-panel-swatch'
      swatch.setAttribute('aria-label', `${field.label} colour`)
      const hex = document.createElement('input')
      hex.type = 'text'
      hex.className = 'fl-draft-panel-hex'
      hex.spellcheck = false
      hex.setAttribute('aria-label', `${field.label} value`)
      hex.dataset.property = field.property
      const start = seed.colours[field.property]
      swatch.value = start.length > 0 ? start : '#000000'
      hex.value = start
      hex.placeholder = start.length > 0 ? '' : 'none'
      let committed = start
      const commitColour = (value: string): void => {
        if (value.trim() === committed) return
        committed = value.trim()
        const result = draftColourEdit(facts.id, field.property, value)
        if (result.ok && result.edit.kind === 'colour') {
          const shown = hexOfColour(result.edit.value)
          if (shown.length > 0) swatch.value = shown
        }
        this.#commit(result)
      }
      // `change` fires when the picker closes — the end of the input, not every drag step.
      swatch.addEventListener('change', () => {
        hex.value = swatch.value
        commitColour(swatch.value)
      })
      hex.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitColour(hex.value)
        }
      })
      hex.addEventListener('blur', () => commitColour(hex.value))
      row.append(swatch, hex)
      this.#body.append(section(field.label, row))
    }

    for (const box of ['padding', 'margin'] as const) {
      const row = document.createElement('div')
      row.className = 'fl-draft-panel-sides'
      for (const side of DRAFT_SIDES) {
        const input = document.createElement('input')
        input.type = 'number'
        input.min = '0'
        input.step = '1'
        input.className = 'fl-draft-panel-side'
        input.dataset.box = box
        input.dataset.side = side
        input.setAttribute('aria-label', `${box === 'padding' ? 'Padding' : 'Margin'} ${side}`)
        input.title = side.charAt(0).toUpperCase() + side.slice(1)
        input.value = seed[box][side]
        input.addEventListener('change', () => this.#commit(draftSpacingEdit(facts.id, box, side, input.value)))
        row.append(input)
      }
      this.#body.append(section(box === 'padding' ? 'Padding' : 'Margin', row))
    }

    const ask = document.createElement('button')
    ask.type = 'button'
    ask.className = 'fl-draft-panel-ask'
    ask.textContent = 'Ask the agent'
    ask.addEventListener('click', () => this.#callbacks.onAsk())
    this.#body.append(ask)
  }
}

function section(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'fl-draft-panel-section'
  const name = document.createElement('div')
  name.className = 'fl-draft-panel-label'
  name.textContent = label
  wrap.append(name, control)
  return wrap
}

const PANEL_STYLE_ID = 'fl-draft-panel-styles'

function ensurePanelStyles(): void {
  if (document.getElementById(PANEL_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = PANEL_STYLE_ID
  style.textContent = `
    .fl-draft-panel {
      flex: none;
      width: 248px;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-md, 12px);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-draft-panel[hidden] { display: none; }
    .fl-draft-panel-body { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-draft-panel-head { display: flex; align-items: flex-start; gap: var(--fl-space-xs); }
    .fl-draft-panel-titles { flex: 1; min-width: 0; }
    .fl-draft-panel-kind { font-weight: var(--fl-text-ui-weight-medium, 600); }
    .fl-draft-panel-screen { color: var(--fl-color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-draft-panel-close {
      border: 0; background: transparent; color: var(--fl-color-text-secondary); cursor: pointer;
      font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: var(--fl-radius-sm);
    }
    .fl-draft-panel-close:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-draft-panel-section { display: flex; flex-direction: column; gap: 4px; }
    .fl-draft-panel-label { color: var(--fl-color-text-secondary); font-size: 11px; }
    .fl-draft-panel input, .fl-draft-panel textarea {
      min-width: 0;
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      padding: 4px 6px;
      box-sizing: border-box;
    }
    .fl-draft-panel input:focus, .fl-draft-panel textarea:focus { outline: none; border-color: var(--fl-color-accent); }
    .fl-draft-panel-text { resize: vertical; width: 100%; }
    .fl-draft-panel-colour { display: flex; gap: var(--fl-space-xs); align-items: center; }
    .fl-draft-panel input.fl-draft-panel-swatch { width: 28px; height: 26px; padding: 2px; flex: none; cursor: pointer; }
    .fl-draft-panel-hex { flex: 1; font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-draft-panel-sides { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
    .fl-draft-panel-side { width: 100%; text-align: center; }
    .fl-draft-panel-ask {
      margin-top: var(--fl-space-xs);
      height: 28px;
      border: 0;
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-accent);
      color: #fff;
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium, 600);
      cursor: pointer;
    }
    .fl-draft-panel-status { min-height: 1.4em; color: var(--fl-color-text-secondary); font-size: 11px; line-height: 1.4; }
    .fl-draft-panel-status.bad { color: var(--fl-color-danger, #dc2626); }
  `
  document.head.appendChild(style)
}
