/**
 * Who owns Escape while focus mode is on (#1161).
 *
 * Focus mode (#616) registered its Escape exit on `window` in the CAPTURE
 * phase, so it always won the race against surfaces that register on
 * `document`. Focus mode is the editor-only view, so the things that own
 * Escape in it — Monaco's find widget, the titlebar project dropdown, a
 * context menu — are exactly what the user is looking at. One Escape did two
 * things: dismissed the widget AND tore the user out of focus mode, restoring
 * the whole layout they had just hidden.
 *
 * The handler's own comment already claimed a guard ("skipped while a panel
 * menu is open") that was never in the code; only `isModalOverlayOpen()` was,
 * and that covers marked modal overlays, not Monaco widgets or the shell's
 * popup menus.
 *
 * Rule: Escape exits focus mode only when nothing nearer wants it. This is the
 * conservative half of what VS Code does — it binds Zen-mode exit to a double
 * Escape chord for the same reason — without changing the advertised
 * single-Escape exit the "Focus mode · Esc to exit" pill promises.
 *
 * DOM-free on purpose (the selector lists are just data): the decision is
 * unit-tested, and shell.ts does the querying.
 */

/** Popup surfaces that dismiss on Escape and register on `document`. */
export const ESCAPE_OWNING_POPUPS = [
  '.fl-project-menu',
  '.fl-thread-menu',
  '.fl-tree-menu',
  '.fl-reveal-menu',
  '.fl-term-root-menu',
  '.fl-board-menu',
  '.ctx-menu',
] as const

/** Monaco surfaces that take Escape while visible (find/replace, suggestions). */
export const ESCAPE_OWNING_EDITOR_WIDGETS = [
  '.monaco-editor .find-widget.visible',
  '.monaco-editor .suggest-widget.visible',
  '.monaco-editor .parameter-hints-widget.visible',
  '.monaco-editor .rename-box',
  // NOT just `:not([aria-hidden])`: Monaco keeps the hover element in the DOM
  // after it fades, as `monaco-hover fade-in hidden` with NO aria-hidden — so
  // the bare selector matched from the first time the pointer crossed the
  // editor, and Escape could never leave focus mode again (the pill's promised
  // exit was dead for anyone who had moused over their code).
  '.monaco-editor .monaco-hover:not(.hidden):not([aria-hidden="true"])',
] as const

export interface EscapeContext {
  /** Focus mode is on — otherwise this handler doesn't act at all. */
  focusMode: boolean
  /** A registered modal overlay is open (settings, wizard, palette, board). */
  modalOpen: boolean
  /** A shell popup menu is on screen. */
  popupOpen: boolean
  /** A Monaco widget that dismisses on Escape is visible. */
  editorWidgetOpen: boolean
}

/**
 * Should this Escape exit focus mode? Only when focus mode is on and no nearer
 * surface wants the key — the user's Escape belongs to the thing in front of
 * them, and the pill's promised exit is still one Escape away once that thing
 * is gone.
 */
export function shouldExitFocusMode(context: EscapeContext): boolean {
  if (!context.focusMode) return false
  return !context.modalOpen && !context.popupOpen && !context.editorWidgetOpen
}
