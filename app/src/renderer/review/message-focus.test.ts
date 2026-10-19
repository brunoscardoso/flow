import { captureMessageFocus } from './message-focus'

describe('captureMessageFocus (#282)', () => {
  it('captures a focused message input by key + selection', () => {
    expect(captureMessageFocus('Phase 1 · demo', true, 3, 7)).toEqual({
      key: 'Phase 1 · demo',
      start: 3,
      end: 7,
    })
    expect(captureMessageFocus('Other changes', true, 0, 0)).toEqual({
      key: 'Other changes',
      start: 0,
      end: 0,
    })
  })

  it('returns null when nothing relevant is focused', () => {
    expect(captureMessageFocus(undefined, true, 0, 0)).toBeNull() // not a tagged input
    expect(captureMessageFocus('Phase 1', false, 0, 0)).toBeNull() // outside the panel
  })

  it('defaults a nullish selection to 0 (input types without a caret)', () => {
    expect(captureMessageFocus('Other changes', true, null, null)).toEqual({
      key: 'Other changes',
      start: 0,
      end: 0,
    })
  })
})
