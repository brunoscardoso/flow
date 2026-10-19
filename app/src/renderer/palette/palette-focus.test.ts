import { focusToCapture, focusToRestore, type FocusTarget } from './palette-focus'

// #1100 — dismissing the palette with Escape dropped focus on <body>, so every
// following keystroke was silently discarded until the user clicked.

const el = (isConnected = true): FocusTarget => ({ isConnected })

describe('focusToCapture', () => {
  it('remembers the element that had focus when the palette opened', () => {
    const terminal = el()
    expect(focusToCapture({ active: terminal, body: el(), insidePalette: false })).toBe(terminal)
  })

  it('remembers nothing when focus was already on <body>', () => {
    const body = el()
    expect(focusToCapture({ active: body, body, insidePalette: false })).toBeNull()
  })

  it('remembers nothing when there is no active element', () => {
    expect(focusToCapture({ active: null, body: el(), insidePalette: false })).toBeNull()
  })

  it('never remembers the palette\'s own input (a re-entrant open)', () => {
    expect(focusToCapture({ active: el(), body: el(), insidePalette: true })).toBeNull()
  })
})

describe('focusToRestore', () => {
  it('restores the captured element when the palette is CANCELLED', () => {
    const terminal = el()
    expect(focusToRestore(terminal, 'cancel')).toBe(terminal)
  })

  it('restores nothing when the palette closed to ACTIVATE a result', () => {
    // The action focuses its own surface (open-file → the editor); restoring
    // here would yank focus straight back off it.
    expect(focusToRestore(el(), 'activate')).toBeNull()
  })

  it('restores nothing when nothing was captured', () => {
    expect(focusToRestore(null, 'cancel')).toBeNull()
  })

  it('restores nothing onto an element that left the document', () => {
    expect(focusToRestore(el(false), 'cancel')).toBeNull()
  })
})
