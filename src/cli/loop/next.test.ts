/**
 * Tests for the pure gate — `evaluateNext`, `localRefusal`, `pauseReport`.
 *
 * PURE, SO EVERY ASSERTION IS A CONSTANT. The gate is a function of (directive,
 * state, queue snapshot, pull note, owner, focus, clock); nothing here touches
 * the filesystem, git, the network or a model, and no test sleeps.
 *
 * WHAT PHASE 6 TOOK OUT, AND WHY THIS FILE IS SHORTER FOR IT. The gate used to
 * also count the circuit breaker's failures, size a run budget from the lock's
 * stamp, and hold the pipeline's single lock. All three are gone: a run is a
 * Claude Code background agent now, so `claude agents` says what is running,
 * `stuck-claims.ts` says whose claim belongs to a run that died, and the agent's
 * own session ends the run. The tests that covered them were deleted rather than
 * skipped — a skipped test is a claim nobody is checking.
 *
 * What is left is the contract that survived: the ORDER of the checks (directive
 * pause → state pause → full slot table → queue shape → proceed), the rule that
 * a gated verdict takes no slot and writes no state, and the slot allocator's
 * re-entrancy. `max_run_minutes` still exists, but it now sizes exactly one
 * thing — the slot's TTL — and enforces nothing.
 */

import type { LoopDirective, LoopState } from './types.js';

const { evaluateNext, localRefusal, lockTtlMs, pauseReport, skippedPull, LOCK_TTL_MARGIN_MINUTES } =
  await import('./next.js');
const { acquireLoopLock, emptyLoopState, withGlobalPause, withLoopPause } =
  await import('./loop-state.js');
const { LOOP_STOP_CONDITIONS } = await import('./types.js');

type NextInput = Parameters<typeof evaluateNext>[0];

/** A fixed clock — every timestamp in these tests derives from it. */
const T0 = Date.parse('2026-08-12T09:00:00.000Z');
const MINUTE = 60_000;

/** A producer directive with a 25-minute run length and a cap of 2. */
function producer(overrides: Partial<LoopDirective> = {}): LoopDirective {
  return {
    loop: 'find',
    engine: 'producer',
    paused: false,
    mission: 'Hunt for real bugs',
    scope: ['src'],
    slice: 'changed',
    queue: 'ledger',
    path: 'flow/loops/queue.jsonl',
    maxOpenIssues: 2,
    maxRunMinutes: 25,
    maxConcurrentRuns: 1,
    needsApproval: false,
    direction: '',
    rules: '',
    ...overrides,
  };
}

/** A consumer directive over the same ledger. */
function consumer(overrides: Partial<LoopDirective> = {}): LoopDirective {
  return producer({ loop: 'fix', engine: 'consumer', mission: 'Drain the queue', ...overrides });
}

/** A queue snapshot, defaulting to one that has room and something to claim. */
function queue(counts: Partial<NextInput['queue']['counts']> = {}): NextInput['queue'] {
  return {
    kind: 'ledger',
    location: 'flow/loops/queue.jsonl',
    counts: {
      open: 1,
      closed: 0,
      claimed: 0,
      awaitingApproval: 0,
      parked: 0,
      claimable: 1,
      ...counts,
    },
    fingerprints: [],
  };
}

/** The gate's input, with a queue that has room and something to claim. */
function input(overrides: Partial<NextInput> = {}): NextInput {
  return {
    directive: producer(),
    state: emptyLoopState(),
    queue: queue(),
    pull: skippedPull('pull skipped (--no-pull)'),
    owner: 'run-1',
    now: T0,
    ...overrides,
  };
}

/** State in which `owner` holds a slot on `loop`, taken at `since`. */
function heldSince(
  loop: string,
  owner: string,
  since: number,
  minutes = 25,
  state: LoopState = emptyLoopState(),
  maxConcurrentRuns = 1,
): LoopState {
  return acquireLoopLock(state, loop, owner, lockTtlMs(minutes), since, undefined, maxConcurrentRuns)
    .state;
}

