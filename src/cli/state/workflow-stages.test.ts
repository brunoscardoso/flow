/**
 * Tests for the workflow ladder (pure).
 *
 * Two things here are the point of the phase rather than mechanics:
 *
 * 1. FEATURE SCOPING. `a project full of another feature's artifacts` and the
 *    mixed-rounds case reproduce the bug that made the ladder useless on this
 *    repo — ten discovery documents, ten plans, eleven reviews and another
 *    plan's `phase_result` entries reported a fresh chain finished, so the
 *    refusal could never fire. Those tests fail against an unscoped ladder.
 * 2. STRENGTH. Two of the four proofs are file presence, and a consumer must be
 *    able to see that from what this module reports.
 *
 * Everything else is ladder mechanics — every rung of `nextStage`, a gap in the
 * MIDDLE (the case a set difference gets wrong), an empty project, a finished
 * chain, both ends of `previousStage`, and `stageOf` for the command spellings.
 * `stagesCompleted` is driven entirely through fake deps: the suite touches no
 * filesystem, because the module cannot.
 */

import type { PlanPhase } from './types.js';
import type { RoundsEntry } from './rounds-reader.js';
import {
  WORKFLOW_STAGES,
  escapeFeatureForPattern,
  filenamePatternFor,
  nextStage,
  previousStage,
  proofDescriptionFor,
  proofOf,
  stageOf,
  stagesCompleted,
  stagesCompletedForAnyFeature,
  type StageProofDeps,
  type WorkflowStage,
} from './workflow-stages.js';

const PLAN_PHASE: PlanPhase = {
  number: 1,
  name: 'One',
  complexity: 3,
  dependencies: [],
  tasks: [],
};

const OURS = 'harness-autopilot';
const THEIRS = 'worktree-ui-removal';

interface FakeWorld {
  files?: Record<string, string[]>;
  rounds?: RoundsEntry[];
  /** Filenames that parse to real phases. Anything else parses to nothing. */
  parsablePlans?: string[];
  /** Filenames that cannot be read at all (parser throws → adapter returns null). */
  unreadablePlans?: string[];
}

function fakeDeps(world: FakeWorld = {}): StageProofDeps {
  return {
    listFiles: (dir) => world.files?.[dir] ?? [],
    readRounds: () => world.rounds ?? [],
    parsePlan: (filename) => {
      if (world.unreadablePlans?.includes(filename)) return null;
      return world.parsablePlans?.includes(filename) ? [PLAN_PHASE] : [];
    },
  };
}

/** Every rung answered, for `feature`. */
function completeWorld(feature: string): FakeWorld {
  return {
    files: {
      discovery: [`discovery_${feature}_v1.md`],
      plans: [`plan_${feature}_v1.md`],
      'reviewed-code': [`review_${feature}.md`],
    },
    parsablePlans: [`plan_${feature}_v1.md`],
    rounds: [{ type: 'phase_result', plan: feature, phase: 1, status: 'success' }],
  };
}

describe('the ladder', () => {
  it('is the four stages in chain order', () => {
    expect(WORKFLOW_STAGES).toEqual(['discovery', 'create-plan', 'execute-plan', 'review-code']);
  });
});

describe('nextStage', () => {
  it('starts at discovery when nothing is done', () => {
    expect(nextStage([])).toBe('discovery');
  });

  it('walks every rung in order', () => {
    expect(nextStage(['discovery'])).toBe('create-plan');
    expect(nextStage(['discovery', 'create-plan'])).toBe('execute-plan');
    expect(nextStage(['discovery', 'create-plan', 'execute-plan'])).toBe('review-code');
  });

  it('returns null when the chain is finished', () => {
    expect(nextStage([...WORKFLOW_STAGES])).toBeNull();
  });

  it('returns the GAP, not the rung after the highest done stage', () => {
    // execute-plan left a trace but nobody planned: the chain goes back, it
    // does not step over the hole.
    expect(nextStage(['discovery', 'execute-plan'])).toBe('create-plan');
    expect(nextStage(['review-code'])).toBe('discovery');
    expect(nextStage(['discovery', 'create-plan', 'review-code'])).toBe('execute-plan');
  });

  it('ignores order in the input — only membership counts', () => {
    expect(nextStage(['create-plan', 'discovery'])).toBe('execute-plan');
  });
});

describe('previousStage', () => {
  it('is null at the bottom of the ladder', () => {
    expect(previousStage('discovery')).toBeNull();
  });

  it('names the edge a refusal guards', () => {
    expect(previousStage('create-plan')).toBe('discovery');
    expect(previousStage('execute-plan')).toBe('create-plan');
    expect(previousStage('review-code')).toBe('execute-plan');
  });
});

