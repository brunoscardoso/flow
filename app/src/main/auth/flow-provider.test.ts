import {
  assertNotASecret,
  beginWithFlow,
  configuredProvider,
  exchangeWithFlow,
} from './flow-provider'

describe('the configured provider', () => {
  // NULL IS THE ORDINARY CASE — no GitHub app is configured yet, and a build
  // from a clone must offer no sign-in rather than one that cannot work.
  it('is nowhere when the build configured nothing', () => {
    expect(configuredProvider({ endpoint: '', clientId: '' })).toBeNull()
    expect(configuredProvider()).toBeNull()
  })

  it('is nowhere when only half of it was configured', () => {
    expect(configuredProvider({ endpoint: 'https://x/api/auth', clientId: '' })).toBeNull()
    expect(configuredProvider({ endpoint: '', clientId: 'Iv1.abc' })).toBeNull()
  })

  it('refuses a plaintext endpoint', () => {
    expect(configuredProvider({ endpoint: 'http://x/api/auth', clientId: 'Iv1.abc' })).toBeNull()
  })

  it('is the provider when both halves are there', () => {
    expect(configuredProvider({ endpoint: 'https://x/api/auth', clientId: 'Iv1.abc' })).toEqual({
      endpoint: 'https://x/api/auth',
      clientId: 'Iv1.abc',
    })
  })

  it('trims a trailing slash so route joins do not double it', () => {
    expect(configuredProvider({ endpoint: 'https://x/api/auth/', clientId: 'Iv1.abc' })?.endpoint).toBe(
      'https://x/api/auth',
    )
  })

  // The one mistake that would matter: pasting the SECRET half of the pair.
  it('refuses to be configured with a client secret', () => {
    expect(
      configuredProvider({ endpoint: 'https://x/api/auth', clientId: 'a'.repeat(40) }),
    ).toBeNull()
  })
})

describe('the client id tripwire', () => {
  it('passes a real client id', () => {
    expect(assertNotASecret('Iv1.8a61f9b3a7aba766')).toBeNull()
    expect(assertNotASecret('Ov23liABCDEF1234')).toBeNull()
  })

  it('catches the secret half of the same pair', () => {
    const reason = assertNotASecret('0123456789abcdef0123456789abcdef01234567')
    expect(reason).toContain('SECRET')
    expect(reason).toContain('client ID')
  })

  it.each(['ghp_aaaaaaaaaaaaaaaaaaaa', 'sk-aaaaaaaaaaaa', 'postgres://u:p@h/d'])(
    'catches %s',
    (value) => {
      expect(assertNotASecret(value)).not.toBeNull()
    },
  )
})

describe('beginning a sign-in through the function', () => {
  const ok = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

  it('returns the GitHub URL and the state the SERVER issued', async () => {
    const result = await beginWithFlow({
      endpoint: 'https://x/api/auth',
      redirectUri: 'http://127.0.0.1:51234/callback',
      fetchFn: ok({ url: 'https://github.com/login/oauth/authorize?x=1', state: 'st' }),
    })
    expect(result).toEqual({ url: 'https://github.com/login/oauth/authorize?x=1', state: 'st' })
  })

  // A URL that is not GitHub's is a redirect somewhere nobody chose — the
  // client-side half of the rule the server already enforces on redirects.
  it('refuses a URL that does not go to GitHub', async () => {
    await expect(
      beginWithFlow({
        endpoint: 'https://x/api/auth',
        redirectUri: 'http://127.0.0.1:51234/callback',
        fetchFn: ok({ url: 'https://evil.example/authorize', state: 'st' }),
      }),
    ).rejects.toThrow(/GitHub URL/)
  })

  it('refuses a start with no state', async () => {
    await expect(
      beginWithFlow({
        endpoint: 'https://x/api/auth',
        redirectUri: 'http://127.0.0.1:51234/callback',
        fetchFn: ok({ url: 'https://github.com/login/oauth/authorize' }),
      }),
    ).rejects.toThrow(/state/)
  })

  it('reports a refusing server rather than inventing a URL', async () => {
    const refusing = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    await expect(
      beginWithFlow({
        endpoint: 'https://x/api/auth',
        redirectUri: 'http://127.0.0.1:51234/callback',
        fetchFn: refusing,
      }),
    ).rejects.toThrow(/503/)
  })
})

describe('exchanging a code through the function', () => {
  const ok = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

  it('returns what the identity store expects', async () => {
    const result = await exchangeWithFlow({
      endpoint: 'https://x/api/auth',
      code: 'c',
      state: 's',
      fetchFn: ok({ token: 't', subject: 'github|42', displayName: 'Dev User', expiresAt: 99 }),
    })
    expect(result).toEqual({ token: 't', subject: 'github|42', displayName: 'Dev User', expiresAt: 99 })
  })

  it('tolerates a provider that sends no display name or expiry', async () => {
    const result = await exchangeWithFlow({
      endpoint: 'https://x/api/auth',
      code: 'c',
      state: 's',
      fetchFn: ok({ token: 't', subject: 'github|42' }),
    })
    expect(result.displayName).toBeNull()
    expect(result.expiresAt).toBeNull()
  })

  it.each([
    ['no token', { subject: 'github|42' }],
    ['an empty token', { token: '', subject: 'github|42' }],
    ['no subject', { token: 't' }],
  ])('refuses a response with %s', async (_label, body) => {
    await expect(
      exchangeWithFlow({ endpoint: 'https://x/api/auth', code: 'c', state: 's', fetchFn: ok(body) }),
    ).rejects.toThrow()
  })

  it('reports a refusing server', async () => {
    const refusing = (async () => ({ ok: false, status: 400 })) as unknown as typeof fetch
    await expect(
      exchangeWithFlow({ endpoint: 'https://x/api/auth', code: 'c', state: 's', fetchFn: refusing }),
    ).rejects.toThrow(/400/)
  })
})
