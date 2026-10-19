import { createHash } from 'node:crypto'
import {
  authorizationUrl,
  constantTimeEquals,
  createPkcePair,
  createState,
  judgeCallback,
  loopbackRedirectUri,
} from './oauth-desktop'

describe('PKCE', () => {
  it('derives the challenge as S256 of the verifier', () => {
    const pair = createPkcePair()
    const expected = createHash('sha256')
      .update(pair.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(pair.challenge).toBe(expected)
    expect(pair.method).toBe('S256')
  })

  it('produces a verifier inside the RFC 7636 length window', () => {
    const { verifier } = createPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('is base64url — nothing to escape in a URL, nothing to strip', () => {
    const { verifier, challenge } = createPkcePair()
    for (const value of [verifier, challenge]) {
      expect(value).toMatch(/^[A-Za-z0-9\-_]+$/)
      expect(encodeURIComponent(value)).toBe(value)
    }
  })

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 20 }, () => createPkcePair().verifier))
    expect(seen.size).toBe(20)
  })

  it('never reveals the verifier through the challenge', () => {
    const pair = createPkcePair()
    expect(pair.challenge).not.toBe(pair.verifier)
    expect(pair.challenge).not.toContain(pair.verifier.slice(0, 16))
  })
})

describe('the authorization URL', () => {
  const base = {
    authorizationEndpoint: 'https://auth.example/authorize',
    clientId: 'flow-desktop',
    scopes: ['openid', 'email'],
    redirectUri: 'http://127.0.0.1:51234/callback',
    state: 'st-1',
    pkce: { verifier: 'v', challenge: 'ch', method: 'S256' as const },
  }

  it('carries everything a provider needs and nothing it does not', () => {
    const url = new URL(authorizationUrl(base))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('flow-desktop')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid email')
  })

  // NEVER the verifier. It is the one value that must not reach the browser.
  it('does not carry the verifier', () => {
    const url = authorizationUrl({ ...base, pkce: { ...base.pkce, verifier: 'SECRETVERIFIER' } })
    expect(url).not.toContain('SECRETVERIFIER')
  })

  it('encodes a hostile scope rather than letting it add a parameter', () => {
    const url = new URL(
      authorizationUrl({ ...base, scopes: ['openid&client_id=attacker'] }),
    )
    expect(url.searchParams.get('client_id')).toBe('flow-desktop')
    expect(url.searchParams.get('scope')).toBe('openid&client_id=attacker')
  })

  it('preserves an endpoint that already has query parameters', () => {
    const url = new URL(
      authorizationUrl({ ...base, authorizationEndpoint: 'https://auth.example/a?tenant=acme' }),
    )
    expect(url.searchParams.get('tenant')).toBe('acme')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('omits scope entirely when there is none', () => {
    const url = new URL(authorizationUrl({ ...base, scopes: [] }))
    expect(url.searchParams.has('scope')).toBe(false)
  })
})

describe('judging a callback', () => {
  const STATE = 'the-expected-state'
  const q = (s: string) => new URLSearchParams(s)

  it('accepts a well-formed one', () => {
    expect(judgeCallback(q(`code=abc&state=${STATE}`), STATE)).toEqual({ ok: true, code: 'abc' })
  })

  // SOMEBODY ELSE'S CODE, walked into this app's session.
  it('refuses a mismatched state', () => {
    const result = judgeCallback(q('code=abc&state=someone-elses'), STATE)
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('reason', expect.stringContaining('did not match'))
  })

  it('refuses a missing or empty state', () => {
    expect(judgeCallback(q('code=abc'), STATE).ok).toBe(false)
    expect(judgeCallback(q('code=abc&state='), STATE).ok).toBe(false)
  })

  // A DECLINE IS NOT A SUCCESS WITH NO CODE.
  it('reports the provider declining, and prefers its description', () => {
    expect(judgeCallback(q('error=access_denied'), STATE)).toEqual({
      ok: false,
      reason: 'access_denied',
    })
    expect(
      judgeCallback(q('error=access_denied&error_description=You+said+no'), STATE),
    ).toEqual({ ok: false, reason: 'You said no' })
  })

  // An error must be seen BEFORE the state check, or a provider's decline is
  // reported as a forgery and the person is told something frightening and wrong.
  it('reports an error even when the state is absent', () => {
    expect(judgeCallback(q('error=server_error'), STATE)).toEqual({
      ok: false,
      reason: 'server_error',
    })
  })

  it('refuses a clean callback carrying no code', () => {
    const result = judgeCallback(q(`state=${STATE}`), STATE)
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('reason', expect.stringContaining('no code'))
  })

  it('never returns a code when it refuses, whatever was sent', () => {
    for (const raw of [
      'code=abc&state=wrong',
      'code=abc',
      'error=denied&code=abc&state=' + STATE,
      '',
    ]) {
      const result = judgeCallback(q(raw), STATE)
      if (!result.ok) expect(result).not.toHaveProperty('code')
    }
  })
})

describe('constantTimeEquals', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
  })

  // `timingSafeEqual` THROWS on a length mismatch, which would itself be the
  // leak — and a crash in the callback handler.
  it('handles different lengths without throwing', () => {
    expect(() => constantTimeEquals('a', 'abcdef')).not.toThrow()
    expect(constantTimeEquals('a', 'abcdef')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
  })

  it('compares bytes, not code units', () => {
    expect(constantTimeEquals('é', 'é')).toBe(true)
    expect(constantTimeEquals('é', 'e')).toBe(false)
  })
})

describe('the loopback redirect', () => {
  // 127.0.0.1 LITERALLY. `localhost` can resolve to ::1, to a hosts entry, or
  // to nothing, and the redirect must match what was registered byte for byte.
  it('is a literal address, never a name', () => {
    expect(loopbackRedirectUri(51234)).toBe('http://127.0.0.1:51234/callback')
    expect(loopbackRedirectUri(51234)).not.toContain('localhost')
  })

  it('takes a path when a provider insists on one', () => {
    expect(loopbackRedirectUri(80, '/oauth/done')).toBe('http://127.0.0.1:80/oauth/done')
  })
})

describe('state', () => {
  it('is unguessable and unique', () => {
    const seen = new Set(Array.from({ length: 20 }, () => createState()))
    expect(seen.size).toBe(20)
    expect(createState().length).toBeGreaterThanOrEqual(43)
  })
})
