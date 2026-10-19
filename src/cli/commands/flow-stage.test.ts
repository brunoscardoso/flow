/**
 * `planflow-ai flow stage <stage> --check` — the autopilot refusal.
 *
 * In-process against a REAL temp project (the `flow.test.ts` shape), because
 * every proof this gate reads is a file on disk and a fixture that stubs the
 * readers would only prove the pure ladder again — which Phase 1's 47 tests
 * already do. What is new here is the WIRING: the adapter, the two modes, and
 * the refusal's payload.
 *
 * Refusals are asserted on the COMBINED transcript (allowed-pattern #15 — this
 * repo's logger routes `error()` through `console.log`, so a stderr-only
 * assertion passes vacuously), AND the payload is parsed by the last-parseable-
 * `{`-line rule (allowed-pattern #24), which is the rule a consumer has to use
 * because the prose follows the payload on the same stream.
 *
 * NOTHING HERE TOUCHES THIS REPOSITORY: every case runs in its own `mkdtemp`
 * project, removed afterwards.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFlow, FLOW_VERBS, isFlowVerb } = await import('./flow.js');

type FlowOptions = Parameters<typeof runFlow>[2];

interface Invocation {
  stdout: string;
  /** Everything the logger wrote. */
  logged: string[];
  /** stdout + the logger, which is what a person actually sees. */
  transcript: string;
  /** Just the refusal lines. */
  refusals: string[];
  exitCode: number;
  /** The last parseable `{` line of the combined transcript — the payload rule. */
  payload: Record<string, unknown> | null;
}

type StdoutLike = { write: (chunk: unknown) => boolean };

/**
 * The rule a real consumer uses: scan the stream for the LAST line that parses
 * as an object. Implemented here rather than assumed, so a change that puts the
 * prose before the payload fails a test instead of a user's parser.
 */
function lastParseableObject(text: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the payload line — keep scanning backwards.
    }
  }
  return null;
}

/** Call a verb in-process, capturing stdout, the logger and the exit code. */
function invoke(args: string[], options: Partial<FlowOptions> = {}): Invocation {
  const chunks: string[] = [];
  const logged: string[] = [];
  const stdout = process.stdout as unknown as StdoutLike;
  const realWrite = stdout.write;
  const realLog = console.log;
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...args_: unknown[]): void => {
    logged.push(args_.map((arg) => String(arg)).join(' '));
  };

  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    runFlow('stage', args, {
      target: tempProject,
      json: true,
      check: true,
      ...options,
    } as FlowOptions);
  } finally {
    stdout.write = realWrite;
    console.log = realLog;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previousExit;

  const text = chunks.join('');
  const transcript = [text, ...logged].join('\n');
  return {
    stdout: text,
    logged,
    transcript,
    refusals: logged.filter((line) => line.includes('flow refused:')),
    exitCode,
    payload: lastParseableObject(transcript),
  };
}

let tempProject: string;

function flowDir(): string {
  return join(tempProject, 'flow');
}

