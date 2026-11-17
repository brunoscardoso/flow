/**
 * The Source Control popup menu — the header's More Actions and the commit
 * button's chevron. A list of items under an anchor, dismissed on outside
 * click or Escape, arrow keys move between items. Light DOM, one at a time.
 */

export interface ScmMenuItem {
  label: string
  /** Shown dimmed on the right (a shortcut). */
  hint?: string
  disabled?: boolean
  /** A rule goes above this item. */
  separator?: boolean
  onSelect: () => void
}

let open: { menu: HTMLElement; dispose: () => void } | null = null

export function closeScmMenu(): void {
  open?.dispose()
  open = null
}

/** Open a menu under `anchor`, right-aligned to it. */
export function showScmMenu(anchor: HTMLElement, items: ScmMenuItem[], className = ''): HTMLElement {
  closeScmMenu()
  injectStyles()
  const menu = document.createElement('div')
  menu.className = `gp-menu${className ? ` ${className}` : ''}`
  menu.setAttribute('role', 'menu')
  const buttons: HTMLButtonElement[] = []
  for (const item of items) {
    if (item.separator === true && menu.childElementCount > 0) {
      const rule = document.createElement('div')
      rule.className = 'gp-menu-sep'
      rule.setAttribute('role', 'separator')
      menu.appendChild(rule)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'gp-menu-item'
    btn.setAttribute('role', 'menuitem')
    btn.disabled = item.disabled === true
    const label = document.createElement('span')
    label.textContent = item.label
    btn.appendChild(label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'gp-menu-hint'
      hint.textContent = item.hint
      btn.appendChild(hint)
    }
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      if (btn.disabled) return
      closeScmMenu()
      item.onSelect()
    })
    menu.appendChild(btn)
    buttons.push(btn)
  }
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${Math.round(rect.bottom + 4)}px`
  document.body.appendChild(menu)
  const width = menu.offsetWidth || 220
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
  menu.style.left = `${Math.round(left)}px`

  const onDown = (event: MouseEvent): void => {
    if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) return
    closeScmMenu()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeScmMenu()
      anchor.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const live = buttons.filter((btn) => !btn.disabled)
    if (live.length === 0) return
    const at = live.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (at + 1) % live.length : (at - 1 + live.length) % live.length
    live[next]?.focus()
  }
  window.setTimeout(() => document.addEventListener('mousedown', onDown, true), 0)
  document.addEventListener('keydown', onKey, true)
  open = {
    menu,
    dispose: () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      menu.remove()
    },
  }
  buttons.find((btn) => !btn.disabled)?.focus()
  return menu
}

let injected = false

function injectStyles(): void {
  if (injected) return
  injected = true
  const style = document.createElement('style')
  style.textContent = `
    .gp-menu {
      position: fixed; z-index: 1000; min-width: 220px; padding: 4px;
      background: var(--fl-color-surface); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 5px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); font-family: var(--fl-font-ui);
    }
    .gp-menu-item {
      display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 16px;
      padding: 5px 8px; border: 0; border-radius: 3px; background: transparent;
      color: inherit; font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
    }
    .gp-menu-item:hover:not(:disabled), .gp-menu-item:focus-visible { background: var(--fl-color-surface-selected, var(--fl-color-surface-raised)); outline: none; }
    .gp-menu-item:disabled { color: var(--fl-color-text-secondary); opacity: 0.55; cursor: default; }
    .gp-menu-hint { color: var(--fl-color-text-secondary); font-size: 11px; }
    .gp-menu-sep { border-top: var(--fl-border-width) solid var(--fl-color-border); margin: 4px 2px; }
  `
  document.head.appendChild(style)
}