describe('stageOf', () => {
  it('maps every command spelling to its stage', () => {
    expect(stageOf('discovery-plan')).toBe('discovery');
    expect(stageOf('discovery')).toBe('discovery');
    expect(stageOf('create-plan')).toBe('create-plan');
    expect(stageOf('execute-plan')).toBe('execute-plan');
    expect(stageOf('review-code')).toBe('review-code');
  });

  it('tolerates the leading slash, whitespace and case', () => {
    expect(stageOf('/create-plan')).toBe('create-plan');
    expect(stageOf('/discovery-plan')).toBe('discovery');
    expect(stageOf('  /review-code  ')).toBe('review-code');
    expect(stageOf('/Execute-Plan')).toBe('execute-plan');
  });

  it('returns null for anything that is not a rung', () => {
    expect(stageOf('/review-pr')).toBeNull();
    expect(stageOf('brainstorm')).toBeNull();
    expect(stageOf('/write-tests')).toBeNull();
    expect(stageOf('')).toBeNull();
    expect(stageOf('creat-plan')).toBeNull();
  });
});

describe('proofOf', () => {
  it('describes proofs without reading anything', () => {
    const discovery = proofOf('discovery');
    expect(discovery.kind).toBe('file-presence');
    if (discovery.kind !== 'rounds') {
      expect(discovery.dir).toBe('discovery');
      expect(discovery.filenameShape).toBe('discovery_<feature>_v<N>.md');
    }

    const plan = proofOf('create-plan');
    expect(plan.kind).toBe('parse');
    if (plan.kind === 'parse') {
      expect(plan.dir).toBe('plans');
      expect(plan.parser).toBe('src/cli/state/plan-parser.ts');
    }

    const execute = proofOf('execute-plan');
    expect(execute.kind).toBe('rounds');
    if (execute.kind === 'rounds') {
      expect(execute.file).toBe('.rounds.jsonl');
      expect(execute.entryType).toBe('phase_result');
      expect(execute.scopeField).toBe('plan');
    }

    expect(proofOf('review-code').kind).toBe('file-presence');
  });

  it('marks presence-only proofs weak and content-read proofs strong', () => {
    expect(proofOf('discovery').strength).toBe('weak');
    expect(proofOf('review-code').strength).toBe('weak');
    expect(proofOf('create-plan').strength).toBe('strong');
    expect(proofOf('execute-plan').strength).toBe('strong');
  });

  it('keeps the loose any-feature pattern, conspicuously named', () => {
    const discovery = proofOf('discovery');
    if (discovery.kind === 'rounds') throw new Error('unreachable');
    expect(discovery.anyFeaturePattern.test('discovery_anything-at-all_v9.md')).toBe(true);
    expect(discovery.anyFeaturePattern.test('notes.md')).toBe(false);
  });
});

describe('filenamePatternFor', () => {
  it('binds each file proof to one feature', () => {
    const discovery = filenamePatternFor('discovery', OURS);
    expect(discovery?.test(`discovery_${OURS}_v1.md`)).toBe(true);
    expect(discovery?.test(`discovery_${OURS}_v12.md`)).toBe(true);
    expect(discovery?.test(`discovery_${THEIRS}_v1.md`)).toBe(false);

    const plan = filenamePatternFor('create-plan', OURS);
    expect(plan?.test(`plan_${OURS}_v2.md`)).toBe(true);
    expect(plan?.test(`plan_${THEIRS}_v1.md`)).toBe(false);

    const review = filenamePatternFor('review-code', OURS);
    expect(review?.test(`review_${OURS}.md`)).toBe(true);
    expect(review?.test(`review_${THEIRS}.md`)).toBe(false);
  });

  it('does not let one feature slug prefix-match another', () => {
    const plan = filenamePatternFor('create-plan', 'worktree-mode');
    expect(plan?.test('plan_worktree-mode_v1.md')).toBe(true);
    expect(plan?.test('plan_worktree-mode-extra_v1.md')).toBe(false);
    expect(plan?.test('plan_pre-worktree-mode_v1.md')).toBe(false);
  });

  it('does not normalize separators — hyphens and underscores are both real', () => {
    const underscored = filenamePatternFor('review-code', 'file_explorer_content_search');
    expect(underscored?.test('review_file_explorer_content_search.md')).toBe(true);
    expect(underscored?.test('review_file-explorer-content-search.md')).toBe(false);

    const hyphenated = filenamePatternFor('review-code', 'file-explorer-content-search');
    expect(hyphenated?.test('review_file_explorer_content_search.md')).toBe(false);
  });

  it('treats regex-special characters in a slug as literal text', () => {
    const dotted = filenamePatternFor('discovery', 'api.v2');
    expect(dotted?.test('discovery_api.v2_v1.md')).toBe(true);
    // Without escaping, `.` is a wildcard and this would pass.
    expect(dotted?.test('discovery_apiXv2_v1.md')).toBe(false);

    const plussed = filenamePatternFor('review-code', 'a+b');
    expect(plussed?.test('review_a+b.md')).toBe(true);
    expect(plussed?.test('review_ab.md')).toBe(false);
    expect(plussed?.test('review_aaab.md')).toBe(false);

    const starred = filenamePatternFor('review-code', 'x*');
    expect(starred?.test('review_x*.md')).toBe(true);
    expect(starred?.test('review_xxxx.md')).toBe(false);
  });

  it('is null for the one stage whose proof is not a file', () => {
    expect(filenamePatternFor('execute-plan', OURS)).toBeNull();
  });

  it('refuses an empty feature instead of matching loosely', () => {
    expect(() => filenamePatternFor('discovery', '')).toThrow(/needs a feature/);
    expect(() => filenamePatternFor('discovery', '   ')).toThrow(/needs a feature/);
  });
});

