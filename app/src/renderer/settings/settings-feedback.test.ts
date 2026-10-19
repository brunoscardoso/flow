import {
  accountActionFailedToast,
  errorText,
  modelRoutingSaveFailedToast,
  tokenClearFailedToast,
  tokenClearedToast,
  tokenSaveFailedToast,
} from './settings-feedback'

describe('errorText', () => {
  it('reads an Error message, and degrades unknown throws gracefully', () => {
    expect(errorText(new Error('EPERM: config dir busy'))).toBe('EPERM: config dir busy')
    expect(errorText('nope')).toBe('nope')
    expect(errorText({})).toBe('Unknown error') // avoids "[object Object]"
  })

  it('unwraps the Electron IPC wrapper via the shared helper (#988)', () => {
    expect(
      errorText(new Error("Error invoking remote method 'settings:saveToken': Error: bad token")),
    ).toBe('bad token')
  })
})

describe('accountActionFailedToast (#216)', () => {
  it('titles by action and carries the underlying error at error level', () => {
    expect(accountActionFailedToast('remove', new Error('dir locked'))).toEqual({
      title: "Couldn't remove account",
      body: 'dir locked',
      level: 'error',
    })
    expect(accountActionFailedToast('set-default', new Error('io')).title).toBe(
      "Couldn't set default account",
    )
    expect(accountActionFailedToast('assign', new Error('io')).title).toBe(
      "Couldn't assign account",
    )
  })
})

describe('token toasts (#217)', () => {
  it('names the provider and carries the error for a failed save', () => {
    expect(tokenSaveFailedToast('github', new Error('keychain locked'))).toEqual({
      title: "Couldn't save GitHub token",
      body: 'keychain locked',
      level: 'error',
    })
    expect(tokenSaveFailedToast('azure', new Error('x')).title).toBe(
      "Couldn't save Azure DevOps token",
    )
  })

  it('names the provider for a failed disconnect', () => {
    expect(tokenClearFailedToast('jira', new Error('write failed'))).toEqual({
      title: "Couldn't disconnect Jira",
      body: 'write failed',
      level: 'error',
    })
  })
})

describe('modelRoutingSaveFailedToast (#307)', () => {
  it('carries the error and states the routing reverted, at error level', () => {
    const toast = modelRoutingSaveFailedToast(new Error('config dir busy'))
    expect(toast.title).toBe("Couldn't save model routing")
    expect(toast.body).toContain('config dir busy')
    expect(toast.body).toMatch(/reverted/i)
    expect(toast.level).toBe('error')
  })
})

// #1505 — Disconnect destroyed an unrecoverable credential and said nothing:
// the only signal was the pill going grey, which is also what a plain refresh
// looks like. Success has to be announced, not merely repainted.
describe('tokenClearedToast (#1505)', () => {
  it('names the provider and says the token is gone from this machine', () => {
    expect(tokenClearedToast('jira')).toEqual({
      title: 'Disconnected Jira',
      body: 'The stored token was deleted from this machine.',
      level: 'info',
    })
  })

  it('is informational, not an error — the user asked for it', () => {
    expect(tokenClearedToast('github').level).toBe('info')
    expect(tokenClearedToast('github').title).toContain('GitHub')
  })
})
