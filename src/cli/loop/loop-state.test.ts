/**
 * Tests for the loop state store.
 *
 * Real fs via mkdtemp, like the sibling store tests; the transforms are pure and
 * take an injected `now`, so TTL and `until` expiry are proven by arithmetic
 * rather than by sleeping.
 *
 * Covers: deterministic serialization, strict parsing (corrupt / wrong version /
 * malformed record all refuse), atomic writes that never leave a partial or a
 * stray temp file, pause semantics (global + per-loop, self-expiring), the run
 * slot allocator (acquire / release / expire / re-entry), the last-run outcome,
 * and the awaiting-approval escalation policy.
 *
 * WHAT PHASE 6 TOOK OUT, AND SO OUT OF HERE TOO: the consecutive-failure
 * breaker, the state half of the gate (`evaluateLoopGate` — the pause check now
 * lives in `localRefusal` in `next.ts`), and the single pipeline lock. Their
 * tests are deleted rather than skipped: a suite that still describes machinery
 * the module no longer has is a suite that lies about the contract.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  AWAITING_APPROVAL,
  LOOP_STATE_FILENAME,
  acquireLoopLock,
  applyEscalation,
  effectivePause,
  emptyLoopState,
  escalationPromptTail,
  escalationReason,
  expireLoopState,
  freeSlot,
  isLockExpired,
  isPauseExpired,
  liveLocks,
  lockHeldBy,
  loopRecord,
  loopStatePath,
  mutateLoopState,
  oldestLock,
  parseLoopState,
  readLoopState,
  releaseLoopLock,
  serializeLoopState,
  toIso,
  withGlobalPause,
  withLoopPause,
  withLoopStateLock,
  withRunOutcome,
  withoutGlobalPause,
  withoutLoopPause,
  writeLoopState,
} = await import('./loop-state.js');

/** A fixed clock — every timestamp in these tests derives from it. */
const T0 = Date.parse('2026-08-12T09:00:00.000Z');
const MINUTE = 60 * 1000;

