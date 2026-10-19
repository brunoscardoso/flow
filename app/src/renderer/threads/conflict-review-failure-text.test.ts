import { failureText } from './conflict-review-card-model'

/**
 * A failed Accept used to always read "Failed to record decision — try again",
 * including when the reason was a hunk that no longer exists in the file — where
 * retrying can never succeed and the real fix is re-running Resolve with AI.
 * The responder's own message is what the row must show.
 */
describe('failureText', () => {
  it('shows the responder’s explanation when it has one', () => {
    const error = new Error(
      'This conflict changed since the proposal was written — core/flags.py no longer contains that hunk.',
    )
    expect(failureText(error)).toBe(error.message)
  })

  it('falls back to the generic retry prompt for an error with nothing to say', () => {
    expect(failureText(new Error(''))).toBe('Failed to record decision — try again')
    expect(failureText(new Error('   '))).toBe('Failed to record decision — try again')
    expect(failureText(undefined)).toBe('Failed to record decision — try again')
    expect(failureText('a thrown string')).toBe('Failed to record decision — try again')
  })

  it('caps a runaway message so one long path can’t reshape the card', () => {
    const text = failureText(new Error('x'.repeat(500)))
    expect(text).toHaveLength(200)
    expect(text.endsWith('…')).toBe(true)
  })
})
