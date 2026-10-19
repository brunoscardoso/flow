/**
 * The four stops an enforced run pushes through — and the record that says it
 * did (discovery D3, R5).
 *
 * An enforced autopilot run honours THREE pauses: a `high` risk assessment
 * before the publish, the guard classifier's `ask`, and an unbound branch at
 * push. All three are "irreversible to someone else". The other four places
 * `/execute-plan` stops today — a wave with a file conflict, a contract
 * conflict between parallel phases, a withheld behavioural repair, and a failing
 * lint gate — are "the run is not confident", which is what the feature was
 * asked to push through.
 *
 * THAT IS A REAL BEHAVIOUR CHANGE, AND IT BELONGS IN THE RUN RECORD RATHER THAN
 * IN SILENCE. A wave that used to ask and now proceeds must leave something
 * behind that says so, or the only trace of the decision is its absence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CODE CAN AND CANNOT DO HERE — SAID PLAINLY
 *
 * Three of the four stops do not exist in code. They are steps of the
 * `/execute-plan` SKILL — prose a coordinator follows — so no module can force
 * them through, and this one does not pretend to. What it owns is the RECORD:
 * one entry type, one shape, one writer, so that when the skill is instructed to
 * push through, the thing it writes is validated by code instead of composed
 * from a paragraph (allowed-pattern #14).
 *
 *   | stop                     | in code today                                  |
 *   |--------------------------|------------------------------------------------|
 *   | `withheld-repair`        | OBSERVABLE — `verification` entries carry       |
 *   |                          | `withheld_repair` / `failed-needs-decision`,    |
 *   |                          | which `observedWithheldRepairs` reads back      |
 *   | `wave-file-conflict`     | prose only — leaves no record to read           |
 *   | `wave-contract-conflict` | prose only — leaves no record to read           |
 *   | `lint-gate`              | prose only — leaves no record to read           |
 *
 * The observable one is read back at the publish gate, so an enforced run that
 * pushed through a withheld repair says so at the moment it is about to publish
 * — the one place where "the run was not confident" still matters even though it
 * no longer stops anything.
 *
 * Pure: no filesystem, no clock, no model. The writer verb supplies the clock.
 */

import { entryNamesFeature } from './risk-record.js';
import type { RoundsEntry } from './rounds-reader.js';

/** The four stops an enforced run no longer honours. */
export const QUALITY_STOPS = [
  'wave-file-conflict',
  'wave-contract-conflict',
  'withheld-repair',
  'lint-gate',
] as const;

/** One of them. */
export type QualityStop = (typeof QUALITY_STOPS)[number];

/** The stops a code path can see for itself — see the header's table. */
export const CODE_OBSERVABLE_STOPS: readonly QualityStop[] = ['withheld-repair'];

/** The stops that live in `/execute-plan` prose and leave no record to read. */
export const PROSE_ONLY_STOPS: readonly QualityStop[] = [
  'wave-file-conflict',
  'wave-contract-conflict',
  'lint-gate',
];

/** Whether a value is one of the four. */
export function isQualityStop(value: string): value is QualityStop {
  return (QUALITY_STOPS as readonly string[]).includes(value);
}

/** The rounds entry type that records a stop an enforced run went past. */
export const PUSHED_THROUGH_ENTRY_TYPE = 'pushed_through';

/** One recorded push-through, in the rounds record's envelope. */
export interface PushedThroughEntry extends Record<string, unknown> {
  ts: string;
  run_id: string;
  type: typeof PUSHED_THROUGH_ENTRY_TYPE;
  /** Run-level, like `risk` — the record's own convention for a non-phase fact. */
  phase: null;
  /** The plan slug, the way every live entry in this repo scopes itself. */
  plan: string;
  stop: QualityStop;
  /** One sentence from the coordinator about what it went past. */
  detail: string | null;
  /** The chain that was driving, when one was. */
  chain: string | null;
}

/** What the writer is told. */
export interface PushedThroughInput {
  stop: QualityStop;
  feature: string;
  runId: string;
  chain: string | null;
  detail: string | null;
  ts: string;
}

