import { signInToFlow } from './sign-in'
import { createIdentityStore } from './identity-store'

const PROVIDER = { endpoint: 'https://x.example/api/auth', clientId: 'Iv1.abc' }

function storeHarness(options: { available?: boolean; writeFails?: boolean } = {}) {
  let file: Buffer | null = null
  const store = createIdentityStore({
    encryption: {
      isEncryptionAvailable: () => options.available ?? true,
      encryptString: (p) => Buffer.from(`enc:${p}`, 'utf8'),
      decryptString: (b) => {
        const t = b.toString('utf8')
        if (!t.startsWith('enc:')) throw new Error('nope')
        return t.slice(4)
      },
    },
    read: () => file,
    write: (data) => {
      if (options.writeFails === true) throw new Error('EPERM')
      file = data
    },
    remove: () => {
      file = null
    },
  })
  return { store, peek: () => file }
}

/** A function that plays the whole server side. */
let lastRedirect = ''

function serverFetch(overrides: { start?: unknown; callback?: unknown; startStatus?: number } = {}) {
  return (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/start')) {
      try {
        lastRedirect = (JSON.parse(init?.body ?? '{}') as { redirectUri?: string }).redirectUri ?? ''
      } catch {
        lastRedirect = ''
      }
      if (overrides.startStatus !== undefined) return { ok: false, status: overrides.startStatus }
      return {
        ok: true,
        json: async () =>
          overrides.start ?? {
            url: 'https://github.com/login/oauth/authorize?state=srv',
            state: 'srv',
          },
      }
    }
    return {
      ok: true,
      json: async () =>
        overrides.callback ?? {
          token: 'flow-session',
          subject: 'github|42',
          displayName: 'Dev User',
          expiresAt: 9_999,
        },
    }
  }) as unknown as typeof fetch
}

describe('signing in', () => {
  it('runs the whole flow and keeps the identity', async () => {
    const h = storeHarness()
    const result = await signInToFlow({
      store: h.store,
      provider: PROVIDER,
      fetchFn: serverFetch(),
      timeoutMs: 8000,
      // Play the browser: the real one lands back on the loopback the flow just
      // bound, so this does the same with the server's state.
      openExternal: async (url) => {
        const state = new URL(url).searchParams.get('state') ?? 'srv'
        const port = Number(lastRedirect.split(':')[2]?.split('/')[0])
        await fetch(`http://127.0.0.1:${port}/callback?code=real&state=${state}`).catch(
          () => undefined,
        )
      },
    })
    expect(result).toEqual({ ok: true, subject: 'github|42', displayName: 'Dev User' })
    // …and it is actually in the store, not merely reported.
    expect(h.store.load()?.subject).toBe('github|42')
    expect(h.store.load()?.token).toBe('flow-session')
  }, 20000)

  // NOT AN ERROR — this is every build until a GitHub app exists.
  it('says sign-in is unavailable when the build has no provider', async () => {
    const h = storeHarness()
    const result = await signInToFlow({
      store: h.store,
      provider: null,
      openExternal: async () => {},
    })
    expect(result).toEqual({
      ok: false,
      reason: 'Sign-in is not available in this build of Flow.',
    })
  })

  // ASKED BEFORE THE BROWSER OPENS. Sending somebody through GitHub and only
  // then finding there is nowhere to keep the result wastes their time.
  it('refuses before opening a browser when there is no keychain', async () => {
    const h = storeHarness({ available: false })
    let opened = 0
    const result = await signInToFlow({
      store: h.store,
      provider: PROVIDER,
      fetchFn: serverFetch(),
      openExternal: async () => {
        opened += 1
      },
    })
    expect(result.ok).toBe(false)
    expect(opened).toBe(0)
    if (!result.ok) expect(result.reason).toMatch(/works exactly as it does now/)
  })

  it('never throws, whatever the server does', async () => {
    const h = storeHarness()
    await expect(
      signInToFlow({
        store: h.store,
        provider: PROVIDER,
        fetchFn: serverFetch({ startStatus: 503 }),
        timeoutMs: 3000,
        openExternal: async () => {},
      }),
    ).resolves.toMatchObject({ ok: false })
  }, 20000)
})
