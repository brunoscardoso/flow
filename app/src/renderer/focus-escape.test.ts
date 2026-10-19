import { shouldExitFocusMode } from './focus-escape'

// #1161: focus mode's Escape exit fired from a `window` capture listener, so it
// beat every surface that registers on `document` — one Escape closed the find
// widget AND tore the layout back open.

const base = { focusMode: true, modalOpen: false, popupOpen: false, editorWidgetOpen: false }

describe('shouldExitFocusMode (#1161)', () => {
  it('exits when nothing nearer wants the key', () => {
    expect(shouldExitFocusMode(base)).toBe(true)
  })

  it('yields to Monaco’s find widget — the reported case', () => {
    expect(shouldExitFocusMode({ ...base, editorWidgetOpen: true })).toBe(false)
  })

  it('yields to a shell popup menu (the titlebar project dropdown, #638)', () => {
    expect(shouldExitFocusMode({ ...base, popupOpen: true })).toBe(false)
  })

  it('yields to a modal overlay', () => {
    expect(shouldExitFocusMode({ ...base, modalOpen: true })).toBe(false)
  })

  it('does nothing at all outside focus mode', () => {
    // The normal layout's Escape belongs to Monaco/xterm/dialogs, always.
    expect(shouldExitFocusMode({ ...base, focusMode: false })).toBe(false)
    expect(shouldExitFocusMode({ focusMode: false, modalOpen: false, popupOpen: true, editorWidgetOpen: true })).toBe(false)
  })

  it('still exits on the NEXT Escape once the widget is gone', () => {
    // The pill promises "Esc to exit" — that promise must survive the guard.
    expect(shouldExitFocusMode({ ...base, editorWidgetOpen: true })).toBe(false)
    expect(shouldExitFocusMode(base)).toBe(true)
  })
})
