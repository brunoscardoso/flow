import {
  isAuthorized,
  isOverLimit,
  judgeBody,
  LIMITS,
  RATE,
  shouldCount,
  windowStart,
} from './ingest-core.js';

const body = (events: unknown) => ({ events });
const sized = (value: unknown) => JSON.stringify(value).length;

describe('the door', () => {
  it('opens for the key, and nothing else', () => {
    expect(isAuthorized('Bearer flw_k', 'flw_k')).toBe(true);
    expect(isAuthorized('Bearer wrong', 'flw_k')).toBe(false);
    expect(isAuthorized('flw_k', 'flw_k')).toBe(false);
    expect(isAuthorized(undefined, 'flw_k')).toBe(false);
    expect(isAuthorized('Basic flw_k', 'flw_k')).toBe(false);
  });

  // An unconfigured deployment must not be an open one. This is the state a
  // server is in for the minutes between existing and being configured.
  it('authorizes nobody when the server has no key', () => {
    expect(isAuthorized('Bearer anything', '')).toBe(false);
    expect(isAuthorized('Bearer ', '')).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    expect(() => isAuthorized('Bearer a', 'a-much-longer-key')).not.toThrow();
    expect(isAuthorized('Bearer a', 'a-much-longer-key')).toBe(false);
  });
});

describe('judging a body', () => {
  it('accepts a plausible batch', () => {
    const result = judgeBody(body([{ event: 'session.started', at: 1, installId: 'abc' }]), 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(1);
      expect(result.value.installId).toBe('abc');
    }
  });

  it.each([
    ['not an object', 'a string'],
    ['an array', [1, 2]],
    ['null', null],
    ['no events key', { other: 1 }],
    ['events not an array', { events: 'nope' }],
    ['an empty batch', { events: [] }],
  ])('refuses %s', (_label, raw) => {
    expect(judgeBody(raw, 100).ok).toBe(false);
  });

  it('refuses a body larger than the cap, before parsing costs anything', () => {
    const result = judgeBody(body([{ at: 1 }]), LIMITS.maxBodyBytes + 1);
    expect(result).toEqual({ ok: false, error: { status: 413, reason: 'body too large' } });
  });

  // The client batches at 50. The server does not take the client's word for it.
  it('refuses more events than it will take in one request', () => {
    const many = Array.from({ length: LIMITS.maxEventsPerRequest + 1 }, () => ({ at: 1 }));
    expect(judgeBody(body(many), 1000).ok).toBe(false);
  });

  it('refuses an event that is not an object', () => {
    expect(judgeBody(body(['a string']), 100).ok).toBe(false);
    expect(judgeBody(body([null]), 100).ok).toBe(false);
  });

  it('refuses an over-long value', () => {
    const long = { at: 1, locale: 'x'.repeat(LIMITS.maxValueLength + 1) };
    expect(judgeBody(body([long]), 1000).ok).toBe(false);
  });

  // The cheapest way to smuggle bulk past a field COUNT is to nest it.
  it('refuses a nested value', () => {
    expect(judgeBody(body([{ at: 1, extra: { a: 1 } }]), 100).ok).toBe(false);
    expect(judgeBody(body([{ at: 1, extra: [1, 2] }]), 100).ok).toBe(false);
  });

  it('refuses an event with too many fields', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < LIMITS.maxFieldsPerEvent + 1; i += 1) wide[`f${i}`] = i;
    expect(judgeBody(body([wide]), 2000).ok).toBe(false);
  });

  // UNKNOWN FIELDS ARE KEPT, deliberately. A shipped binary keeps posting the
  // shape it was built with for months, and no migration reaches a copy
  // somebody installed in March — so the server stores the document rather than
  // rejecting tomorrow's client.
  it('keeps a field it has never seen', () => {
    const result = judgeBody(body([{ event: 'session.started', at: 1, somethingNew: 7 }]), 100);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events[0]).toHaveProperty('somethingNew', 7);
  });
});

describe('attributing a batch', () => {
  it('reads the installation when the batch agrees with itself', () => {
    const result = judgeBody(body([{ installId: 'a', at: 1 }, { installId: 'a', at: 2 }]), 100);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.value.installId).toBe('a');
  });

  // Either a bug or somebody spreading traffic across ids to evade a limit.
  it('refuses to attribute a batch carrying two installations', () => {
    const result = judgeBody(body([{ installId: 'a', at: 1 }, { installId: 'b', at: 2 }]), 100);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.value.installId).toBeNull();
    expect(shouldCount(result.value.installId)).toBe(false);
  });

  it('treats a batch with no installation as unattributable', () => {
    const result = judgeBody(body([{ at: 1 }]), 100);
    if (!result.ok) throw new Error('expected acceptance');
    expect(shouldCount(result.value.installId)).toBe(false);
  });
});

describe('the rate limit', () => {
  it('allows a normal day and refuses a flood', () => {
    expect(isOverLimit(0, 1)).toBe(false);
    expect(isOverLimit(RATE.maxEventsPerWindow - 1, 1)).toBe(false);
    expect(isOverLimit(RATE.maxEventsPerWindow, 1)).toBe(true);
  });

  it('counts the incoming batch, not just what is already stored', () => {
    // Otherwise one request of a million events passes a limit of five hundred.
    expect(isOverLimit(0, RATE.maxEventsPerWindow + 1)).toBe(true);
  });

  it('buckets by a fixed window', () => {
    const start = windowStart(1_000_000_000_000);
    expect(start % RATE.windowMs).toBe(0);
    expect(windowStart(start)).toBe(start);
    expect(windowStart(start + RATE.windowMs - 1)).toBe(start);
    expect(windowStart(start + RATE.windowMs)).toBe(start + RATE.windowMs);
  });

  it('is generous enough for a real client', () => {
    // A busy day is a few dozen events; the limit should not be reachable by
    // ordinary use, or it is a bug report rather than a defence.
    expect(RATE.maxEventsPerWindow).toBeGreaterThanOrEqual(100);
  });
});

describe('the bounds are actually bounded', () => {
  it('caps every dimension a caller controls', () => {
    for (const value of Object.values(LIMITS)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('cannot be satisfied by a body that is within bytes but absurd in count', () => {
    // 100 tiny events is ~2 KB — well under the body cap — so the count cap is
    // the one doing the work here, and it must exist independently.
    const many = Array.from({ length: LIMITS.maxEventsPerRequest + 1 }, () => ({ a: 1 }));
    expect(sized(body(many))).toBeLessThan(LIMITS.maxBodyBytes);
    expect(judgeBody(body(many), sized(body(many))).ok).toBe(false);
  });
});
