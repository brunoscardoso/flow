/**
 * Reading the recorded risk assessment — the pure half of the publish gate.
 *
 * THE CASE THAT MATTERS MOST IS THE CROSS-PLAN ONE. `flow/.rounds.jsonl` is one
 * file per project holding every plan's entries for ever, and Phase 1's first
 * cut of the workflow ladder proved what happens when a reader forgets that: it
 * reported every rung of a fresh chain done because somebody, once, ran that
 * stage for something else. The same trap is open here in both directions — an
 * old `high` that gates a run it has nothing to do with, and an old `low` that
 * CLEARS one.
 */

import {
  entryNamesFeature,
  featureOfEntry,
  isRiskLevel,
  readRisk,
} from './risk-record.js';
import type { RoundsEntry } from './rounds-reader.js';

const OURS = 'harness-autopilot';
const THEIRS = 'worktree-ui-removal';

/** A risk entry in the shape the live coordinator writes (with `plan`). */
function risk(plan: string, level: string, ts: string, rationale = 'because'): RoundsEntry {
  return {
    ts,
    run_id: `${plan}-20260911-120000`,
    type: 'risk',
    phase: null,
    plan,
    risk_level: level,
    risk_rationale: rationale,
  };
}

/** The same entry, stamped by the chain that recorded it — `flow risk --record`. */
function chained(
  plan: string,
  level: string,
  ts: string,
  chain: string,
  rationale = 'because',
): RoundsEntry {
  return { ...risk(plan, level, ts, rationale), chain };
}

/** A risk entry in the shape the SKILL DOC's example writes — no `plan` field. */
function docShapedRisk(plan: string, level: string, ts: string): RoundsEntry {
  return {
    ts,
    run_id: `${plan}-20260911-101500`,
    type: 'risk',
    phase: null,
    risk_level: level,
    risk_rationale: 'from the documented shape',
  };
}

function phaseResult(plan: string, ts: string): RoundsEntry {
  return { ts, run_id: `${plan}-20260911-120000`, type: 'phase_result', plan, phase: 1, status: 'success' };
}

describe('which entries belong to a feature', () => {
  it('matches the bare slug every live entry in this repo carries', () => {
    expect(entryNamesFeature({ plan: OURS }, OURS)).toBe(true);
    expect(entryNamesFeature({ plan: THEIRS }, OURS)).toBe(false);
  });

  it("matches the filename spelling run_intent is documented to carry", () => {
    expect(entryNamesFeature({ plan: `plan_${OURS}_v1` }, OURS)).toBe(true);
    expect(entryNamesFeature({ plan: `plan_${OURS}_v2.md` }, OURS)).toBe(true);
  });

  it('matches the run id, which is all a doc-shaped risk entry carries', () => {
    expect(entryNamesFeature({ run_id: `${OURS}-20260911-182332` }, OURS)).toBe(true);
    expect(entryNamesFeature({ run_id: `${OURS}-20260911` }, OURS)).toBe(true);
    expect(entryNamesFeature({ run_id: `${OURS}-plan` }, OURS)).toBe(true);
  });

  it('a shorter slug never claims a longer one — the run id needs its date', () => {
    expect(entryNamesFeature({ run_id: 'harness-autopilot-20260911-182332' }, 'harness')).toBe(false);
  });

  it('a slug is a name, not a pattern', () => {
    expect(entryNamesFeature({ plan: 'aXb' }, 'a.b')).toBe(false);
    expect(entryNamesFeature({ plan: 'a.b' }, 'a.b')).toBe(true);
  });

  it('an empty slug matches nothing', () => {
    expect(entryNamesFeature({ plan: OURS }, '   ')).toBe(false);
  });
});

describe('which feature an entry names', () => {
  it('prefers the explicit field, and unwraps the filename spelling', () => {
    expect(featureOfEntry({ plan: OURS })).toBe(OURS);
    expect(featureOfEntry({ plan: `plan_${OURS}_v3.md` })).toBe(OURS);
  });

  it('falls back to stripping the run id, which is all a doc-shaped entry has', () => {
    expect(featureOfEntry({ run_id: `${OURS}-20260911-182332` })).toBe(OURS);
    expect(featureOfEntry({ run_id: `${OURS}-plan` })).toBe(OURS);
  });

  it('names nothing when the entry names nothing', () => {
    expect(featureOfEntry({ type: 'risk' })).toBeNull();
  });
});

