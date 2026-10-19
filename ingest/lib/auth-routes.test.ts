/**
 * THE SIGN-IN ROUTES, against a GitHub that ENFORCES `redirect_uri`.
 *
 * The previous version of this file used a fake that accepted whatever it was
 * given, and every test passed while the flow was unusable: the server sent
 * GitHub the app's loopback, GitHub validated it against the ONE callback the
 * OAuth App registers, and refused with "The redirect_uri is not associated
 * with this application."
 *
 * The fake below registers a callback and refuses anything else, exactly as
 * GitHub does. That one rule is the difference between a suite that agreed with
 * a broken design and one that would have stopped it.
 */
import { handleStart } from '../api/auth/start.js';
import { handleCallback, type GithubExchange } from '../api/auth/callback.js';
import { handleClaim } from '../api/auth/claim.js';
import { STATE_TTL_MS, verifySession } from './auth-core.js';
import type { AuthDb } from './auth-db.js';

const SECRET = 'server-signing-secret';
const CLIENT_ID = 'Ov23liTEST';
const SERVER_CALLBACK = 'https://ingest.example/api/auth/callback';
const LOOPBACK = 'http://127.0.0.1:51234/callback';
const NOW = 1_700_000_000_000;

/** GitHub, with the one rule that matters. */
function github(registeredCallback = SERVER_CALLBACK) {
  return {
    /** Refuses an authorization URL whose redirect_uri is not the registered one. */
    authorize(url: string): { ok: true } | { ok: false; reason: string } {
      const asked = new URL(url).searchParams.get('redirect_uri') ?? '';
      if (asked !== registeredCallback) {
        return { ok: false, reason: 'The redirect_uri is not associated with this application.' };
      }
      return { ok: true };
    },
  };
}

function harness(overrides: Partial<AuthDb> = {}) {
  type Row = {
    redirectUri: string;
    createdAt: number;
    usedAt: number | null;
    claimedAt: number | null;
    token: string | null;
    subject: string | null;
    displayName: string | null;
    expiresAt: number | null;
  };
  const states = new Map<string, Row>();
  const identities: { subject: string; displayName: string | null }[] = [];
  const db: AuthDb = {
    rememberState: async (state, redirectUri) => {
      states.set(state, {
        redirectUri,
        createdAt: NOW,
        usedAt: null,
        claimedAt: null,
        token: null,
        subject: null,
        displayName: null,
        expiresAt: null,
      });
    },
    readState: async (state) => {
      const r = states.get(state);
      return r === undefined ? null : { createdAt: r.createdAt, usedAt: r.usedAt };
    },
    retireState: async (state) => {
      const r = states.get(state);
      if (r && r.usedAt === null) r.usedAt = NOW;
    },
    readRedirect: async (state) => states.get(state)?.redirectUri ?? null,
    parkSession: async (state, session) => {
      const r = states.get(state);
      if (r) Object.assign(r, { ...session });
    },
    readClaim: async (state) => states.get(state) ?? null,
    markClaimed: async (state) => {
      const r = states.get(state);
      if (r && r.claimedAt === null) r.claimedAt = NOW;
    },
    rememberIdentity: async (subject, _provider, displayName) => {
      identities.push({ subject, displayName });
    },
    ...overrides,
  };
  // ONE RESPONSE, MUTATED — which is what a real one is. Modelling each call as
  // a new entry made `setHeader('location'); status(302)` look like two
  // responses with the redirect on a phantom status 0, and the tests read the
  // wrong one.
  const sent: { status: number; body?: unknown; headers: Record<string, string> }[] = [];
  const current = (): { status: number; body?: unknown; headers: Record<string, string> } => {
    if (sent.length === 0) sent.push({ status: 0, headers: {} });
    return sent[sent.length - 1] as { status: number; body?: unknown; headers: Record<string, string> };
  };
  const response = {
    status(code: number) {
      current().status = code;
      return this;
    },
    json(body: unknown) {
      current().body = body;
    },
    setHeader(name: string, value: string) {
      current().headers[name] = value;
    },
    end(body?: string) {
      if (body !== undefined) current().body = body;
    },
  };
  return { db, response, sent, states, identities };
}

const post = (body: unknown) => ({ method: 'POST', body });

async function start(h: ReturnType<typeof harness>) {
  await handleStart(post({ redirectUri: LOOPBACK }), h.response as never, h.db, CLIENT_ID, SERVER_CALLBACK);
  const body = h.sent[0]?.body as { url: string; state: string };
  h.sent.length = 0;
  return body;
}

describe('GitHub accepts the authorization URL', () => {
  // THE TEST THAT WAS MISSING. The old fake took any redirect_uri, so the suite
  // agreed with a URL GitHub refuses by name.
  it('sends the SERVER callback, which is what is registered', async () => {
    const h = harness();
    const { url } = await start(h);
    expect(github().authorize(url)).toEqual({ ok: true });
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(SERVER_CALLBACK);
  });

  it('does NOT send the app loopback — GitHub would refuse it', async () => {
    const h = harness();
    const { url } = await start(h);
    expect(url).not.toContain('127.0.0.1');
    // Proving the fake would have caught the old design.
    const asIfOld = url.replace(encodeURIComponent(SERVER_CALLBACK), encodeURIComponent(LOOPBACK));
    expect(github().authorize(asIfOld).ok).toBe(false);
  });

  it('refuses to start without a registered callback configured', async () => {
    const h = harness();
    await handleStart(post({ redirectUri: LOOPBACK }), h.response as never, h.db, CLIENT_ID, '');
    expect(h.sent[0]?.status).toBe(503);
  });

  it('still records the app loopback, for the hand-back', async () => {
    const h = harness();
    const { state } = await start(h);
    expect(h.states.get(state)?.redirectUri).toBe(LOOPBACK);
  });
});

