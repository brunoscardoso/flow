/**
 * Tests for pipeline stage derivation, the stalled-pipeline policy and the
 * awaiting-approval policy.
 *
 * ALMOST EVERYTHING HERE IS PURE. `deriveStage`, `evaluateStall` and both state
 * transforms take their inputs and an injected `now`, so a stage assertion is a
 * constant and a breaker trip is proven by arithmetic rather than by sleeping.
 * The one exception is `readPipelineInput`, which is exercised against real
 * throwaway directories — it is the module's only I/O, and the thing it has to
 * prove is that it finds (and normalizes the names of) real files on disk.
 *
 * NO GIT, NO NETWORK, NO MODEL CALL. Nothing in this file shells out.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PHASE 6 CUT THIS SUITE IN HALF, along with the module it covers. The
// stalled-pipeline policy (resume twice, then abandon) and the
// awaiting-approval pause are gone: both were SUPERVISION, and the supervisor
// that acted on them — the daemon's loop task and finalizer — was deleted in
// Phase 5. What is left is the DERIVATION, and it is still load-bearing: "is a
// pipeline stage in flight" is what tells `loop log --record` that a run holding
// a claim ended honestly rather than abandoning the item.
const {
  claimedPlan,
  deriveStage,
  idleStage,
  isPipelineStageKind,
  normalizePlanName,
  readPipelineInput,
  readStage,
  skillStage,
  stageKey,
  stageSourceNote,
} = await import('./pipeline-state.js');

type PipelineInput = Parameters<typeof deriveStage>[0];
type PipelineStage = ReturnType<typeof deriveStage>;

/** A fixed clock — every timestamp in these tests derives from it. */
const T0 = Date.parse('2026-08-12T09:00:00.000Z');
const PLAN_HASH = 'a'.repeat(64);

// ── fixtures ─────────────────────────────────────────────

function executionState(overrides: Record<string, unknown> = {}): PipelineInput['state'] {
  return {
    active_skill: null,
    active_plan: null,
    current_phase: null,
    current_task: null,
    completed_phases: [],
    decisions: [],
    blockers: [],
    files_modified: [],
    next_action: null,
    updated_at: null,
    ...overrides,
  } as PipelineInput['state'];
}

/** A compiled artifact with `phases` phases grouped into `waves` waves. */
function runScript(options: {
  plan?: string;
  phases?: number;
  waves?: number[][];
  skip?: number[];
}): PipelineInput['script'] {
  const count = options.phases ?? 4;
  const skip = new Set(options.skip ?? []);
  return {
    version: 1,
    plan: options.plan ?? 'agent-loops',
    planHash: PLAN_HASH,
    phases: Array.from({ length: count }, (_unused, index) => ({
      number: index + 1,
      name: `Phase ${index + 1}`,
      complexity: 5,
      dependencies: [],
      model: 'sonnet',
      skip: skip.has(index + 1),
      tasks: [],
    })),
    waves: (options.waves ?? [[1, 2], [3], [4]]).map((phases, index) => ({
      wave_number: index + 1,
      phase_numbers: phases,
    })),
    routing: [],
    commitStrategy: 'per-task',
    overrides: {},
    diagnostics: [],
  } as unknown as PipelineInput['script'];
}

/** A `phase_result` success carrying this plan's lineage. */
function phaseResult(phase: number, runId = 'run-1'): Record<string, unknown> {
  return {
    ts: '2026-08-12T08:00:00.000Z',
    run_id: runId,
    type: 'phase_result',
    phase,
    status: 'success',
    planHash: PLAN_HASH,
  };
}

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    state: null,
    // No claim by default. A claim is the ONLY thing that names a pipeline —
    // STATE.md is the interactive session's mirror and never dispatches one.
    claimPlan: '',
    script: null,
    rounds: [],
    discoveryDocExists: false,
    planDocExists: false,
    ...overrides,
  };
}

