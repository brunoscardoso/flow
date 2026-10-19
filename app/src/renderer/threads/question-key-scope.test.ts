import {
  isShortcutDigit,
  shouldRouteDigitToCard,
  targetCardIndex,
  type ScopeCandidate,
} from './question-key-scope'

const candidate = (overrides: Partial<ScopeCandidate> = {}): ScopeCandidate => ({
  visible: true,
  resolved: false,
  containsFocus: false,
  ...overrides,
})

describe('isShortcutDigit', () => {
  it('accepts 1-9 only', () => {
    expect(isShortcutDigit('1')).toBe(true)
    expect(isShortcutDigit('9')).toBe(true)
    expect(isShortcutDigit('0')).toBe(false)
    expect(isShortcutDigit('a')).toBe(false)
    expect(isShortcutDigit('12')).toBe(false)
    expect(isShortcutDigit('')).toBe(false)
  })
})

describe('shouldRouteDigitToCard (#983)', () => {
  it('routes to the card from a non-text target', () => {
    expect(
      shouldRouteDigitToCard({ isTextTarget: false, isComposerTarget: false, composerEmpty: false }),
    ).toBe(true)
  })

  it('routes to the card from an EMPTY composer — the state the card is born into', () => {
    expect(
      shouldRouteDigitToCard({ isTextTarget: true, isComposerTarget: true, composerEmpty: true }),
    ).toBe(true)
  })

  it('never steals a digit from a composer holding a draft', () => {
    expect(
      shouldRouteDigitToCard({ isTextTarget: true, isComposerTarget: true, composerEmpty: false }),
    ).toBe(false)
  })

  it('never steals a digit from a non-composer text field (e.g. the "Other" box)', () => {
    expect(
      shouldRouteDigitToCard({ isTextTarget: true, isComposerTarget: false, composerEmpty: false }),
    ).toBe(false)
    // Emptiness is irrelevant off-composer: typing "2" into an empty Other box must type.
    expect(
      shouldRouteDigitToCard({ isTextTarget: true, isComposerTarget: false, composerEmpty: true }),
    ).toBe(false)
  })
})

describe('targetCardIndex (#984)', () => {
  it('is -1 with no cards, and with no live card', () => {
    expect(targetCardIndex([])).toBe(-1)
    expect(targetCardIndex([candidate({ resolved: true }), candidate({ visible: false })])).toBe(-1)
  })

  it('picks the single pending card', () => {
    expect(targetCardIndex([candidate()])).toBe(0)
  })

  it('picks the NEWEST visible unanswered card when focus is in neither', () => {
    expect(targetCardIndex([candidate(), candidate()])).toBe(1)
  })

  it('a focused card wins over a newer unfocused one — the card the user works in', () => {
    expect(targetCardIndex([candidate({ containsFocus: true }), candidate()])).toBe(0)
  })

  it('never targets a resolved or hidden card, even when focused', () => {
    expect(targetCardIndex([candidate(), candidate({ resolved: true, containsFocus: true })])).toBe(
      0,
    )
    expect(targetCardIndex([candidate(), candidate({ visible: false, containsFocus: true })])).toBe(
      0,
    )
  })

  it('answering a card moves the scope to the remaining pending card', () => {
    // Before: two pending → newest owns the digits.
    expect(targetCardIndex([candidate(), candidate()])).toBe(1)
    // After the newest resolves → the older pending card owns them.
    expect(targetCardIndex([candidate(), candidate({ resolved: true })])).toBe(0)
  })
})