describe('loop state store', () => {
  let tempDir: string;
  let flowDir: string;
  let loopsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-loop-state-test-'));
    flowDir = join(tempDir, 'flow');
    loopsDir = join(flowDir, 'loops');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('paths and defaults', () => {
    it('stores state at flow/loops/state.json', () => {
      expect(loopStatePath(flowDir)).toBe(join(loopsDir, LOOP_STATE_FILENAME));
    });

    it('reads a missing file as an empty store', () => {
      expect(readLoopState(flowDir, T0)).toEqual(emptyLoopState());
    });

    it('reads an empty file as an empty store', () => {
      mkdirSync(loopsDir, { recursive: true });
      writeFileSync(loopStatePath(flowDir), '   \n', 'utf-8');
      expect(readLoopState(flowDir, T0)).toEqual(emptyLoopState());
    });

    it('defaults an unrecorded loop to a record holding nothing', () => {
      // Phase 6 removed the failure counter, so a defaulted record is now empty
      // rather than `{ consecutiveFailures: 0 }`. Absence and "nothing has
      // happened yet" still read the same, which is the point of `loopRecord`.
      const record = loopRecord(emptyLoopState(), 'find');
      expect(record).toEqual({});
      expect(record.pause).toBeUndefined();
      expect(record.locks).toBeUndefined();
      expect(record.lastOutcome).toBeUndefined();
    });

    it('toIso renders epoch milliseconds in the form stored on disk', () => {
      expect(toIso(T0)).toBe('2026-08-12T09:00:00.000Z');
    });
  });

  describe('serialization', () => {
    it('is deterministic — same state, byte-identical output', () => {
      const state = {
        version: 1,
        globalPause: { reason: 'maintenance', since: '2026-08-12T09:00:00.000Z' },
        loops: {
          find: { lastOutcome: 'failure' as const, lastRunAt: '2026-08-12T08:00:00.000Z' },
          fix: {},
        },
      };
      expect(serializeLoopState(state)).toBe(serializeLoopState(state));
    });

    it('sorts loops by name so key insertion order never shows in the diff', () => {
      const a = serializeLoopState({
        version: 1,
        loops: { improve: {}, find: {} },
      });
      const b = serializeLoopState({
        version: 1,
        loops: { find: {}, improve: {} },
      });
      expect(a).toBe(b);
      expect(a.indexOf('find')).toBeLessThan(a.indexOf('improve'));
    });

    it('orders locks by slot, so a held set always writes the same bytes', () => {
      const highFirst = serializeLoopState({
        version: 1,
        loops: {
          fix: {
            locks: [
              { owner: 'run-b', slot: 2, acquiredAt: '2026-08-12T09:00:00.000Z', expiresAt: '2026-08-12T09:30:00.000Z' },
              { owner: 'run-a', slot: 1, acquiredAt: '2026-08-12T09:00:00.000Z', expiresAt: '2026-08-12T09:30:00.000Z' },
            ],
          },
        },
      });
      expect(highFirst.indexOf('run-a')).toBeLessThan(highFirst.indexOf('run-b'));
    });

    it('round-trips through parse without loss', () => {
      const state = {
        version: 1,
        globalPause: { reason: 'maintenance', since: '2026-08-12T09:00:00.000Z', until: '2026-08-12T10:00:00.000Z' },
        loops: {
          fix: {
            lastOutcome: 'failure' as const,
            lastRunAt: '2026-08-12T08:00:00.000Z',
            locks: [
              {
                owner: 'run-1',
                slot: 1,
                acquiredAt: '2026-08-12T09:00:00.000Z',
                expiresAt: '2026-08-12T09:30:00.000Z',
              },
            ],
          },
        },
      };
      expect(parseLoopState(serializeLoopState(state))).toEqual(state);
    });

    it('round-trips a lock’s focus and pull stamp — both are read back in another process', () => {
      // The aim is set at the gate and read by every later verb; the pull stamp
      // is written by one process and read by `loop worktree` in another. A
      // field dropped here would exist only inside the process that set it.
      const state = {
        version: 1,
        loops: {
          fix: {
            locks: [
              {
                owner: 'run-1',
                slot: 1,
                acquiredAt: '2026-08-12T09:00:00.000Z',
                expiresAt: '2026-08-12T09:30:00.000Z',
                focus: 'the flaky worktree test',
                pulled: { at: '2026-08-12T08:59:00.000Z', base: 'main' },
              },
            ],
          },
        },
      };
      expect(parseLoopState(serializeLoopState(state))).toEqual(state);
    });

    it('ends with a trailing newline', () => {
      expect(serializeLoopState(emptyLoopState()).endsWith('\n')).toBe(true);
    });
  });

  describe('strict parsing', () => {
    it('refuses corrupt JSON rather than reporting nothing is paused', () => {
      expect(() => parseLoopState('{ not json', 'state.json')).toThrow(/unreadable state — invalid JSON/);
    });

    it('refuses a non-object document', () => {
      expect(() => parseLoopState('[]')).toThrow(/expected a JSON object/);
    });

    it('refuses an unknown schema version', () => {
      expect(() => parseLoopState('{"version": 2, "loops": {}}')).toThrow(
        /unsupported state version '2' — expected 1/,
      );
    });

    it('refuses a pause with no reason and a lock with no owner', () => {
      expect(() =>
        parseLoopState('{"version":1,"loops":{"fix":{"pause":{"since":"2026-08-12T09:00:00.000Z"}}}}'),
      ).toThrow(/pause for loop 'fix' has no reason/);
      expect(() =>
        parseLoopState('{"version":1,"loops":{"fix":{"lock":{"acquiredAt":"x","expiresAt":"y"}}}}'),
      ).toThrow(/lock for loop 'fix' has no owner/);
    });

    it('refuses an unknown outcome', () => {
      expect(() => parseLoopState('{"version":1,"loops":{"fix":{"lastOutcome":"maybe"}}}')).toThrow(
        /unknown lastOutcome 'maybe'/,
      );
    });

    it('reads a pre-Phase-6 file carrying consecutiveFailures, and discards the number', () => {
      // The breaker is gone, but a state file written by an older CLI still
      // carries its counter. Refusing it would make this CLI unable to read its
      // own history, so the key is read and dropped rather than validated.
      const legacy = '{"version":1,"loops":{"fix":{"consecutiveFailures":3,"lastOutcome":"failure"}}}';
      expect(parseLoopState(legacy)).toEqual({
        version: 1,
        loops: { fix: { lastOutcome: 'failure' } },
      });
    });

    it('propagates the refusal through readLoopState, naming the file', () => {
      mkdirSync(loopsDir, { recursive: true });
      writeFileSync(loopStatePath(flowDir), '{ broken', 'utf-8');
      expect(() => readLoopState(flowDir, T0)).toThrow(/state\.json: unreadable state/);
    });
  });

  describe('atomic writes', () => {
    it('creates flow/loops/ and writes a readable state file', () => {
      writeLoopState(flowDir, { version: 1, loops: { fix: { lastOutcome: 'failure' } } });
      expect(existsSync(loopStatePath(flowDir))).toBe(true);
      expect(readLoopState(flowDir, T0).loops.fix.lastOutcome).toBe('failure');
    });

    it('leaves no temp files behind after repeated writes', () => {
      for (let i = 0; i < 5; i += 1) {
        writeLoopState(flowDir, { version: 1, loops: { fix: { lastRunAt: toIso(T0 + i * MINUTE) } } });
      }
      expect(readdirSync(loopsDir)).toEqual([LOOP_STATE_FILENAME]);
    });

    it('cleans up its uniquely-named temp file when the rename fails', () => {
      // A directory where the state file belongs makes renameSync fail — the
      // deterministic stand-in for a crashed write.
      mkdirSync(join(loopStatePath(flowDir), 'blocker'), { recursive: true });
      expect(() => writeLoopState(flowDir, emptyLoopState())).toThrow();
      expect(readdirSync(loopsDir)).toEqual([LOOP_STATE_FILENAME]);
    });

    it('never publishes a partial file — the target is always fully parseable', () => {
      writeLoopState(flowDir, { version: 1, loops: { fix: { lastRunAt: toIso(T0) } } });
      const raw = readFileSync(loopStatePath(flowDir), 'utf-8');
      expect(() => parseLoopState(raw)).not.toThrow();
      expect(raw.endsWith('}\n')).toBe(true);
    });

    it('uses a distinct temp name per write (pid + counter), so writers never collide', () => {
      // Two writes in one process must not reuse a name; the second write would
      // otherwise rename a file the first is still writing.
      const names = new Set<string>();
      for (let i = 0; i < 3; i += 1) {
        writeLoopState(flowDir, { version: 1, loops: { fix: { lastRunAt: toIso(T0 + i * MINUTE) } } });
        names.add(readFileSync(loopStatePath(flowDir), 'utf-8'));
      }
      expect(names.size).toBe(3);
      expect(readdirSync(loopsDir)).toEqual([LOOP_STATE_FILENAME]);
    });
  });

  describe('mutateLoopState', () => {
    it('reads, transforms and writes in one call, returning what was written', () => {
      const written = mutateLoopState(
        flowDir,
        (state, now) => withRunOutcome(state, 'fix', 'failure', now),
        T0,
      );
      expect(written.loops.fix.lastOutcome).toBe('failure');
      expect(readLoopState(flowDir, T0)).toEqual(written);
    });

    it('composes across calls — each mutation sees the previous one', () => {
      mutateLoopState(flowDir, (state, now) => withRunOutcome(state, 'fix', 'failure', now), T0);
      const second = mutateLoopState(
        flowDir,
        (state, now) => withRunOutcome(state, 'find', 'success', now),
        T0 + MINUTE,
      );
      expect(Object.keys(second.loops).sort()).toEqual(['find', 'fix']);
    });
  });

  describe('withLoopStateLock — inter-process mutual exclusion (#1662)', () => {
    const lockFile = (): string => `${loopStatePath(flowDir)}.lock`;

    it('holds the lock file for the duration of fn and releases it after', () => {
      const result = withLoopStateLock(flowDir, () => {
        expect(existsSync(lockFile())).toBe(true);
        return 'done';
      });
      expect(result).toBe('done');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('releases the lock when fn throws', () => {
      expect(() =>
        withLoopStateLock(flowDir, () => {
          throw new Error('transform refused');
        }),
      ).toThrow('transform refused');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('is re-entrant within a process — a verb holding the lock may mutate', () => {
      const written = withLoopStateLock(flowDir, () =>
        mutateLoopState(flowDir, (state, now) => withRunOutcome(state, 'fix', 'success', now), T0),
      );
      expect(written.loops.fix.lastOutcome).toBe('success');
      // The OUTER hold releases the file, not the inner one.
      expect(existsSync(lockFile())).toBe(false);
    });

    it('takes over a stale lock left by a dead process — a crash cannot wedge later verbs', () => {
      mkdirSync(loopsDir, { recursive: true });
      writeFileSync(lockFile(), '99999', 'utf-8');
      // Age the file past the stale threshold: the process that wrote it is
      // gone, and its leftover must not stop every verb that follows.
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockFile(), past, past);
      expect(withLoopStateLock(flowDir, () => 'reclaimed')).toBe('reclaimed');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('a write another process lands mid-window survives — the mutate re-reads under the lock', () => {
      // Process A snapshots the store, then B writes a lock, then A mutates.
      // A's transform must run over B's state, not A's stale snapshot.
      const snapshotBeforeB = readLoopState(flowDir, T0);
      expect(liveLocks(snapshotBeforeB, 'find', T0)).toHaveLength(0);
      const b = acquireLoopLock(emptyLoopState(), 'find', 'run-b', 30 * MINUTE, T0);
      expect(b.acquired).toBe(true);
      writeLoopState(flowDir, b.state);
      const after = mutateLoopState(
        flowDir,
        (state, now) => withRunOutcome(state, 'fix', 'success', now),
        T0,
      );
      expect(liveLocks(after, 'find', T0).map((lock) => lock.owner)).toEqual(['run-b']);
      expect(after.loops.fix.lastOutcome).toBe('success');
    });
  });

  describe('pause — per loop', () => {
    it('records a reason and a since stamp from the injected clock', () => {
      const state = withLoopPause(emptyLoopState(), 'fix', { reason: 'awaiting-approval' }, T0);
      expect(state.loops.fix.pause).toEqual({
        reason: 'awaiting-approval',
        since: '2026-08-12T09:00:00.000Z',
      });
    });

    it('stops only the loop it names', () => {
      const state = withLoopPause(emptyLoopState(), 'fix', { reason: 'awaiting-approval' }, T0);
      expect(effectivePause(state, 'fix', T0)?.scope).toBe('loop');
      expect(effectivePause(state, 'find', T0)).toBeNull();
    });

    it('is cleared by withoutLoopPause and leaves the rest of the record intact', () => {
      const paused = withLoopPause(
        { version: 1, loops: { fix: { lastOutcome: 'failure' } } },
        'fix',
        { reason: 'manual' },
        T0,
      );
      const resumed = withoutLoopPause(paused, 'fix');
      expect(resumed.loops.fix.pause).toBeUndefined();
      expect(resumed.loops.fix.lastOutcome).toBe('failure');
      expect(effectivePause(resumed, 'fix', T0)).toBeNull();
    });

    it('clearing an unpaused loop is a no-op', () => {
      expect(withoutLoopPause(emptyLoopState(), 'fix').loops.fix).toEqual({});
    });
  });

  describe('pause — global', () => {
    it('stops every loop, including ones with no record', () => {
      const state = withGlobalPause(emptyLoopState(), { reason: 'maintenance' }, T0);
      expect(effectivePause(state, 'fix', T0)).toMatchObject({ scope: 'global' });
      expect(effectivePause(state, 'anything', T0)).toMatchObject({ scope: 'global' });
    });

    it('outranks a per-loop pause, so the reported reason is the global one', () => {
      const state = withGlobalPause(
        withLoopPause(emptyLoopState(), 'fix', { reason: 'loop reason' }, T0),
        { reason: 'global reason' },
        T0,
      );
      expect(effectivePause(state, 'fix', T0)).toMatchObject({
        scope: 'global',
        record: { reason: 'global reason' },
      });
    });

    it('is cleared by withoutGlobalPause, leaving per-loop pauses standing', () => {
      const state = withGlobalPause(
        withLoopPause(emptyLoopState(), 'fix', { reason: 'loop reason' }, T0),
        { reason: 'global reason' },
        T0,
      );
      const cleared = withoutGlobalPause(state);
      expect(cleared.globalPause).toBeUndefined();
      expect(effectivePause(cleared, 'fix', T0)).toMatchObject({ scope: 'loop' });
    });
  });

  describe('pause — self-expiring until', () => {
    it('holds before the deadline and lifts at or after it', () => {
      const state = withLoopPause(emptyLoopState(), 'fix', { reason: 'cooling off', until: T0 + 30 * MINUTE }, T0);
      expect(effectivePause(state, 'fix', T0 + 29 * MINUTE)).not.toBeNull();
      expect(effectivePause(state, 'fix', T0 + 30 * MINUTE)).toBeNull();
      expect(effectivePause(state, 'fix', T0 + 31 * MINUTE)).toBeNull();
    });

    it('expires a global pause the same way', () => {
      const state = withGlobalPause(emptyLoopState(), { reason: 'deploying', until: T0 + MINUTE }, T0);
      expect(effectivePause(state, 'fix', T0)).not.toBeNull();
      expect(effectivePause(state, 'fix', T0 + 2 * MINUTE)).toBeNull();
    });

    it('holds forever when no until is given', () => {
      const state = withLoopPause(emptyLoopState(), 'fix', { reason: 'manual' }, T0);
      expect(isPauseExpired(state.loops.fix.pause!, T0 + 365 * 24 * 60 * MINUTE)).toBe(false);
    });

    it('treats an unreadable until as no expiry — a pause we cannot read still holds', () => {
      expect(isPauseExpired({ reason: 'manual', since: '2026-08-12T09:00:00.000Z', until: 'soon' }, T0)).toBe(false);
    });

    it('drops expired pauses on read, so a forgotten pause does not stop loops forever', () => {
      writeLoopState(flowDir, withLoopPause(emptyLoopState(), 'fix', { reason: 'cooling off', until: T0 + MINUTE }, T0));

      const during = readLoopState(flowDir, T0);
      expect(during.loops.fix.pause).toBeDefined();

      const after = readLoopState(flowDir, T0 + 2 * MINUTE);
      expect(after.loops.fix.pause).toBeUndefined();
      expect(effectivePause(after, 'fix', T0 + 2 * MINUTE)).toBeNull();
    });

    it('expireLoopState keeps everything that has not run out', () => {
      const state = withGlobalPause(
        withRunOutcome(withLoopPause(emptyLoopState(), 'fix', { reason: 'short', until: T0 + MINUTE }, T0), 'fix', 'failure', T0),
        { reason: 'long', until: T0 + 60 * MINUTE },
        T0,
      );
      const expired = expireLoopState(state, T0 + 2 * MINUTE);
      expect(expired.globalPause).toBeDefined();
      expect(expired.loops.fix.pause).toBeUndefined();
      // The run history is not an expiring record — it survives the sweep.
      expect(expired.loops.fix.lastOutcome).toBe('failure');
    });
  });

  describe('locks — per loop', () => {
    const TTL = 30 * MINUTE;

    it('acquires a free lock, stamping owner and TTL from the injected clock', () => {
      const attempt = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0);
      expect(attempt.acquired).toBe(true);
      expect(attempt.lock).toEqual({
        owner: 'run-1',
        slot: 1,
        acquiredAt: '2026-08-12T09:00:00.000Z',
        expiresAt: '2026-08-12T09:30:00.000Z',
      });
      expect(attempt.state.loops.fix.locks).toEqual([attempt.lock]);
    });

    it('refuses a live lock held by someone else and leaves state untouched', () => {
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state;
      const attempt = acquireLoopLock(held, 'fix', 'run-2', TTL, T0 + MINUTE);
      expect(attempt.acquired).toBe(false);
      expect(attempt.lock.owner).toBe('run-1');
      expect(attempt.state).toBe(held);
    });

    it('is re-entrant for the same owner and extends the TTL', () => {
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state;
      const again = acquireLoopLock(held, 'fix', 'run-1', TTL, T0 + MINUTE);
      expect(again.acquired).toBe(true);
      expect(again.lock.expiresAt).toBe('2026-08-12T09:31:00.000Z');
      // Only the expiry moves: `acquiredAt` answers "when did this run start".
      expect(again.lock.acquiredAt).toBe('2026-08-12T09:00:00.000Z');
    });

    it('lets a later run take over once the TTL has expired', () => {
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'crashed-run', TTL, T0).state;
      const before = acquireLoopLock(held, 'fix', 'run-2', TTL, T0 + TTL - MINUTE);
      expect(before.acquired).toBe(false);

      const after = acquireLoopLock(held, 'fix', 'run-2', TTL, T0 + TTL);
      expect(after.acquired).toBe(true);
      expect(after.lock.owner).toBe('run-2');
    });

    it('locks only the loop they name', () => {
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state;
      expect(acquireLoopLock(held, 'find', 'run-2', TTL, T0).acquired).toBe(true);
    });

    it('releases its own lock and refuses to release someone else’s', () => {
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state;
      expect(releaseLoopLock(held, 'fix', 'run-2').loops.fix.locks).toBeDefined();
      expect(releaseLoopLock(held, 'fix', 'run-1').loops.fix.locks).toBeUndefined();
      expect(releaseLoopLock(held, 'fix').loops.fix.locks).toBeUndefined();
    });

    it('releasing an unheld lock is a no-op', () => {
      const state = emptyLoopState();
      expect(releaseLoopLock(state, 'fix', 'run-1')).toBe(state);
    });

    it('treats an unreadable expiry as expired, so a lock can never wedge a loop', () => {
      expect(isLockExpired({ owner: 'x', slot: 1, acquiredAt: 'x', expiresAt: 'never' }, T0)).toBe(true);
    });

    it('drops expired locks on read', () => {
      writeLoopState(flowDir, acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state);
      expect(readLoopState(flowDir, T0 + MINUTE).loops.fix.locks).toBeDefined();
      expect(readLoopState(flowDir, T0 + TTL).loops.fix.locks).toBeUndefined();
    });

    it('carries the aim it was given, and keeps it across a re-entry', () => {
      const aimed = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, 'the flaky worktree test');
      expect(aimed.lock.focus).toBe('the flaky worktree test');

      // A run re-opens the gate mid-run without re-typing what a person said
      // once, so a re-entry with no focus must not drop the one on record.
      const again = acquireLoopLock(aimed.state, 'fix', 'run-1', TTL, T0 + MINUTE);
      expect(again.lock.focus).toBe('the flaky worktree test');

      // Re-aiming is deliberate, so a NEW focus still wins.
      const reaimed = acquireLoopLock(again.state, 'fix', 'run-1', TTL, T0 + 2 * MINUTE, 'something else');
      expect(reaimed.lock.focus).toBe('something else');
    });
  });

  describe('reading who holds what', () => {
    const TTL = 30 * MINUTE;

    it('liveLocks reports only unexpired locks, lowest slot first', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 3).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0 + 10 * MINUTE, undefined, 3).state;
      expect(liveLocks(state, 'fix', T0 + 10 * MINUTE).map((lock) => lock.slot)).toEqual([1, 2]);
      // run-1's TTL has run out here; only run-2 is still holding a checkout.
      expect(liveLocks(state, 'fix', T0 + TTL + MINUTE).map((lock) => lock.owner)).toEqual(['run-2']);
      expect(liveLocks(emptyLoopState(), 'fix', T0)).toEqual([]);
    });

    it('lockHeldBy finds a run’s own live lock, and nobody else’s', () => {
      const state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0).state;
      expect(lockHeldBy(state, 'fix', 'run-1', T0)?.slot).toBe(1);
      expect(lockHeldBy(state, 'fix', 'run-2', T0)).toBeUndefined();
      // An expired lock is not held, whatever the file still says.
      expect(lockHeldBy(state, 'fix', 'run-1', T0 + TTL)).toBeUndefined();
    });

    it('oldestLock names the run closest to wrapping up', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 2).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0 + MINUTE, undefined, 2).state;
      expect(oldestLock(state, 'fix', T0 + MINUTE)?.owner).toBe('run-1');
      expect(oldestLock(emptyLoopState(), 'fix', T0)).toBeUndefined();
    });

    it('freeSlot hands back the LOWEST free slot, and null when every one is taken', () => {
      // Lowest rather than next: a loop that usually runs alone keeps landing in
      // slot 1 — the original worktree and the original `loop/<name>` branch.
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 2).state;
      expect(freeSlot(state, 'fix', T0, 2)).toBe(2);
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0, undefined, 2).state;
      expect(freeSlot(state, 'fix', T0, 2)).toBeNull();
      // Once run-1's TTL lapses its checkout is free again, and it is the lowest.
      expect(freeSlot(state, 'fix', T0 + TTL, 2)).toBe(1);
    });
  });

  describe('run slots — one loop, more than one run', () => {
    const TTL = 30 * MINUTE;

    it('reads a pre-slot state file, calling its single lock slot 1', () => {
      // The shape every state file written before slots carries. It must load as
      // a held loop — a machine that upgrades mid-run must not find its running
      // loop suddenly free.
      const legacy = JSON.stringify({
        version: 1,
        loops: {
          fix: {
            lock: {
              owner: 'run-1',
              acquiredAt: '2026-08-12T09:00:00.000Z',
              expiresAt: '2026-08-12T09:30:00.000Z',
            },
          },
        },
      });
      const parsed = parseLoopState(legacy);
      expect(parsed.loops.fix.locks).toEqual([
        {
          owner: 'run-1',
          slot: 1,
          acquiredAt: '2026-08-12T09:00:00.000Z',
          expiresAt: '2026-08-12T09:30:00.000Z',
        },
      ]);
      expect(liveLocks(parsed, 'fix', T0).map((lock) => lock.owner)).toEqual(['run-1']);
    });

    it('hands a second run the second slot when the directive allows two', () => {
      const first = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 2);
      const second = acquireLoopLock(first.state, 'fix', 'run-2', TTL, T0 + MINUTE, undefined, 2);
      expect(second.acquired).toBe(true);
      expect(second.lock.slot).toBe(2);
      expect(liveLocks(second.state, 'fix', T0 + MINUTE).map((lock) => lock.owner)).toEqual([
        'run-1',
        'run-2',
      ]);
    });

    it('still refuses a second run when the directive allows one', () => {
      const first = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0);
      const second = acquireLoopLock(first.state, 'fix', 'run-2', TTL, T0 + MINUTE);
      expect(second.acquired).toBe(false);
      expect(second.state).toBe(first.state);
    });

    it('refuses the run that finds every slot taken, naming the oldest', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 2).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0 + MINUTE, undefined, 2).state;
      const third = acquireLoopLock(state, 'fix', 'run-3', TTL, T0 + 2 * MINUTE, undefined, 2);
      expect(third.acquired).toBe(false);
      expect(third.lock.owner).toBe('run-1');
    });

    it('gives a re-entering run the slot it already holds, not the lowest free one', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 3).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0, undefined, 3).state;
      // slot 1 frees up while run-2 is still working in slot 2
      state = releaseLoopLock(state, 'fix', 'run-1');

      const again = acquireLoopLock(state, 'fix', 'run-2', TTL, T0 + MINUTE, undefined, 3);
      expect(again.lock.slot).toBe(2);
      // and its clock did not restart just because it asked again
      expect(again.lock.acquiredAt).toBe('2026-08-12T09:00:00.000Z');
    });

    it('reuses a slot a finished run gave back', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', TTL, T0, undefined, 2).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0, undefined, 2).state;
      state = releaseLoopLock(state, 'fix', 'run-1');

      const next = acquireLoopLock(state, 'fix', 'run-3', TTL, T0 + MINUTE, undefined, 2);
      expect(next.acquired).toBe(true);
      expect(next.lock.slot).toBe(1);
    });

    it('frees a crashed run’s slot at the TTL without touching its sibling', () => {
      let state = acquireLoopLock(emptyLoopState(), 'fix', 'crashed', TTL, T0, undefined, 2).state;
      state = acquireLoopLock(state, 'fix', 'run-2', TTL, T0 + 10 * MINUTE, undefined, 2).state;

      const after = T0 + TTL + MINUTE;
      expect(liveLocks(state, 'fix', after).map((lock) => lock.owner)).toEqual(['run-2']);
      const taken = acquireLoopLock(state, 'fix', 'run-3', TTL, after, undefined, 2);
      expect(taken.acquired).toBe(true);
      expect(taken.lock.slot).toBe(1);
      // the dead run's record is gone from the file, not merely ignored
      expect(taken.state.loops.fix.locks?.map((lock) => lock.owner).sort()).toEqual([
        'run-2',
        'run-3',
      ]);
    });

    it('refuses a state file claiming two runs in one slot', () => {
      const doubled = JSON.stringify({
        version: 1,
        loops: {
          fix: {
            locks: [
              { owner: 'a', slot: 1, acquiredAt: '2026-08-12T09:00:00.000Z', expiresAt: '2026-08-12T09:00:00.000Z' },
              { owner: 'b', slot: 1, acquiredAt: '2026-08-12T09:00:00.000Z', expiresAt: '2026-08-12T09:00:00.000Z' },
            ],
          },
        },
      });
      expect(() => parseLoopState(doubled)).toThrow('two locks on one slot');
    });
  });

  describe('withRunOutcome — history, not a breaker', () => {
    // Phase 6 replaced `recordRunOutcome` with this. What went is the counting:
    // the consecutive-failure breaker it fed is gone with the unattended
    // scheduler it protected, so what remains is the two facts `loop status`
    // reads — how the last run ended, and when.

    it('records the outcome and stamps it from the injected clock', () => {
      const state = withRunOutcome(emptyLoopState(), 'fix', 'failure', T0);
      expect(state.loops.fix).toEqual({
        lastOutcome: 'failure',
        lastRunAt: '2026-08-12T09:00:00.000Z',
      });
    });

    it('overwrites the previous outcome rather than accumulating anything', () => {
      const failed = withRunOutcome(emptyLoopState(), 'fix', 'failure', T0);
      const recovered = withRunOutcome(failed, 'fix', 'success', T0 + MINUTE);
      expect(recovered.loops.fix).toEqual({
        lastOutcome: 'success',
        lastRunAt: '2026-08-12T09:01:00.000Z',
      });
    });

    it('touches nothing else — a pause and a held slot both stand', () => {
      // A recorded failure is not a decision to stop; that is what the deleted
      // breaker did, and its absence is exactly what this asserts.
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', 30 * MINUTE, T0).state;
      const paused = withLoopPause(held, 'fix', { reason: 'manual' }, T0);
      const after = withRunOutcome(paused, 'fix', 'failure', T0 + MINUTE);
      expect(after.loops.fix.pause?.reason).toBe('manual');
      expect(liveLocks(after, 'fix', T0 + MINUTE).map((lock) => lock.owner)).toEqual(['run-1']);
    });

    it('records against only the loop it names', () => {
      const state = withRunOutcome(emptyLoopState(), 'fix', 'failure', T0);
      expect(state.loops.find).toBeUndefined();
      expect(loopRecord(state, 'find')).toEqual({});
    });

    it('survives a write/read round trip through the store', () => {
      writeLoopState(flowDir, withRunOutcome(emptyLoopState(), 'fix', 'failure', T0));
      const reread = readLoopState(flowDir, T0 + 10 * MINUTE);
      expect(reread.loops.fix.lastOutcome).toBe('failure');
      expect(reread.loops.fix.lastRunAt).toBe('2026-08-12T09:00:00.000Z');
    });
  });

  describe('escalation — awaiting approval', () => {
    // Relocated here in Phase 6 from the deleted pipeline machinery: an
    // escalation IS a pause, so it lives beside the pause transforms. The stage
    // annotation went with the pipeline — nothing supervises a run's stage any
    // more — so `escalationPromptTail` now takes only the loop and the detail.

    it('reads the detail into the reason, and stands alone when there is none', () => {
      expect(escalationReason('needs a human on the schema change')).toBe(
        `${AWAITING_APPROVAL} — needs a human on the schema change`,
      );
      expect(escalationReason('')).toBe(AWAITING_APPROVAL);
      expect(escalationReason('   ')).toBe(AWAITING_APPROVAL);
    });

    it('pauses the loop it names with that reason', () => {
      const state = applyEscalation(emptyLoopState(), 'fix', 'high-risk push', T0);
      expect(state.loops.fix.pause).toEqual({
        reason: `${AWAITING_APPROVAL} — high-risk push`,
        since: '2026-08-12T09:00:00.000Z',
      });
      expect(effectivePause(state, 'fix', T0)).toMatchObject({ scope: 'loop' });
      expect(effectivePause(state, 'find', T0)).toBeNull();
    });

    it('holds until a person clears it — a human gate has no expiry', () => {
      const state = applyEscalation(emptyLoopState(), 'fix', 'high-risk push', T0);
      expect(state.loops.fix.pause?.until).toBeUndefined();
      expect(effectivePause(state, 'fix', T0 + 365 * 24 * 60 * MINUTE)).not.toBeNull();
    });

    it('does not release the run’s slot — the claimed item stays claimed', () => {
      // A gate is not a failure: handing the half-finished work to whoever
      // starts the next run while a person is still looking at it is the one
      // thing escalation must not do.
      const held = acquireLoopLock(emptyLoopState(), 'fix', 'run-1', 30 * MINUTE, T0).state;
      const escalated = applyEscalation(held, 'fix', 'high-risk push', T0);
      expect(liveLocks(escalated, 'fix', T0).map((lock) => lock.owner)).toEqual(['run-1']);
      expect(escalated.loops.fix.lastOutcome).toBeUndefined();
    });

    it('writes a prompt tail naming the loop, the reason and the way back', () => {
      const tail = escalationPromptTail('fix', 'high-risk push');
      expect(tail).toContain('loop: fix');
      expect(tail).toContain('reason: high-risk push');
      expect(tail).toContain('--loop fix');
      expect(escalationPromptTail('fix', '  ')).toContain(`reason: ${AWAITING_APPROVAL}`);
    });
  });
});
