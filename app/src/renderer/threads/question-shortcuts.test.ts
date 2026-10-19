import { optionIndexForKey, optionShortcutKey, shouldAdvanceAfterPick } from './question-shortcuts'

describe('optionShortcutKey (#465)', () => {
  it('numbers the first nine options 1..9, none beyond', () => {
    expect(optionShortcutKey(0)).toBe('1')
    expect(optionShortcutKey(8)).toBe('9')
    expect(optionShortcutKey(9)).toBeNull()
    expect(optionShortcutKey(-1)).toBeNull()
  })
})

describe('optionIndexForKey', () => {
  it('maps a digit key to an in-range option index', () => {
    expect(optionIndexForKey('1', 4)).toBe(0)
    expect(optionIndexForKey('4', 4)).toBe(3)
  })
  it('rejects out-of-range digits and non-digits', () => {
    expect(optionIndexForKey('5', 4)).toBeNull() // only 4 options
    expect(optionIndexForKey('0', 4)).toBeNull() // no zero shortcut
    expect(optionIndexForKey('a', 4)).toBeNull()
    expect(optionIndexForKey('', 4)).toBeNull()
  })
})

describe('shouldAdvanceAfterPick', () => {
  it('advances a single-select pick that is not the last question', () => {
    expect(shouldAdvanceAfterPick(false, false)).toBe(true)
  })
  it('does not advance multi-select or the last question', () => {
    expect(shouldAdvanceAfterPick(true, false)).toBe(false)
    expect(shouldAdvanceAfterPick(false, true)).toBe(false)
    expect(shouldAdvanceAfterPick(true, true)).toBe(false)
  })
})
