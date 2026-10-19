/**
 * The big/small verdict — `flow/loops/classifications.jsonl`.
 *
 * A consumer run has to decide whether the item it claimed is SMALL (fix it
 * directly) or BIG (run the project's own pipeline, one stage per run). That
 * judgment needs to read the item, so it belongs to the agent — no model call
 * ever enters a CLI verb, and this module contains no heuristic that pretends
 * to make the call itself.
 *
 * WHAT THE CLI ENFORCES IS THAT THE VERDICT EXISTS, NOT WHAT IT SAYS. A run
 * that starts work without having recorded one is the failure mode this store
 * exists to prevent: a "quick fix" that silently turned into a rewrite, with no
 * discovery document, no plan, and nothing in the record saying anyone ever
 * decided it was small. `requireVerdict` is that gate, in one code path
 * (allowed-pattern #14), so no run prompt has to be told to classify first.
 *
 * APPEND-ONLY, FAIL-SOFT PER LINE — the run log's shape, deliberately not a
 * fifth invention. A re-classification is a NEW line, and the latest one wins:
 * a run that discovers halfway through that "small" was wrong records `big`
 * and the record shows both the original call and the correction.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlLines } from '../blueprint/store.js';
import { LOOPS_DIRNAME } from './directive-parser.js';

/** Filename of the classification log inside `<flowDir>/loops/`. */
export const CLASSIFY_FILENAME = 'classifications.jsonl';

/**
 * The two verdicts.
 *
 * - `small` — fixed directly this run; skips the DOCUMENTS, never the rails
 * - `big` — runs `/discovery-plan → /create-plan → /execute-plan → /review-pr`,
 *   one stage per run, holding the pipeline lock for the duration
 */
export type WorkVerdict = 'big' | 'small';

/** Every verdict, for validation and refusal messages. */
export const WORK_VERDICTS: readonly WorkVerdict[] = ['big', 'small'];

/** Whether a value is a known verdict. */
export function isWorkVerdict(value: string): value is WorkVerdict {
  return (WORK_VERDICTS as readonly string[]).includes(value);
}

/** One recorded judgment about one queue item. */
export interface ClassificationRecord {
  /** ISO timestamp. */
  ts: string;
  loop: string;
  /** Queue item id the verdict is about. */
  id: string;
  verdict: WorkVerdict;
  /** The run that recorded it. */
  owner?: string;
  /** Why — the agent's own one-line rationale. */
  detail?: string;
}

/** Absolute path of the classification log for a flow directory. */
export function classifyPath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, CLASSIFY_FILENAME);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one raw record, or null when a required field is missing or malformed. */
export function parseClassification(raw: unknown): ClassificationRecord | null {
  if (!isRecordObject(raw)) return null;
  if (typeof raw.ts !== 'string' || raw.ts.length === 0) return null;
  if (typeof raw.loop !== 'string' || raw.loop.length === 0) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.verdict !== 'string' || !isWorkVerdict(raw.verdict)) return null;

  const record: ClassificationRecord = {
    ts: raw.ts,
    loop: raw.loop,
    id: raw.id,
    verdict: raw.verdict,
  };
  if (typeof raw.owner === 'string' && raw.owner.length > 0) record.owner = raw.owner;
  if (typeof raw.detail === 'string' && raw.detail.length > 0) record.detail = raw.detail;
  return record;
}

/** Read every recorded classification, in file order. A missing file is none. */
export function readClassifications(flowDir: string): ClassificationRecord[] {
  const records: ClassificationRecord[] = [];
  for (const line of readJsonlLines(classifyPath(flowDir))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: a corrupt line costs itself, never the whole read
      continue;
    }
    const record = parseClassification(parsed);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Append one verdict — the ONLY writer of the classification log. */
export function appendClassification(flowDir: string, record: ClassificationRecord): void {
  const filePath = classifyPath(flowDir);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * The verdict in force for one item, or null when none was recorded. Pure — the
 * LAST matching record wins, so a correction supersedes without rewriting
 * anything.
 */
export function latestVerdict(
  records: readonly ClassificationRecord[],
  loop: string,
  id: string,
): ClassificationRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.loop === loop && record.id === id) return record;
  }
  return null;
}

/**
 * The gate: the verdict for an item, or a throw naming what to do about its
 * absence. Every caller that needs to know big-vs-small comes through here, so
 * "work started without a recorded verdict" has exactly one place it can be
 * caught, and it is code rather than prompt discipline.
 */
export function requireVerdict(
  records: readonly ClassificationRecord[],
  loop: string,
  id: string,
): ClassificationRecord {
  const record = latestVerdict(records, loop, id);
  if (record === null) {
    throw new Error(
      `item ${id} has no recorded classification — record one with \`loop classify --record --loop ${loop} --id ${id} --verdict big|small\` before starting work`,
    );
  }
  return record;
}
