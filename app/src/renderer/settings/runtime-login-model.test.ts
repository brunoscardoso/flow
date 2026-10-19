import { failureMessage, initialRuntimeLoginState, reduceRuntimeLogin } from './runtime-login-model'

const start = initialRuntimeLoginState('copilot')

describe('the in-app runtime sign-in, as the reader sees it', () => {
  it('shows the page and the code a device-code flow prints', () => {
    // Measured from `copilot login --device-code`: "To authenticate, visit
    // https://github.com/login/device and enter code 6CB7-0989".
    let state = reduceRuntimeLogin(start, {
      provider: 'copilot',
      kind: 'url',
      url: 'https://github.com/login/device',
    })
    state = reduceRuntimeLogin(state, { provider: 'copilot', kind: 'code', code: '6CB7-0989' })
    expect(state.url).toBe('https://github.com/login/device')
    expect(state.code).toBe('6CB7-0989')
    expect(state.status).toContain('Open the sign-in page')
    expect(state.finished).toBe(false)
  })

  it('keeps the instruction on screen for the whole wait', () => {
    // The real sequence prints "Waiting for authorization..." right after the
    // URL. No tool line reaches this state at all now, and the one actionable
    // sentence stays put.
    const withUrl = reduceRuntimeLogin(start, {
      provider: 'copilot',
      kind: 'url',
      url: 'https://github.com/login/device',
    })
    const after = reduceRuntimeLogin(withUrl, { provider: 'copilot', kind: 'code', code: 'AAAA-BBBB' })
    expect(after.status).toBe(withUrl.status)
    expect(after.url).toBe('https://github.com/login/device')
  })

  it('ends on the outcome, in Flow’s words', () => {
    const done = reduceRuntimeLogin(start, { provider: 'copilot', kind: 'done' })
    expect(done).toMatchObject({ finished: true, ok: true })
    expect(done.status).toBe('Signed in to GitHub Copilot.')

    const failed = reduceRuntimeLogin(start, { provider: 'copilot', kind: 'error' })
    expect(failed).toMatchObject({ finished: true, ok: false })
    expect(failed.status).toBe('The GitHub Copilot sign-in did not complete.')
  })

  it('says a config failure is a config failure — not "sign-in failed"', () => {
    // The line this replaced: "Codex sign-in did not complete — in
    // `model_reasoning_effort`". The tool never reached the login; sending
    // somebody to re-authorise would be sending them to the wrong problem.
    const state = reduceRuntimeLogin(initialRuntimeLoginState('codex'), {
      provider: 'codex',
      kind: 'error',
      reason: 'config-unreadable',
    })
    expect(state.status).toBe(
      'Codex could not read its own settings file, so the sign-in stopped before it began. Updating Codex usually fixes this.',
    )
    expect(state.status).not.toMatch(/model_reasoning_effort|variant|Error loading/)
  })

  it('names cancelling as cancelling, and a timeout as a timeout', () => {
    expect(failureMessage('codex', 'cancelled')).toBe('Codex sign-in cancelled.')
    expect(failureMessage('copilot', 'timeout')).toContain('took too long')
    expect(failureMessage('copilot', 'not-installed')).toContain('nothing to sign in to')
  })
})
