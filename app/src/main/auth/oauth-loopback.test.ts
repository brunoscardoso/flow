/**
 * THE WHOLE FLOW, AGAINST A FAKE PROVIDER.
 *
 * The plan asks for the desktop flow to be proved BEFORE a vendor is chosen.
 * This drives it end to end — browser opened, callback received, code exchanged
 * — with a provider that is 20 lines of test code, which is exactly the point:
 * if the flow needs a real vendor to be exercised, it cannot be evaluated
 * before one is picked.
 */
import { signIn, listenOnLoopback, DEFAULT_TIMEOUT_MS, DONE_PAGE } from './oauth-loopback'

const CONFIG = {
  authorizationEndpoint: 'https://auth.example/authorize',
  tokenEndpoint: 'https://auth.example/token',
  clientId: 'flow-desktop',
  scopes: ['openid', 'email'],
}

const IDENTITY = {
  subject: 'user-123',
  displayName: 'Dev User',
  token: 'live-session-token',
  expiresAt: null,
}

/**
 * A provider that follows the person to the browser and back.
 *
 * `respond` decides what comes back on the loopback, given the URL the app
 * opened — so a test can be a good provider, a declining one, or a hostile one.
 */
function fakeProvider(
  respond: (opened: URL) => string | null,
  options: { exchange?: (input: Record<string, string>) => Promise<typeof IDENTITY> } = {},
) {
  const opened: string[] = []
  const exchanges: Record<string, string>[] = []
  let settle: ((url: string) => void) | null = null
  let closed = false

  const deps = {
    openExternal: async (url: string) => {
      opened.push(url)
      const back = respond(new URL(url))
      if (back !== null) settle?.(back)
    },
    exchange: async (input: Record<string, string>) => {
      exchanges.push(input)
      return options.exchange ? options.exchange(input) : IDENTITY
    },
    listen: async (handler: (url: string) => { status: number; body: string }) => {
      const firstCallback = new Promise<string>((resolve) => {
        settle = resolve
      })
      return {
        port: 51234,
        close: () => {
          closed = true
        },
        firstCallback,
        // exposed for the page assertion below
        handler,
      }
    },
    timeoutMs: 50,
  }
  return { deps, opened, exchanges, wasClosed: () => closed }
}

/** A well-behaved provider: hands back the state it was given, with a code. */
const good = (opened: URL): string =>
  `/callback?code=auth-code-1&state=${encodeURIComponent(opened.searchParams.get('state') ?? '')}`

describe('a complete sign-in', () => {
  it('opens the system browser and comes back with an identity', async () => {
    const p = fakeProvider(good)
    const result = await signIn(CONFIG, p.deps as never)
    expect(result).toEqual({ ok: true, identity: IDENTITY })
    expect(p.opened).toHaveLength(1)
  })

  it('sends the browser to the provider, with PKCE and a loopback redirect', async () => {
    const p = fakeProvider(good)
    await signIn(CONFIG, p.deps as never)
    const url = new URL(p.opened[0] as string)
    expect(url.origin + url.pathname).toBe('https://auth.example/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback')
  })

  // The verifier is the one value that must never reach the browser — it is
  // what makes an intercepted code useless.
  it('never puts the verifier in the browser, only in the exchange', async () => {
    const p = fakeProvider(good)
    await signIn(CONFIG, p.deps as never)
    const verifier = p.exchanges[0]?.['verifier'] as string
    expect(verifier).toBeTruthy()
    expect(p.opened[0]).not.toContain(verifier)
  })

  it('exchanges the code it was actually given, with the same redirect', async () => {
    const p = fakeProvider(good)
    await signIn(CONFIG, p.deps as never)
    expect(p.exchanges[0]).toMatchObject({
      code: 'auth-code-1',
      clientId: 'flow-desktop',
      tokenEndpoint: 'https://auth.example/token',
      redirectUri: 'http://127.0.0.1:51234/callback',
    })
  })

  it('uses a fresh state and verifier on every attempt', async () => {
    const states = new Set<string>()
    for (let i = 0; i < 5; i += 1) {
      const p = fakeProvider(good)
      await signIn(CONFIG, p.deps as never)
      states.add(new URL(p.opened[0] as string).searchParams.get('state') ?? '')
    }
    expect(states.size).toBe(5)
  })
})

