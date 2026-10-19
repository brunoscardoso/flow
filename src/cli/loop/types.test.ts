/**
 * Unit tests for the loop type vocabulary.
 *
 * Pure — no fs, no clock, no model. Covers the enumerations every other loop
 * module validates against, their guards, and the documented defaults. Types
 * erase at runtime, so what is asserted here is the RUNTIME half: the lists,
 * the guards, and the constants downstream code depends on being exactly these
 * values.
 */

import type {
  LoopDirective,
  LoopGateDecision,
  LoopLockRecord,
  LoopPauseRecord,
  LoopRecord,
  LoopState,
} from './types.js';

const {
  DEFAULT_LEDGER_PATH,
  DEFAULT_LOOP_SLICE,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_MAX_OPEN_ISSUES,
  LOOP_ENGINES,
  LOOP_GATE_VERDICTS,
  LOOP_QUEUE_KINDS,
  LOOP_SLICES,
  LOOP_STATE_VERSION,
  isLoopEngine,
  isLoopGateVerdict,
  isLoopQueueKind,
  isLoopSlice,
} = await import('./types.js');
const { lockTtlMs } = await import('./next.js');

describe('loop vocabulary', () => {
  it('names exactly two engines', () => {
    expect([...LOOP_ENGINES]).toEqual(['producer', 'consumer']);
  });

  it('names exactly two queue kinds', () => {
    expect([...LOOP_QUEUE_KINDS]).toEqual(['github', 'ledger']);
  });

  it('names exactly three slice modes', () => {
    expect([...LOOP_SLICES]).toEqual(['changed', 'rotate', 'full']);
  });

  it('names exactly four gate verdicts', () => {
    expect([...LOOP_GATE_VERDICTS]).toEqual(['proceed', 'skip', 'paused', 'locked']);
  });
});

describe('loop guards', () => {
  it('accepts every listed member and rejects anything else', () => {
    for (const engine of LOOP_ENGINES) expect(isLoopEngine(engine)).toBe(true);
    for (const queue of LOOP_QUEUE_KINDS) expect(isLoopQueueKind(queue)).toBe(true);
    for (const slice of LOOP_SLICES) expect(isLoopSlice(slice)).toBe(true);
    for (const verdict of LOOP_GATE_VERDICTS) expect(isLoopGateVerdict(verdict)).toBe(true);

    expect(isLoopEngine('worker')).toBe(false);
    expect(isLoopQueueKind('gitlab')).toBe(false);
    expect(isLoopSlice('random')).toBe(false);
    expect(isLoopGateVerdict('blocked')).toBe(false);
  });

  it('rejects casing and whitespace variants rather than coercing them', () => {
    expect(isLoopEngine('Producer')).toBe(false);
    expect(isLoopQueueKind(' github')).toBe(false);
    expect(isLoopSlice('CHANGED')).toBe(false);
    expect(isLoopGateVerdict('proceed ')).toBe(false);
  });

  it('rejects the empty string for every guard', () => {
    expect(isLoopEngine('')).toBe(false);
    expect(isLoopQueueKind('')).toBe(false);
    expect(isLoopSlice('')).toBe(false);
    expect(isLoopGateVerdict('')).toBe(false);
  });
});

describe('loop defaults', () => {
  it('defaults the slice to changed and the beat budget to 25 minutes', () => {
    expect(DEFAULT_LOOP_SLICE).toBe('changed');
    expect(isLoopSlice(DEFAULT_LOOP_SLICE)).toBe(true);
    expect(DEFAULT_MAX_RUN_MINUTES).toBe(25);
  });

  it('defaults the open-item cap to a bound rather than to no bound', () => {
    expect(DEFAULT_MAX_OPEN_ISSUES).toBe(8);
    expect(Number.isInteger(DEFAULT_MAX_OPEN_ISSUES)).toBe(true);
    expect(DEFAULT_MAX_OPEN_ISSUES).toBeGreaterThan(0);
  });

  it('defaults the ledger path under flow/loops/', () => {
    expect(DEFAULT_LEDGER_PATH).toBe('flow/loops/queue.jsonl');
  });

  it('gives a run slot a TTL longer than the run length it reserves for', () => {
    // Phase 6: the TTL is no longer sized against a run BUDGET (there is none —
    // the run lives in a Claude Code session). It sizes how long a dead run's
    // checkout stays reserved, and `lockTtlMs` owns that arithmetic now.
    expect(lockTtlMs(DEFAULT_MAX_RUN_MINUTES)).toBeGreaterThan(DEFAULT_MAX_RUN_MINUTES * 60 * 1000);
  });

  it('stamps state files with version 1', () => {
    expect(LOOP_STATE_VERSION).toBe(1);
  });
});

describe('loop record shapes', () => {
  it('models a directive with every defaulted field resolved', () => {
    const directive: LoopDirective = {
      loop: 'find',
      engine: 'producer',
      paused: false,
      mission: 'Find cleanup targets in the repo',
      scope: ['src/', 'app/src/'],
      slice: DEFAULT_LOOP_SLICE,
      queue: 'github',
      repo: 'owner/name',
      label: 'qa-heartbeat',
      maxOpenIssues: DEFAULT_MAX_OPEN_ISSUES,
      maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
      needsApproval: false,
      direction: 'Look for dead code.',
      rules: 'Reproduce before filing.',
    };
    expect(isLoopEngine(directive.engine)).toBe(true);
    expect(isLoopQueueKind(directive.queue)).toBe(true);
  });

  it('models a pause whose presence IS the pause', () => {
    const pause: LoopPauseRecord = {
      reason: 'breaker tripped',
      since: '2026-08-12T09:00:00.000Z',
      until: '2026-08-12T10:00:00.000Z',
    };
    const record: LoopRecord = { pause, consecutiveFailures: 3, lastOutcome: 'failure' };
    expect(record.pause?.reason).toBe('breaker tripped');

    const running: LoopRecord = { consecutiveFailures: 0 };
    expect(running.pause).toBeUndefined();
  });

  it('models a lock and the state that holds the single pipeline lock', () => {
    const lock: LoopLockRecord = {
      owner: 'beat-1',
      acquiredAt: '2026-08-12T09:00:00.000Z',
      expiresAt: '2026-08-12T09:30:00.000Z',
    };
    const state: LoopState = {
      version: LOOP_STATE_VERSION,
      pipelineLock: lock,
      loops: { fix: { consecutiveFailures: 0, lock } },
    };
    expect(state.pipelineLock?.owner).toBe('beat-1');
    expect(state.loops.fix.lock?.expiresAt).toBe('2026-08-12T09:30:00.000Z');
  });

  it('models a gate decision carrying a non-empty reason for every verdict', () => {
    const decisions: LoopGateDecision[] = LOOP_GATE_VERDICTS.map((verdict) => ({
      verdict,
      reason: `verdict is ${verdict}`,
    }));
    expect(decisions).toHaveLength(4);
    for (const decision of decisions) {
      expect(isLoopGateVerdict(decision.verdict)).toBe(true);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});