describe('a stated scope', () => {
  const scope = { kind: 'stated', feature: OURS } as const;

  it('reads the level the coordinator recorded', () => {
    const reading = readRisk([risk(OURS, 'high', '2026-09-11T10:00:00Z')], scope);
    expect(reading.assessment).toMatchObject({ level: 'high', rationale: 'because' });
    expect(reading.absence).toBeNull();
  });

  it('reads the documented shape, which carries no plan field at all', () => {
    const reading = readRisk([docShapedRisk(OURS, 'low', '2026-09-11T10:00:00Z')], scope);
    expect(reading.assessment?.level).toBe('low');
  });

  it("ANOTHER PLAN'S high does not gate this one", () => {
    const reading = readRisk(
      [risk(THEIRS, 'high', '2026-09-11T10:00:00Z'), risk(OURS, 'low', '2026-09-11T11:00:00Z')],
      scope,
    );
    expect(reading.assessment?.level).toBe('low');
  });

  it("ANOTHER PLAN'S low does not clear this one", () => {
    const reading = readRisk(
      [risk(OURS, 'high', '2026-09-11T10:00:00Z'), risk(THEIRS, 'low', '2026-09-11T11:00:00Z')],
      scope,
    );
    expect(reading.assessment?.level).toBe('high');
  });

  it('the latest recorded assessment wins — a re-assessment is a new line', () => {
    const reading = readRisk(
      [risk(OURS, 'high', '2026-09-11T10:00:00Z'), risk(OURS, 'medium', '2026-09-11T12:00:00Z')],
      scope,
    );
    expect(reading.assessment?.level).toBe('medium');
  });

  it('entries for this feature that are not assessments read as unassessed', () => {
    const reading = readRisk([phaseResult(OURS, '2026-09-11T10:00:00Z')], scope);
    expect(reading.assessment).toBeNull();
    expect(reading.absence).toBe('unassessed');
  });

  it('a record holding nothing of ours reads as no record', () => {
    const reading = readRisk([risk(THEIRS, 'high', '2026-09-11T10:00:00Z')], scope);
    expect(reading.assessment).toBeNull();
    expect(reading.absence).toBe('no-record');
  });

  it('an empty record reads as no record — never as a low one', () => {
    expect(readRisk([], scope)).toMatchObject({ assessment: null, absence: 'no-record' });
  });

  it('a fourth level is not an assessment', () => {
    expect(isRiskLevel('catastrophic')).toBe(false);
    const reading = readRisk([risk(OURS, 'catastrophic', '2026-09-11T10:00:00Z')], scope);
    expect(reading.assessment).toBeNull();
    expect(reading.absence).toBe('unassessed');
  });
});

describe('an observed scope', () => {
  const since = '2026-09-11T12:00:00Z';

  it('resolves the feature from the newest entry inside the window', () => {
    const reading = readRisk(
      [phaseResult(THEIRS, '2026-09-11T09:00:00Z'), phaseResult(OURS, '2026-09-11T13:00:00Z')],
      { kind: 'observed', since },
    );
    expect(reading.feature).toBe(OURS);
  });

  it("an older run's assessment is outside the window and cannot clear this one", () => {
    const reading = readRisk(
      [risk(THEIRS, 'low', '2026-09-11T09:00:00Z'), phaseResult(OURS, '2026-09-11T13:00:00Z')],
      { kind: 'observed', since },
    );
    expect(reading.feature).toBe(OURS);
    expect(reading.assessment).toBeNull();
    expect(reading.absence).toBe('unassessed');
  });

  it("an older run's high is outside the window and cannot gate this one", () => {
    const reading = readRisk(
      [
        risk(THEIRS, 'high', '2026-09-11T09:00:00Z'),
        risk(OURS, 'low', '2026-09-11T13:00:00Z'),
      ],
      { kind: 'observed', since },
    );
    expect(reading.assessment?.level).toBe('low');
  });

  it('reads BOTH timestamp spellings — the record really holds ts and at', () => {
    const reading = readRisk(
      [
        { at: '2026-09-11T13:00:00', type: 'phase_result', plan: OURS, run_id: `${OURS}-20260911` },
        { at: '2026-09-11T13:05:00', type: 'risk', plan: OURS, risk_level: 'high', run_id: `${OURS}-20260911` },
      ],
      { kind: 'observed', since: '2026-09-11T12:00:00' },
    );
    expect(reading.feature).toBe(OURS);
    expect(reading.assessment?.level).toBe('high');
  });

  it('an entry with no usable timestamp is outside every window', () => {
    const reading = readRisk([{ type: 'risk', plan: OURS, risk_level: 'low' }], {
      kind: 'observed',
      since,
    });
    expect(reading.feature).toBeNull();
    expect(reading.absence).toBe('no-record');
  });

  it('an empty window resolves no feature and reads as no record', () => {
    const reading = readRisk([phaseResult(OURS, '2026-09-11T09:00:00Z')], {
      kind: 'observed',
      since,
    });
    expect(reading.feature).toBeNull();
    expect(reading.absence).toBe('no-record');
  });
});

/**
 * THE REGRESSION — #1915 C1, as the reviewer reproduced it live.
 *
 * An honest `high` assessment refused a publish; ONE appended line naming a
 * feature that does not exist opened the gate, because `observed` resolved its
 * subject from the newest line naming anything and then read that subject's
 * rating. The line was both the question and the answer.
 *
 * Every case here is the shape of a real failure rather than a shape of the
 * implementation: a decoy, a neighbouring chain, and an unstamped entry. And the
 * reporting reading is asserted UNCHANGED alongside them — enforcement is for
 * chains, and a person asking by hand is never cornered (discovery R3).
 */
