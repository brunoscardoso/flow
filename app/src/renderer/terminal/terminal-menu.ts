/**
 * Terminal body context menu (#1149).
 *
 * Right-clicking inside the shell did nothing at all — no Copy, no Paste, even
 * with a live selection under the cursor — while the terminal's own tab strip
 * 20px above answered the same gesture with the close-ops menu (#735). Right
 * click is *the* copy/paste gesture in every terminal a user arrives from
 * (VS Code, iTerm2, Terminal.app, Windows Terminal), and ⌘C/⌘V already worked
 * here: only the discoverable route was missing.
 *
 * The menu is rendered in the LIGHT DOM (`.ctx-menu`, the same class and item
 * markup fl-tabs uses) rather than through main's `webContents('context-menu')`
 * event — the renderer owns every other menu in the app, and a native menu
 * would be invisible to the panel's own styling and to the e2e suite.
 *
 * The action set is derived, not hardcoded on/off: an item that cannot do
 * anything (Copy with no selection) renders DISABLED rather than missing, so
 * the menu's shape doesn't change under the cursor between right-clicks.
 */

import { terminalMenuItems, type TerminalMenuState } from './terminal-menu-model'

/** Viewport margin used when clamping the menu inside the window (#827). */
const CTX_MENU_VIEWPORT_MARGIN_PX = 8

let openMenu: HTMLElement | null = null
let detach: (() => void) | null = null

/** Close the open terminal menu, if any. */
export function closeTerminalMenu(): void {
  detach?.()
  detach = null
  openMenu?.remove()
  openMenu = null
}

export interface TerminalMenuHandlers {
  copy(): void
  paste(): void
  selectAll(): void
  clear(): void
  /** Open a new terminal beside this one (#1133). */
  split(): void
  /** Return the keyboard to the pane the menu belongs to (#1387). */
  refocus(): void
}

/** Show the terminal context menu at viewport coordinates (x, y). */
export function showTerminalMenu(
  x: number,
  y: number,
  state: TerminalMenuState,
  handlers: TerminalMenuHandlers,
): void {
  closeTerminalMenu()

  const menu = document.createElement('div')
  menu.className = 'ctx-menu fl-term-ctx-menu'
  menu.style.cssText = [
    'position:fixed',
    `left:${x}px`,
    `top:${y}px`,
    'z-index:1000',
    'min-width:160px',
    'background:var(--fl-color-surface-raised)',
    'border:var(--fl-border-width) solid var(--fl-color-border)',
    'border-radius:var(--fl-radius-md)',
    'padding:4px',
    'box-shadow:var(--fl-shadow-md)',
    'font-size:var(--fl-text-ui-size)',
  ].join(';')

  for (const item of terminalMenuItems(state)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ctx-item'
    button.dataset['termMenu'] = item.id
    button.textContent = item.label
    button.disabled = item.disabled
    button.style.cssText = [
      'display:block',
      'width:100%',
      'text-align:left',
      'padding:4px 8px',
      'background:none',
      'border:none',
      'border-radius:var(--fl-radius-sm)',
      'color:var(--fl-color-text)',
      item.disabled ? 'opacity:0.5;cursor:default' : 'cursor:pointer',
    ].join(';')
    if (!item.disabled) {
      button.addEventListener('mouseenter', () => {
        button.style.background = 'var(--fl-color-surface)'
      })
      button.addEventListener('mouseleave', () => {
        button.style.background = 'none'
      })
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        closeTerminalMenu()
        if (item.id === 'copy') handlers.copy()
        else if (item.id === 'paste') handlers.paste()
        else if (item.id === 'select-all') handlers.selectAll()
        else if (item.id === 'split') handlers.split()
        else handlers.clear()
        // #1387: the <button> took focus on mousedown and closeTerminalMenu()
        // removed it from the DOM, dropping focus to <body>. Every item ends
        // by handing the keyboard back — except Split, which deliberately
        // moves focus to the NEW pane it just created.
        if (item.id !== 'split') handlers.refocus()
      })
    }
    menu.appendChild(button)
  }

  document.body.appendChild(menu)
  openMenu = menu

  // Clamp into the viewport — a right-click near the bottom/right edge must not
  // put the items off screen (#827's lesson, same numbers).
  if (x + menu.offsetWidth > window.innerWidth - CTX_MENU_VIEWPORT_MARGIN_PX) {
    menu.style.left = `${Math.max(CTX_MENU_VIEWPORT_MARGIN_PX, window.innerWidth - CTX_MENU_VIEWPORT_MARGIN_PX - menu.offsetWidth)}px`
  }
  if (y + menu.offsetHeight > window.innerHeight - CTX_MENU_VIEWPORT_MARGIN_PX) {
    menu.style.top = `${Math.max(CTX_MENU_VIEWPORT_MARGIN_PX, window.innerHeight - CTX_MENU_VIEWPORT_MARGIN_PX - menu.offsetHeight)}px`
  }

  const onDown = (event: MouseEvent): void => {
    if (openMenu && !openMenu.contains(event.target as Node)) closeTerminalMenu()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // Scoped: this Escape belongs to the menu and must not also reach the
    // terminal or exit focus mode behind it (#1161's lesson).
    event.stopPropagation()
    closeTerminalMenu()
  }
  detach = () => {
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey, true)
  }
  // Deferred so the mousedown that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
  }, 0)
}
