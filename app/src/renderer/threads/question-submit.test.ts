import {
  SESSION_GONE_SENTINEL,
  SessionGoneError,
  isSessionGone,
  sessionGoneMessage,
  submitFailureMessage,
} from './question-submit'

describe('submitFailureMessage (#278)', () => {
  it('names the underlying Error so the user knows why the submit failed', () => {
    expect(submitFailureMessage(new Error('session not ready'))).toBe(
      'Failed to send — session not ready. Try again.',
    )
  })

  it('passes through a string reason', () => {
    expect(submitFailureMessage('IPC channel closed')).toBe(
      'Failed to send — IPC channel closed. Try again.',
    )
  })

  it('degrades an opaque non-Error value to "Unknown error" (never "[object Object]")', () => {
    expect(submitFailureMessage({})).toBe('Failed to send — Unknown error. Try again.')
  })
})

describe('session-gone classification (#301)', () => {
  it('recognizes the terminal "session gone" rejection, including the Electron-wrapped form', () => {
    expect(isSessionGone(new SessionGoneError())).toBe(true)
    // Electron wraps a thrown handler error — substring must still match.
    expect(
      isSessionGone(
        new Error(`Error invoking remote method 'threads:respondDialog': Error: ${SESSION_GONE_SENTINEL}`),
      ),
    ).toBe(true)
  })

  it('does NOT classify an unrelated / transient failure as session-gone', () => {
    expect(isSessionGone(new Error('network timeout'))).toBe(false)
    expect(isSessionGone("couldn't reach the agent")).toBe(false)
    expect(isSessionGone(undefined)).toBe(false)
  })

  it('SessionGoneError is an Error carrying the sentinel message', () => {
    const err = new SessionGoneError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SessionGoneError')
    expect(err.message).toBe(SESSION_GONE_SENTINEL)
  })

  it('the terminal message drops the futile "Try again" guidance', () => {
    expect(sessionGoneMessage()).toBe('This session ended — the question can no longer be answered.')
    expect(sessionGoneMessage()).not.toMatch(/try again/i)
  })
})
