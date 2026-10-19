/**
 * One sign-in state: a rejected session is cleared through the identity
 * store's own sign-out, and every change is broadcast to every window.
 *
 * The store here is the REAL identity store over an in-memory file, so a
 * "cleared" assertion means the credential is really gone.
 */
import { createAuthSession, type AuthChangeCause } from './auth-session'
import { createIdentityStore, type StoredIdentity } from './identity-store'

const OLD = 'OLD-SESSION-TOKEN'
const FRESH = 'FRESH-SESSION-TOKEN'

function identity(token: string): StoredIdentity {
  return { subject: 'github|42', displayName: 'Ada', token, expiresAt: null }
}

function harness(held: StoredIdentity | null) {
  let file: Buffer | null = null
  const store = createIdentityStore({
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (data) => data.toString('utf8').slice(4),
    },
    read: () => file,
    write: (data) => {
      file = data
    },
    remove: () => {
      file = null
    },
  })
  if (held !== null) store.save(held)
  const sent: AuthChangeCause[] = []
  const session = createAuthSession({ store, broadcast: (change) => sent.push(change.cause) })
  return { store, session, sent }
}

let infoSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance
beforeEach(() => {
  infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  infoSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('a rejected session', () => {
  it('clears the stored sign-in and tells every window', () => {
    const h = harness(identity(OLD))
    // POSITIVE FIRST: somebody really is signed in before the rejection.
    expect(h.store.load()?.subject).toBe('github|42')

    expect(h.session.sessionRejected({ reason: 'unauthenticated', token: OLD })).toBe(true)

    expect(h.store.load()).toBeNull()
    expect(h.sent).toEqual(['session-rejected'])
  })

  it('never clears a newer sign-in that replaced the rejected one', () => {
    const h = harness(identity(FRESH))
    expect(h.session.sessionRejected({ reason: 'session-expired', token: OLD })).toBe(false)
    expect(h.store.load()?.token).toBe(FRESH)
    expect(h.sent).toEqual([])
  })

  it('does nothing when nobody is signed in', () => {
    const h = harness(null)
    expect(h.session.sessionRejected({ reason: 'identity-disabled', token: OLD })).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('a broadcast that throws does not undo the sign-out', () => {
    let file: Buffer | null = Buffer.from(`enc:${JSON.stringify(identity(OLD))}`, 'utf8')
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (data) => data.toString('utf8').slice(4),
      },
      read: () => file,
      write: (data) => {
        file = data
      },
      remove: () => {
        file = null
      },
    })
    const session = createAuthSession({
      store,
      broadcast: () => {
        throw new Error('window gone')
      },
    })
    expect(store.load()?.token).toBe(OLD)
    expect(session.sessionRejected({ reason: 'unauthenticated', token: OLD })).toBe(true)
    expect(store.load()).toBeNull()
  })
})

describe('sign-in and sign-out from Settings take the same path', () => {
  it('a sign-out removes the identity, reports it, and broadcasts', () => {
    const h = harness(identity(OLD))
    expect(h.store.load()).not.toBeNull()
    expect(h.session.signOut()).toMatchObject({ removed: true })
    expect(h.store.load()).toBeNull()
    expect(h.sent).toEqual(['signed-out'])
  })

  it('a sign-in broadcasts', () => {
    const h = harness(identity(FRESH))
    h.session.signedIn()
    expect(h.sent).toEqual(['signed-in'])
  })
})
