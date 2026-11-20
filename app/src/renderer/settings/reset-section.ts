/**
 * SETTINGS › APP › RESET FLOW — the closed row, the checkboxes, the dialog.
 *
 * Closed by default: one row and one button. Nothing is read from disk until
 * the button is pressed, so Settings opens as fast as before. Every word and
 * rule comes from `reset-model.ts`; this file only draws and listens.
 *
 * KEPT ALIVE ACROSS RENDERS (settings-view re-renders on every account
 * change), so an open section and its ticks survive an unrelated repaint.
 */
import { RESET_ITEMS, type ResetInventory, type ResetItem } from '../../shared/reset-items'
import { markModalOverlay } from '../modal-overlay'
import {
  RESET_BUTTON,
  RESET_CANCEL,
  RESET_CLEAR,
  RESET_CONFIRM,
  RESET_COPY,
  RESET_FAILED,
  RESET_GROUPS,
  RESET_HIDE,
  RESET_LEAD,
  RESET_OPEN_LABEL,
  RESET_READING,
  RESET_SELECT_ALL,
  RESET_SUMMARY,
  RESET_TITLE,
  RESET_UNREADABLE,
  RESET_WORKING,
  confirmMatches,
  dialogView,
  itemsInGroup,
  orderedSelection,
  outcomeLine,
  selectionLine,
  sizeText,
} from './reset-model'

const STYLE_ID = 'fl-reset-styles'

export class ResetSettingsSection {
  readonly element: HTMLElement
  #open = false
  #selected = new Set<ResetItem>()
  #inventory: ResetInventory | null = null
  #readFailed = false
  #readSeq = 0

  constructor() {
    injectStyles()
    this.element = document.createElement('section')
    this.element.className = 'fl-reset'
    this.element.dataset['section'] = 'reset'
    this.#render()
  }

  #render(): void {
    const head = document.createElement('div')
    head.className = 'fl-reset-head'
    const text = document.createElement('div')
    const title = document.createElement('h3')
    title.className = 'fl-reset-title'
    title.textContent = RESET_TITLE
    const lead = document.createElement('p')
    lead.className = 'fl-reset-lead'
    lead.textContent = this.#open ? RESET_LEAD : RESET_SUMMARY
    text.append(title, lead)
    head.appendChild(text)

    if (!this.#open) {
      const openBtn = button(RESET_OPEN_LABEL, 'fl-reset-btn')
      openBtn.dataset['action'] = 'reset-open'
      openBtn.setAttribute('aria-expanded', 'false')
      openBtn.addEventListener('click', () => {
        this.#open = true
        this.#render()
        void this.#read()
      })
      head.appendChild(openBtn)
      this.element.replaceChildren(head)
      return
    }

    const links = document.createElement('div')
    links.className = 'fl-reset-links'
    const all = linkButton(RESET_SELECT_ALL, () => {
      this.#selected = new Set(RESET_ITEMS)
      this.#render()
    })
    all.dataset['action'] = 'reset-select-all'
    const clear = linkButton(RESET_CLEAR, () => {
      this.#selected.clear()
      this.#render()
    })
    const hide = linkButton(RESET_HIDE, () => {
      this.#open = false
      this.#selected.clear()
      this.#render()
    })
    hide.dataset['action'] = 'reset-hide'
    links.append(all, clear, hide)
    head.appendChild(links)

    const status = document.createElement('p')
    status.className = 'fl-reset-status'
    status.textContent = this.#readFailed ? RESET_UNREADABLE : this.#inventory === null ? RESET_READING : ''
    status.hidden = status.textContent === ''

