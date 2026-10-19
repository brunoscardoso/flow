/**
 * Change-simulation baseline store (blueprint-simulation).
 *
 * The predicted per-phase touched-sets are persisted as a new `rounds.jsonl`
 * entry type, `simulation_baseline`, keyed by the plan's `planHash` (the SAME
 * sha256 the run script uses — one definition of "the plan changed"). Reusing
 * the append-only rounds record means the baseline archives with the plan and
 * needs no new store (discovery decision #11).
 *
 * Lifecycle (decision #12): the baseline auto-regenerates when the plan changes.
 * Because rounds is append-only, regenerating simply appends a NEW baseline
 * entry — the latest entry for a given `planHash` wins on read, and prior
 * baselines remain as history (versioning-by-accretion). No entry is ever
 * rewritten.
 *
 * INVARIANT (allowed-pattern #14): all baseline writes go through
 * `writeSimulationBaseline` here — the one code path. The coordinator remains
 * the sole writer of run-scoped rounds entries; this plan-time entry keys on
 * `planHash` and carries no `run_id`.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRoundsEntries, type RoundsEntry } from '../state/rounds-reader.js';
import type { TouchedSet } from './types.js';

const ROUNDS_FILENAME = '.rounds.jsonl';

/** The rounds entry type discriminator for a stored simulation baseline. */
export const SIMULATION_BASELINE_TYPE = 'simulation_baseline';

/**
 * A `simulation_baseline` rounds entry: the predicted touched-sets for one plan
 * at one `planHash`. Written at plan-time; carries no `run_id` (it precedes any
 * execution run).
 */
export interface SimulationBaselineEntry {
  ts: string;
  type: typeof SIMULATION_BASELINE_TYPE;
  plan: string;
  planHash: string;
  touchedSets: TouchedSet[];
}

/** Narrow a raw rounds entry to a well-formed simulation baseline. */
function asBaselineEntry(entry: RoundsEntry): SimulationBaselineEntry | null {
  if (entry.type !== SIMULATION_BASELINE_TYPE) return null;
  if (typeof entry.plan !== 'string' || typeof entry.planHash !== 'string') return null;
  if (!Array.isArray(entry.touchedSets)) return null;
  return {
    ts: typeof entry.ts === 'string' ? entry.ts : '',
    type: SIMULATION_BASELINE_TYPE,
    plan: entry.plan,
    planHash: entry.planHash,
    touchedSets: entry.touchedSets as TouchedSet[],
  };
}

/**
 * Append a simulation baseline for `planHash`. Single writer path (append-only,
 * never rewrites). `ts` is injected by the caller so the module stays clock-free
 * and deterministic under test.
 */
export function writeSimulationBaseline(
  flowDir: string,
  plan: string,
  planHash: string,
  touchedSets: TouchedSet[],
  ts: string,
): void {
  const entry: SimulationBaselineEntry = {
    ts,
    type: SIMULATION_BASELINE_TYPE,
    plan,
    planHash,
    touchedSets,
  };
  appendFileSync(join(flowDir, ROUNDS_FILENAME), `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * The latest baseline stored for `planHash`, or null when none exists.
 * Latest-wins: scans all baseline entries and keeps the last matching one
 * (append order = chronological), so a regenerated baseline supersedes the old.
 */
export function readSimulationBaseline(
  flowDir: string,
  planHash: string,
): SimulationBaselineEntry | null {
  let latest: SimulationBaselineEntry | null = null;
  for (const raw of readRoundsEntries(flowDir)) {
    const baseline = asBaselineEntry(raw);
    if (baseline !== null && baseline.planHash === planHash) {
      latest = baseline;
    }
  }
  return latest;
}

/** What `ensureBaselineFresh` did. */
export interface BaselineFreshnessResult {
  /** True when a fresh baseline was written (the stored hash had drifted/absent). */
  regenerated: boolean;
}

/**
 * Ensure a baseline exists for `currentPlanHash`, regenerating when the stored
 * hash has drifted or is absent (decision #12). The touched-sets are produced
 * by the injected `recompute` fn (keeps this module free of story/graph I/O and
 * unit-testable). No-op — no write — when the current hash already has a
 * baseline. Append-only, so regeneration never destroys prior history.
 */
export function ensureBaselineFresh(
  flowDir: string,
  plan: string,
  currentPlanHash: string,
  recompute: () => TouchedSet[],
  ts: string,
): BaselineFreshnessResult {
  if (readSimulationBaseline(flowDir, currentPlanHash) !== null) {
    return { regenerated: false };
  }
  writeSimulationBaseline(flowDir, plan, currentPlanHash, recompute(), ts);
  return { regenerated: true };
}
