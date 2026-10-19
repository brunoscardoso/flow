import {
  cancelLoginOwnedBy,
  markLoginInFlight,
  ownsLoginInFlight,
  resetLoginInFlight,
  settleLogin,
  WIZARD_LOGIN_SURFACE,
} from './login-inflight'

// #1167: an interactive `claude auth login` outlives the surface that started
// it. The orchestrator has ONE in-flight slot, so an abandoned child locks
// every later Add account / Connect out for 5 minutes, app-wide.

describe('login in-flight ownership (#1167)', () => {
  beforeEach(() => resetLoginInFlight())

  it('cancels a login the closing surface started', () => {
    let cancels = 0
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, async () => {
      cancels += 1
    })
    expect(cancels).toBe(1)
    expect(ownsLoginInFlight(WIZARD_LOGIN_SURFACE)).toBe(false)
  })

  it('does not cancel a login another surface owns', () => {
    // Dismissing Settings must not kill the sign-in the wizard is running.
    let cancels = 0
    markLoginInFlight('settings')
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, async () => {
      cancels += 1
    })
    expect(cancels).toBe(0)
    expect(ownsLoginInFlight('settings')).toBe(true)
  })

  it('is a no-op with nothing in flight', () => {
    let cancels = 0
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, async () => {
      cancels += 1
    })
    expect(cancels).toBe(0)
  })

  it('does not cancel a login that already settled', () => {
    // Connected/failed already released the slot — cancelling would be a lie.
    let cancels = 0
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    settleLogin(WIZARD_LOGIN_SURFACE)
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, async () => {
      cancels += 1
    })
    expect(cancels).toBe(0)
  })

  it('is idempotent — a second close cancels nothing', () => {
    let cancels = 0
    const cancel = async (): Promise<void> => {
      cancels += 1
    }
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, cancel)
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, cancel)
    expect(cancels).toBe(1)
  })

  it('survives a missing or rejecting cancel (older preload / racing exit)', () => {
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    expect(() => cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, undefined)).not.toThrow()
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    expect(() =>
      cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, () => Promise.reject(new Error('gone'))),
    ).not.toThrow()
  })

  it('settleLogin from another surface does not release this one', () => {
    markLoginInFlight(WIZARD_LOGIN_SURFACE)
    settleLogin('settings')
    expect(ownsLoginInFlight(WIZARD_LOGIN_SURFACE)).toBe(true)
  })
})
