/**
 * Minimal "Reveal in Finder/Explorer" context menu (#1063), optionally preceded
 * by a few caller-supplied items (#SCMS: the git panel's selection-scoped
 * Stage/Unstage/Discard Selected).
 *
 * A focused affordance for surfaces that have no context menu of their own
 * (git change rows, attachment chips). This is deliberately NOT a general
 * reusable context-menu component — the file-tree and editor-tab menus keep
 * their own richer builders, and the leading items are passed IN by the caller
 * (git-panel), never baked in here. It renders those items, then one
 * platform-aware reveal item, matching the file-tree menu's Stark styling, and
 * dismisses on outside-click or Escape.
 */
import { revealLabel } from './reveal-label'

/** A caller-supplied leading item for the reveal menu (#SCMS). */
export interface RevealMenuItem {
  label: string
  onSelect: () => void
}

let openMenu: HTMLElement | null = null
let dismiss: (() => void) | null = null

/** A menu row sharing the reveal item's Stark styling. Closes the menu first so
 *  the click can't re-trigger dismissal, then runs the action. */
function menuButton(label: string, onSelect: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.style.cssText = [
    'display:block',
    'width:100%',
    'text-align:left',
    'padding:4px 8px',
    'background:none',
    'border:none',
    'cursor:pointer',
    'border-radius:var(--fl-radius-sm)',
    'color:var(--fl-color-text)',
  ].join(';')
  button.addEventListener('mouseenter', () => (button.style.background = 'var(--fl-color-surface)'))
  button.addEventListener('mouseleave', () => (button.style.background = 'none'))
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    closeRevealMenu()
    onSelect()
  })
  return button
}

/** Close any open reveal menu and detach its dismiss listeners. */
export function closeRevealMenu(): void {
  dismiss?.()
  dismiss = null
  openMenu?.remove()
  openMenu = null
}

/**
 * Show the reveal menu at viewport coordinates (x, y). Optional `items` render
 * above the Reveal item, in order (#SCMS). Each item's `onSelect` (and `onReveal`)
 * fires on click; the menu closes first so the click can't re-trigger dismissal.
 * Any previously-open reveal menu is closed.
 */
export function showRevealMenu(
  x: number,
  y: number,
  onReveal: () => void,
  items: RevealMenuItem[] = [],
): void {
  closeRevealMenu()
  const menu = document.createElement('div')
  menu.className = 'fl-reveal-menu'
  menu.style.cssText = [
    'position:fixed',
    `left:${x}px`,
    `top:${y}px`,
    'z-index:1000',
    'min-width:170px',
    'background:var(--fl-color-surface-raised)',
    'border:var(--fl-border-width) solid var(--fl-color-border)',
    'border-radius:var(--fl-radius-md)',
    'padding:4px',
    'box-shadow:var(--fl-shadow-md)',
    'font-size:var(--fl-text-ui-size)',
  ].join(';')

  for (const item of items) menu.appendChild(menuButton(item.label, item.onSelect))
  menu.appendChild(menuButton(revealLabel(), onReveal))

  document.body.appendChild(menu)
  openMenu = menu

  // Keep the menu inside the viewport (mirrors the file-tree menu).
  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`

  const onDown = (event: MouseEvent): void => {
    if (openMenu && !openMenu.contains(event.target as Node)) closeRevealMenu()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeRevealMenu()
  }
  let listenTimer = 0
  dismiss = () => {
    window.clearTimeout(listenTimer)
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey)
  }
  // A DISMISS CLOSED BEFORE THIS TIMER FIRES MUST NOT LEAVE ITS LISTENER BEHIND.
  // The add is deferred so the opening click cannot close the menu; the teardown
  // only ever removed a listener, so closing inside that one tick (Escape right
  // after opening, which is what a poll of this menu does) let the timer attach
  // `onOutside` for a panel that was already gone. Nothing could remove it, and
  // its closure tests a DETACHED element — so `!contains(target)` was true for
  // every later press, and the NEXT menu was dismissed on mousedown before the
  // click reached the item. Measured: the item's handler never ran, no write
  // happened, and the menu closed anyway.
  listenTimer = window.setTimeout(() => {
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
  }, 0)
}