/** A failed beat line at a stage. */
function failedRun(loop: string, stage: string): Record<string, unknown> {
  return { ts: '2026-08-12T08:00:00.000Z', kind: 'beat', loop, stage, outcome: 'failure' };
}

type RunEntries = Parameters<typeof evaluateStall>[2];

// ── Task 5.1: stage derivation ───────────────────────────

describe('Task 5.1 — the stage is derived, never stored', () => {
  it('reads as `none` when nothing is in flight', () => {
    const stage = deriveStage(input());
    expect(stage).toEqual(idleStage());
    expect(stage.kind).toBe('none');
    expect(stage.inFlight).toBe(false);
    expect(stage.label).toBe('no pipeline in flight');
  });

  it('reads as `none` when STATE.md exists but names nothing', () => {
    const stage = deriveStage(input({ state: executionState({ active_plan: 'None' }) }));
    expect(stage.kind).toBe('none');
  });

  it('reads as `discovery` when a claim names a plan but no document exists yet', () => {
    const stage = deriveStage(
      input({ claimPlan: 'agent-loops', state: executionState({ active_skill: 'discovery-plan' }) }),
    );
    expect(stage.kind).toBe('discovery');
    expect(stage.plan).toBe('agent-loops');
    expect(stage.label).toBe('discovery — plan agent-loops');
    expect(stage.inFlight).toBe(true);
  });

  it('reads as `plan` once the discovery document exists', () => {
    const stage = deriveStage(
      input({
        claimPlan: 'plan_agent-loops_v1',
        discoveryDocExists: true,
      }),
    );
    expect(stage.kind).toBe('plan');
    expect(stage.label).toBe('plan — plan agent-loops');
  });

  it('reads as an uncompiled `wave 1 of ?` once the plan document exists', () => {
    const stage = deriveStage(
      input({
        claimPlan: 'agent-loops',
        discoveryDocExists: true,
        planDocExists: true,
      }),
    );
    expect(stage.kind).toBe('wave');
    expect(stage.wave).toBe(1);
    // Unknown rather than pretended: nothing has compiled the waves yet.
    expect(stage.waves).toBe(0);
    expect(stage.label).toBe('wave 1 of ? — plan agent-loops');
  });

  it('reads the CURRENT wave from the artifact plus the rounds lineage', () => {
    const stage = deriveStage(
      input({
        state: executionState({ active_plan: 'agent-loops', active_skill: 'execute-plan' }),
        script: runScript({}),
        rounds: [phaseResult(1), phaseResult(2)],
        planDocExists: true,
      }),
    );
    expect(stage.kind).toBe('wave');
    expect(stage.wave).toBe(2);
    expect(stage.waves).toBe(3);
    expect(stage.label).toBe('wave 2 of 3 — plan agent-loops');
    expect(stage.completedPhases).toEqual([1, 2]);
    expect(stage.pendingPhases).toEqual([3, 4]);
    expect(stage.lineage).toBe(true);
  });

  it('counts a skipped phase as complete, so a skip-only wave is not re-entered', () => {
    const stage = deriveStage(
      input({
        script: runScript({ skip: [1, 2] }),
        rounds: [],
        state: executionState({ active_plan: 'agent-loops' }),
      }),
    );
    expect(stage.wave).toBe(2);
    expect(stage.completedPhases).toEqual([1, 2]);
  });

  it('reads as `review` once every phase is complete', () => {
    const stage = deriveStage(
      input({
        state: executionState({ active_plan: 'agent-loops' }),
        script: runScript({}),
        rounds: [phaseResult(1), phaseResult(2), phaseResult(3), phaseResult(4)],
      }),
    );
    expect(stage.kind).toBe('review');
    expect(stage.pendingPhases).toEqual([]);
    expect(stage.label).toBe('review — plan agent-loops');
  });

  it('trusts NO completion without planHash lineage — every phase reads pending', () => {
    const unstamped = [{ ts: 'x', run_id: 'run-1', type: 'phase_result', phase: 1, status: 'success' }];
    const stage = deriveStage(
      input({
        state: executionState({ active_plan: 'agent-loops' }),
        script: runScript({}),
        rounds: unstamped,
      }),
    );
    expect(stage.lineage).toBe(false);
    expect(stage.completedPhases).toEqual([]);
    expect(stage.wave).toBe(1);
  });

  it('ignores a `phase_result` from a run whose lineage belongs to another plan', () => {
    const foreign = [
      { ts: 'x', run_id: 'run-2', type: 'run_intent', planHash: 'b'.repeat(64) },
      { ts: 'x', run_id: 'run-2', type: 'phase_result', phase: 1, status: 'success' },
    ];
    const stage = deriveStage(
      input({ state: executionState({ active_plan: 'agent-loops' }), script: runScript({}), rounds: foreign }),
    );
    expect(stage.completedPhases).toEqual([]);
  });

  it('falls back to phase order when the artifact carries no wave grouping', () => {
    const stage = deriveStage(
      input({
        state: executionState({ active_plan: 'agent-loops' }),
        script: runScript({ phases: 3, waves: [] }),
        rounds: [phaseResult(1)],
      }),
    );
    expect(stage.wave).toBe(2);
    expect(stage.waves).toBe(3);
  });

  it('the artifact outranks STATE.md — a stale `Active Skill` cannot move the stage', () => {
    const stage = deriveStage(
      input({
        // STATE.md still says discovery; the compiled artifact says wave 2.
        state: executionState({ active_plan: 'agent-loops', active_skill: '/discovery-plan' }),
        script: runScript({}),
        rounds: [phaseResult(1), phaseResult(2)],
      }),
    );
    expect(stage.kind).toBe('wave');
    expect(stage.wave).toBe(2);
  });

  it('is a pure function — identical inputs derive identical stages', () => {
    const built = input({
      state: executionState({ active_plan: 'agent-loops' }),
      script: runScript({}),
      rounds: [phaseResult(1)],
    });
    expect(JSON.stringify(deriveStage(built))).toBe(JSON.stringify(deriveStage(built)));
  });

  it('normalizes every spelling of a plan name to the artifact key', () => {
    expect(normalizePlanName('plan_agent-loops_v1.md')).toBe('agent-loops');
    expect(normalizePlanName('plan_agent-loops_v12')).toBe('agent-loops');
    expect(normalizePlanName('agent-loops')).toBe('agent-loops');
    expect(normalizePlanName('None')).toBe('');
    expect(normalizePlanName(null)).toBe('');
    expect(normalizePlanName('   ')).toBe('');
  });

  it('reads the stage word out of however a skill wrote itself', () => {
    expect(skillStage('/execute-plan')).toBe('wave');
    expect(skillStage('execute-plan (phase 3)')).toBe('wave');
    expect(skillStage('create-plan')).toBe('plan');
    expect(skillStage('discovery-plan')).toBe('discovery');
    expect(skillStage('review-pr')).toBe('review');
    expect(skillStage('brainstorm')).toBe('');
    expect(skillStage(null)).toBe('');
  });

  it('keys each stage stably, so advancing a wave is a NEW key', () => {
    const wave2 = deriveStage(
      input({
        state: executionState({ active_plan: 'agent-loops' }),
        script: runScript({}),
        rounds: [phaseResult(1), phaseResult(2)],
      }),
    );
    const wave1 = deriveStage(
      input({ state: executionState({ active_plan: 'agent-loops' }), script: runScript({}), rounds: [] }),
    );
    expect(stageKey(wave1)).toBe('wave:agent-loops:1');
    expect(stageKey(wave2)).toBe('wave:agent-loops:2');
    expect(stageKey(idleStage())).toBe('none');
    expect(isPipelineStageKind('wave')).toBe(true);
    expect(isPipelineStageKind('nonsense')).toBe(false);
  });
});