describe('an enforced reading is keyed on the chain id', () => {
  const OURS_CHAIN = 'chain-2026-09-11-001';
  const THEIR_CHAIN = 'chain-2026-09-11-002';
  const since = '2026-09-11T12:00:00Z';
  const observed = { kind: 'observed', since } as const;

  it('THE DECOY: an appended line naming another feature does not clear a high', () => {
    const honest = chained(OURS, 'high', '2026-09-11T13:00:00Z', OURS_CHAIN, 'Touches auth');
    const decoy = risk('anything-at-all', 'low', '2026-09-11T13:30:00Z', 'looks fine');

    const reading = readRisk([honest, decoy], observed, OURS_CHAIN);

    expect(reading.assessment?.level).toBe('high');
    expect(reading.feature).toBe(OURS);
  });

  it('the decoy cannot nominate itself as the subject either', () => {
    const decoy = risk('anything-at-all', 'low', '2026-09-11T13:30:00Z');
    const reading = readRisk([decoy], observed, OURS_CHAIN);
    expect(reading.feature).not.toBe('anything-at-all');
    expect(reading.assessment).toBeNull();
  });

  it("ANOTHER CHAIN'S low does not satisfy this chain", () => {
    const reading = readRisk(
      [chained(OURS, 'low', '2026-09-11T13:00:00Z', THEIR_CHAIN)],
      observed,
      OURS_CHAIN,
    );
    expect(reading.assessment).toBeNull();
    expect(reading.absence).toBe('no-record');
  });

  it('an UNSTAMPED entry never satisfies an enforced gate — the backward-compat choice', () => {
    const reading = readRisk([risk(OURS, 'low', '2026-09-11T13:00:00Z')], observed, OURS_CHAIN);
    expect(reading.assessment).toBeNull();
  });

  it('the chain this run recorded under is read, and answers', () => {
    const reading = readRisk(
      [chained(OURS, 'medium', '2026-09-11T13:00:00Z', OURS_CHAIN, 'bounded')],
      observed,
      OURS_CHAIN,
    );
    expect(reading.assessment).toMatchObject({ level: 'medium', rationale: 'bounded' });
    expect(reading.feature).toBe(OURS);
  });

  it('the latest of THIS chain wins — a re-assessment is still a new line', () => {
    const reading = readRisk(
      [
        chained(OURS, 'high', '2026-09-11T13:00:00Z', OURS_CHAIN),
        chained(OURS, 'low', '2026-09-11T14:00:00Z', OURS_CHAIN),
      ],
      observed,
      OURS_CHAIN,
    );
    expect(reading.assessment?.level).toBe('low');
  });

  it('the window still bounds the chain — an entry before it is out', () => {
    const reading = readRisk(
      [chained(OURS, 'low', '2026-09-11T09:00:00Z', OURS_CHAIN)],
      observed,
      OURS_CHAIN,
    );
    expect(reading.assessment).toBeNull();
  });

  it('a stated scope needs BOTH the chain and the feature it was asked about', () => {
    const stated = { kind: 'stated', feature: OURS } as const;
    const theirs = chained(THEIRS, 'low', '2026-09-11T13:00:00Z', OURS_CHAIN);

    expect(readRisk([theirs], stated, OURS_CHAIN).assessment).toBeNull();
    expect(readRisk([theirs], stated, OURS_CHAIN).feature).toBe(OURS);
    expect(
      readRisk([chained(OURS, 'low', '2026-09-11T13:00:00Z', OURS_CHAIN)], stated, OURS_CHAIN)
        .assessment?.level,
    ).toBe('low');
  });

  it('a blank chain is not an enforcement — it reads as reporting', () => {
    const entries = [risk(OURS, 'high', '2026-09-11T13:00:00Z')];
    expect(readRisk(entries, observed, '   ').assessment?.level).toBe('high');
  });
});

describe('the reporting reading is untouched by the chain fix', () => {
  const observed = { kind: 'observed', since: '2026-09-11T12:00:00Z' } as const;

  it('still reads an unstamped entry, because it refuses nothing', () => {
    const reading = readRisk([risk(OURS, 'low', '2026-09-11T13:00:00Z')], observed);
    expect(reading.assessment?.level).toBe('low');
    expect(reading.feature).toBe(OURS);
  });

  it('still resolves its subject the way it always did', () => {
    const reading = readRisk(
      [risk(OURS, 'high', '2026-09-11T13:00:00Z'), risk(THEIRS, 'low', '2026-09-11T13:30:00Z')],
      observed,
    );
    expect(reading.feature).toBe(THEIRS);
  });
});