/**
 * The entry, built in ONE place.
 *
 * `run_id` is taken from the caller rather than minted: the record's own rule is
 * that a run has one id and nobody invents a second scheme, so a verb that could
 * not be given one would be a verb that has to make one up.
 */
export function buildPushedThroughEntry(input: PushedThroughInput): PushedThroughEntry {
  return {
    ts: input.ts,
    run_id: input.runId,
    type: PUSHED_THROUGH_ENTRY_TYPE,
    phase: null,
    plan: input.feature,
    stop: input.stop,
    detail: input.detail,
    chain: input.chain,
  };
}

/** One withheld repair the record already carries. */
export interface WithheldRepair {
  phase: number | string | null;
  task: number | string | null;
  /** The coordinator's own sentence, when it wrote one. */
  detail: string | null;
}

/**
 * The withheld repairs in the record for one feature — the one stop a code path
 * can see for itself.
 *
 * Two spellings both count, because `per-task-verification.md` produces both: a
 * `verification` entry whose status is `failed-needs-decision`, and one carrying
 * a `withheld_repair` sentence. Neither is more authoritative than the other and
 * an entry carrying both is counted once.
 */
export function observedWithheldRepairs(
  entries: readonly RoundsEntry[],
  feature: string,
): WithheldRepair[] {
  const found: WithheldRepair[] = [];
  for (const entry of entries) {
    if (entry.type !== 'verification') continue;
    if (!entryNamesFeature(entry, feature)) continue;
    const withheld =
      typeof entry.withheld_repair === 'string' && entry.withheld_repair.trim().length > 0
        ? entry.withheld_repair
        : null;
    if (withheld === null && entry.status !== 'failed-needs-decision') continue;
    found.push({
      phase: entry.phase ?? null,
      task: (entry.task as number | string | undefined) ?? null,
      detail: withheld,
    });
  }
  return found;
}

/** Push-throughs already recorded for one feature, oldest first. */
export function recordedPushThroughs(
  entries: readonly RoundsEntry[],
  feature: string,
): PushedThroughEntry[] {
  return entries.filter(
    (entry): entry is PushedThroughEntry =>
      entry.type === PUSHED_THROUGH_ENTRY_TYPE &&
      typeof entry.stop === 'string' &&
      isQualityStop(entry.stop) &&
      entryNamesFeature(entry, feature),
  );
}

/** One stop's recorded push-throughs, collapsed for the report. */
export interface RecordedStopSummary {
  stop: QualityStop;
  /** How many push-throughs this run recorded for the stop. */
  count: number;
  /** The coordinator's own sentences, in record order, nulls dropped. */
  details: string[];
}

/**
 * The recorded push-throughs for one feature, GROUPED BY STOP.
 *
 * Reporting only, for the publish gate. `recordedPushThroughs` gives one entry
 * per record — right for a machine reader, noisy for a person when a run went
 * past the SAME stop in three waves. This collapses those to one row per stop
 * with a count, in the canonical `QUALITY_STOPS` order (never record order, so
 * the report reads the same whatever sequence the coordinator wrote in), and a
 * stop with no record does not appear at all — the row's presence IS the fact.
 */
export function summarizeRecordedStops(
  entries: readonly RoundsEntry[],
  feature: string,
): RecordedStopSummary[] {
  const byStop = new Map<QualityStop, string[]>();
  const counts = new Map<QualityStop, number>();
  for (const entry of recordedPushThroughs(entries, feature)) {
    counts.set(entry.stop, (counts.get(entry.stop) ?? 0) + 1);
    if (entry.detail !== null && entry.detail.trim().length > 0) {
      byStop.set(entry.stop, [...(byStop.get(entry.stop) ?? []), entry.detail]);
    }
  }
  return QUALITY_STOPS.filter((stop) => counts.has(stop)).map((stop) => ({
    stop,
    count: counts.get(stop) ?? 0,
    details: byStop.get(stop) ?? [],
  }));
}
