/**
 * `planflow-ai flow risk` — the high-risk publish gate (`--check`) and the ONE
 * writer of the assessment it reads (`--record`), plus `flow pushed-through`,
 * the one writer of the record that says an enforced run went past a stop it
 * used to honour.
 *
 * THE CASE THIS FILE EXISTS FOR IS THE DECOY (#1915 C1): an honest `high` plus
 * one appended line naming a feature that does not exist used to turn exit 1
 * into exit 0, live. An enforced call now reads only what its own chain
 * recorded, so the fixtures below are chain-stamped and the unstamped ones are
 * the regression rather than the norm.
 *
 * In-process against a REAL temp project (the `flow-stage.test.ts` shape),
 * because what is new here is the WIRING: the two scopes, the two modes, and the
 * refusal's payload. The pure reading is proved in `state/risk-record.test.ts`.
 *
 * Refusals are asserted on the COMBINED transcript (allowed-pattern #15 — this
 * repo's logger routes `error()` through `console.log`, so a stderr-only
 * assertion passes vacuously), AND the payload is parsed by the
 * last-parseable-`{`-line rule (allowed-pattern #24), which is the rule a
 * consumer has to use because the prose follows the payload on the same stream.
 *
 * NOTHING HERE TOUCHES THIS REPOSITORY: every case runs in its own `mkdtemp`
 * project, removed afterwards.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  transcript: string;
  refusals: string[];
  exitCode: number;
  payload: Record<string, unknown> | null;
}

type StdoutLike = { write: (chunk: unknown) => boolean };

/** The rule a real consumer uses: the LAST line of the stream that parses. */
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

