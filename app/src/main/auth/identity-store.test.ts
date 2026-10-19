import { createIdentityStore, isExpired, type StoredIdentity } from './identity-store'

const IDENTITY: StoredIdentity = {
  subject: 'user-123',
  displayName: 'Dev User',
  token: 'live-session-token',
  expiresAt: 2_000,
}

/** A fake keychain: reversible, and loudly not real encryption. */
function harness(options: { available?: boolean } = {}) {
  let file: Buffer | null = null
  const store = createIdentityStore({
    encryption: {
      isEncryptionAvailable: () => options.available ?? true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => {
        const text = buf.toString('utf8')
        if (!text.startsWith('enc:')) throw new Error('not encrypted by us')
        return text.slice(4)
      },
    },
    read: () => file,
    write: (data) => {
      file = data
    },
    remove: () => {
      file = null
    },
  })
  return { store, peek: () => file }
}

describe('a round trip', () => {
  it('saves and loads the identity', () => {
    const h = harness()
    expect(h.store.save(IDENTITY)).toEqual({ ok: true })
    expect(h.store.load()).toEqual(IDENTITY)
  })

  // THE POINT OF THE FILE. What lands on disk must not be the token.
  it('writes ciphertext, never the token in the clear', () => {
    const h = harness()
    h.store.save(IDENTITY)
    const onDisk = h.peek()?.toString('utf8') ?? ''
    expect(onDisk).toContain('enc:')
    // With a real safeStorage this is opaque bytes; the fake is reversible on
    // purpose, so assert the ENCRYPT step ran rather than that the token is
    // absent — which the fake could not honestly claim.
    expect(h.peek()).not.toBeNull()
    expect(onDisk.startsWith('enc:')).toBe(true)
  })
})

describe('no keychain on this machine', () => {
  // FAIL CLOSED. The tempting move is to write it in the clear "just this
  // once", which puts a live session token in a plain file to buy a feature the
  // user was told was optional.
  it('refuses to save, and writes nothing at all', () => {
    const h = harness({ available: false })
    const result = h.store.save(IDENTITY)
    expect(result.ok).toBe(false)
    expect(h.peek()).toBeNull()
  })

  it("says why, in the user's own terms", () => {
    const h = harness({ available: false })
    const result = h.store.save(IDENTITY)
    if (result.ok) throw new Error('expected a refusal')
    // No path, no API name, no config key (forbidden-pattern #12) — and it says
    // the app still works, because that is the thing somebody actually fears.
    expect(result.reason).not.toMatch(/safeStorage|keychain|libsecret|\.json|~\//i)
    expect(result.reason).toMatch(/works exactly as it does now/i)
  })

  it('reports itself unavailable rather than pretending', () => {
    expect(harness({ available: false }).store.available()).toBe(false)
    expect(harness().store.available()).toBe(true)
  })

  it('loads nothing, rather than throwing', () => {
    expect(harness({ available: false }).store.load()).toBeNull()
  })
})

describe('the keychain is not disturbed without a reason', () => {
  // A macOS password prompt for a feature somebody has not used reads as
  // malware, not as protection. Somebody who never signed in has no identity
  // file, and no file means there is nothing to decrypt — so there is nothing
  // to ask the OS about.
  it('never asks the keychain when there is no identity file', () => {
    let asked = 0
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => {
          asked += 1
          return true
        },
        encryptString: (p) => Buffer.from(p, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
      read: () => null,
      write: () => {},
      remove: () => {},
    })
    expect(store.load()).toBeNull()
    expect(asked).toBe(0)
  })

  it('does ask when there IS something to open', () => {
    // POSITIVE BEFORE ABSENCE: the check still happens where it matters, so
    // the absence above is restraint rather than a store that never checks.
    let asked = 0
    const h = harness()
    h.store.save(IDENTITY)
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => {
          asked += 1
          return true
        },
        encryptString: (p) => Buffer.from(`enc:${p}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').slice(4),
      },
      read: () => h.peek(),
      write: () => {},
      remove: () => {},
    })
    store.load()
    expect(asked).toBeGreaterThan(0)
  })

  it('still refuses to load when the keychain is gone and a file exists', () => {
    const h = harness()
    h.store.save(IDENTITY)
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => false,
        encryptString: (p) => Buffer.from(p, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
      read: () => h.peek(),
      write: () => {},
      remove: () => {},
    })
    expect(store.load()).toBeNull()
  })
})

describe('an unreadable store is simply "signed out"', () => {
  // A restored backup, a changed login password, a half-written file. Every one
  // of those means not-signed-in, which is a complete state the app supports —
  // so none of them is an error anybody needs to see.
  it.each([
    ['a blob it cannot decrypt', Buffer.from('garbage', 'utf8')],
    ['an empty file', Buffer.alloc(0)],
    ['encrypted nonsense', Buffer.from('enc:{not json', 'utf8')],
    ['a shape from an older version', Buffer.from('enc:{"subject":"u"}', 'utf8')],
    ['a null token', Buffer.from('enc:{"subject":"u","token":null}', 'utf8')],
  ])('returns null for %s', (_label, content) => {
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (p) => Buffer.from(`enc:${p}`, 'utf8'),
        decryptString: (b) => {
          const t = b.toString('utf8')
          if (!t.startsWith('enc:')) throw new Error('nope')
          return t.slice(4)
        },
      },
      read: () => content,
      write: () => {},
      remove: () => {},
    })
    expect(store.load()).toBeNull()
  })
})

describe('signing out says what it did', () => {
  it('removes a stored identity and reports it', () => {
    const h = harness()
    h.store.save(IDENTITY)
    const report = h.store.signOut()
    expect(report.removed).toBe(true)
    expect(report.detail).toMatch(/removed from this computer/i)
    expect(h.peek()).toBeNull()
    expect(h.store.load()).toBeNull()
  })

  // "You were already signed out" is a different fact from "I just signed you
  // out", and reporting the second when the first is true is the app telling
  // somebody something untrue about their own state.
  it('distinguishes "removed" from "there was nothing"', () => {
    const h = harness()
    const report = h.store.signOut()
    expect(report.removed).toBe(false)
    expect(report.detail).toMatch(/already signed out/i)
  })

  it('does not claim success when the removal failed', () => {
    const store = createIdentityStore({
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (p) => Buffer.from(p, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
      read: () => Buffer.from('something', 'utf8'),
      write: () => {},
      remove: () => {
        throw new Error('EPERM')
      },
    })
    const report = store.signOut()
    expect(report.removed).toBe(false)
    expect(report.detail).toMatch(/couldn't remove/i)
  })
})

describe('expiry', () => {
  it('is past when the clock says so', () => {
    expect(isExpired(IDENTITY, 1_999)).toBe(false)
    expect(isExpired(IDENTITY, 2_000)).toBe(true)
    expect(isExpired(IDENTITY, 2_001)).toBe(true)
  })

  it('never expires when the provider said nothing', () => {
    expect(isExpired({ ...IDENTITY, expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})
