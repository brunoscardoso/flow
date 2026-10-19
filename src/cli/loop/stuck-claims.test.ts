/**
 * Stuck-claim detection — the item a run took and then died still holding.
 *
 * The tests that matter here are the ones about NOT reporting: this module's
 * whole risk is a false positive, because a report that names healthy runs as
 * dead is one people stop reading, and the single real stuck claim goes with it.
 *
 * The session-list fixtures are the SHAPE OBSERVED LIVE against Claude Code
 * 2.1.241 during planning — two entry kinds in one array, the user's own
 * interactive chat among them.
 */

const {
  BACKGROUND_KIND,
  RUN_SESSION_SEPARATOR,
  claimBindings,
  liveRuns,
  ownerSessionId,
  parseLiveRuns,
  runOwner,
  stuckClaims,
  stuckClaimsPhrase,
  unknownRuns,
} = await import('./stuck-claims.js');

/** The session a run in these tests lives in — a real UUID shape. */
const ALIVE = '8b1e6bfd-2e30-432d-993a-125dca91778f';
/** The session of a run that has died. */
const DEAD = '2c9f0a41-77aa-4d31-9f2e-31b8c1ad5e02';
/** The user's own chat, which is in the list and is not a loop run. */
const CHAT = '7f87aba8-09a2-4c50-9bf6-2ae2e2a63ab0';

/** The list `claude agents --cwd <root> --json` really returns. */
const SNAPSHOT: unknown[] = [
  {
    id: '8b1e6bfd',
    cwd: '/repo',
    kind: 'background',
    startedAt: 1783733695215,
    sessionId: ALIVE,
    name: 'loop fix',
    state: 'blocked',
  },
  {
    pid: 95820,
    cwd: '/repo',
    kind: 'interactive',
    startedAt: 1787580043902,
    sessionId: CHAT,
    name: 'plan-flow-56',
    status: 'busy',
  },
];

/** One held item, as the queue records it. */
function held(id: string, owner: string): { id: string; claimedBy: string; claimedAt: string } {
  return { id, claimedBy: owner, claimedAt: '2026-08-24T09:00:00.000Z' };
}

describe('the owner carries the session — one identity, not two', () => {
  it('round-trips a session through the owner the claim already stores', () => {
    const owner = runOwner('run-20260824T090000000Z-4242', ALIVE);
    expect(owner).toContain(RUN_SESSION_SEPARATOR);
    expect(ownerSessionId(owner)).toBe(ALIVE);
  });

  it('leaves an owner untouched when no session is known', () => {
    expect(runOwner('run-1')).toBe('run-1');
    expect(runOwner('run-1', '   ')).toBe('run-1');
    expect(ownerSessionId('run-1')).toBeNull();
  });

  it('names no session for a claim held on ANOTHER machine', () => {
    // `@<login>` is what a claim looks like when it was derived from the
    // assignee — five engineers share this queue, and their runs were never in
    // this machine's session list to begin with.
    expect(ownerSessionId('@someone-else')).toBeNull();
    expect(ownerSessionId(undefined)).toBeNull();
  });
});

describe('reading the session list', () => {
  it('takes the background agents and leaves the user\'s own chat out of it', () => {
    const runs = liveRuns(SNAPSHOT);
    expect(runs.known).toBe(true);
    if (!runs.known) throw new Error('unreachable');
    expect([...runs.sessionIds]).toEqual([ALIVE]);
    expect(runs.sessionIds.has(CHAT)).toBe(false);
  });

  it('an empty list is KNOWN — nothing is running, and that is an answer', () => {
    const runs = liveRuns([]);
    expect(runs.known).toBe(true);
    if (!runs.known) throw new Error('unreachable');
    expect(runs.sessionIds.size).toBe(0);
  });

  it('anything that is not the observed shape is unknown, never empty', () => {
    for (const bad of [null, 'nope', 42, {}, [null], ['string'], [{ sessionId: ALIVE }]]) {
      const runs = liveRuns(bad);
      expect(runs.known).toBe(false);
      if (runs.known) throw new Error('unreachable');
      expect(runs.reason.length).toBeGreaterThan(0);
    }
  });

  it('a background agent that will not say which session it is makes the whole list unknown', () => {
    // That unidentifiable entry may be the very run holding the claim, so
    // narrowing the live set around it is exactly how a healthy claim is
    // reported dead.
    const runs = liveRuns([{ kind: BACKGROUND_KIND, id: 'abc', state: 'running' }]);
    expect(runs.known).toBe(false);
  });

  it('parses raw JSON, and treats absence and garbage as unknown', () => {
    expect(parseLiveRuns(JSON.stringify(SNAPSHOT)).known).toBe(true);
    expect(parseLiveRuns(undefined).known).toBe(false);
    expect(parseLiveRuns('   ').known).toBe(false);
    expect(parseLiveRuns('{not json').known).toBe(false);
  });
});

