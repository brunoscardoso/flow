/**
 * The one writer of a `risk` rounds entry — `planflow-ai flow risk --record`.
 *
 * WHY THIS EXISTS AT ALL, SAID PLAINLY. `pushed_through` was built in the same
 * phase as the publish gate and given exactly this protection: one verb, one
 * shape, a validated vocabulary, "never hand-composed"
 * (`../state/quality-stops.ts`). The `risk` entry the gate actually reads got
 * none of it — `execute-plan-skill.md` told the coordinator to compose the JSON
 * line itself. The review (#1915, H2) named that as the root of C1, and it was:
 * a record with no writer has no schema anyone enforces, no identity anyone can
 * check, and latest-append-wins as its only rule. Appending one line to
 * `flow/.rounds.jsonl` flipped a `high` refusal into a granted publish.
 *
 * So this verb is the same bargain `flow pushed-through` struck: a coordinator
 * instructed to record an assessment calls this instead of writing JSON out of a
 * paragraph, and what lands in the record is validated by code
 * (allowed-pattern #14).
 *
 * IT NEVER JUDGES RISK. Rating a changeset means reading the changeset, which is
 * a model's job, and no model call ever enters a verb. The level and the one
 * sentence come from the coordinator that did the work; this verb owns the
 * vocabulary (`low|medium|high` and nothing else), the envelope, and the stamp.
 *
 * THE STAMP IS THE WHOLE POINT. `--chain <id>` writes the chain id onto the
 * entry, and an enforced gate admits only entries carrying the id it was called
 * with (`../state/risk-record.ts`). The chain id is minted by the harness and by
 * nothing else, which is the only identity in this system that a file cannot
 * forge. A coordinator that forgets the flag writes an unstamped entry and the
 * gate then REFUSES under `risk-unassessed` — the safe direction, and the
 * opposite of the behaviour this replaces.
 *
 * Append-only, like every other writer of this file. Nothing is ever rewritten
 * and nothing already in the record is read for permission to write — a second
 * assessment is a second line, exactly as a re-classification is.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RISK_LEVELS, buildRiskEntry, isRiskLevel } from '../state/risk-record.js';
import { ROUNDS_FILE } from '../state/workflow-stages.js';
import type { RiskEntry, RiskLevel } from '../state/risk-record.js';

/** Every spelling this verb accepts, for the unknown-level refusal. */
export function riskLevelVocabulary(): string {
  return RISK_LEVELS.join('|');
}

/**
 * The level a caller named, or a throw naming what it should have been.
 *
 * A fourth level is not a quieter third one. The gate reads `high` and nothing
 * else as blocking, so an entry saying `critical` would be read as no assessment
 * at all — silently the most permissive answer available. Refused here instead.
 */
export function requireRiskLevel(named: string): RiskLevel {
  const normalized = named.trim().toLowerCase();
  if (!isRiskLevel(normalized)) {
    throw new Error(`unknown risk level '${named}' — expected ${riskLevelVocabulary()}`);
  }
  return normalized;
}

/** What the verb was told to record. */
export interface RiskRecordRequest {
  level: RiskLevel;
  feature: string;
  runId: string;
  chain: string | null;
  rationale: string | null;
}

/** The one place the clock enters. Injectable so a test can read what it asserts. */
export interface RiskRecordDeps {
  now: () => Date;
  append: (line: string) => void;
}

/** The real writer — creates the flow directory if this is the record's first line. */
export function riskRecordDeps(flowDir: string): RiskRecordDeps {
  return {
    now: () => new Date(),
    append: (line: string) => {
      mkdirSync(flowDir, { recursive: true });
      appendFileSync(join(flowDir, ROUNDS_FILE), line, 'utf-8');
    },
  };
}

/**
 * Record one assessment.
 *
 * Returns the entry it wrote, so the verb's result object carries the fact
 * rather than a claim about it — and so a caller can see whether its `--chain`
 * actually landed on the line, which is the difference between a gate that will
 * open and one that will refuse.
 */
export function recordRisk(
  flowDir: string,
  request: RiskRecordRequest,
  deps: RiskRecordDeps = riskRecordDeps(flowDir),
): RiskEntry {
  const entry = buildRiskEntry({
    level: request.level,
    feature: request.feature,
    runId: request.runId,
    chain: request.chain,
    rationale: request.rationale,
    ts: deps.now().toISOString(),
  });
  deps.append(`${JSON.stringify(entry)}\n`);
  return entry;
}