describe('the gate opens the run and stamps when it started', () => {
  it('takes a slot, stamps the start on it, and reports the stamp back', () => {
    const evaluation = evaluateNext(input());
    const result = evaluation.result;
    expect(result.verdict).toBe('proceed');
    expect(result.owner).toBe('run-1');
    expect(result.lock?.acquiredAt).toBe('2026-08-12T09:00:00.000Z');
    expect(result.runStartedAt).toBe(result.lock?.acquiredAt);
    expect(result.stopCondition).toBe('none');
    // Taking a slot is the one thing that changes state, so it is the one
    // verdict the caller must persist.
    expect(evaluation.stateChanged).toBe(true);
    expect(evaluation.state.loops.find?.locks).toHaveLength(1);
  });

  it('hands a lone run slot 1 — the original checkout and the original branch', () => {
    expect(evaluateNext(input()).result.lock?.slot).toBe(1);
  });

  it('sizes the slot TTL from the run length plus the wrap-up margin', () => {
    // Phase 6 left `max_run_minutes` exactly one job: how long a checkout stays
    // reserved for a run that may have died. It enforces nothing else.
    const result = evaluateNext(input()).result;
    expect(result.maxRunMinutes).toBe(25);
    expect(Date.parse(result.lock!.expiresAt) - T0).toBe((25 + LOCK_TTL_MARGIN_MINUTES) * MINUTE);
    expect(lockTtlMs(25)).toBe((25 + LOCK_TTL_MARGIN_MINUTES) * MINUTE);
  });

  it('echoes back what a person aimed this run at, and empty when nobody did', () => {
    expect(evaluateNext(input({ focus: 'the blueprint board' })).result.focus).toBe(
      'the blueprint board',
    );
    expect(evaluateNext(input()).result.focus).toBe('');
  });

  it('carries the aim onto the slot, so no later verb has to be told it again', () => {
    expect(evaluateNext(input({ focus: 'the blueprint board' })).result.lock?.focus).toBe(
      'the blueprint board',
    );
  });

  it('reports the pull note verbatim, including one that was never attempted', () => {
    const pull = skippedPull('pull skipped (--no-pull)');
    expect(pull).toEqual({ attempted: false, ok: false, note: 'pull skipped (--no-pull)' });
    expect(evaluateNext(input({ pull })).result.pull).toEqual(pull);
    // A pull that failed does not gate anything — it is recorded and the run
    // goes ahead, because a network hiccup must not silence a loop.
    const failed = { attempted: true, ok: false, note: 'could not reach origin' };
    const result = evaluateNext(input({ pull: failed })).result;
    expect(result.verdict).toBe('proceed');
    expect(result.pull).toEqual(failed);
  });

  it('hands over the loop’s known fingerprints, sorted', () => {
    const result = evaluateNext(
      input({ queue: { ...queue(), fingerprints: ['zeta', 'alpha', 'mu'] } }),
    ).result;
    expect(result.fingerprints).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('a run re-entering the gate keeps the slot it already holds', () => {
  it('says so in the reason, and does not restart its own clock', () => {
    const state = heldSince('find', 'run-1', T0);
    const result = evaluateNext(input({ state, now: T0 + 10 * MINUTE })).result;

    expect(result.verdict).toBe('proceed');
    expect(result.reason).toContain("re-entered by 'run-1'");
    // The stamp did NOT move: re-entering extends the TTL, it does not restart
    // the run. Nothing enforces a budget against it any more (Phase 6), but the
    // stamp is still what every surface reporting the run reads.
    expect(result.runStartedAt).toBe('2026-08-12T09:00:00.000Z');
    expect(result.lock?.acquiredAt).toBe('2026-08-12T09:00:00.000Z');
    expect(result.stopCondition).toBe('none');
  });

  it('is not locked out by the slot it is itself holding', () => {
    // One slot, and this run holds it. The re-entrancy exception is the whole
    // reason a run may open the gate twice.
    const state = heldSince('find', 'run-1', T0);
    expect(evaluateNext(input({ state, now: T0 + MINUTE })).result.verdict).toBe('proceed');
  });

  it('lands back in the SAME checkout, not the lowest free one', () => {
    // Slot 1 went to another run; this one took slot 2 and must get slot 2 back,
    // because the slot IS the worktree its half-finished work is in.
    const directive = producer({ maxConcurrentRuns: 3 });
    const withOther = heldSince('find', 'other-run', T0, 25, emptyLoopState(), 3);
    const state = heldSince('find', 'run-1', T0, 25, withOther, 3);
    const result = evaluateNext(input({ directive, state, now: T0 + 2 * MINUTE })).result;
    expect(result.verdict).toBe('proceed');
    expect(result.lock?.slot).toBe(2);
  });

  it('takes a free slot beside a run already working, when the loop allows it', () => {
    const directive = producer({ maxConcurrentRuns: 2 });
    const state = heldSince('find', 'other-run', T0, 25, emptyLoopState(), 2);
    const result = evaluateNext(
      input({ directive, state, owner: 'run-2', now: T0 + MINUTE }),
    ).result;
    expect(result.verdict).toBe('proceed');
    expect(result.lock?.slot).toBe(2);
  });
});

/**
 * A GATED VERDICT TAKES NOTHING AND HANDS BACK NOTHING (#1575).
 *
 * The trap was that `owner` was present and plausible on a result meaning "you
 * got nothing": a caller that read it without checking the verdict recorded its
 * whole run under an id holding no slot, and `log --record` — which releases
 * only the slot it owns — then left the REAL slot stranded for its full TTL.
 */
describe('a gated verdict takes no slot and writes no state', () => {
  it('blanks the owner and the start stamp when the directive itself is paused', () => {
    const evaluation = evaluateNext(
      input({ directive: producer({ paused: true }), owner: 'run-2' }),
    );
    expect(evaluation.result.verdict).toBe('paused');
    expect(evaluation.result.reason).toBe("loop 'find' is paused by its directive");
    expect(evaluation.result.owner).toBe('');
    expect(evaluation.result.runStartedAt).toBe('');
    expect(evaluation.result.lock).toBeNull();
    expect(evaluation.stateChanged).toBe(false);
    expect(evaluation.state.loops.find).toBeUndefined();
  });

  it('blanks the owner when every slot is taken', () => {
    const evaluation = evaluateNext(
      input({ state: heldSince('find', 'run-1', T0), owner: 'run-2', now: T0 + MINUTE }),
    );
    expect(evaluation.result.verdict).toBe('locked');
    expect(evaluation.result.reason).toContain("'run-1' holds one until");
    expect(evaluation.result.owner).toBe('');
    expect(evaluation.result.runStartedAt).toBe('');
    expect(evaluation.result.lock).toBeNull();
    expect(evaluation.stateChanged).toBe(false);
  });

  it('blanks the owner on a queue-shaped skip too', () => {
    const evaluation = evaluateNext(
      input({ directive: consumer(), queue: queue({ open: 0, claimable: 0 }) }),
    );
    expect(evaluation.result.verdict).toBe('skip');
    expect(evaluation.result.owner).toBe('');
    expect(evaluation.result.runStartedAt).toBe('');
    expect(evaluation.stateChanged).toBe(false);
  });

  it('keeps the owner on a proceed, which is the verdict that took the slot', () => {
    const result = evaluateNext(input({ owner: 'run-2' })).result;
    expect(result.verdict).toBe('proceed');
    expect(result.owner).toBe('run-2');
  });

  it('still reports the directive’s prose on a gated verdict', () => {
    // A refused run still has to be able to say what loop it was and what that
    // loop is for — a verdict nobody can read is not a verdict.
    const directive = producer({ paused: true, direction: 'stay in src', rules: 'no reformatting' });
    const result = evaluateNext(input({ directive })).result;
    expect(result.loop).toBe('find');
    expect(result.mission).toBe('Hunt for real bugs');
    expect(result.direction).toBe('stay in src');
    expect(result.rules).toBe('no reformatting');
  });
});

describe('the order of the checks is the contract', () => {
  it('the directive’s pause outranks a machine-local one', () => {
    // Steering by commit wins, because it is the signal that survives a state
    // file being lost or reset.
    const state = withLoopPause(emptyLoopState(), 'find', { reason: 'local' }, T0);
    const result = evaluateNext(input({ directive: producer({ paused: true }), state })).result;
    expect(result.reason).toBe("loop 'find' is paused by its directive");
  });

  it('a machine-local pause outranks a full slot table', () => {
    const held = heldSince('find', 'run-1', T0);
    const state = withGlobalPause(held, { reason: 'maintenance window' }, T0);
    const result = evaluateNext(input({ state, owner: 'run-2', now: T0 + MINUTE })).result;
    expect(result.verdict).toBe('paused');
    expect(result.reason).toBe('all loops are paused — maintenance window');
  });

  it('a full slot table outranks the queue’s shape', () => {
    // Nothing to claim AND no free slot: the slot answer comes first, because it
    // is the one a person waiting on this loop is waiting for.
    const result = evaluateNext(
      input({
        directive: consumer(),
        state: heldSince('fix', 'run-1', T0),
        queue: queue({ open: 0, claimable: 0 }),
        owner: 'run-2',
        now: T0 + MINUTE,
      }),
    ).result;
    expect(result.verdict).toBe('locked');
  });

  it('names the scope of the pause it found', () => {
    const perLoop = withLoopPause(emptyLoopState(), 'find', { reason: 'noisy' }, T0);
    expect(evaluateNext(input({ state: perLoop })).result.reason).toBe(
      "loop 'find' is paused — noisy",
    );
  });
});

describe('the stop condition names why a run has nothing left to do', () => {
  it('is `cap` when a producer has nowhere left to file', () => {
    const evaluation = evaluateNext(input({ queue: queue({ open: 2, claimable: 2 }) }));
    expect(evaluation.result.verdict).toBe('skip');
    expect(evaluation.result.stopCondition).toBe('cap');
    // The prose and the condition agree, and neither is derived from the other.
    expect(evaluation.result.reason).toContain('open-item cap reached');
    expect(evaluation.stateChanged).toBe(false);
  });

  it('is `empty` when a consumer has nothing claimable and nothing in flight', () => {
    const result = evaluateNext(
      input({ directive: consumer(), queue: queue({ open: 0, closed: 4, claimable: 0 }) }),
    ).result;
    expect(result.verdict).toBe('skip');
    expect(result.stopCondition).toBe('empty');
    expect(result.reason).toContain('nothing claimable');
  });

  it('is not `empty` while a consumer still has something in flight', () => {
    const result = evaluateNext(
      input({ directive: consumer(), queue: queue({ open: 1, claimed: 1, claimable: 0 }) }),
    ).result;
    expect(result.verdict).toBe('proceed');
    expect(result.stopCondition).toBe('none');
  });

  it('is `none` while there is still work', () => {
    expect(evaluateNext(input({ directive: consumer() })).result.stopCondition).toBe('none');
  });

  it('only ever reports a word from the closed vocabulary', () => {
    for (const result of everyVerdict()) {
      expect(LOOP_STOP_CONDITIONS).toContain(result.stopCondition);
    }
  });

  it('never reports `budget` — Phase 6 deleted the thing that produced it', () => {
    // `budget` is still a legal word in `LoopStopCondition` (a run may still
    // report it on its own record), but the GATE no longer sizes or spends a
    // budget, so no verdict it produces can name one. A run left holding a slot
    // far past its nominal minutes is a re-entering run, not a stopping one.
    for (const result of everyVerdict()) {
      expect(result.stopCondition).not.toBe('budget');
    }
  });

  /** Every branch of the gate, so a vocabulary claim covers all of them. */
  function everyVerdict() {
    return [
      evaluateNext(input()).result,
      evaluateNext(input({ directive: consumer() })).result,
      evaluateNext(input({ directive: producer({ paused: true }) })).result,
      evaluateNext(input({ queue: queue({ open: 2, claimable: 2 }) })).result,
      evaluateNext(input({ directive: consumer(), queue: queue({ open: 0, claimable: 0 }) })).result,
      evaluateNext(input({ state: heldSince('find', 'run-1', T0), owner: 'run-2', now: T0 + MINUTE }))
        .result,
      // long past its nominal 25 minutes, and still just a re-entering run
      evaluateNext(input({ state: heldSince('find', 'run-1', T0), now: T0 + 40 * MINUTE })).result,
    ];
  }
});

describe('the cap is a producer’s fact (#1585)', () => {
  /**
   * `counts.open` means two different things by engine — `scopeQuery` drops the
   * loop filter for a consumer, because a consumer's queue IS the queue — so the
   * cap comparison only asks a meaningful question for a producer. Reported
   * unfiltered, `fix` read `28/20 · capReached: true` while having filed
   * nothing and being unable to be blocked by it.
   */
  const overCap = queue({ open: 28, claimable: 28 });

  it('a producer over its cap still reports capReached', () => {
    const result = evaluateNext(input({ directive: producer(), queue: overCap })).result;
    expect(result.queue.capReached).toBe(true);
  });

  it('a consumer never reports capReached, however deep the in-tray is', () => {
    const result = evaluateNext(input({ directive: consumer(), queue: overCap })).result;
    expect(result.queue.open).toBe(28); // the count itself keeps its meaning
    expect(result.queue.capReached).toBe(false);
  });

  it('the reported cap agrees with the gate, which never stopped a consumer on it', () => {
    const consumerVerdict = evaluateNext(input({ directive: consumer(), queue: overCap })).result;
    expect(consumerVerdict.stopCondition).not.toBe('cap');
    const producerVerdict = evaluateNext(input({ directive: producer(), queue: overCap })).result;
    expect(producerVerdict.stopCondition).toBe('cap');
  });
});

describe('the gate stays pure', () => {
  it('is deterministic — identical inputs, byte-identical result', () => {
    const shared = input({ state: heldSince('find', 'run-1', T0), now: T0 + 3 * MINUTE });
    expect(JSON.stringify(evaluateNext(shared).result)).toBe(
      JSON.stringify(evaluateNext(shared).result),
    );
  });

  it('is deterministic for a gated verdict too', () => {
    const shared = input({ directive: producer({ paused: true }) });
    expect(JSON.stringify(evaluateNext(shared).result)).toBe(
      JSON.stringify(evaluateNext(shared).result),
    );
  });

  it('never mutates the state it was handed', () => {
    const state = emptyLoopState();
    const before = JSON.stringify(state);
    evaluateNext(input({ state }));
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('a refusal decidable from local state costs no round trip (#1626)', () => {
  /**
   * `localRefusal` exists to answer ONE question before the run pays for its
   * `git pull`: is this gate certain to refuse? The daemon puts every scheduled
   * loop through the gate, so a paused or locked one used to buy a ~3.7s network
   * round trip per run to be told something the checkout was never asked about.
   *
   * The direction that matters is the unsafe one: a refusal claimed here for a
   * gate that then PROCEEDS would put a run to work on a checkout nobody brought
   * current. Every case below therefore checks the answer against what
   * `evaluateNext` actually decides on the same state.
   *
   * Phase 6 note: this used to mirror three refusals. The breaker was the third,
   * and it is gone — the two that remain are the pauses and the slot table.
   */

  it('a directive pause refuses without the checkout', () => {
    const refusal = localRefusal(producer({ paused: true }), emptyLoopState(), 'run-1', T0);
    expect(refusal?.verdict).toBe('paused');
    expect(refusal?.reason).toBe("loop 'find' is paused by its directive");
  });

  it('a machine-local pause refuses without the checkout', () => {
    // Safe to ask before the pull: loop state lives under `flow/`, which is
    // gitignored, so no pull can change the answer this reads.
    const state = withLoopPause(emptyLoopState(), 'find', { reason: 'noisy' }, T0);
    const refusal = localRefusal(producer(), state, 'run-1', T0);
    expect(refusal?.verdict).toBe('paused');
    expect(refusal?.reason).toBe("loop 'find' is paused — noisy");
  });

  it('a global pause refuses without the checkout', () => {
    const state = withGlobalPause(emptyLoopState(), { reason: 'maintenance window' }, T0);
    expect(localRefusal(producer(), state, 'run-1', T0)?.reason).toBe(
      'all loops are paused — maintenance window',
    );
  });

  it('an expired pause is not a refusal', () => {
    const state = withLoopPause(
      emptyLoopState(),
      'find',
      { reason: 'ten minutes only', until: T0 + 10 * MINUTE },
      T0,
    );
    expect(localRefusal(producer(), state, 'run-1', T0 + 11 * MINUTE)).toBeNull();
  });

  it('a full slot table refuses without the checkout', () => {
    const state = heldSince('find', 'run-incumbent', T0 - MINUTE);
    expect(localRefusal(producer(), state, 'run-2', T0)?.verdict).toBe('locked');
  });

  it('the run already holding a slot is re-entrant, so it still pulls', () => {
    const state = heldSince('find', 'run-1', T0 - MINUTE);
    expect(localRefusal(producer(), state, 'run-1', T0)).toBeNull();
  });

  it('a loop with a slot still free is not refused — it pays for its pull', () => {
    const state = heldSince('find', 'run-1', T0 - MINUTE, 25, emptyLoopState(), 2);
    expect(localRefusal(producer({ maxConcurrentRuns: 2 }), state, 'run-2', T0)).toBeNull();
  });

  it('a free loop is not refused here — it pays for its pull, as before', () => {
    expect(localRefusal(producer(), emptyLoopState(), 'run-1', T0)).toBeNull();
  });

  it('an expired slot is not a refusal — the checkout is free again', () => {
    const state = heldSince('find', 'run-incumbent', T0 - 60 * MINUTE);
    expect(localRefusal(producer(), state, 'run-2', T0)).toBeNull();
  });

  it('a queue-shaped skip is NOT claimed here — it needs a backend read', () => {
    const directive = consumer();
    const state = emptyLoopState();
    // The gate skips it, but only after asking the queue — so the pull stands.
    expect(
      evaluateNext(input({ directive, state, queue: queue({ open: 0, claimable: 0 }) })).result
        .verdict,
    ).toBe('skip');
    expect(localRefusal(directive, state, 'run-1', T0)).toBeNull();
  });

  it('never claims a refusal the gate does not reach', () => {
    const cases: { directive: LoopDirective; state: LoopState; owner: string }[] = [
      { directive: producer({ paused: true }), state: emptyLoopState(), owner: 'run-1' },
      {
        directive: producer(),
        state: withLoopPause(emptyLoopState(), 'find', { reason: 'noisy' }, T0),
        owner: 'run-1',
      },
      {
        directive: producer(),
        state: withGlobalPause(emptyLoopState(), { reason: 'everything' }, T0),
        owner: 'run-1',
      },
      { directive: producer(), state: heldSince('find', 'other', T0 - MINUTE), owner: 'run-2' },
      { directive: producer(), state: heldSince('find', 'run-1', T0 - MINUTE), owner: 'run-1' },
      { directive: producer(), state: emptyLoopState(), owner: 'run-1' },
      {
        directive: consumer(),
        state: withLoopPause(emptyLoopState(), 'fix', { reason: 'noisy' }, T0),
        owner: 'run-1',
      },
    ];
    for (const { directive, state, owner } of cases) {
      const refusal = localRefusal(directive, state, owner, T0);
      const { verdict } = evaluateNext(input({ directive, state, owner })).result;
      if (refusal !== null) {
        // The unsafe direction: a skipped pull must never precede a proceed.
        expect(verdict).not.toBe('proceed');
        expect(verdict).toBe(refusal.verdict);
      }
    }
  });
});

describe('the pause report says the same thing to every surface', () => {
  it('is null when nothing is paused', () => {
    expect(pauseReport(emptyLoopState(), 'find', T0)).toBeNull();
  });

  it('reports a per-loop pause with its scope, reason and start', () => {
    const state = withLoopPause(emptyLoopState(), 'find', { reason: 'noisy' }, T0);
    expect(pauseReport(state, 'find', T0)).toEqual({
      scope: 'loop',
      reason: 'noisy',
      since: '2026-08-12T09:00:00.000Z',
    });
  });

  it('reports a global pause as global, for every loop', () => {
    const state = withGlobalPause(emptyLoopState(), { reason: 'maintenance window' }, T0);
    expect(pauseReport(state, 'find', T0)?.scope).toBe('global');
    expect(pauseReport(state, 'fix', T0)?.scope).toBe('global');
  });

  it('carries `until` when the pause self-expires, and stops reporting once it has', () => {
    const state = withLoopPause(
      emptyLoopState(),
      'find',
      { reason: 'ten minutes only', until: T0 + 10 * MINUTE },
      T0,
    );
    expect(pauseReport(state, 'find', T0)?.until).toBe('2026-08-12T09:10:00.000Z');
    expect(pauseReport(state, 'find', T0 + 11 * MINUTE)).toBeNull();
  });

  it('omits `until` entirely for a pause that holds until someone resumes it', () => {
    const state = withLoopPause(emptyLoopState(), 'find', { reason: 'noisy' }, T0);
    expect(Object.keys(pauseReport(state, 'find', T0) ?? {})).not.toContain('until');
  });
});
