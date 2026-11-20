/**
 * The built-in browser's tab row — drawing and pointer input only. The state
 * and its rules live in `shared/browser-tabs.ts`; `browser-tab.ts` owns the
 * pages and calls `render` after every change.
 *
 * Each tab: a letter badge, the title, a red dot when a page in the background
 * logged errors, and a close button. Sleeping tabs are faded. Drag to reorder;
 * a middle click closes. The "+" opens a new tab.
 */
import type { BrowserTabsState } from '../../shared/browser-tabs'

export interface BrowserTabRowHandlers {
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
  onMove(id: string, toIndex: number): void
}

const STYLE_ID = 'fl-browser-tabs-styles'

export class BrowserTabRow {
  readonly element: HTMLElement
  #list: HTMLElement
  #handlers: BrowserTabRowHandlers
  #dragId: string | null = null

  constructor(handlers: BrowserTabRowHandlers) {
    ensureStyles()
    this.#handlers = handlers
    this.element = document.createElement('div')
    this.element.className = 'fl-browser-tabs'
    this.element.setAttribute('role', 'tablist')
    this.element.setAttribute('aria-label', 'Browser tabs')
    this.#list = document.createElement('div')
    this.#list.className = 'fl-browser-tabs-list'
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'fl-browser-tabs-new'
    add.dataset['action'] = 'browser-new-tab'
    add.title = 'New tab'
    add.setAttribute('aria-label', 'New tab')
    add.textContent = '+'
    add.addEventListener('click', () => handlers.onNew())
    this.element.append(this.#list, add)
  }

  render(state: BrowserTabsState): void {
    // Redrawing replaces the rows: keep keyboard focus on the row, so the next
    // shortcut still finds the browser focused.
    const hadFocus = this.#list.contains(document.activeElement)
    const rows: HTMLElement[] = state.tabs.map((tab, index) => {
      const row = document.createElement('div')
      row.className = 'fl-browser-tabs-tab'
      row.dataset['tabId'] = tab.id
      row.setAttribute('role', 'tab')
      row.setAttribute('aria-selected', String(tab.id === state.activeId))
      row.tabIndex = tab.id === state.activeId ? 0 : -1
      row.title = tab.url ?? tab.title
      row.draggable = true
      if (!tab.live && tab.id !== state.activeId) row.classList.add('is-asleep')

      const badge = document.createElement('span')
      badge.className = 'fl-browser-tabs-badge'
      badge.textContent = (tab.title.trim()[0] ?? '·').toUpperCase()
      const title = document.createElement('span')
      title.className = 'fl-browser-tabs-title'
      title.textContent = tab.title
      row.append(badge, title)
      if (tab.unseenErrors > 0 && tab.id !== state.activeId) {
        const dot = document.createElement('span')
        dot.className = 'fl-browser-tabs-dot'
        dot.setAttribute('aria-label', 'Logged errors')
        row.append(dot)
      }
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'fl-browser-tabs-close'
      close.title = 'Close tab'
      close.setAttribute('aria-label', `Close ${tab.title}`)
      close.textContent = '×'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#handlers.onClose(tab.id)
      })
      row.append(close)

      row.addEventListener('click', () => this.#handlers.onSelect(tab.id))
      row.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        this.#handlers.onClose(tab.id)
      })
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.#handlers.onSelect(tab.id)
        }
      })
      row.addEventListener('dragstart', (event) => {
        this.#dragId = tab.id
        event.dataTransfer?.setData('text/plain', tab.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      })
      row.addEventListener('dragover', (event) => {
        if (this.#dragId === null) return
        event.preventDefault()
      })
      row.addEventListener('drop', (event) => {
        event.preventDefault()
        const dragged = this.#dragId
        this.#dragId = null
        if (dragged !== null && dragged !== tab.id) this.#handlers.onMove(dragged, index)
      })
      row.addEventListener('dragend', () => {
        this.#dragId = null
      })
      return row
    })
    this.#list.replaceChildren(...rows)
    const active = this.#list.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (hadFocus) active?.focus()
  }
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-browser-tabs {
      display: flex;
      align-items: stretch;
      gap: 2px;
      min-width: 0;
      height: 30px;
      padding: 3px 6px 0;
      background: var(--fl-color-surface-sunken, var(--fl-color-surface));
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-browser-tabs-list {
      display: flex;
      gap: 2px;
      min-width: 0;
      flex: 0 1 auto;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .fl-browser-tabs-list::-webkit-scrollbar { display: none; }
    .fl-browser-tabs-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 1 180px;
      min-width: 72px;
      max-width: 200px;
      padding: 0 4px 0 8px;
      border-radius: var(--fl-radius-sm) var(--fl-radius-sm) 0 0;
      color: var(--fl-color-text-secondary);
      cursor: default;
      user-select: none;
    }
    .fl-browser-tabs-tab:hover { background: var(--fl-color-surface-raised); }
    .fl-browser-tabs-tab[aria-selected="true"] {
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      box-shadow: inset 0 2px 0 var(--fl-color-accent);
    }
    .fl-browser-tabs-tab:focus-visible { outline: 1px solid var(--fl-color-accent); outline-offset: -1px; }
    .fl-browser-tabs-tab.is-asleep { opacity: 0.55; }
    .fl-browser-tabs-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text-secondary);
      font-size: 10px;
      font-weight: 600;
    }
    .fl-browser-tabs-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .fl-browser-tabs-dot {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--fl-color-danger, #e5484d);
    }
    .fl-browser-tabs-close,
    .fl-browser-tabs-new {
      flex: none;
      width: 20px;
      height: 20px;
      align-self: center;
      padding: 0;
      border: 0;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }
    .fl-browser-tabs-close { opacity: 0; }
    .fl-browser-tabs-tab:hover .fl-browser-tabs-close,
    .fl-browser-tabs-tab[aria-selected="true"] .fl-browser-tabs-close { opacity: 1; }
    .fl-browser-tabs-close:hover,
    .fl-browser-tabs-new:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
  `
  document.head.appendChild(style)
}
