/**
 * The high-risk gate — `planflow-ai flow risk --check`.
 *
 * The skill doc has promised since #653 that an autopilot run with
 * `risk_level: high` pauses before push/PR. It was prose, enforced by nothing
 * (discovery C3). This is the gate, and it is the SIBLING of `flow-stage.ts`:
 * same family, same contract, same shape — a tagged mode union, ONE computation
 * whose mode decides only the exit code, a refusal payload on stdout before the
 * prose line, and developer-facing fields quarantined behind `diagnostic`. A
 * second gate idiom is a second thing to keep in step; there is one.
 *
 * WHAT IT GUARDS is the publish seam, not a stage edge — the last irreversible
 * step of an enforced run, where the work stops being local. Both callers reach
 * the same code path (allowed-pattern #14): the IDE chain spawns this verb from
 * `chain-tail.ts` before it publishes, and the `/execute-plan` skill calls it on
 * a manual or headless run. A gate implemented twice is the bug this feature
 * exists to remove.
 *
 * IT NEVER JUDGES RISK — see `../state/risk-record.ts`, which also argues what a
 * MISSING assessment means and why it refuses on the enforced path under its own
 * reason code rather than passing for a low one.
 *
 * AN ENFORCED CALL IS KEYED ON ITS CHAIN ID. `--chain` is not merely the switch
 * between refusing and reporting any more: it is passed into the reading, which
 * then admits only entries `flow risk --record` stamped with that id. The first
 * cut resolved WHICH FEATURE IT WAS GATING from the newest line naming any plan,
 * so one appended line was both the question and the answer and flipped a `high`
 * refusal into a publish (#1915 C1, reproduced live). The subject now comes from
 * the chain's own record or the gate refuses; the writer verb is its sibling,
 * `flow-risk-record.ts`, and this module still writes nothing.
 *
 * THE QUALITY STOPS RIDE ALONG, REPORTING ONLY. An enforced run no longer stops
 * for a withheld repair (discovery D3), so the publish gate is the last place
 * that fact can still be seen — it is carried in the payload and never refuses
 * anything (`../state/quality-stops.ts`).
 */

import { readRoundsEntries } from '../state/rounds-reader.js';
import { BLOCKING_RISK, RISK_ENTRY_TYPE, readRisk } from '../state/risk-record.js';
import {
  CODE_OBSERVABLE_STOPS,
  PROSE_ONLY_STOPS,
  observedWithheldRepairs,
  recordedPushThroughs,
  summarizeRecordedStops,
} from '../state/quality-stops.js';
import { ROUNDS_FILE } from '../state/workflow-stages.js';
import type { EnforcementMode } from '../state/enforcement-mode.js';
import type { QualityStop, RecordedStopSummary } from '../state/quality-stops.js';
import type { RiskLevel, RiskScope } from '../state/risk-record.js';
import type { RoundsEntry } from '../state/rounds-reader.js';

/** Why a publish may not go ahead. `null` on the success path. */
export type RiskRefusalReason = 'risk-high' | 'risk-unassessed';

/**
 * The developer-facing half of a verdict — names the record and the module.
 *
 * NEVER RENDER THIS IN A GUI (forbidden-pattern #12). It exists so a terminal
 * refusal can say where the fact came from, and so that a GUI consumer choosing
 * the top-level fields cannot pick one of these by accident.
 */
export interface RiskCheckDiagnostic {
  /** The record the assessment is read from, relative to the flow directory. */
  file: string;
  /** The entry type that carries it. */
  entryType: string;
  /** The module that reads it. */
  module: string;
  /** Why the record and not a model's report. */
  why: string;
}

/** What the four quality stops left behind, for this feature. Reporting only. */
export interface QualityStopReport {
  /** Withheld repairs the record carries — the one stop code can observe. */
  withheldRepairs: number;
  /** Push-throughs a coordinator recorded, one row per record. */
  recorded: { stop: QualityStop; detail: string | null }[];
  /**
   * The same push-throughs collapsed to one row per stop, with a count.
   *
   * The reader-facing view: a run that went past the SAME stop in three waves is
   * one line here, not three. `recorded` stays for machine consumers that want
   * each record; this is what the human render and a person's audit read.
   */
  recordedByStop: RecordedStopSummary[];
  /** Which of the four a code path can see for itself. */
  observable: readonly QualityStop[];
  /** Which of the four live in `/execute-plan` prose and leave no record. */
  proseOnly: readonly QualityStop[];
}

