import { handle, type Db } from '../api/events.js';

const KEY = 'flw_ingest_secret';

function harness(overrides: Partial<Db> = {}) {
  const recorded: { installId: string | null; events: unknown[] }[] = [];
  const db: Db = {
    countInWindow: async () => 0,
    record: async (installId: string | null, _window: number, events: unknown[]) => {
      recorded.push({ installId, events });
    },
    ...overrides,
  };
  const sent: { status: number; body: unknown }[] = [];
  const response = {
    status(code: number) {
      sent.push({ status: code, body: undefined });
      return this;
    },
    json(body: unknown) {
      const last = sent[sent.length - 1];
      if (last) last.body = body;
    },
    setHeader() {},
  };
  return { db, response, sent, recorded };
}

const ok = (events: unknown[]) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}` },
  body: { events },
});

describe('the endpoint', () => {
  it('accepts a good batch and stores it', async () => {
    const h = harness();
    await handle(ok([{ event: 'session.started', at: 1, installId: 'abc' }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.status).toBe(202);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.installId).toBe('abc');
  });

  it('returns an EMPTY body — it never echoes what it was given', async () => {
    const h = harness();
    await handle(ok([{ at: 1, installId: 'abc', model: 'opus' }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.body).toEqual({});
    expect(JSON.stringify(h.sent[0]?.body)).not.toContain('opus');
  });

  it('is POST only — there is no read path at all', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', undefined]) {
      const h = harness();
      await handle(
        { method, headers: { authorization: `Bearer ${KEY}` } },
        h.response,
        h.db,
        0,
        KEY,
      );
      expect(h.sent[0]?.status).toBe(405);
      expect(h.recorded).toEqual([]);
    }
  });

  it('refuses without the key, and stores nothing', async () => {
    for (const authorization of [undefined, 'Bearer wrong', 'Basic ' + KEY]) {
      const h = harness();
      await handle({ method: 'POST', headers: { authorization }, body: { events: [{ at: 1 }] } }, h.response, h.db, 0, KEY);
      expect(h.sent[0]?.status).toBe(401);
      expect(h.recorded).toEqual([]);
    }
  });

  // A 401 that distinguishes "no key" from "wrong key" is a guessing oracle.
  it('says nothing about WHY it refused', async () => {
    const a = harness();
    await handle({ method: 'POST', headers: {}, body: {} }, a.response, a.db, 0, KEY);
    const b = harness();
    await handle({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: {} }, b.response, b.db, 0, KEY);
    expect(a.sent[0]?.body).toEqual(b.sent[0]?.body);
  });

  it('refuses a malformed body with the reason the core gave', async () => {
    const h = harness();
    await handle(
      { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: { events: [] } },
      h.response,
      h.db,
      0,
      KEY,
    );
    expect(h.sent[0]?.status).toBe(400);
    expect(h.recorded).toEqual([]);
  });

  it('refuses a flood, and stores none of it', async () => {
    const h = harness({ countInWindow: async () => 10_000 });
    await handle(ok([{ at: 1, installId: 'abc' }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.status).toBe(429);
    expect(h.recorded).toEqual([]);
  });

  // An unattributable batch is bounded by the request limits and nothing else —
  // a stated acceptance. It must not be counted against one bucket.
  it('stores an unattributable batch without consulting the counter', async () => {
    let counted = 0;
    const h = harness({
      countInWindow: async () => {
        counted += 1;
        return 0;
      },
    });
    await handle(ok([{ at: 1 }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.status).toBe(202);
    expect(counted).toBe(0);
  });

  it('reports a database that is down as unavailable, not as a bug', async () => {
    const h = harness({
      record: async () => {
        throw new Error('connection refused');
      },
    });
    await handle(ok([{ at: 1, installId: 'abc' }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.status).toBe(503);
  });

  it('never leaks a database error into the response', async () => {
    const h = harness({
      record: async () => {
        throw new Error('FATAL: password authentication failed for user "neondb_owner"');
      },
    });
    await handle(ok([{ at: 1, installId: 'abc' }]), h.response, h.db, 0, KEY);
    expect(JSON.stringify(h.sent[0]?.body)).not.toContain('neondb_owner');
    expect(JSON.stringify(h.sent[0]?.body)).not.toContain('password');
  });

  it('survives a body that cannot be serialized', async () => {
    const cyclic: Record<string, unknown> = { events: [{ at: 1 }] };
    cyclic['self'] = cyclic;
    const h = harness();
    await handle(
      { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: cyclic },
      h.response,
      h.db,
      0,
      KEY,
    );
    expect(h.sent[0]?.status).toBe(413);
    expect(h.recorded).toEqual([]);
  });
});

/**
 * THE INGEST ENDPOINT STILL HAS NO READ PATH.
 *
 * Sign-in adds routes that necessarily read — `/api/auth/*` looks up states and
 * identities. The property worth protecting is that `/api/events` does not, and
 * a property nobody asserts is one that erodes the next time somebody adds "just
 * a small GET to check it's working".
 */
describe('sign-in did not give ingest a read path', () => {
  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'refuses %s outright',
    async (method) => {
      const h = harness();
      await handle(
        { method, headers: { authorization: `Bearer ${KEY}` } },
        h.response,
        h.db,
        0,
        KEY,
      );
      expect(h.sent[0]?.status).toBe(405);
    },
  );

  it('answers an accepted POST with an empty body, whatever was sent', async () => {
    const h = harness();
    await handle(ok([{ event: 'session.started', at: 1, installId: 'abc', model: 'opus' }]), h.response, h.db, 0, KEY);
    expect(h.sent[0]?.body).toEqual({});
  });

  it('has no database read in its dependency surface beyond the rate counter', () => {
    // `countInWindow` is the ONE read, and it returns a number about the caller's
    // own quota — not a row, not an event, nothing another install wrote.
    const h = harness();
    expect(Object.keys(h.db).sort()).toEqual(['countInWindow', 'record']);
  });
});