describe('a sign-in that does not complete', () => {
  // SOMEBODY ELSE'S CODE. The callback carries a valid-looking code and a state
  // this app never issued.
  it('refuses a forged callback and returns no identity', async () => {
    const p = fakeProvider(() => '/callback?code=attacker-code&state=not-ours')
    const result = await signIn(CONFIG, p.deps as never)
    expect(result.ok).toBe(false)
    expect(p.exchanges).toEqual([]) // …and never exchanged it
  })

  it('reports the provider declining, in its words', async () => {
    const p = fakeProvider(() => '/callback?error=access_denied&error_description=You+said+no')
    const result = await signIn(CONFIG, p.deps as never)
    expect(result).toEqual({ ok: false, reason: 'You said no' })
  })

  // A person who closes the tab leaves a promise nobody settles and a port
  // nobody frees.
  it('ends at the deadline rather than waiting for ever', async () => {
    const p = fakeProvider(() => null)
    const result = await signIn(CONFIG, p.deps as never)
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('reason', expect.stringMatching(/timed out/i))
  })

  it('survives a token exchange that throws, without leaking its message', async () => {
    const p = fakeProvider(good, {
      exchange: async () => {
        throw new Error('token endpoint said 500: internal at /srv/app/handler.rb:22')
      },
    })
    const result = await signIn(CONFIG, p.deps as never)
    expect(result.ok).toBe(false)
    // No provider internals, no path, in something a person reads.
    expect(result).toHaveProperty('reason', expect.not.stringContaining('/srv/'))
    expect(result).toHaveProperty('reason', expect.stringMatching(/try again/i))
  })

  it('survives a browser that cannot be opened', async () => {
    const p = fakeProvider(good)
    const deps = {
      ...p.deps,
      openExternal: async () => {
        throw new Error('no browser')
      },
    }
    const result = await signIn(CONFIG, deps as never)
    expect(result.ok).toBe(false)
  })
})

describe('the door always shuts', () => {
  // A loopback listener left running is a local endpoint any process on the
  // machine can talk to.
  it.each([
    ['a success', good],
    ['a forgery', () => '/callback?code=x&state=nope'],
    ['a decline', () => '/callback?error=access_denied'],
    ['a timeout', () => null],
  ])('closes the listener after %s', async (_label, respond) => {
    const p = fakeProvider(respond as (o: URL) => string | null)
    await signIn(CONFIG, p.deps as never)
    expect(p.wasClosed()).toBe(true)
  })
})

describe('what the browser tab says', () => {
  it('says something in plain words, and never shows a blank', () => {
    const page = DONE_PAGE('Signed in. Flow has what it needs.')
    expect(page).toContain('Signed in')
    expect(page).toContain('close this tab')
    expect(page).toMatch(/^<!doctype html>/i)
  })
})

describe('the deadline', () => {
  it('is long enough to find a password and short enough to end', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60_000)
  })
})

/**
 * THE REAL SOCKET.
 *
 * Every test above injects `listen`, so the actual server — the part that binds
 * a port and answers a browser — is untested by them. These drive it for real:
 * a bound port, a genuine HTTP request, a genuine response body. "Binds
 * 127.0.0.1 rather than the wildcard" is a security claim, and a claim about a
 * socket can only be checked against a socket.
 */
describe('the real loopback listener', () => {
  it('binds a port, answers the browser, and hands back the callback', async () => {
    const opened: string[] = []
    const result = await signIn(CONFIG, {
      openExternal: async (url: string) => {
        opened.push(url)
        const port = Number(new URL(url).searchParams.get('redirect_uri')?.split(':')[2]?.split('/')[0])
        const state = new URL(url).searchParams.get('state') ?? ''
        // A real request, from outside the process, like a browser makes.
        const response = await fetch(
          `http://127.0.0.1:${port}/callback?code=real-code&state=${encodeURIComponent(state)}`,
        )
        const body = await response.text()
        expect(response.status).toBe(200)
        expect(body).toContain('close this tab')
      },
      exchange: async () => IDENTITY,
      timeoutMs: 5_000,
    })
    expect(result).toEqual({ ok: true, identity: IDENTITY })
    expect(opened).toHaveLength(1)
  })

  // ASKED OF THE SOCKET, NOT OF A STRING WE BUILT.
  //
  // This assertion first read the hostname out of the redirect URI — which
  // `loopbackRedirectUri` hardcodes to 127.0.0.1 whatever the server did. It
  // therefore passed with the server bound to the WILDCARD, which is the exact
  // bug it claims to prevent, and a negative control is the only reason that
  // was noticed.
  it('binds loopback only, never the wildcard', async () => {
    const server = await listenOnLoopback(() => ({ status: 200, body: 'ok' }))
    try {
      expect(server.address).toBe('127.0.0.1')
      expect(server.address).not.toBe('0.0.0.0')
      expect(server.address).not.toBe('::')
    } finally {
      server.close()
    }
  })

  it('answers a favicon request without settling the flow', async () => {
    // A browser asks for /favicon.ico on the same origin. Answering it as the
    // callback would settle the sign-in with a URL carrying no code at all.
    const result = await signIn(CONFIG, {
      openExternal: async (url: string) => {
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? ''
        const { port } = new URL(redirect)
        const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
        expect(favicon.status).toBe(404)
      },
      exchange: async () => IDENTITY,
      timeoutMs: 300,
    })
    // It timed out rather than completing on the favicon.
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('reason', expect.stringMatching(/timed out/i))
  })

  it('frees the port afterwards', async () => {
    let port = 0
    await signIn(CONFIG, {
      openExternal: async (url: string) => {
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? ''
        port = Number(new URL(redirect).port)
      },
      exchange: async () => IDENTITY,
      timeoutMs: 50,
    })
    // Nothing is listening once the flow has ended.
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow()
  })
})