/** One publish gate's verdict. Computed once; rendered two ways; refused in one mode. */
export interface RiskCheckVerdict {
  /** The feature every entry was matched against — resolved, under `observed`. */
  feature: string | null;
  /** Which question was asked of the record. */
  scope: RiskScope;
  /** Whether the publish may go ahead. */
  satisfied: boolean;
  /** Why not, when not. */
  reason: RiskRefusalReason | null;
  /** The recorded level, or `null` when nothing rated this run. */
  level: RiskLevel | null;
  /** The coordinator's own sentence. Human-facing. */
  rationale: string | null;
  /** The run that recorded the assessment. */
  runId: string | null;
  /** When it was recorded. */
  assessedAt: string | null;
  /** One sentence a person can act on. Human-facing. */
  message: string;
  /** What would satisfy the gate. Human-facing. `null` when it is satisfied. */
  expected: string | null;
  /** The four stops, for the record. Never a reason to refuse. */
  qualityStops: QualityStopReport;
  /** See `RiskCheckDiagnostic`. */
  diagnostic: RiskCheckDiagnostic;
  /** Which question was asked — enforcing, or reporting. */
  mode: EnforcementMode['mode'];
  /** The chain driving this call, or `null` for a manual one. */
  chain: string | null;
}

/**
 * The refusal payload — the verdict, plus the reason code at the front.
 *
 * `refused` first, matching `worktree refused: unbound` and `flow stage`
 * (allowed-pattern #21): the consumer that only wants to know WHAT happened
 * reads one field, and the one that wants to ask the person about it has the
 * rest already — the level, the rationale the coordinator wrote, and the run it
 * belongs to.
 */
export interface RiskCheckRefusalPayload extends RiskCheckVerdict {
  refused: RiskRefusalReason;
  verb: 'risk';
}

/**
 * A refusal that carries its own answer.
 *
 * Thrown by the verb and caught by `runFlow`, which writes `payload` to stdout
 * and then the one `flow refused:` line — prose after payload, on the same
 * stream, exactly as allowed-pattern #24 says consumers should expect it.
 */
export class RiskCheckRefusal extends Error {
  readonly payload: RiskCheckRefusalPayload;

  constructor(payload: RiskCheckRefusalPayload) {
    super(payload.message);
    this.name = 'RiskCheckRefusal';
    this.payload = payload;
  }
}

/** The only reader this gate needs — injectable, so the whole gate is testable. */
export interface RiskCheckDeps {
  readRounds(): readonly RoundsEntry[];
}

/** The real reader. Fail-soft on READ, never on LOGIC (`rounds-reader.ts`). */
export function riskCheckDeps(flowDir: string): RiskCheckDeps {
  return { readRounds: () => readRoundsEntries(flowDir) };
}

const DIAGNOSTIC: RiskCheckDiagnostic = {
  file: ROUNDS_FILE,
  entryType: RISK_ENTRY_TYPE,
  module: 'src/cli/state/risk-record.ts',
  why:
    'The rounds record is written by the execute coordinator itself, not by a ' +
    'model asked to remember. Rating a changeset needs the changeset read, so ' +
    'the judgement stays with the agent and this gate only enforces that it exists.',
};

/** What `evaluateRiskCheck` is being asked. */
export interface RiskCheckRequest {
  scope: RiskScope;
  mode: EnforcementMode;
}

/**
 * The sentence naming what would satisfy the gate. One place builds it.
 *
 * An ENFORCED call says the chain part out loud (allowed-pattern #21 — a refusal
 * that asks a question carries its own answer). "No assessment" and "an
 * assessment nobody stamped with this chain" are the same refusal from the
 * caller's side and completely different things to fix, and the second is the
 * one a coordinator that forgot `--chain` while recording has actually done.
 */
function expectationFor(feature: string | null, chain: string | null): string {
  const named = feature === null ? 'this run' : `'${feature}'`;
  const stamp = chain === null ? '' : `, recorded by \`flow risk --record\` with --chain ${chain}`;
  return `${ROUNDS_FILE} (a ${RISK_ENTRY_TYPE} entry for ${named}${stamp}, written at the end of /execute-plan)`;
}

/**
 * The verdict — THE one computation.
 *
 * Both modes call this and neither has an opinion the other lacks; the refusal
 * is a formatting decision taken afterwards, on the same object. Pure apart from
 * `deps`, so the whole gate is testable against a fixture with no project on
 * disk.
 */
