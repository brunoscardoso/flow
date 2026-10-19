/**
 * Resume evaluator — pure judgment of which compiled-run phases are already
 * complete according to the rounds record (`flow/.rounds.jsonl`).
 *
 * No I/O here: `rounds-reader.ts` reads the file; this module only interprets
 * the entries against a compiled `RunScript`.
 *
 * Resume is gated on **hash lineage**: a run's `phase_result` entries count
 * only when that run is provably an execution of THIS plan content — i.e. some
 * entry for the same `run_id` (a `run_intent` or a `phase_result`) carries a
 * `planHash` equal to the script's `planHash`. Rounds files that predate
 * planHash stamping never establish lineage, so they conservatively enable no
 * resume — every phase reports `pending`.
 *
 * Skip semantics: phases compiled with `skip: true` report `complete`. The
 * two-state contract (`complete | pending`) is kept deliberately — from the
 * resume consumer's perspective the only question is "does this phase still
 * need to run?", and a skipped phase does not. The script itself remains the
 * source of truth for WHY (its `skip` flag), so no third state is needed.
 */

import type { RunScript } from './types.js';
import type { RoundsEntry } from './rounds-reader.js';

/** Resume state of one compiled phase. */
export interface ResumeStatus {
  phase: number;
  state: 'complete' | 'pending';
}

/**
 * Normalize a rounds entry's `phase` field to an integer phase number.
 * Returns null for run-level entries (`phase: null`), legacy string phases
 * that aren't purely numeric (e.g. `"P1"`), and anything else non-integral —
 * the conservative reading: uninterpretable phases never mark completion.
 */
function normalizePhaseNumber(phase: RoundsEntry['phase']): number | null {
  if (typeof phase === 'number' && Number.isInteger(phase)) {
    return phase;
  }
  if (typeof phase === 'string' && /^\d+$/.test(phase)) {
    return Number.parseInt(phase, 10);
  }
  return null;
}

/**
 * Collect the run_ids whose lineage matches the script's planHash: any
 * `run_intent` or `phase_result` entry carrying `planHash === script.planHash`
 * anchors its run_id to this plan content.
 */
function collectLineageRunIds(script: RunScript, entries: RoundsEntry[]): Set<string> {
  const runIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'run_intent' && entry.type !== 'phase_result') {
      continue;
    }
    if (typeof entry.run_id !== 'string' || entry.run_id.length === 0) {
      continue;
    }
    if (entry.planHash === script.planHash) {
      runIds.add(entry.run_id);
    }
  }

  return runIds;
}

/**
 * Evaluate which phases of a compiled run script are already complete
 * according to the rounds entries.
 *
 * Rules:
 * - Only `phase_result` entries with `status === 'success'` mark a phase
 *   complete; `partial` / `failure` (or anything else) leave it pending.
 * - A `phase_result` counts only when its run_id's lineage matches
 *   `script.planHash` (see module header). No matching lineage anywhere →
 *   all non-skip phases are pending.
 * - Phases with `skip: true` always report `complete` — they will not run.
 * - Output is deterministic, ordered by ascending phase number.
 */
export function evaluateResume(script: RunScript, entries: RoundsEntry[]): ResumeStatus[] {
  const lineageRunIds = collectLineageRunIds(script, entries);

  const completedPhases = new Set<number>();
  if (lineageRunIds.size > 0) {
    for (const entry of entries) {
      if (entry.type !== 'phase_result' || entry.status !== 'success') {
        continue;
      }
      if (typeof entry.run_id !== 'string' || !lineageRunIds.has(entry.run_id)) {
        continue;
      }
      const phaseNumber = normalizePhaseNumber(entry.phase);
      if (phaseNumber !== null) {
        completedPhases.add(phaseNumber);
      }
    }
  }

  return [...script.phases]
    .sort((a, b) => a.number - b.number)
    .map((phase) => ({
      phase: phase.number,
      state: phase.skip || completedPhases.has(phase.number) ? 'complete' : 'pending',
    }));
}
