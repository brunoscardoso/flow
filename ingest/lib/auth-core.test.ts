import {
  GITHUB_SCOPES,
  SESSION_TTL_MS,
  STATE_TTL_MS,
  failureResponse,
  githubAuthorizeUrl,
  isAllowedRedirect,
  judgeCallbackBody,
  judgeStart,
  mintState,
  signSession,
  stateUsable,
  usableSessionSecret,
  verifySession,
} from './auth-core.js';

const SECRET = 'a-server-side-signing-secret';

describe('the redirect rule', () => {
  // A redirect the server will accept is a place it will mail an authorization
  // code to. "Whatever the caller says" is an open redirector.
  it('accepts a loopback with a real port', () => {
    expect(isAllowedRedirect('http://127.0.0.1:51234/callback')).toBe(true);
  });

  it.each([
    ['a public host', 'https://evil.example/callback'],
    ['http on a public host', 'http://evil.example/callback'],
    ['localhost by name, which can resolve anywhere', 'http://localhost:51234/callback'],
    ['IPv6 loopback, which the desktop flow never binds', 'http://[::1]:51234/callback'],
    ['https on loopback, which has no certificate', 'https://127.0.0.1:51234/callback'],
    ['a privileged port', 'http://127.0.0.1:80/callback'],
    ['no port at all', 'http://127.0.0.1/callback'],
    ['a query string', 'http://127.0.0.1:51234/callback?next=https://evil.example'],
    ['a fragment', 'http://127.0.0.1:51234/callback#x'],
    ['nonsense', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_label, uri) => {
    expect(isAllowedRedirect(uri)).toBe(false);
  });
});

describe('the authorization URL', () => {
  const base = { clientId: 'Iv1.abc', redirectUri: 'http://127.0.0.1:51234/callback', state: 'st' };

  it('goes to GitHub and carries what GitHub needs', () => {
    const url = new URL(githubAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });

  // The narrowest thing that yields an identity. Anything more is access nobody
  // asked for, on a token the server holds.
  it('asks for nothing beyond a readable identity', () => {
    expect(GITHUB_SCOPES).toEqual(['read:user']);
    expect(githubAuthorizeUrl(base)).not.toMatch(/repo|write|admin|delete/);
  });

  it('never carries a secret', () => {
    expect(githubAuthorizeUrl(base)).not.toContain('secret');
  });
});

describe('the session token', () => {
  it('round-trips a subject', () => {
    const token = signSession('gh|12345', 2_000, SECRET);
    expect(verifySession(token, SECRET, 1_000)).toEqual({
      ok: true,
      subject: 'gh|12345',
      expiresAt: 2_000,
    });
  });

  it('is verifiable with no database and no call to GitHub', () => {
    // The whole point of signing rather than storing. If this ever needs a
    // lookup, the claim in the plan stops being true.
    const token = signSession('gh|1', Date.now() + 1000, SECRET);
    expect(verifySession(token, SECRET, Date.now()).ok).toBe(true);
  });

  it('refuses another signer', () => {
    const token = signSession('gh|1', 2_000, SECRET);
    expect(verifySession(token, 'a-different-secret', 1_000)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  // THE SIGNATURE IS CHECKED BEFORE THE BODY IS BELIEVED. Answering `expired`
  // for a forged token tells the forger their body parsed, which is one bit
  // they did not have.
  it('reports a forged token as a bad signature, never as expired', () => {
    const forged =
      Buffer.from(JSON.stringify({ sub: 'gh|1', exp: 1 }), 'utf8').toString('base64url') +
      '.not-a-real-signature';
    expect(verifySession(forged, SECRET, 1_000)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('expires', () => {
    const token = signSession('gh|1', 1_000, SECRET);
    expect(verifySession(token, SECRET, 999).ok).toBe(true);
    expect(verifySession(token, SECRET, 1_000)).toEqual({ ok: false, reason: 'expired' });
    expect(verifySession(token, SECRET, 1_001)).toEqual({ ok: false, reason: 'expired' });
  });

  it.each([['', 'empty'], ['no-dot', 'no separator'], ['.', 'nothing either side'], ['a.b', 'not base64 json']])(
    'refuses %s as malformed or unsigned',
    (token) => {
      const verdict = verifySession(token, SECRET, 1_000);
      expect(verdict.ok).toBe(false);
    },
  );

  it('cannot be edited without breaking the signature', () => {
    const token = signSession('gh|1', 9_999, SECRET);
    const [body, sig] = token.split('.');
    const swapped =
      Buffer.from(JSON.stringify({ sub: 'gh|somebody-else', exp: 9_999 }), 'utf8').toString(
        'base64url',
      ) + '.' + sig;
    expect(body).toBeTruthy();
    expect(verifySession(swapped, SECRET, 1_000)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('lasts long enough not to nag and short enough to end', () => {
    expect(SESSION_TTL_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000);
    expect(SESSION_TTL_MS).toBeLessThanOrEqual(90 * 24 * 60 * 60_000);
  });
});

// The share contract's shared vector (flow/contracts/share-api_contract.md
// §2.2). planflow.sh asserts the same bytes in
// `src/lib/share/author-session.test.ts`: change the signing here without
// changing it there and one of the two goes red.
describe('the shared session vector', () => {
  const VECTOR_SECRET = 'flow-share-contract-test-secret-not-for-production';
  const VECTOR_SUB = 'github|1234567';
  const VECTOR_EXP = 4102444800000;
  const VECTOR_TOKEN =
    'eyJzdWIiOiJnaXRodWJ8MTIzNDU2NyIsImV4cCI6NDEwMjQ0NDgwMDAwMH0.3ifktXS0OwaczxGdWrZfSjpwhVSs7J9wnq4BgpoKk_Q';
  const VECTOR_NOW = 1790000000000;

  it('signSession produces the contract token, byte for byte', () => {
    expect(signSession(VECTOR_SUB, VECTOR_EXP, VECTOR_SECRET)).toBe(VECTOR_TOKEN);
  });

  it('verifies to the contract subject and expiry', () => {
    expect(verifySession(VECTOR_TOKEN, VECTOR_SECRET, VECTOR_NOW)).toEqual({
      ok: true,
      subject: VECTOR_SUB,
      expiresAt: VECTOR_EXP,
    });
  });

  it('is a bad signature under any other secret', () => {
    expect(verifySession(VECTOR_TOKEN, `${VECTOR_SECRET}x`, VECTOR_NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is expired at exp', () => {
    expect(verifySession(VECTOR_TOKEN, VECTOR_SECRET, VECTOR_EXP - 1).ok).toBe(true);
    expect(verifySession(VECTOR_TOKEN, VECTOR_SECRET, VECTOR_EXP)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('the session secret', () => {
  it('is used byte for byte — never trimmed, as planflow.sh reads it', () => {
    const secret = ` ${'s'.repeat(32)}\n`;
    expect(usableSessionSecret(secret)).toBe(secret);
  });

  it('is refused below 32 bytes, and when absent', () => {
    expect(usableSessionSecret('s'.repeat(31))).toBe('');
    expect(usableSessionSecret('s'.repeat(32))).toBe('s'.repeat(32));
    expect(usableSessionSecret('')).toBe('');
    expect(usableSessionSecret(undefined)).toBe('');
  });

  it('counts bytes, not characters', () => {
    // 16 two-byte characters: 32 bytes.
    expect(usableSessionSecret('é'.repeat(16))).toBe('é'.repeat(16));
    expect(usableSessionSecret('é'.repeat(15))).toBe('');
  });
});

describe('state', () => {
  it('is unguessable and never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintState()));
    expect(seen.size).toBe(50);
    expect(mintState().length).toBeGreaterThanOrEqual(43);
  });

  it('is usable once, before it goes stale', () => {
    const now = 1_000_000;
    expect(stateUsable({ createdAt: now, usedAt: null }, now)).toEqual({ ok: true });
  });

  it.each([
    ['never issued', null, 'unknown-state'],
    ['already redeemed', { createdAt: 1_000_000, usedAt: 1_000_001 }, 'state-already-used'],
    ['too old', { createdAt: 0, usedAt: null }, 'state-expired'],
  ])('refuses one that was %s', (_label, record, failure) => {
    const verdict = stateUsable(record as never, 1_000_000 + STATE_TTL_MS + 1);
    expect(verdict).toEqual({ ok: false, failure });
  });
});

describe('what a caller is told', () => {
  // ONE ANSWER FOR THREE CAUSES. The distinction is recorded for us, not told
  // to the caller — "that state existed once" is a fact a replayer would like
  // confirmed.
  it('does not distinguish unknown, expired and replayed states', () => {
    const answers = (['unknown-state', 'state-expired', 'state-already-used'] as const).map(
      failureResponse,
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it('does distinguish a decline from a failure', () => {
    expect(failureResponse('declined').status).toBe(400);
    expect(failureResponse('exchange-failed').status).toBe(502);
  });

  it('never relays a provider message', () => {
    for (const f of ['declined', 'exchange-failed', 'no-identity', 'unknown-state'] as const) {
      const { reason } = failureResponse(f);
      expect(reason).not.toMatch(/github|oauth|token|client_id|secret|http/i);
    }
  });
});

describe('judging request bodies', () => {
  it('accepts a well-formed start', () => {
    expect(judgeStart({ redirectUri: 'http://127.0.0.1:51234/callback' })).toEqual({
      ok: true,
      redirectUri: 'http://127.0.0.1:51234/callback',
    });
  });

  it('refuses a start with a redirect it will not mail a code to', () => {
    const verdict = judgeStart({ redirectUri: 'https://evil.example/cb' });
    expect(verdict.ok).toBe(false);
    // NO ECHO: repeating the caller's URI back makes a refusal a reflection.
    if (!verdict.ok) expect(verdict.reason).not.toContain('evil.example');
  });

  it.each([['a string', 'nope'], ['an array', []], ['null', null], ['no uri', {}]])(
    'refuses %s as a start body',
    (_label, raw) => {
      expect(judgeStart(raw).ok).toBe(false);
    },
  );

  it('accepts a well-formed callback', () => {
    expect(judgeCallbackBody({ code: 'c', state: 's' })).toEqual({
      ok: true,
      code: 'c',
      state: 's',
    });
  });

  it.each([
    ['no code', { state: 's' }],
    ['no state', { code: 'c' }],
    ['an empty code', { code: '', state: 's' }],
    ['an absurd code', { code: 'x'.repeat(513), state: 's' }],
    ['an absurd state', { code: 'c', state: 'x'.repeat(513) }],
  ])('refuses %s', (_label, raw) => {
    expect(judgeCallbackBody(raw).ok).toBe(false);
  });
});