/** Write a file under `flow/`, creating its directory. */
function seed(relativePath: string, content: string): void {
  const full = join(flowDir(), relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/** A plan document the parser CAN read — `###`, with checkbox tasks. */
function parsablePlan(): string {
  return [
    '# Plan',
    '',
    '### Phase 1: Do the thing',
    '',
    '**Complexity**: 3',
    '',
    '- [ ] Task 1 — do it',
    '',
  ].join('\n');
}

/**
 * A plan document the parser CANNOT read — `##`, the shape five of this repo's
 * ten live plans use, including the one that asked for this feature.
 */
function unparsablePlan(): string {
  return [
    '# Plan',
    '',
    '## Phase 1: Do the thing',
    '',
    '**Tasks**: 1. Do it',
    '',
    '## Phase 2: Do the other thing',
    '',
  ].join('\n');
}

function roundsLine(plan: string): string {
  return `${JSON.stringify({ type: 'phase_result', plan, phase: 1, status: 'success' })}\n`;
}

/** Every file sitting in `flow/` — this verb must never add one. */
function flowTree(): string[] {
  if (!existsSync(flowDir())) return [];
  return readdirSync(flowDir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

const FEATURE = 'harness-autopilot';
const CHAIN = { chain: 'chain-2026-09-11-001' };

beforeEach(() => {
  tempProject = mkdtempSync(join(tmpdir(), 'plan-flow-flow-stage-'));
  mkdirSync(flowDir(), { recursive: true });
});

afterEach(() => {
  rmSync(tempProject, { recursive: true, force: true });
});

describe('the verb joins the family', () => {
  it('answers to stage alongside set, unset and show', () => {
    expect([...FLOW_VERBS]).toEqual([
      'set',
      'unset',
      'show',
      'stage',
      'risk',
      'pushed-through',
      'run-start',
    ]);
    expect(isFlowVerb('stage')).toBe(true);
  });

  it('refuses a stage that is not a rung of the ladder', () => {
    const result = invoke(['review-pr'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain("unknown stage 'review-pr'");
    expect(result.transcript).toContain('discovery|create-plan|execute-plan|review-code');
  });

  it('accepts the slash-command spelling the driver would pass', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const result = invoke(['/Create-Plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.stage).toMatchObject({ stage: 'create-plan', satisfied: true });
  });

  it('refuses a call with no --check, naming the shape it wanted', () => {
    const result = invoke([], { feature: FEATURE, check: false });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain('flow stage <stage> --check --feature <slug>');
  });

  it('refuses a call with no --feature — an unscoped proof is a gate that is always open', () => {
    const result = invoke(['create-plan'], { ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('stage needs --feature <slug>');
  });

  it('carries the refusal prefix exactly once', () => {
    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0].match(/flow refused:/g)).toHaveLength(1);
  });
});

describe('every edge refuses with its own reason', () => {
  it('refuses create-plan when this feature has no discovery', () => {
    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain('discovery has left no proof');
    expect(result.payload).toMatchObject({
      refused: 'predecessor-missing',
      verb: 'stage',
      stage: 'create-plan',
      previous: 'discovery',
      feature: FEATURE,
      expected: `discovery/discovery_${FEATURE}_v<N>.md`,
      found: null,
    });
  });

  it('refuses execute-plan when this feature has no plan at all', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const result = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('create-plan has left no proof');
    expect(result.payload).toMatchObject({
      refused: 'predecessor-missing',
      previous: 'create-plan',
      expected: `plans/plan_${FEATURE}_v<N>.md`,
    });
  });

  it('refuses review-code when no phase of this feature ever ran', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    seed(`plans/plan_${FEATURE}_v1.md`, parsablePlan());
    const result = invoke(['review-code'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('execute-plan has left no proof');
    expect(result.payload).toMatchObject({
      refused: 'predecessor-missing',
      previous: 'execute-plan',
      expected: `.rounds.jsonl (phase_result with plan ${FEATURE})`,
    });
  });

  it('never refuses discovery — it is the bottom rung', () => {
    const result = invoke(['discovery'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.stage).toMatchObject({
      stage: 'discovery',
      previous: null,
      satisfied: true,
      expected: null,
      diagnostic: null,
    });
  });
});

describe('a satisfied edge is silent', () => {
  it('lets create-plan run once a discovery document exists', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.refusals).toEqual([]);
    expect(result.payload?.stage).toMatchObject({
      satisfied: true,
      reason: null,
      found: `discovery/discovery_${FEATURE}_v1.md`,
    });
  });

  it('lets execute-plan run once a plan PARSES', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    seed(`plans/plan_${FEATURE}_v1.md`, parsablePlan());
    const result = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.stage).toMatchObject({ satisfied: true, previous: 'create-plan' });
  });

  it('lets review-code run once a phase_result names this feature', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    seed(`plans/plan_${FEATURE}_v1.md`, parsablePlan());
    seed('.rounds.jsonl', roundsLine(FEATURE));
    const result = invoke(['review-code'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.stage).toMatchObject({
      satisfied: true,
      done: ['discovery', 'create-plan', 'execute-plan'],
      next: 'review-code',
    });
  });

  it('counts a FAILED phase — the stage ran, and that changeset is worth reviewing', () => {
    seed('.rounds.jsonl', `${JSON.stringify({ type: 'phase_result', plan: FEATURE, status: 'failed' })}\n`);
    const result = invoke(['review-code'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(0);
  });
});

describe('a plan that is there and cannot be read is a DIFFERENT refusal', () => {
  it('says the document could not be read, not that there is none', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    seed(`plans/plan_${FEATURE}_v1.md`, unparsablePlan());
    const result = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });

    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({
      refused: 'predecessor-unreadable',
      previous: 'create-plan',
      found: `plans/plan_${FEATURE}_v1.md`,
    });
    expect(result.transcript).toContain('could not be read as a plan');
    expect(result.transcript).not.toContain('has left no proof');
  });

  it("carries whyNoPhases's author-actionable sentence, not a generic complaint", () => {
    seed(`plans/plan_${FEATURE}_v1.md`, unparsablePlan());
    const result = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });
    const diagnosis = String((result.payload as { diagnosis?: unknown }).diagnosis);
    expect(diagnosis).toContain('2 phase heading(s) are `##`');
    expect(diagnosis).toContain('exactly three hashes');
    expect(result.transcript).toContain('exactly three hashes');
  });
});

describe('the proofs are bound to THIS feature', () => {
  it("another feature's artifacts satisfy nothing", () => {
    seed('discovery/discovery_some-other-feature_v1.md', '# Discovery\n');
    seed('plans/plan_some-other-feature_v1.md', parsablePlan());
    seed('.rounds.jsonl', roundsLine('some-other-feature'));

    for (const stage of ['create-plan', 'execute-plan', 'review-code']) {
      const result = invoke([stage], { feature: FEATURE, ...CHAIN });
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({ refused: 'predecessor-missing' });
      expect(result.payload?.done).toEqual([]);
    }
  });

  it('treats a slug as a NAME — a regex-ish feature does not widen the gate', () => {
    seed('discovery/discovery_aXb_v1.md', '# Discovery\n');
    const result = invoke(['create-plan'], { feature: 'a.b', ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'predecessor-missing' });
  });
});

describe('enforcement belongs to the enforced run', () => {
  it('never refuses a manual call, even with every proof missing', () => {
    for (const stage of ['create-plan', 'execute-plan', 'review-code']) {
      const result = invoke([stage], { feature: FEATURE });
      expect(result.exitCode).toBe(0);
      expect(result.refusals).toEqual([]);
      expect(result.payload?.stage).toMatchObject({
        satisfied: false,
        mode: 'reporting',
        chain: null,
      });
    }
  });

  it('computes the SAME verdict in both modes — only the exit differs', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    seed(`plans/plan_${FEATURE}_v1.md`, unparsablePlan());

    const manual = invoke(['execute-plan'], { feature: FEATURE });
    const driven = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });

    expect(manual.exitCode).toBe(0);
    expect(driven.exitCode).toBe(1);
    for (const field of ['reason', 'message', 'expected', 'found', 'diagnosis', 'previous']) {
      expect((manual.payload?.stage as Record<string, unknown>)[field]).toEqual(
        (driven.payload as Record<string, unknown>)[field],
      );
    }
  });

  it('prints what would satisfy the rung when the message names the artifact found', () => {
    seed(`plans/plan_${FEATURE}_v1.md`, unparsablePlan());
    const result = invoke(['execute-plan'], { feature: FEATURE, json: false });
    expect(result.stdout).toContain(`  expected: plans/plan_${FEATURE}_v<N>.md`);
    expect(result.stdout).toContain('could not be read as a plan');
  });

  it('reports rather than enforces when --chain is blank, so a caller bug is visible', () => {
    const result = invoke(['create-plan'], { feature: FEATURE, chain: '   ' });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.stage).toMatchObject({ mode: 'reporting', chain: null });
  });

  it('says out loud that nothing was refused, in the human rendering', () => {
    const result = invoke(['create-plan'], { feature: FEATURE, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('nothing was refused — no chain is driving this call');
    // The sentence already names the path, so the `expected:` line does not
    // repeat it — it appears only when the message names the artifact FOUND.
    expect(result.stdout).toContain(`expected discovery/discovery_${FEATURE}_v<N>.md`);
    expect(result.stdout).not.toContain('  expected: discovery/');
  });
});