describe('the browser comes back to the server', () => {
  const good: GithubExchange = async () => ({ subject: 'github|42', displayName: 'Dev User' });
  const cb = (query: Record<string, string>) => ({ method: 'GET', query });

  it('exchanges the code and sends the browser to the app', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW, SECRET);
    expect(h.sent[0]?.status).toBe(302);
    const location = h.sent[0]?.headers['location'] ?? '';
    expect(location.startsWith(LOOPBACK)).toBe(true);
    expect(new URL(location).searchParams.get('state')).toBe(state);
  });

  // ONLY THE STATE TRAVELS. A URL lands in history, in a referrer, and in
  // whatever the browser syncs.
  it('never puts the session in the redirect', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW, SECRET);
    const location = h.sent[0]?.headers['location'] ?? '';
    const parked = h.states.get(state)?.token ?? '';
    expect(parked).not.toBe('');
    expect(location).not.toContain(parked);
    expect(new URL(location).searchParams.get('token')).toBeNull();
  });

  it('is GET, because a browser follows a redirect', async () => {
    const h = harness();
    await handleCallback({ method: 'POST', query: {} }, h.response as never, h.db, good, NOW, SECRET);
    expect(h.sent[0]?.status).toBe(405);
  });

  // They should land back in the app, not on a page telling them what they know.
  it('sends a decline back to the app too', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleCallback(cb({ state, error: 'access_denied' }), h.response as never, h.db, good, NOW, SECRET);
    expect(h.sent[0]?.status).toBe(302);
    expect(new URL(h.sent[0]?.headers['location'] ?? '').searchParams.get('error')).toBe('declined');
    expect(h.identities).toEqual([]);
  });

  it('refuses a replayed state', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW, SECRET);
    h.sent.length = 0;
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW, SECRET);
    expect(new URL(h.sent[0]?.headers['location'] ?? 'http://x/?error=none').searchParams.get('error')).toBe(
      'state-already-used',
    );
    expect(h.identities).toHaveLength(1);
  });

  it('refuses a state it never issued, with nowhere to send them', async () => {
    const h = harness();
    await handleCallback(cb({ code: 'c', state: 'invented' }), h.response as never, h.db, good, NOW, SECRET);
    expect(h.sent[0]?.status).toBe(400);
    expect(h.sent[0]?.headers['location']).toBeUndefined();
  });

  it('refuses a stale one', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW + STATE_TTL_MS + 1, SECRET);
    expect(h.identities).toEqual([]);
  });

  it('never relays a GitHub message', async () => {
    const h = harness();
    const { state } = await start(h);
    const angry: GithubExchange = async () => {
      throw new Error('github says 500: bad_verification_code at api.github.com');
    };
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, angry, NOW, SECRET);
    expect(JSON.stringify(h.sent[0])).not.toMatch(/bad_verification|api\.github/i);
  });
});

describe('the app claims its session', () => {
  const good: GithubExchange = async () => ({ subject: 'github|42', displayName: 'Dev User' });
  const cb = (query: Record<string, string>) => ({ method: 'GET', query });

  async function throughCallback(h: ReturnType<typeof harness>) {
    const { state } = await start(h);
    await handleCallback(cb({ code: 'c', state }), h.response as never, h.db, good, NOW, SECRET);
    h.sent.length = 0;
    return state;
  }

  it('hands over a verifiable session', async () => {
    const h = harness();
    const state = await throughCallback(h);
    await handleClaim(post({ state }), h.response as never, h.db, NOW);
    expect(h.sent[0]?.status).toBe(200);
    const body = h.sent[0]?.body as { token: string; subject: string };
    expect(verifySession(body.token, SECRET, NOW)).toMatchObject({ ok: true, subject: 'github|42' });
  });

  // ONE COLLECTION PER AUTHORIZATION.
  it('refuses a second claim', async () => {
    const h = harness();
    const state = await throughCallback(h);
    await handleClaim(post({ state }), h.response as never, h.db, NOW);
    h.sent.length = 0;
    await handleClaim(post({ state }), h.response as never, h.db, NOW);
    expect(h.sent[0]?.status).toBe(400);
  });

  it('refuses a claim before the browser has come back', async () => {
    const h = harness();
    const { state } = await start(h);
    await handleClaim(post({ state }), h.response as never, h.db, NOW);
    expect(h.sent[0]?.status).toBe(400);
  });

  it('refuses a state it never issued', async () => {
    const h = harness();
    await handleClaim(post({ state: 'invented' }), h.response as never, h.db, NOW);
    expect(h.sent[0]?.status).toBe(400);
  });

  it('is POST only', async () => {
    const h = harness();
    await handleClaim({ method: 'GET' }, h.response as never, h.db, NOW);
    expect(h.sent[0]?.status).toBe(405);
  });
});