function invoke(verb: string, args: string[], options: Partial<FlowOptions> = {}): Invocation {
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
    runFlow(verb, args, { target: tempProject, json: true, ...options } as FlowOptions);
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

const OURS = 'harness-autopilot';
const THEIRS = 'worktree-ui-removal';
const CHAIN = { chain: 'chain-2026-09-11-001' };

function appendRound(entry: Record<string, unknown>): void {
  const file = join(flowDir(), '.rounds.jsonl');
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  writeFileSync(file, `${existing}${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * A risk entry as it lands on disk.
 *
 * `chain` defaults to the chain every enforced case here is driven by, because
 * that is what `flow risk --record --chain <id>` writes and what an enforced
 * gate will read. A case that wants the OTHER shapes — unstamped, or stamped by
 * a neighbouring run — says so, and those cases are the regression.
 */
function riskEntry(
  plan: string,
  level: string,
  ts: string,
  chain: string | null = CHAIN.chain,
): Record<string, unknown> {
  return {
    ts,
    run_id: `${plan}-20260911-120000`,
    type: 'risk',
    phase: null,
    plan,
    risk_level: level,
    risk_rationale: `${level} because the changeset says so`,
    chain,
  };
}

function rounds(): Record<string, unknown>[] {
  const file = join(flowDir(), '.rounds.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every file sitting in `flow/` — the gate must never add one. */
function flowTree(): string[] {
  if (!existsSync(flowDir())) return [];
  return readdirSync(flowDir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

beforeEach(() => {
  tempProject = mkdtempSync(join(tmpdir(), 'plan-flow-flow-risk-'));
  mkdirSync(flowDir(), { recursive: true });
});

afterEach(() => {
  rmSync(tempProject, { recursive: true, force: true });
});

describe('the verbs join the family', () => {
  it('answers to risk and pushed-through alongside the rest', () => {
    expect([...FLOW_VERBS]).toEqual([
      'set',
      'unset',
      'show',
      'stage',
      'risk',
      'pushed-through',
      'run-start',
    ]);
    expect(isFlowVerb('risk')).toBe(true);
    expect(isFlowVerb('pushed-through')).toBe(true);
  });

  it('refuses a risk call with no scope — an unscoped read is the open gate', () => {
    const result = invoke('risk', [], { check: true, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain('needs a scope');
  });

  it('refuses a risk call carrying both scopes', () => {
    const result = invoke('risk', [], {
      check: true,
      feature: OURS,
      since: '2026-09-11T00:00:00Z',
      ...CHAIN,
    });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('one scope, not both');
  });

  it('refuses a risk call without --check, rather than assuming it', () => {
    const result = invoke('risk', [], { feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('takes --check');
  });
});

describe('a low or medium assessment lets the publish go ahead', () => {
  it.each(['low', 'medium'])('%s is satisfied, enforced or not', (level) => {
    appendRound(riskEntry(OURS, level, '2026-09-11T10:00:00Z'));
    for (const options of [{}, CHAIN]) {
      const result = invoke('risk', [], { check: true, feature: OURS, ...options });
      expect(result.exitCode).toBe(0);
      expect(result.payload?.risk).toMatchObject({ satisfied: true, level, reason: null });
    }
  });
});

describe('a high assessment stops an enforced run before it publishes', () => {
  beforeEach(() => {
    appendRound(riskEntry(OURS, 'high', '2026-09-11T10:00:00Z'));
  });

  it('refuses with the family line, exit 1, and the payload first on stdout', () => {
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain('rated high risk');
    expect(result.payload).toMatchObject({
      refused: 'risk-high',
      verb: 'risk',
      satisfied: false,
      level: 'high',
      feature: OURS,
      mode: 'enforced',
      chain: CHAIN.chain,
    });
  });

  it('carries its own answer — the rationale the coordinator wrote', () => {
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.payload?.rationale).toContain('high because');
  });

  it('reports and refuses nothing when no chain is driving', () => {
    const result = invoke('risk', [], { check: true, feature: OURS });
    expect(result.exitCode).toBe(0);
    expect(result.refusals).toEqual([]);
    expect(result.payload?.risk).toMatchObject({ satisfied: false, reason: 'risk-high', mode: 'reporting' });
  });

  it('writes nothing — the gate is a reader', () => {
    const before = flowTree();
    invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(flowTree()).toEqual(before);
    expect(rounds()).toHaveLength(1);
  });
});

describe('no assessment at all', () => {
  it('refuses an enforced run under its OWN reason, never as a high one', () => {
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'risk-unassessed', level: null });
    expect(result.transcript).toContain('nothing recorded how risky');
  });

  it('refuses nothing on a manual call — a person is never cornered', () => {
    const result = invoke('risk', [], { check: true, feature: OURS });
    expect(result.exitCode).toBe(0);
    expect(result.refusals).toEqual([]);
    expect(result.payload?.risk).toMatchObject({ reason: 'risk-unassessed', mode: 'reporting' });
  });

  it('says what would satisfy it (allowed-pattern #21)', () => {
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(String(result.payload?.expected)).toContain('.rounds.jsonl');
    expect(String(result.payload?.expected)).toContain(OURS);
  });
});

describe("another plan's assessment", () => {
  it('does not gate this one', () => {
    appendRound(riskEntry(THEIRS, 'high', '2026-09-11T10:00:00Z', null));
    appendRound(riskEntry(OURS, 'low', '2026-09-11T11:00:00Z'));
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.risk).toMatchObject({ satisfied: true, level: 'low' });
  });

  it('does not clear this one', () => {
    appendRound(riskEntry(OURS, 'high', '2026-09-11T10:00:00Z'));
    appendRound(riskEntry(THEIRS, 'low', '2026-09-11T11:00:00Z', null));
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'risk-high' });
  });

  it('is outside an observed window and answers for neither', () => {
    appendRound(riskEntry(THEIRS, 'low', '2026-09-11T09:00:00Z', null));
    appendRound({
      ts: '2026-09-11T13:00:00Z',
      run_id: `${OURS}-20260911-120000`,
      type: 'phase_result',
      plan: OURS,
      phase: 1,
      status: 'success',
    });
    const result = invoke('risk', [], {
      check: true,
      since: '2026-09-11T12:00:00Z',
      ...CHAIN,
    });
    expect(result.exitCode).toBe(1);
    // AND IT NAMES NO FEATURE. An enforced gate reads its subject off the
    // assessment THIS chain recorded; a `phase_result` nobody stamped can no
    // longer nominate one (#1915 C1). The refusal still says what would satisfy
    // it, which is what the caller needs.
    expect(result.payload).toMatchObject({ refused: 'risk-unassessed', feature: null });
    expect(String(result.payload?.expected)).toContain(CHAIN.chain);
  });
});

describe('the observed scope — the caller that knows when, not what', () => {
  it('resolves the feature from the record and answers for it', () => {
    appendRound({
      ts: '2026-09-11T13:00:00Z',
      run_id: `${OURS}-20260911-120000`,
      type: 'phase_result',
      plan: OURS,
      phase: 1,
      status: 'success',
    });
    appendRound(riskEntry(OURS, 'high', '2026-09-11T13:30:00Z'));
    const result = invoke('risk', [], {
      check: true,
      since: '2026-09-11T12:00:00Z',
      ...CHAIN,
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({
      refused: 'risk-high',
      feature: OURS,
      scope: { kind: 'observed', since: '2026-09-11T12:00:00Z' },
    });
  });
});

describe('the four quality stops ride along, reporting only', () => {
  it('a withheld repair is observed and never refuses anything', () => {
    appendRound(riskEntry(OURS, 'low', '2026-09-11T10:00:00Z'));
    appendRound({
      ts: '2026-09-11T09:00:00Z',
      run_id: `${OURS}-20260911-120000`,
      type: 'verification',
      plan: OURS,
      phase: 1,
      task: 2,
      status: 'failed-needs-decision',
      withheld_repair: 'Would remove an intentional null-check',
    });
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(result.exitCode).toBe(0);
    expect(result.payload?.risk).toMatchObject({
      satisfied: true,
      qualityStops: {
        withheldRepairs: 1,
        observable: ['withheld-repair'],
        proseOnly: ['wave-file-conflict', 'wave-contract-conflict', 'lint-gate'],
      },
    });
  });

  it("another plan's withheld repair is not counted here", () => {
    appendRound(riskEntry(OURS, 'low', '2026-09-11T10:00:00Z'));
    appendRound({
      ts: '2026-09-11T09:00:00Z',
      run_id: `${THEIRS}-20260911-120000`,
      type: 'verification',
      plan: THEIRS,
      phase: 1,
      task: 2,
      status: 'failed-needs-decision',
    });
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect((result.payload?.risk as { qualityStops: { withheldRepairs: number } }).qualityStops.withheldRepairs).toBe(0);
  });
});

describe('flow pushed-through — the one writer of the record', () => {
  const WRITE = { feature: OURS, run: `${OURS}-20260911-120000` };

  it('appends one entry naming the stop, the plan and the run', () => {
    const result = invoke('pushed-through', ['lint-gate'], {
      ...WRITE,
      ...CHAIN,
      detail: 'Two style errors remain.',
    });
    expect(result.exitCode).toBe(0);
    const written = rounds();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      type: 'pushed_through',
      stop: 'lint-gate',
      plan: OURS,
      run_id: WRITE.run,
      phase: null,
      chain: CHAIN.chain,
      detail: 'Two style errors remain.',
    });
    expect(typeof written[0].ts).toBe('string');
  });

  it('refuses a stop that is not one of the four, and writes nothing', () => {
    const result = invoke('pushed-through', ['looked-risky'], WRITE);
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain("unknown stop 'looked-risky'");
    expect(result.transcript).toContain('wave-file-conflict|wave-contract-conflict|withheld-repair|lint-gate');
    expect(rounds()).toEqual([]);
  });

  it('refuses to mint a run id it was not given', () => {
    const result = invoke('pushed-through', ['lint-gate'], { feature: OURS });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('needs --run');
    expect(rounds()).toEqual([]);
  });

  it('refuses without a feature to scope the record to', () => {
    const result = invoke('pushed-through', ['lint-gate'], { run: WRITE.run });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('needs --feature');
    expect(rounds()).toEqual([]);
  });

  it('is read back by the gate, for this feature only', () => {
    invoke('pushed-through', ['wave-file-conflict'], { ...WRITE, detail: 'Two phases wrote one file.' });
    invoke('pushed-through', ['lint-gate'], {
      feature: THEIRS,
      run: `${THEIRS}-20260911-120000`,
    });
    appendRound(riskEntry(OURS, 'low', '2026-09-11T14:00:00Z'));
    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect((result.payload?.risk as { qualityStops: { recorded: unknown[] } }).qualityStops.recorded).toEqual([
      { stop: 'wave-file-conflict', detail: 'Two phases wrote one file.' },
    ]);
  });
});

/**
 * THE THREE PROSE-ONLY STOPS ARE REPORTED DISTINCTLY AT THE PUBLISH SEAM.
 *
 * A chained run that pushed past a wave conflict or a failing lint gate records
 * it (`flow pushed-through`); the gate reads it back and names it, so the last
 * local step is auditable — the same visibility `withheld-repair` already has.
 * Reporting only: the gate exits 0 for a low-rated run whatever it pushed past.
 */
describe('the publish gate names each recorded prose-only stop', () => {
  const RUN = `${OURS}-20260911-120000`;

  it.each([
    ['wave-file-conflict', 'Two phases wrote one file.'],
    ['wave-contract-conflict', 'Phase 3 widened the response.'],
    ['lint-gate', 'Two style errors remain.'],
  ])('reports %s in the transcript and payload', (stop, detail) => {
    invoke('pushed-through', [stop], { feature: OURS, run: RUN, ...CHAIN, detail });
    appendRound(riskEntry(OURS, 'low', '2026-09-11T14:00:00Z'));

    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });

    // The positive first: the gate cleared a low-rated run (allowed-pattern #28).
    expect(result.exitCode).toBe(0);
    const report = (result.payload?.risk as { qualityStops: { recordedByStop: unknown[] } })
      .qualityStops.recordedByStop;
    expect(report).toEqual([{ stop, count: 1, details: [detail] }]);

    // …and the human render (non-JSON mode) names the stop it pushed past.
    const rendered = invoke('risk', [], { check: true, feature: OURS, ...CHAIN, json: false });
    expect(rendered.transcript).toContain(`pushed through: ${stop} — ${detail}`);
  });

  it('collapses repeats of one stop to a single row with a count', () => {
    invoke('pushed-through', ['wave-file-conflict'], {
      feature: OURS,
      run: RUN,
      ...CHAIN,
      detail: 'Wave 1 overlap.',
    });
    invoke('pushed-through', ['wave-file-conflict'], {
      feature: OURS,
      run: RUN,
      ...CHAIN,
      detail: 'Wave 2 overlap.',
    });
    appendRound(riskEntry(OURS, 'low', '2026-09-11T14:00:00Z'));

    const result = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    const report = (result.payload?.risk as { qualityStops: { recordedByStop: { count: number }[] } })
      .qualityStops.recordedByStop;
    expect(report).toEqual([
      { stop: 'wave-file-conflict', count: 2, details: ['Wave 1 overlap.', 'Wave 2 overlap.'] },
    ]);

    const rendered = invoke('risk', [], { check: true, feature: OURS, ...CHAIN, json: false });
    expect(rendered.transcript).toContain('pushed through: wave-file-conflict (×2)');
  });
});

/**
 * THE REGRESSION, AT THE VERB — #1915 C1, exactly as the reviewer ran it.
 *
 * A throwaway project holding an honest `high` refused the publish; appending
 * ONE line naming a feature that does not exist turned exit 1 into exit 0. These
 * cases are that transcript, and they assert BOTH halves of allowed-pattern #24:
 * the refusal line on the combined stream, and the absence of the effect — here,
 * that `satisfied` never became true.
 */
describe('an appended line cannot open the gate', () => {
  const DECOY = 'anything-at-all';

  function decoy(): Record<string, unknown> {
    return {
      ts: '2026-09-11T13:30:00Z',
      run_id: `${DECOY}-20260911-133000`,
      type: 'risk',
      phase: null,
      plan: DECOY,
      risk_level: 'low',
      risk_rationale: 'looks fine',
    };
  }

  it('THE LIVE REPRODUCTION: a decoy after an honest high still refuses', () => {
    appendRound(riskEntry(OURS, 'high', '2026-09-11T13:00:00Z'));
    appendRound(decoy());

    const result = invoke('risk', [], {
      check: true,
      since: '2026-09-11T12:00:00Z',
      ...CHAIN,
    });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain('rated high risk');
    expect(result.payload).toMatchObject({ refused: 'risk-high', feature: OURS, satisfied: false });
  });

  it('a decoy alone cannot nominate itself as the subject', () => {
    appendRound(decoy());
    const result = invoke('risk', [], {
      check: true,
      since: '2026-09-11T12:00:00Z',
      ...CHAIN,
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'risk-unassessed' });
    expect(result.payload?.feature).not.toBe(DECOY);
  });

  it("a low stamped by ANOTHER chain does not satisfy this one", () => {
    appendRound(riskEntry(OURS, 'low', '2026-09-11T13:00:00Z', 'chain-2026-09-11-999'));
    const result = invoke('risk', [], {
      check: true,
      since: '2026-09-11T12:00:00Z',
      ...CHAIN,
    });
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ refused: 'risk-unassessed' });
  });

  it('an UNSTAMPED low does not satisfy an enforced gate — the backward-compat choice', () => {
    appendRound(riskEntry(OURS, 'low', '2026-09-11T13:00:00Z', null));
    const enforced = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(enforced.exitCode).toBe(1);
    expect(enforced.payload).toMatchObject({ refused: 'risk-unassessed' });

    // …and the same record, asked by a person, refuses nothing and answers.
    const manual = invoke('risk', [], { check: true, feature: OURS });
    expect(manual.exitCode).toBe(0);
    expect(manual.refusals).toEqual([]);
    expect(manual.payload?.risk).toMatchObject({ satisfied: true, level: 'low', mode: 'reporting' });
  });

  it('the gate still writes nothing while refusing all of this', () => {
    appendRound(riskEntry(OURS, 'high', '2026-09-11T13:00:00Z'));
    appendRound(decoy());
    const before = flowTree();
    const written = rounds().length;
    invoke('risk', [], { check: true, since: '2026-09-11T12:00:00Z', ...CHAIN });
    expect(flowTree()).toEqual(before);
    expect(rounds()).toHaveLength(written);
  });
});

/**
 * `flow risk --record` — the one writer, and the half `pushed_through` had from
 * the start while `risk` was composed out of a paragraph (#1915 H2).
 */
describe('flow risk --record — the one writer of an assessment', () => {
  const WRITE = { feature: OURS, run: `${OURS}-20260911-120000` };

  it('appends one entry carrying the level, the plan, the run and the stamp', () => {
    const result = invoke('risk', [], {
      ...WRITE,
      ...CHAIN,
      record: 'high',
      rationale: 'Touches auth.',
    });
    expect(result.exitCode).toBe(0);
    const written = rounds();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      type: 'risk',
      plan: OURS,
      run_id: WRITE.run,
      phase: null,
      risk_level: 'high',
      risk_rationale: 'Touches auth.',
      chain: CHAIN.chain,
    });
    expect(typeof written[0].ts).toBe('string');
  });

  it('is what the enforced gate then reads — the two halves meet', () => {
    invoke('risk', [], { ...WRITE, ...CHAIN, record: 'low', rationale: 'Bounded.' });
    const gate = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(gate.exitCode).toBe(0);
    expect(gate.payload?.risk).toMatchObject({ satisfied: true, level: 'low', chain: CHAIN.chain });
  });

  it('a high it recorded refuses the gate it stamped', () => {
    invoke('risk', [], { ...WRITE, ...CHAIN, record: 'high', rationale: 'Touches auth.' });
    const gate = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(gate.exitCode).toBe(1);
    expect(gate.payload).toMatchObject({ refused: 'risk-high', rationale: 'Touches auth.' });
  });

  it('refuses a fourth level, and writes nothing', () => {
    const result = invoke('risk', [], { ...WRITE, ...CHAIN, record: 'catastrophic' });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain("unknown risk level 'catastrophic'");
    expect(result.transcript).toContain('low|medium|high');
    expect(rounds()).toEqual([]);
  });

  it('refuses to mint a run id it was not given, and writes nothing', () => {
    const result = invoke('risk', [], { feature: OURS, ...CHAIN, record: 'low' });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('needs --run');
    expect(rounds()).toEqual([]);
  });

  it('refuses without a feature to scope the record to, and writes nothing', () => {
    const result = invoke('risk', [], { run: WRITE.run, ...CHAIN, record: 'low' });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('needs --feature');
    expect(rounds()).toEqual([]);
  });

  it('refuses a call that both asks and answers, and writes nothing', () => {
    const result = invoke('risk', [], { ...WRITE, ...CHAIN, record: 'low', check: true });
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('never both in one call');
    expect(rounds()).toEqual([]);
  });

  it('records without a chain, and says the entry satisfies no enforced gate', () => {
    const result = invoke('risk', [], { ...WRITE, record: 'low', json: false });
    expect(result.exitCode).toBe(0);
    expect(rounds()[0]).toMatchObject({ chain: null, risk_level: 'low' });
    expect(result.transcript).toContain('satisfies no enforced publish gate');

    const gate = invoke('risk', [], { check: true, feature: OURS, ...CHAIN });
    expect(gate.exitCode).toBe(1);
    expect(gate.payload).toMatchObject({ refused: 'risk-unassessed' });
  });
});