describe('Task 5.1 — reading the inputs off disk', () => {
  const temps: string[] = [];

  function makeFlow(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-state-'));
    temps.push(dir);
    const flowDir = join(dir, 'flow');
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    mkdirSync(join(flowDir, 'discovery'), { recursive: true });
    return flowDir;
  }

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('an empty flow directory reads as nothing in flight', () => {
    expect(readStage(makeFlow()).kind).toBe('none');
  });

  it('finds the documents and the artifact for the plan STATE.md names', () => {
    const flowDir = makeFlow();
    writeFileSync(
      join(flowDir, 'STATE.md'),
      ['## Execution State', '', '- **Active Skill**: execute-plan', '- **Active Plan**: plan_agent-loops_v1', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(join(flowDir, 'discovery', 'discovery_agent-loops_v1.md'), '# d\n', 'utf-8');
    writeFileSync(join(flowDir, 'plans', 'plan_agent-loops_v1.md'), '# p\n', 'utf-8');
    writeFileSync(
      join(flowDir, 'plans', 'agent-loops.run.json'),
      JSON.stringify(runScript({})),
      'utf-8',
    );
    writeFileSync(
      join(flowDir, '.rounds.jsonl'),
      `${JSON.stringify(phaseResult(1))}\n${JSON.stringify(phaseResult(2))}\n`,
      'utf-8',
    );

    // STATE.md names the plan and everything exists on disk — and NONE of it
    // is looked up, because no claim names a pipeline (#1599: the file is the
    // interactive session's mirror; keying lookups on it handed a loop run a
    // human's half-finished execution as "wave 2 is mine to advance").
    const read = readPipelineInput(flowDir);
    expect(read.discoveryDocExists).toBe(false);
    expect(read.planDocExists).toBe(false);
    expect(read.script).toBeNull();
    expect(deriveStage(read).kind).toBe('none');

    // The identical disk, asked with the CLAIM naming the plan: everything.
    const claimed = readPipelineInput(flowDir, 'agent-loops');
    expect(claimed.discoveryDocExists).toBe(true);
    expect(claimed.planDocExists).toBe(true);
    expect(claimed.script?.plan).toBe('agent-loops');
    expect(claimed.rounds).toHaveLength(2);
    const stage = deriveStage(claimed);
    expect(stage.label).toBe('wave 2 of 3 — plan agent-loops');
    expect(stage.source).toBe('claim');
  });

  it('a plan named ONLY in STATE.md reads as no pipeline at all', () => {
    const flowDir = makeFlow();
    writeFileSync(
      join(flowDir, 'STATE.md'),
      ['## Execution State', '', '- **Active Plan**: brand-new', ''].join('\n'),
      'utf-8',
    );
    const stage = readStage(flowDir);
    expect(stage.kind).toBe('none');
    expect(stage.inFlight).toBe(false);
  });
});

// ── Phase 5.1: the claim is the handoff, with no file at all ──

/**
 * THE DEFECT THIS PLAN EXISTS FOR (#1599). Five skills were instructed to delete
 * `flow/STATE.md` on completion, so the next run asked what was in flight and
 * heard `none` while its own pipeline sat mid-execution.
 *
 * Every case below therefore writes NO `STATE.md` — not an empty one, not one
 * naming nothing. The file is absent from disk, which is the state the deleting
 * skills actually left behind, and the stage still has to come back.
 */
describe('Phase 5.1 — the claim carries the plan, with no STATE.md at all', () => {
  const temps: string[] = [];

  function makeFlow(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-claim-'));
    temps.push(dir);
    const flowDir = join(dir, 'flow');
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    mkdirSync(join(flowDir, 'discovery'), { recursive: true });
    return flowDir;
  }

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('derives the wave from the claim alone — `state` is null, as after a delete', () => {
    const stage = deriveStage(
      input({
        state: null,
        claimPlan: 'agent-loops',
        script: runScript({}),
        rounds: [phaseResult(1), phaseResult(2)],
      }),
    );
    expect(stage.kind).toBe('wave');
    expect(stage.wave).toBe(2);
    expect(stage.plan).toBe('agent-loops');
    expect(stage.inFlight).toBe(true);
    expect(stage.source).toBe('claim');
  });

  it('reads the documents off disk for a plan only the claim names', () => {
    const flowDir = makeFlow();
    // Deliberately no STATE.md: this is the post-delete filesystem.
    writeFileSync(join(flowDir, 'discovery', 'discovery_agent-loops_v1.md'), '# d\n', 'utf-8');
    writeFileSync(join(flowDir, 'plans', 'plan_agent-loops_v1.md'), '# p\n', 'utf-8');
    writeFileSync(join(flowDir, 'plans', 'agent-loops.run.json'), JSON.stringify(runScript({})), 'utf-8');
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${JSON.stringify(phaseResult(1))}\n`, 'utf-8');

    const read = readPipelineInput(flowDir, 'agent-loops');
    expect(read.state).toBeNull();
    expect(read.claimPlan).toBe('agent-loops');
    expect(read.script?.plan).toBe('agent-loops');

    const stage = deriveStage(read);
    expect(stage.label).toBe('wave 1 of 3 — plan agent-loops');
    expect(stage.source).toBe('claim');
  });

  it('accepts the claim spelled as a filename — the marker is normalized like any other name', () => {
    const flowDir = makeFlow();
    writeFileSync(join(flowDir, 'discovery', 'discovery_agent-loops_v1.md'), '# d\n', 'utf-8');
    const stage = readStage(flowDir, 'plan_agent-loops_v1.md');
    expect(stage.plan).toBe('agent-loops');
    expect(stage.kind).toBe('plan');
  });

  it('the claim OUTRANKS STATE.md — a file naming another plan cannot redirect the run', () => {
    const stage = deriveStage(
      input({
        state: executionState({ active_plan: 'some-finished-feature' }),
        claimPlan: 'agent-loops',
        script: runScript({}),
      }),
    );
    expect(stage.plan).toBe('agent-loops');
    expect(stage.source).toBe('claim');
  });

  it('with NEITHER source nothing is in flight — no document on disk is guessed at (C-2)', () => {
    const flowDir = makeFlow();
    // Two finished features sitting on disk, exactly the case C-2 rules out.
    writeFileSync(join(flowDir, 'discovery', 'discovery_old-thing_v1.md'), '# d\n', 'utf-8');
    writeFileSync(join(flowDir, 'plans', 'plan_older-thing_v1.md'), '# p\n', 'utf-8');

    const stage = readStage(flowDir, '');
    expect(stage.kind).toBe('none');
    expect(stage.plan).toBe('');
    expect(stage.source).toBe('none');
  });

  it('reads the plan back off the items the gate already listed', () => {
    const items = [
      { state: 'open', plan: 'agent-loops', claimedBy: 'run-A' },
      { state: 'open' },
    ];
    expect(claimedPlan(items, 'run-A')).toBe('agent-loops');
    // The run's OWN claim wins over a ghost another run left behind.
    expect(
      claimedPlan(
        [
          { state: 'open', plan: 'stranded', claimedBy: 'run-B' },
          { state: 'open', plan: 'agent-loops', claimedBy: 'run-A' },
        ],
        'run-A',
      ),
    ).toBe('agent-loops');
    // Two different plans and neither is mine: no answer, rather than a guess.
    expect(
      claimedPlan([
        { state: 'open', plan: 'one', claimedBy: 'run-B' },
        { state: 'open', plan: 'two', claimedBy: 'run-C' },
      ]),
    ).toBe('');
    // A closed item is not a pipeline in flight.
    expect(claimedPlan([{ state: 'closed', plan: 'agent-loops' }])).toBe('');
  });

  it('says WHERE it learned there was a pipeline', () => {
    expect(stageSourceNote('claim')).toBe('from the claim');
    expect(stageSourceNote('state')).toBe('from flow/STATE.md');
    expect(stageSourceNote('none')).toBe('');
  });
});

// ── Phase 5.2: NFR-1, every STATE.md already on disk keeps working ──

/**
 * NFR-1 is the constraint with the widest blast radius in this plan: a
 * regression here strands in-flight work in every project already using the
 * tool. So each case is a filesystem that predates `loop-plan:` entirely —
 * a `STATE.md` and no claim marker anywhere — and must resolve exactly as it
 * did before.
 */
describe('Phase 5.2 — a STATE.md with no claim marker still resolves (NFR-1)', () => {
  const temps: string[] = [];

  function makeFlow(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-comapt-'));
    temps.push(dir);
    const flowDir = join(dir, 'flow');
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    mkdirSync(join(flowDir, 'discovery'), { recursive: true });
    return flowDir;
  }

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('reports no pipeline when the claim names nothing — whatever STATE.md says', () => {
    const flowDir = makeFlow();
    writeFileSync(
      join(flowDir, 'STATE.md'),
      [
        '## Execution State',
        '',
        '- **Active Skill**: execute-plan',
        '- **Active Plan**: plan_agent-loops_v1',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(flowDir, 'plans', 'agent-loops.run.json'), JSON.stringify(runScript({})), 'utf-8');
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${JSON.stringify(phaseResult(1))}\n`, 'utf-8');

    // Called exactly as a pre-#1599 caller called it: one argument. The file
    // names a plan with a compiled artifact behind it — and none of that is a
    // pipeline, because no claim carries it. This is the windows_support
    // phantom: the interactive session's STATE.md read back as loop work.
    const stage = readStage(flowDir);
    expect(stage.kind).toBe('none');
    expect(stage.inFlight).toBe(false);
    expect(stage.source).toBe('none');
  });

  it('an explicit empty claim reads identically to no claim argument at all', () => {
    const flowDir = makeFlow();
    writeFileSync(
      join(flowDir, 'STATE.md'),
      ['## Execution State', '', '- **Active Plan**: brand-new', ''].join('\n'),
      'utf-8',
    );
    expect(JSON.stringify(readStage(flowDir, ''))).toBe(JSON.stringify(readStage(flowDir)));
  });

  it('a STATE.md naming only a skill proves nothing without a claim', () => {
    const stage = deriveStage(input({ state: executionState({ active_skill: '/review-pr' }) }));
    expect(stage.kind).toBe('none');
    expect(stage.inFlight).toBe(false);
    expect(stage.source).toBe('none');
  });

  it("the skill line refines the CLAIM's stage — review is sayable only for a claimed plan", () => {
    const stage = deriveStage(
      input({ claimPlan: 'agent-loops', state: executionState({ active_skill: 'review-pr' }) }),
    );
    expect(stage.kind).toBe('review');
    expect(stage.plan).toBe('agent-loops');
    expect(stage.source).toBe('claim');
  });

  it('every STATE.md spelling reads as `none` with no claim — the mirror never dispatches', () => {
    const cases: [Record<string, unknown>, Partial<PipelineInput>][] = [
      [{ active_plan: 'brand-new' }, {}],
      [{ active_plan: 'brand-new' }, { discoveryDocExists: true }],
      [{ active_plan: 'brand-new' }, { discoveryDocExists: true, planDocExists: true }],
      [{ active_skill: 'review-pr', active_plan: 'brand-new' }, {}],
    ];
    for (const [state, extra] of cases) {
      const stage = deriveStage(input({ state: executionState(state), claimPlan: '', ...extra }));
      expect(stage.kind).toBe('none');
      expect(stage.source).toBe('none');
    }
  });
});