describe('escapeFeatureForPattern', () => {
  it('leaves the separators real slugs use alone', () => {
    expect(escapeFeatureForPattern('worktree-ui-removal')).toBe('worktree-ui-removal');
    expect(escapeFeatureForPattern('file_explorer_content_search')).toBe(
      'file_explorer_content_search',
    );
  });

  it('escapes what would otherwise be pattern syntax', () => {
    expect(new RegExp(`^${escapeFeatureForPattern('a.b+c')}$`).test('a.b+c')).toBe(true);
    expect(new RegExp(`^${escapeFeatureForPattern('a.b+c')}$`).test('aXbbc')).toBe(false);
  });
});

describe('proofDescriptionFor', () => {
  it('names what the refusal looked for, per stage', () => {
    expect(proofDescriptionFor('discovery', OURS)).toBe(
      'discovery/discovery_harness-autopilot_v<N>.md',
    );
    expect(proofDescriptionFor('create-plan', OURS)).toBe('plans/plan_harness-autopilot_v<N>.md');
    expect(proofDescriptionFor('review-code', OURS)).toBe(
      'reviewed-code/review_harness-autopilot.md',
    );
    expect(proofDescriptionFor('execute-plan', OURS)).toBe(
      '.rounds.jsonl (phase_result with plan harness-autopilot)',
    );
  });

  it('refuses an empty feature', () => {
    expect(() => proofDescriptionFor('discovery', '')).toThrow(/needs a feature/);
  });
});