    const groups = document.createElement('div')
    groups.className = 'fl-reset-groups'
    const rows = new Map((this.#inventory?.rows ?? []).map((row) => [row.item, row]))
    for (const group of RESET_GROUPS) {
      const box = document.createElement('div')
      box.className = 'fl-reset-group'
      const heading = document.createElement('h4')
      heading.textContent = group
      box.appendChild(heading)
      for (const item of itemsInGroup(group)) {
        const copy = RESET_COPY[item]
        const row = rows.get(item)
        const label = document.createElement('label')
        label.className = 'fl-reset-opt'
        label.dataset['item'] = item
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.id = `fl-reset-${item}`
        input.checked = this.#selected.has(item)
        input.addEventListener('change', () => {
          if (input.checked) this.#selected.add(item)
          else this.#selected.delete(item)
          this.#render()
        })
        const name = document.createElement('span')
        name.className = 'fl-reset-name'
        name.textContent = copy.label
        const size = document.createElement('span')
        size.className = 'fl-reset-size'
        size.textContent = sizeText(row)
        const desc = document.createElement('span')
        desc.className = 'fl-reset-desc'
        desc.textContent = copy.description
        label.append(input, name, size, desc)
        if (row?.warning) {
          const flag = document.createElement('span')
          flag.className = 'fl-reset-flag'
          flag.textContent = row.warning
          label.appendChild(flag)
        }
        box.appendChild(label)
      }
      groups.appendChild(box)
    }

    const foot = document.createElement('div')
    foot.className = 'fl-reset-foot'
    const count = document.createElement('span')
    count.textContent = selectionLine(this.#selected)
    const go = button(RESET_BUTTON, 'fl-reset-btn danger')
    go.dataset['action'] = 'reset-selected'
    go.disabled = this.#selected.size === 0
    go.addEventListener('click', () => this.#confirm())
    foot.append(count, go)

    this.element.replaceChildren(head, status, groups, foot)
  }

  async #read(): Promise<void> {
    const seq = ++this.#readSeq
    this.#readFailed = false
    this.#inventory = null
    try {
      const inventory = await window.flow.reset?.inventory({})
      if (seq !== this.#readSeq) return
      if (inventory === undefined) this.#readFailed = true
      else this.#inventory = inventory
    } catch {
      if (seq !== this.#readSeq) return
      this.#readFailed = true
    }
    if (this.#open) this.#render()
  }

  #confirm(): void {
    if (this.#selected.size === 0) return
    const view = dialogView(this.#selected, this.#inventory?.rows ?? [], this.#inventory?.busy ?? null)
    const items = orderedSelection(this.#selected)

    const overlay = document.createElement('div')
    overlay.className = 'fl-reset-overlay'
    markModalOverlay(overlay)
    const dialog = document.createElement('div')
    dialog.className = 'fl-reset-dialog'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', view.title)
    const title = document.createElement('h2')
    title.textContent = view.title
    const lead = document.createElement('p')
    lead.textContent = view.lead
    const list = document.createElement('ul')
    for (const line of view.lines) {
      const li = document.createElement('li')
      const a = document.createElement('span')
      a.textContent = line.label
      const b = document.createElement('span')
      b.textContent = line.size
      li.append(a, b)
      list.appendChild(li)
    }
    dialog.append(title, lead, list)
    for (const text of [...view.warnings, ...(view.busy === null ? [] : [view.busy])]) {
      const warn = document.createElement('p')
      warn.className = 'fl-reset-warn'
      warn.textContent = text
      dialog.appendChild(warn)
    }
    const field = document.createElement('label')
    field.className = 'fl-reset-type'
    field.htmlFor = 'fl-reset-confirm'
    field.textContent = view.typePrompt
    const input = document.createElement('input')
    input.id = 'fl-reset-confirm'
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    const message = document.createElement('p')
    message.className = 'fl-reset-message'
    message.setAttribute('role', 'alert')
    const actions = document.createElement('div')
    actions.className = 'fl-reset-actions'
    const cancel = button(RESET_CANCEL, 'fl-reset-btn')
    const go = button(RESET_CONFIRM, 'fl-reset-btn danger')
    go.dataset['action'] = 'reset-confirm'
    go.disabled = true
    actions.append(cancel, go)
    dialog.append(field, input, message, actions)
    overlay.appendChild(dialog)

    let busy = false
    const close = (): void => {
      if (busy) return
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    input.addEventListener('input', () => {
      go.disabled = !confirmMatches(input.value)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !go.disabled) go.click()
    })
    cancel.addEventListener('click', close)
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close()
    })
    go.addEventListener('click', () => {
      if (!confirmMatches(input.value) || busy) return
      busy = true
      go.disabled = true
      cancel.disabled = true
      go.textContent = RESET_WORKING
      void (async () => {
        const answer = await window.flow.reset?.schedule({ items, confirmed: true }).catch(() => null)
        if (answer?.ok === true) return // the app is restarting
        busy = false
        cancel.disabled = false
        go.textContent = RESET_CONFIRM
        go.disabled = !confirmMatches(input.value)
        message.textContent = answer?.ok === false ? answer.detail : RESET_FAILED
      })()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    cancel.focus()
  }
}

/**
 * The line after a restart that ran a reset: shown once, as a notification.
 * Called at startup; a renderer without the channel says nothing.
 */
export async function announceResetOutcome(): Promise<void> {
  const outcome = await window.flow.reset?.outcome({}).catch(() => null)
  const line = outcomeLine(outcome ?? null)
  if (line === null) return
  document.dispatchEvent(
    new CustomEvent('flow:notify', {
      detail: {
        kind: 'state-change',
        rootId: '',
        title: RESET_TITLE,
        body: line.text,
        timestamp: new Date().toISOString(),
        level: line.failed ? 'error' : 'info',
      },
    }),
  )
}

function button(label: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.textContent = label
  return btn
}

function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = button(label, 'fl-reset-link')
  btn.addEventListener('click', onClick)
  return btn
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-reset {
      margin-top: var(--fl-space-lg);
      padding: var(--fl-space-md);
      border: var(--fl-border-width) solid color-mix(in srgb, var(--fl-color-danger) 35%, var(--fl-color-border));
      border-radius: var(--fl-radius-md);
      display: flex; flex-direction: column; gap: var(--fl-space-md);
    }
    .fl-reset-head { display: flex; justify-content: space-between; align-items: center; gap: var(--fl-space-md); flex-wrap: wrap; }
    .fl-reset-title { margin: 0; font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-reset-lead, .fl-reset-status { margin: 2px 0 0; font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    .fl-reset-links { display: flex; gap: var(--fl-space-md); }
    .fl-reset-link {
      background: none; border: 0; padding: 0; cursor: pointer;
      font: inherit; font-size: var(--fl-text-ui-size); color: var(--fl-color-accent);
    }
    .fl-reset-link:last-child { color: var(--fl-color-text-secondary); }
    .fl-reset-link:focus-visible, .fl-reset-btn:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 2px; }
    .fl-reset-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--fl-space-md) var(--fl-space-xl); }
    .fl-reset-group h4 {
      margin: 0 0 var(--fl-space-xs); font-size: var(--fl-text-caption-size); letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--fl-color-text-secondary); font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-reset-opt {
      display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 2px var(--fl-space-sm);
      padding: 6px; border-radius: var(--fl-radius-sm); align-items: start; cursor: pointer;
    }
    .fl-reset-opt:hover { background: var(--fl-color-surface-raised); }
    .fl-reset-opt input { margin: 2px 0 0; accent-color: var(--fl-color-danger); }
    .fl-reset-name { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    .fl-reset-size { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .fl-reset-desc { grid-column: 2 / 4; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); line-height: var(--fl-line-height); }
    .fl-reset-flag {
      grid-column: 2 / 4; justify-self: start; font-size: var(--fl-text-caption-size); padding: 1px 6px;
      border-radius: var(--fl-radius-sm); color: var(--fl-color-warning);
      background: color-mix(in srgb, var(--fl-color-warning) 14%, transparent);
    }
    .fl-reset-foot {
      display: flex; justify-content: space-between; align-items: center; gap: var(--fl-space-md);
      border-top: var(--fl-border-width) solid var(--fl-color-border); padding-top: var(--fl-space-md);
      font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary);
    }
    .fl-reset-btn {
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); padding: 5px 12px; cursor: pointer;
      border-radius: var(--fl-radius-sm); border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
    }
    .fl-reset-btn.danger { background: var(--fl-color-danger); border-color: var(--fl-color-danger); color: #fff; }
    .fl-reset-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .fl-reset-overlay {
      position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-reset-dialog {
      width: min(500px, calc(100vw - var(--fl-space-xl))); display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-lg); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface); box-shadow: var(--fl-shadow-md); font-family: var(--fl-font-ui); color: var(--fl-color-text);
    }
    .fl-reset-dialog h2 { margin: 0; font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-reset-dialog p { margin: 0; font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); line-height: var(--fl-line-height); }
    .fl-reset-dialog ul {
      list-style: none; margin: 0; padding: var(--fl-space-sm) var(--fl-space-md); display: flex; flex-direction: column; gap: 3px;
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); background: var(--fl-color-bg);
      font-size: var(--fl-text-ui-size);
    }
    .fl-reset-dialog li { display: flex; justify-content: space-between; gap: var(--fl-space-sm); }
    .fl-reset-dialog li span:last-child { color: var(--fl-color-text-secondary); font-variant-numeric: tabular-nums; }
    .fl-reset-dialog .fl-reset-warn {
      color: var(--fl-color-text); padding: var(--fl-space-sm) var(--fl-space-md); border-radius: var(--fl-radius-sm);
      background: color-mix(in srgb, var(--fl-color-warning) 14%, transparent);
    }
    .fl-reset-type { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); margin-top: var(--fl-space-xs); }
    .fl-reset-dialog input[type="text"] {
      padding: var(--fl-space-xs) var(--fl-space-sm); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm); background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-mono); font-size: var(--fl-text-ui-size);
    }
    .fl-reset-dialog input[type="text"]:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
    .fl-reset-dialog .fl-reset-message { color: var(--fl-color-error); }
    .fl-reset-dialog .fl-reset-message:empty { display: none; }
    .fl-reset-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); margin-top: var(--fl-space-xs); }
  `
  document.head.appendChild(style)
}