describe('binding a loop\'s open items to the runs holding them', () => {
  it('keeps only the items somebody holds, and remembers the loop', () => {
    const bindings = claimBindings('fix', [
      held('12', runOwner('run-a', ALIVE)),
      { id: '13' },
      { id: '14', claimedBy: '  ' },
    ]);
    expect(bindings).toEqual([
      {
        id: '12',
        loop: 'fix',
        owner: runOwner('run-a', ALIVE),
        claimedAt: '2026-08-24T09:00:00.000Z',
      },
    ]);
  });
});

describe('which claims are stuck', () => {
  const runs = liveRuns(SNAPSHOT);

  it('names the claim whose run is gone', () => {
    const claims = claimBindings('fix', [held('12', runOwner('run-b', DEAD))]);
    expect(stuckClaims(claims, runs)).toEqual([
      {
        id: '12',
        loop: 'fix',
        owner: runOwner('run-b', DEAD),
        sessionId: DEAD,
        claimedAt: '2026-08-24T09:00:00.000Z',
      },
    ]);
  });

  it('leaves a claim whose run is alive alone', () => {
    const claims = claimBindings('fix', [held('12', runOwner('run-a', ALIVE))]);
    expect(stuckClaims(claims, runs)).toEqual([]);
  });

  it('does NOT count the user\'s interactive chat as a live run', () => {
    // The failure this pins is subtle and goes both ways. An unfiltered reader
    // would have found CHAT in the list and called this claim healthy — so a
    // genuinely dead run stays invisible for as long as the user keeps a chat
    // open, and reappears the moment they close it.
    const claims = claimBindings('fix', [held('12', runOwner('run-c', CHAT))]);
    expect(stuckClaims(claims, runs).map((claim) => claim.id)).toEqual(['12']);
  });

  it('reports NOTHING when the session list is unknown — never everything', () => {
    // The whole safety property: "we could not tell" collapsed into "no runs
    // are alive" would name every live claim in the project as dead.
    const claims = claimBindings('fix', [
      held('12', runOwner('run-a', ALIVE)),
      held('13', runOwner('run-b', DEAD)),
    ]);
    expect(stuckClaims(claims, unknownRuns('the agent list could not be read'))).toEqual([]);
    expect(stuckClaims(claims, parseLiveRuns(undefined))).toEqual([]);
    expect(stuckClaims(claims, liveRuns('nonsense'))).toEqual([]);
  });

  it('never reports a claim that names no session', () => {
    // A claim taken before sessions existed, one an operator owned by hand, and
    // another engineer's claim read off the assignee. None of them could ever
    // have appeared in THIS machine's list, so none may be called dead by it.
    const claims = claimBindings('fix', [
      held('12', 'run-legacy'),
      held('13', '@another-engineer'),
    ]);
    expect(stuckClaims(claims, runs)).toEqual([]);
  });

  it('an empty live list does report the dead claim — known-empty is not unknown', () => {
    const claims = claimBindings('fix', [held('12', runOwner('run-b', DEAD))]);
    expect(stuckClaims(claims, liveRuns([])).map((claim) => claim.id)).toEqual(['12']);
  });

  it('carries the loop through, because the reader has more than one', () => {
    const stuck = [
      ...stuckClaims(claimBindings('fix', [held('12', runOwner('run-b', DEAD))]), runs),
      ...stuckClaims(claimBindings('find', [held('99', runOwner('run-d', DEAD))]), runs),
    ];
    expect(stuck.map((claim) => `${claim.loop}/${claim.id}`)).toEqual(['fix/12', 'find/99']);
  });
});

describe('the line a person reads', () => {
  it('names the item and the run, because a count cannot be chased', () => {
    const stuck = stuckClaims(
      claimBindings('fix', [held('12', runOwner('run-b', DEAD))]),
      liveRuns(SNAPSHOT),
    );
    const phrase = stuckClaimsPhrase(stuck);
    expect(phrase).toBe(`1 stuck claim (12 — run ${DEAD} is gone)`);
  });

  it('says nothing when nothing is stuck', () => {
    expect(stuckClaimsPhrase([])).toBe('');
  });

  it('pluralizes honestly', () => {
    const stuck = stuckClaims(
      claimBindings('fix', [held('12', runOwner('run-b', DEAD)), held('13', runOwner('run-c', DEAD))]),
      liveRuns(SNAPSHOT),
    );
    expect(stuckClaimsPhrase(stuck)).toContain('2 stuck claims');
  });
});