/**
 * A SERVER-MINTED STATE.
 *
 * When the authorization is started by a server, the state the callback is
 * judged against is the server's — one it recorded and can retire, so a replay
 * is refusable by something that keeps records. The client cannot offer that
 * about its own request.
 */
describe('when a server mints the state', () => {
  it("uses the server URL and judges against the server state", async () => {
    const opened: string[] = []
    const exchanges: Record<string, string>[] = []
    let settle: ((url: string) => void) | null = null
    const result = await signIn(CONFIG, {
      begin: async (redirectUri: string) => {
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
        return { url: 'https://github.com/login/oauth/authorize?x=1', state: 'server-state' }
      },
      openExternal: async (url: string) => {
        opened.push(url)
        settle?.('/callback?code=real&state=server-state')
      },
      exchange: async (input: Record<string, string>) => {
        exchanges.push(input)
        return IDENTITY
      },
      listen: async () => ({
        port: 51234,
        address: '127.0.0.1',
        close: () => {},
        firstCallback: new Promise<string>((resolve) => {
          settle = resolve
        }),
      }),
      timeoutMs: 2000,
    } as never)

    expect(result).toEqual({ ok: true, identity: IDENTITY })
    expect(opened[0]).toBe('https://github.com/login/oauth/authorize?x=1')
    // The state reaches the exchange, so the server can retire it.
    expect(exchanges[0]?.['state']).toBe('server-state')
  })

  it('refuses a callback carrying the state the CLIENT would have made', async () => {
    // The client's own state is replaced by the server's; a callback echoing
    // anything else is somebody else's authorization.
    let settle: ((url: string) => void) | null = null
    const result = await signIn(CONFIG, {
      begin: async () => ({ url: 'https://github.com/login/oauth/authorize', state: 'server-state' }),
      openExternal: async () => {
        settle?.('/callback?code=real&state=not-the-server-state')
      },
      exchange: async () => IDENTITY,
      listen: async () => ({
        port: 51234,
        address: '127.0.0.1',
        close: () => {},
        firstCallback: new Promise<string>((resolve) => {
          settle = resolve
        }),
      }),
      timeoutMs: 2000,
    } as never)
    expect(result.ok).toBe(false)
  })

  it('reports a server that will not start a sign-in', async () => {
    const result = await signIn(CONFIG, {
      begin: async () => {
        throw new Error('sign-in start returned 503')
      },
      openExternal: async () => {},
      exchange: async () => IDENTITY,
      listen: async () => ({
        port: 51234,
        address: '127.0.0.1',
        close: () => {},
        firstCallback: new Promise<string>(() => {}),
      }),
      timeoutMs: 500,
    } as never)
    expect(result.ok).toBe(false)
  })
})

/**
 * THE PAGE AND THE OUTCOME AGREE.
 *
 * They did not, once, and it is the failure a person actually met: a real
 * sign-in succeeded — identity stored, session claimed — while the browser tab
 * said "That sign-in could not be completed." The page used `judgeCallback`
 * (which needs a code) after the outcome moved to `judgeHandBack` (which needs
 * only a state).
 *
 * Nothing caught it because the page is the one output no test was reading.
 */
describe('what the browser is told matches what happened', () => {
  async function run(callbackQuery: string) {
    let settle: ((url: string) => void) | null = null
    let handler: ((url: string) => { status: number; body: string }) | null = null
    const result = await signIn(CONFIG, {
      begin: async () => ({ url: 'https://github.com/login/oauth/authorize', state: 'srv' }),
      openExternal: async () => {
        // The page the browser would be shown for this very callback.
        page = handler?.(callbackQuery) ?? null
        settle?.(callbackQuery)
      },
      exchange: async () => IDENTITY,
      listen: async (h: (url: string) => { status: number; body: string }) => {
        handler = h
        return {
          port: 51234,
          address: '127.0.0.1',
          close: () => {},
          firstCallback: new Promise<string>((resolve) => {
            settle = resolve
          }),
        }
      },
      timeoutMs: 3000,
    } as never)
    return { result, page }
  }
  let page: { status: number; body: string } | null = null

  it('says SIGNED IN when the hand-back is good', async () => {
    const { result, page: shown } = await run('/callback?state=srv')
    expect(result.ok).toBe(true)
    expect(shown?.status).toBe(200)
    expect(shown?.body).toContain('Signed in')
    // The exact regression: a state-only hand-back must not read as a failure.
    expect(shown?.body).not.toContain('could not be completed')
  })

  it('says it failed when it did', async () => {
    const { result, page: shown } = await run('/callback?state=somebody-elses')
    expect(result.ok).toBe(false)
    expect(shown?.status).toBe(400)
    expect(shown?.body).toContain('could not be completed')
  })

  it('never tells the browser the opposite of the outcome', async () => {
    for (const query of ['/callback?state=srv', '/callback?state=wrong', '/callback?error=declined']) {
      const { result, page: shown } = await run(query)
      expect(shown?.status === 200).toBe(result.ok)
    }
  })
})
