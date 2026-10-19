/**
 * Board keyboard-focus ownership (#963) — pure, no DOM.
 *
 * The blueprint board advertises keys in its own tooltips ("Fit to view (0)",
 * "Trace mode … (T)") and `#onKeydown` only fires while the board contains
 * `document.activeElement` (#517, so a composer beside the board keeps its
 * keys). Nothing handed the board that focus on the ordinary arrival path —
 * rail click, ⌘5, palette — so every advertised key was dead until the user
 * happened to click the map.
 *
 * Claiming focus is therefore right, but NOT unconditionally: the ownership
 * rule established by #1099/#1045 is that a focused text input or a terminal
 * owns its keys, and a reveal/rebuild never steals focus the user placed
 * somewhere else. This module is that decision, isolated so it can be tested
 * without a renderer.
 */

/** What currently holds focus, reduced to the facts the decision needs. */
export interface FocusOwner {
  /** Uppercase tag name of `document.activeElement` (e.g. 'INPUT', 'BODY'). */
  tag: string
  /** The element is (or is inside) a contenteditable region. */
  isContentEditable: boolean
  /** The element sits inside a terminal host (xterm owns every key it sees). */
  inTerminal: boolean
  /** The element is already inside the board — the keys already work. */
  inBoard: boolean
}

/** Tags that are text entry: taking their keys would eat the user's typing. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Should the board take keyboard focus as it becomes the visible pane?
 *
 * `null` (nothing focused / focus on `<body>`) is the common arrival case and
 * always yields. A text field, a contenteditable surface, or a terminal keeps
 * what it has — the user is mid-keystroke there, and the board's keys are not
 * worth a swallowed character. Focus already inside the board is a no-op: the
 * keys work, and re-focusing would move the caret off an in-board control.
 */
export function shouldClaimBoardFocus(owner: FocusOwner | null): boolean {
  if (owner === null) return true
  if (owner.inBoard) return false
  if (owner.inTerminal) return false
  if (owner.isContentEditable) return false
  if (TEXT_ENTRY_TAGS.has(owner.tag.toUpperCase())) return false
  return true
}

/**
 * Should the board take focus back after RE-RENDERING a level?
 *
 * Strictly narrower than the arrival claim above, and deliberately so. Every
 * dive/pop rebuilds the sheet, which destroys whatever cell was
 * focused inside it — focus falls to `<body>`, `#onKeydown`'s contains-gate
 * stops matching, and the keys the board advertises (`0`, `Esc`, `Backspace`)
 * go dead until something is clicked. That is #963's complaint reappearing
 * after every navigation, and the board's own e2e had already learned to live
 * around it by clicking the sheet before pressing Escape.
 *
 * A re-render is NOT an arrival, though: the user may have deliberately moved
 * focus to another pane since, and a repaint that happens to fire (a graph
 * reload, a learn event landing) must never yank it back. So this returns true
 * for exactly one case — nothing holds focus at all, which is the state the
 * re-render itself created. Anything else, including a non-text control in
 * another pane, keeps what it has.
 */
export function shouldRestoreBoardFocus(owner: FocusOwner | null): boolean {
  return owner === null
}
