import { signInCopy, signInStateFrom } from './sign-in-model'

describe('what the section says', () => {
  // A control that cannot work is worse than its absence, and this is every
  // build until a provider is configured.
  it('offers no action at all when sign-in is unavailable', () => {
    expect(signInCopy({ kind: 'unavailable' }).action).toBeNull()
  })

  it('offers GitHub when signed out, and says what it does', () => {
    const copy = signInCopy({ kind: 'signed-out' })
    expect(copy.action).toBe('Sign in with GitHub')
    expect(copy.who).toBeNull()
    expect(copy.hint).toMatch(/nothing about how flow works changes/i)
  })

  it('shows the name, not the id', () => {
    const copy = signInCopy({ kind: 'signed-in', displayName: 'Dev User', subject: 'github|42' })
    expect(copy.who).toBe('Dev User')
    expect(copy.who).not.toContain('github|')
  })

  // Showing somebody `github|1234567` as "who you are" is the app talking to
  // itself. Without a name it says something a person can read instead.
  it('never shows a raw subject when there is no name', () => {
    const copy = signInCopy({ kind: 'signed-in', displayName: null, subject: 'github|42' })
    expect(copy.who).not.toContain('github|')
    expect(copy.who).toBeTruthy()
  })

  // THE TENSION THE DISCOVERY RECORDED. Sync is the reason to sign in and does
  // not exist; the copy must not promise it.
  it.each([{ kind: 'signed-out' as const }, { kind: 'signed-in' as const, displayName: 'B', subject: 's' }])(
    'promises no sync in %p',
    (state) => {
      const copy = signInCopy(state)
      expect(`${copy.hint} ${copy.action}`).not.toMatch(/sync|across (your )?machines|coming soon/i)
    },
  )

  it('says signing out changes nothing else', () => {
    expect(signInCopy({ kind: 'signed-in', displayName: 'B', subject: 's' }).hint).toMatch(
      /changes nothing else/i,
    )
  })
})

describe('deciding the state', () => {
  it('is unavailable when there is no provider and nobody is signed in', () => {
    expect(signInStateFrom(false, null)).toEqual({ kind: 'unavailable' })
  })

  it('is signed out when a provider exists and nobody is', () => {
    expect(signInStateFrom(true, null)).toEqual({ kind: 'signed-out' })
  })

  it('is signed in when somebody is', () => {
    expect(signInStateFrom(true, { subject: 'github|42', displayName: 'Dev User' })).toEqual({
      kind: 'signed-in',
      displayName: 'Dev User',
      subject: 'github|42',
    })
  })

  // Stranding a stored identity with no way to clear it is worse than showing
  // a control in a build that can no longer sign anybody in.
  it('still shows a signed-in person when the provider has gone', () => {
    const state = signInStateFrom(false, { subject: 'github|42', displayName: 'Dev User' })
    expect(state.kind).toBe('signed-in')
    expect(signInCopy(state).action).toBe('Sign out')
  })
})
