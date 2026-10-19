// Board keyboard-focus ownership — pure logic, no DOM (node env). Guards #963
// (the board must take the keys on arrival) against #1099/#1045 (a text input
// or terminal owns its own keys, and a reveal never steals focus).

import { shouldClaimBoardFocus, shouldRestoreBoardFocus, type FocusOwner } from './board-focus'

function owner(overrides: Partial<FocusOwner> = {}): FocusOwner {
  return { tag: 'DIV', isContentEditable: false, inTerminal: false, inBoard: false, ...overrides }
}

describe('shouldClaimBoardFocus', () => {
  it('claims when nothing holds focus — the ⌘5 / palette arrival path (#963)', () => {
    expect(shouldClaimBoardFocus(null)).toBe(true)
  })

  it('claims from BODY and from a plain button (the rail icon path, #963)', () => {
    // Measured in the report: ACTIVE was `BODY` after ⌘5 and `BUTTON.fl-rail-item`
    // after a rail click — in both cases every board key was inert.
    expect(shouldClaimBoardFocus(owner({ tag: 'BODY' }))).toBe(true)
    expect(shouldClaimBoardFocus(owner({ tag: 'BUTTON' }))).toBe(true)
  })

  it('never takes keys from a focused text field (#1045 ownership rule)', () => {
    expect(shouldClaimBoardFocus(owner({ tag: 'INPUT' }))).toBe(false)
    expect(shouldClaimBoardFocus(owner({ tag: 'TEXTAREA' }))).toBe(false)
    expect(shouldClaimBoardFocus(owner({ tag: 'textarea' }))).toBe(false) // case-insensitive
    expect(shouldClaimBoardFocus(owner({ tag: 'SELECT' }))).toBe(false)
  })

  it('never takes keys from the composer (a contenteditable surface)', () => {
    expect(shouldClaimBoardFocus(owner({ tag: 'DIV', isContentEditable: true }))).toBe(false)
  })

  it('never takes keys from the terminal (#1099 — xterm owns every key)', () => {
    expect(shouldClaimBoardFocus(owner({ tag: 'TEXTAREA', inTerminal: true }))).toBe(false)
    expect(shouldClaimBoardFocus(owner({ tag: 'DIV', inTerminal: true }))).toBe(false)
  })

  it('is a no-op when focus is already inside the board', () => {
    expect(shouldClaimBoardFocus(owner({ tag: 'BUTTON', inBoard: true }))).toBe(false)
    // …including an in-board text field (the popover's reject-feedback input).
    expect(shouldClaimBoardFocus(owner({ tag: 'INPUT', inBoard: true }))).toBe(false)
  })
})

// A DIVE DESTROYS THE FOCUSED CELL. Every feature-map navigation rebuilds
// the sheet, focus falls to `<body>`, and `#onKeydown`'s contains-gate then
// refuses `0` / `Esc` / `Backspace` until something is clicked — #963's
// complaint reappearing after every move. Re-claiming is right; re-claiming as
// broadly as an ARRIVAL is not, because a repaint can fire long after the user
// has deliberately put focus somewhere else.
describe('shouldRestoreBoardFocus (after a level re-render)', () => {
  it('takes back the focus the re-render itself dropped', () => {
    expect(shouldRestoreBoardFocus(null)).toBe(true)
  })

  it('never steals from ANY other holder — not even a plain button', () => {
    // This is where it is strictly narrower than the arrival claim: that one
    // takes keys from a rail BUTTON on purpose; a repaint must not.
    expect(shouldClaimBoardFocus(owner({ tag: 'BUTTON' }))).toBe(true)
    expect(shouldRestoreBoardFocus(owner({ tag: 'BUTTON' }))).toBe(false)
  })

  it('leaves the composer and the terminal alone (#517 / #1099)', () => {
    expect(shouldRestoreBoardFocus(owner({ tag: 'DIV', isContentEditable: true }))).toBe(false)
    expect(shouldRestoreBoardFocus(owner({ tag: 'TEXTAREA', inTerminal: true }))).toBe(false)
    expect(shouldRestoreBoardFocus(owner({ tag: 'INPUT' }))).toBe(false)
  })

  it('is a no-op when focus is already inside the board', () => {
    expect(shouldRestoreBoardFocus(owner({ tag: 'BUTTON', inBoard: true }))).toBe(false)
  })
})
