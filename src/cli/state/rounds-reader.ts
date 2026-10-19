/**
 * Rounds reader — fail-soft line reader for `flow/.rounds.jsonl`.
 *
 * The rounds file is the append-only execution record written by the
 * `/execute-plan` coordinator (envelope documented in
 * `.claude/resources/skills/execute-plan-skill.md`, "Rounds Record").
 * This module does the I/O only; interpretation lives in
 * `resume-evaluator.ts`, which is pure.
 *
 * `RoundsEntry` is intentionally minimal and co-located here rather than in
 * `types.ts` — that file's header documents rounds shapes as doc-defined,
 * not centrally typed. Only the fields the resume evaluator needs are named;
 * everything else passes through via the index signature.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUNDS_FILENAME = '.rounds.jsonl';

/**
 * One parsed line of `flow/.rounds.jsonl`.
 *
 * All fields are optional: older rounds files predate some fields (e.g.
 * `planHash`), and legacy entries may use string phases (`"P1"`) — the
 * evaluator treats anything it cannot interpret conservatively.
 */
export interface RoundsEntry {
  ts?: string;
  run_id?: string;
  type?: string;
  phase?: number | string | null;
  status?: string;
  plan?: string;
  planHash?: string;
  [key: string]: unknown;
}

/**
 * Read and parse `flow/.rounds.jsonl` from a flow directory.
 *
 * Fail-soft by design: a missing file, an unreadable file, or any malformed
 * line yields no error and no log output — malformed lines are skipped and a
 * missing/unreadable file returns `[]`. Only lines that parse to a JSON
 * object are returned.
 */
export function readRoundsEntries(flowDir: string): RoundsEntry[] {
  const filePath = join(flowDir, ROUNDS_FILENAME);

  if (!existsSync(filePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: RoundsEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        entries.push(parsed as RoundsEntry);
      }
    } catch {
      // Malformed line — skip silently (fail-soft)
    }
  }

  return entries;
}