describe('stagesCompleted', () => {
  it('finds nothing in an empty project and points at discovery', () => {
    const result = stagesCompleted(fakeDeps(), { feature: OURS });
    expect(result.done).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.next).toBe('discovery');
    expect(result.feature).toBe(OURS);
    expect(result.nearMisses).toEqual([]);
  });

  it('finds every rung for our feature and has nowhere to go', () => {
    const result = stagesCompleted(fakeDeps(completeWorld(OURS)), { feature: OURS });
    expect(result.done).toEqual(['discovery', 'create-plan', 'execute-plan', 'review-code']);
    expect(result.next).toBeNull();
  });

  // ── The bug this scoping exists to fix ─────────────────────────────────────

  it('reports NOTHING done when the project is full of another feature only', () => {
    const result = stagesCompleted(fakeDeps(completeWorld(THEIRS)), { feature: OURS });
    expect(result.done).toEqual([]);
    expect(result.next).toBe('discovery');
  });

  it('reports nothing done against a whole repo of other features', () => {
    // The real shape of this project: many documents, none of them ours.
    const world: FakeWorld = {
      files: {
        discovery: [
          'discovery_board-column-collapse_v1.md',
          'discovery_worktree-mode_v1.md',
          'discovery_worktree-ui-removal_v1.md',
          'discovery_shared-ide-assets_v1.md',
        ],
        plans: [
          'plan_board-column-collapse_v1.md',
          'plan_shared-ide-assets_v2.md',
          'plan_worktree-ui-removal_v1.md',
        ],
        'reviewed-code': [
          'review_agent-change-review.md',
          'review_worktree-implementation.md',
          'review_file_explorer_content_search.md',
        ],
      },
      parsablePlans: [
        'plan_board-column-collapse_v1.md',
        'plan_shared-ide-assets_v2.md',
        'plan_worktree-ui-removal_v1.md',
      ],
      rounds: [
        { type: 'run_intent', plan: 'worktree-ui-removal' },
        { type: 'phase_result', plan: 'worktree-ui-removal', phase: 1, status: 'success' },
        { type: 'phase_result', plan: 'worktree-ui-removal', phase: 2, status: 'success' },
      ],
    };
    const result = stagesCompleted(fakeDeps(world), { feature: OURS });
    expect(result.done).toEqual([]);
    expect(result.next).toBe('discovery');
  });

  it('counts only our plan name in a rounds file holding two', () => {
    const rounds: RoundsEntry[] = [
      { type: 'phase_result', plan: THEIRS, phase: 1, status: 'success' },
      { type: 'phase_result', plan: THEIRS, phase: 2, status: 'success' },
    ];
    expect(stagesCompleted(fakeDeps({ rounds }), { feature: OURS }).done).toEqual([]);

    rounds.push({ type: 'phase_result', plan: OURS, phase: 1, status: 'partial' });
    const result = stagesCompleted(fakeDeps({ rounds }), { feature: OURS });
    expect(result.done).toEqual(['execute-plan']);
    expect(result.evidence[0].detail).toBe('.rounds.jsonl (phase_result with plan harness-autopilot)');
  });

  it('does not count a run_intent for our feature — only a phase_result', () => {
    // The live state of this repo when the amendment was written: our plan had
    // an intent recorded and no phase had run.
    const result = stagesCompleted(
      fakeDeps({
        files: { discovery: [`discovery_${OURS}_v1.md`], plans: [`plan_${OURS}_v1.md`] },
        parsablePlans: [`plan_${OURS}_v1.md`],
        rounds: [
          { type: 'run_intent', plan: OURS },
          { type: 'phase_result', plan: THEIRS, phase: 1, status: 'success' },
        ],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['discovery', 'create-plan']);
    expect(result.next).toBe('execute-plan');
  });

  it('does not let another feature satisfy a rung in the middle', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: {
          discovery: [`discovery_${OURS}_v1.md`],
          plans: [`plan_${THEIRS}_v1.md`],
          'reviewed-code': [`review_${OURS}.md`],
        },
        parsablePlans: [`plan_${THEIRS}_v1.md`],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['discovery', 'review-code']);
    expect(result.next).toBe('create-plan');
  });

  it('refuses an empty feature rather than answering the loose question', () => {
    expect(() => stagesCompleted(fakeDeps(completeWorld(THEIRS)), { feature: '' })).toThrow(
      /needs a feature/,
    );
  });

  // ── Strength ───────────────────────────────────────────────────────────────

  it('reports the two weak proofs as weak — presence is not parse', () => {
    const { evidence } = stagesCompleted(fakeDeps(completeWorld(OURS)), { feature: OURS });
    const byStage = new Map(evidence.map((e) => [e.stage, e]));

    expect(byStage.get('discovery')).toMatchObject({
      kind: 'file-presence',
      strength: 'weak',
      detail: `discovery/discovery_${OURS}_v1.md`,
    });
    expect(byStage.get('review-code')).toMatchObject({
      kind: 'file-presence',
      strength: 'weak',
      detail: `reviewed-code/review_${OURS}.md`,
    });
    expect(byStage.get('create-plan')).toMatchObject({ kind: 'parse', strength: 'strong' });
    expect(byStage.get('execute-plan')).toMatchObject({ kind: 'rounds', strength: 'strong' });

    // The distinction is visible without knowing which stage is which.
    const weak = evidence.filter((e) => e.strength === 'weak').map((e) => e.stage);
    expect(weak).toEqual<WorkflowStage[]>(['discovery', 'review-code']);
  });

  // ── Proof mechanics ────────────────────────────────────────────────────────

  it('accepts an EMPTY discovery file — presence is the whole proof, on purpose', () => {
    const result = stagesCompleted(
      fakeDeps({ files: { discovery: [`discovery_${OURS}_v1.md`] } }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['discovery']);
    expect(result.next).toBe('create-plan');
  });

  it('ignores files in the right directory with the wrong shape', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: {
          discovery: ['README.md', `discovery_${OURS}.md`, `discovery_${OURS}_v.md`],
          'reviewed-code': ['pr_12.md', `review_${OURS}_v1.md`],
        },
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual([]);
  });

  it('refuses a plan file that does not parse as a plan', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: { discovery: [`discovery_${OURS}_v1.md`], plans: [`plan_${OURS}_v1.md`] },
        parsablePlans: [],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['discovery']);
    expect(result.next).toBe('create-plan');
  });

  it('reports the unparsable plan as a near miss, not as an absent plan', () => {
    // Live on this repo: 5 of 10 plan documents head their phases `## Phase N`
    // and the parser wants `### Phase N`, so a real plan proves nothing. The
    // refusal must be able to say the document is THERE and unreadable.
    const result = stagesCompleted(
      fakeDeps({ files: { plans: [`plan_${OURS}_v1.md`] }, parsablePlans: [] }),
      { feature: OURS },
    );
    expect(result.done).toEqual([]);
    expect(result.nearMisses).toEqual([
      {
        stage: 'create-plan',
        detail: `plans/plan_${OURS}_v1.md`,
        why: 'the document was read but no phase in it could be understood',
      },
    ]);
  });

  it('refuses a plan file the parser cannot read at all', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: { plans: [`plan_${OURS}_v1.md`] },
        unreadablePlans: [`plan_${OURS}_v1.md`],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual([]);
    expect(result.nearMisses).toEqual([
      {
        stage: 'create-plan',
        detail: `plans/plan_${OURS}_v1.md`,
        why: 'the document could not be read',
      },
    ]);
  });

  it('records no near miss for another feature\'s unparsable plan', () => {
    const result = stagesCompleted(
      fakeDeps({ files: { plans: [`plan_${THEIRS}_v1.md`] }, parsablePlans: [] }),
      { feature: OURS },
    );
    expect(result.nearMisses).toEqual([]);
  });

  it('records no near miss once a later candidate parses', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: { plans: [`plan_${OURS}_v1.md`, `plan_${OURS}_v2.md`] },
        parsablePlans: [`plan_${OURS}_v1.md`],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['create-plan']);
    expect(result.nearMisses).toEqual([]);
  });

  it('accepts any parsable version among our own candidates', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: { plans: [`plan_${OURS}_v1.md`, `plan_${OURS}_v2.md`, `plan_${THEIRS}_v1.md`] },
        parsablePlans: [`plan_${OURS}_v2.md`, `plan_${THEIRS}_v1.md`],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['create-plan']);
    expect(result.evidence[0].detail).toBe(`plans/plan_${OURS}_v2.md`);
  });

  it('counts a failed phase_result — the question is whether it RAN', () => {
    const result = stagesCompleted(
      fakeDeps({ rounds: [{ type: 'phase_result', plan: OURS, phase: 2, status: 'failure' }] }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['execute-plan']);
    expect(result.evidence[0]).toMatchObject({ strength: 'strong', kind: 'rounds' });
  });

  it('does not count other rounds entry types', () => {
    const result = stagesCompleted(
      fakeDeps({
        rounds: [
          { type: 'run_intent', run_id: 'r1', plan: OURS },
          { type: 'verification', phase: 1, status: 'success', plan: OURS },
          { type: 'risk', status: 'low', plan: OURS },
        ],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual([]);
    expect(result.next).toBe('discovery');
  });

  it('reports a middle gap through next, not the highest rung reached', () => {
    const result = stagesCompleted(
      fakeDeps({
        files: { discovery: [`discovery_${OURS}_v1.md`] },
        rounds: [{ type: 'phase_result', plan: OURS, phase: 1, status: 'success' }],
      }),
      { feature: OURS },
    );
    expect(result.done).toEqual(['discovery', 'execute-plan']);
    expect(result.next).toBe('create-plan');
  });
});

describe('stagesCompletedForAnyFeature', () => {
  it('answers the LOOSE question, and is provably a different answer', () => {
    const deps = fakeDeps(completeWorld(THEIRS));

    const scoped = stagesCompleted(deps, { feature: OURS });
    const loose = stagesCompletedForAnyFeature(deps);

    // Same project, same deps, opposite verdicts — which is exactly why the
    // loose path may never be what a refusal reads.
    expect(scoped.done).toEqual([]);
    expect(loose.done).toEqual(['discovery', 'create-plan', 'execute-plan', 'review-code']);
    expect(scoped.next).toBe('discovery');
    expect(loose.next).toBeNull();
  });

  it('records that no feature was asked about', () => {
    expect(stagesCompletedForAnyFeature(fakeDeps()).feature).toBeNull();
    expect(stagesCompleted(fakeDeps(), { feature: OURS }).feature).toBe(OURS);
  });

  it('still reports strength honestly', () => {
    const { evidence } = stagesCompletedForAnyFeature(fakeDeps(completeWorld(THEIRS)));
    const weak = evidence.filter((e) => e.strength === 'weak').map((e) => e.stage);
    expect(weak).toEqual<WorkflowStage[]>(['discovery', 'review-code']);
  });
});
