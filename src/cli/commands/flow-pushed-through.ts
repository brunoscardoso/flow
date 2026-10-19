/**
 * The one writer of a `pushed_through` rounds entry —
 * `planflow-ai flow pushed-through <stop>`.
 *
 * An enforced autopilot run goes past four stops it used to honour: a wave file
 * conflict, a contract conflict, a withheld behavioural repair, and a failing
 * lint gate (discovery D3). That is a real behaviour change, and R5 says it
 * belongs in the run record rather than in silence.
 *
 * THIS VERB DOES NOT PUSH ANYTHING THROUGH. Three of the four stops are steps of
 * the `/execute-plan` SKILL — prose a coordinator follows — so no module can
 * force them, and this one does not pretend to (`../state/quality-stops.ts` has
 * the table of which is which). What it owns is the SHAPE: the stop vocabulary,
 * the envelope, the append. A coordinator instructed to record a push-through
 * calls this instead of composing JSON from a paragraph, so the record cannot
 * drift into four spellings of the same fact (allowed-pattern #14).
 *
 * Append-only, like every other writer of this file. Nothing is ever rewritten
 * and nothing already in the record is read for permission to write.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  QUALITY_STOPS,
  buildPushedThroughEntry,
  isQualityStop,
} from '../state/quality-stops.js';
import { ROUNDS_FILE } from '../state/workflow-stages.js';
import type { PushedThroughEntry, QualityStop } from '../state/quality-stops.js';

/** Every spelling this verb accepts, for the unknown-stop refusal. */
export function qualityStopVocabulary(): string {
  return QUALITY_STOPS.join('|');
}

/** The stop a caller named, or a throw naming what it should have been. */
export function requireQualityStop(named: string): QualityStop {
  const normalized = named.trim().toLowerCase();
  if (!isQualityStop(normalized)) {
    throw new Error(`unknown stop '${named}' — expected ${qualityStopVocabulary()}`);
  }
  return normalized;
}

/** What the verb was told to record. */
export interface PushedThroughRequest {
  stop: QualityStop;
  feature: string;
  runId: string;
  chain: string | null;
  detail: string | null;
}

/** The one place the clock enters. Injectable so a test can read what it asserts. */
export interface PushedThroughDeps {
  now: () => Date;
  append: (line: string) => void;
}

/** The real writer — creates the flow directory if this is the record's first line. */
export function pushedThroughDeps(flowDir: string): PushedThroughDeps {
  return {
    now: () => new Date(),
    append: (line: string) => {
      mkdirSync(flowDir, { recursive: true });
      appendFileSync(join(flowDir, ROUNDS_FILE), line, 'utf-8');
    },
  };
}

/**
 * Record that an enforced run went past one stop.
 *
 * Returns the entry it wrote, so the verb's result object carries the fact
 * rather than a claim about it.
 */
export function recordPushedThrough(
  flowDir: string,
  request: PushedThroughRequest,
  deps: PushedThroughDeps = pushedThroughDeps(flowDir),
): PushedThroughEntry {
  const entry = buildPushedThroughEntry({
    stop: request.stop,
    feature: request.feature,
    runId: request.runId,
    chain: request.chain,
    detail: request.detail,
    ts: deps.now().toISOString(),
  });
  deps.append(`${JSON.stringify(entry)}\n`);
  return entry;
}