describe('the payload', () => {
  it('parses by the last-parseable-object rule, with the prose after it', () => {
    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    // The payload is on stdout; the refusal line follows on the same stream.
    expect(lastParseableObject(result.stdout)).not.toBeNull();
    expect(result.payload?.refused).toBe('predecessor-missing');
    const proseIndex = result.transcript.indexOf('flow refused:');
    const payloadIndex = result.transcript.indexOf('{"refused"');
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(proseIndex).toBeGreaterThan(payloadIndex);
  });

  it('keeps the module paths behind `diagnostic`, away from what a GUI renders', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const result = invoke(['execute-plan'], { feature: FEATURE, ...CHAIN });
    const payload = result.payload as Record<string, unknown>;
    const diagnostic = payload.diagnostic as Record<string, unknown>;

    expect(diagnostic.module).toBe('src/cli/state/plan-parser.ts');
    expect(diagnostic.proofKind).toBe('parse');
    expect(diagnostic.proofStrength).toBe('strong');
    for (const field of ['message', 'expected', 'found', 'diagnosis']) {
      expect(String(payload[field] ?? '')).not.toContain('src/cli/');
    }
  });

  it('carries the ladder alongside the refusal, so the asker sees where they are', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const result = invoke(['review-code'], { feature: FEATURE, ...CHAIN });
    expect(result.payload).toMatchObject({
      done: ['discovery'],
      next: 'create-plan',
      mode: 'enforced',
      chain: CHAIN.chain,
    });
  });
});

describe('the gate is read-only', () => {
  it('writes nothing — not on the success path and not on the refusal', () => {
    seed(`discovery/discovery_${FEATURE}_v1.md`, '# Discovery\n');
    const before = flowTree();
    invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    invoke(['review-code'], { feature: FEATURE, ...CHAIN });
    expect(flowTree()).toEqual(before);
  });

  it('the plan edge, end to end: refused for want of a discovery, and no plan on disk', () => {
    // The scenario Task 6.3 names, rather than the mechanism the case above
    // proves: a chain reaches `/create-plan` in a project where nothing ran a
    // discovery. The edge refuses, and `flow/plans/` is exactly as empty
    // afterwards as it was before — the refusal is what stands between the
    // chain and a plan built on nothing.
    expect(flowTree()).toEqual([]);

    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.payload).toMatchObject({ refused: 'predecessor-missing', stage: 'create-plan' });
    expect(existsSync(join(flowDir(), 'plans'))).toBe(false);
    expect(flowTree()).toEqual([]);
  });

  it('is fail-soft on a project with no flow directory at all', () => {
    rmSync(flowDir(), { recursive: true, force: true });
    const result = invoke(['create-plan'], { feature: FEATURE, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'predecessor-missing' });
    expect(existsSync(flowDir())).toBe(false);
  });
});
