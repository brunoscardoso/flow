import { shouldSubmitOnEnter } from './submit-on-enter'

// #1396: every text field in the settings family ignored Enter — including
// the account-name field, whose primary action is the first thing in the
// overlay. Not even the blank-field hint the button shows (#834) appeared.
// The decision lives here so it is testable without a DOM.

describe('shouldSubmitOnEnter (#1396)', () => {
  it('submits on Enter', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, disabled: false })).toBe(true)
  })

  it('ignores every other key', () => {
    expect(shouldSubmitOnEnter({ key: 'a', isComposing: false, disabled: false })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Escape', isComposing: false, disabled: false })).toBe(false)
  })

  it('does not re-fire an action already in flight', () => {
    // The button disables itself during an interactive sign-in; Enter must not
    // start a second one.
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, disabled: true })).toBe(false)
  })

  it('leaves IME composition alone — Enter commits a candidate there', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: true, disabled: false })).toBe(false)
  })
})