export function evaluateRiskCheck(
  deps: RiskCheckDeps,
  request: RiskCheckRequest,
): RiskCheckVerdict {
  const entries = deps.readRounds();
  // THE CHAIN IS PASSED INTO THE READING, NOT APPLIED AFTER IT. An enforced call
  // admits only the entries that chain stamped, so no line the chain did not
  // write can be the answer — or change the question (#1915 C1,
  // `../state/risk-record.ts`). A reporting call passes `null` and reads exactly
  // as it always did, because it refuses nothing.
  const reading = readRisk(entries, request.scope, request.mode.chain);
  const feature = reading.feature;

  const qualityStops: QualityStopReport = {
    withheldRepairs: feature === null ? 0 : observedWithheldRepairs(entries, feature).length,
    recorded:
      feature === null
        ? []
        : recordedPushThroughs(entries, feature).map((entry) => ({
            stop: entry.stop,
            detail: entry.detail,
          })),
    recordedByStop: feature === null ? [] : summarizeRecordedStops(entries, feature),
    observable: CODE_OBSERVABLE_STOPS,
    proseOnly: PROSE_ONLY_STOPS,
  };

  const base = {
    feature,
    scope: request.scope,
    qualityStops,
    diagnostic: DIAGNOSTIC,
    mode: request.mode.mode,
    chain: request.mode.chain,
  };

  if (reading.assessment === null) {
    return {
      ...base,
      satisfied: false,
      reason: 'risk-unassessed',
      level: null,
      rationale: null,
      runId: null,
      assessedAt: null,
      message:
        `nothing recorded how risky this work is, so it was not published — ` +
        `expected ${expectationFor(feature, request.mode.chain)}`,
      expected: expectationFor(feature, request.mode.chain),
    };
  }

  const { level, rationale, runId, ts } = reading.assessment;

  if (level === BLOCKING_RISK) {
    return {
      ...base,
      satisfied: false,
      reason: 'risk-high',
      level,
      rationale,
      runId,
      assessedAt: ts,
      message:
        `this work was rated ${level} risk, so it was not published — ` +
        `${rationale ?? 'no rationale was recorded with the assessment'}`,
      expected: null,
    };
  }

  return {
    ...base,
    satisfied: true,
    reason: null,
    level,
    rationale,
    runId,
    assessedAt: ts,
    message: `this work was rated ${level} risk, so publishing may go ahead`,
    expected: null,
  };
}

/**
 * The verb's body: compute the verdict, and refuse only when a chain is driving.
 *
 * The refusal is a THROW carrying the payload so that `runFlow`'s one catch keeps
 * owning the family's contract — one `flow refused:` line, exit 1 — and this
 * module never writes to stdout itself.
 */
export function checkRisk(
  flowDir: string,
  request: RiskCheckRequest,
  deps: RiskCheckDeps = riskCheckDeps(flowDir),
): RiskCheckVerdict {
  const verdict = evaluateRiskCheck(deps, request);

  if (verdict.satisfied || verdict.mode === 'reporting' || verdict.reason === null) {
    return verdict;
  }

  throw new RiskCheckRefusal({ refused: verdict.reason, verb: 'risk', ...verdict });
}

/**
 * The human rendering of a verdict — a SECOND FORMATTER, never a second
 * computation (the family's contract).
 *
 * A reporting-mode call that found a gap says so and says that nothing was
 * refused, because "exit 0 with a complaint" is otherwise indistinguishable from
 * "exit 0, all clear" to the person reading the terminal.
 */
export function renderRiskVerdict(verdict: RiskCheckVerdict): string[] {
  const lines: string[] = [`flow: ${verdict.message}`];

  if (verdict.feature !== null) {
    lines.push(`  feature: ${verdict.feature}`);
  }
  if (verdict.qualityStops.withheldRepairs > 0) {
    lines.push(
      `  pushed through: ${verdict.qualityStops.withheldRepairs} withheld repair(s) — ` +
        'recorded, and not a reason to stop an enforced run',
    );
  }
  for (const recorded of verdict.qualityStops.recordedByStop) {
    const times = recorded.count > 1 ? ` (×${recorded.count})` : '';
    const detail = recorded.details.length > 0 ? ` — ${recorded.details.join('; ')}` : '';
    lines.push(`  pushed through: ${recorded.stop}${times}${detail}`);
  }
  if (!verdict.satisfied && verdict.mode === 'reporting') {
    lines.push('  nothing was refused — no chain is driving this call');
  }

  return lines;
}
