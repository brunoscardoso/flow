/**
 * Promotion of anchored run records into the annotation stream.
 *
 * Reads `<flowDir>/.rounds.jsonl` (doc-defined envelope — see the Rounds
 * Record section of `.claude/resources/skills/execute-plan-skill.md`) and
 * `<flowDir>/.wave-context.jsonl` (ContextEntry lines), selects records
 * carrying a non-empty `anchors` array, and appends them as annotations in
 * `flow/brain/.structure/annotations.jsonl`.
 *
 * Rounds-record mapping (anchored records only):
 *
 * | Rounds type      | Annotation type          | Text                                                                    |
 * |------------------|--------------------------|-------------------------------------------------------------------------|
 * | `plan_decision`  | `decision`               | `<decision>: <choice>`                                                   |
 * | `run_intent`     | `decision`               | `Run <plan>: <intent_goal> — <originating_request>`                      |
 * | `phase_result`   | `claim` (selective)      | `Phase <phase> (<plan>): <summary> — decisions: <…>; deviations: <…>`    |
 * | `review_verdict` | `rule` (kept) / `claim`  | `<finding_fingerprint>: <reason>`                                        |
 * | `escalation`     | `claim`                  | `<what>: <choice>`                                                       |
 * | `risk`           | `claim`                  | `<risk_level>: <risk_rationale>`                                         |
 * | other            | `claim`                  | `<type>: <summary>`                                                      |
 *
 * `run_intent` provenance uses the record's own `run_id` (the originating
 * run), not the promotion pass's `runId` parameter. `phase_result` records
 * are promoted only when they carry decisions and/or deviations — routine
 * phase completions never enter the annotation stream (bounded growth).
 *
 * Both source files are optional (absent → treated as empty); malformed
 * lines are skipped and counted, never silently swallowed. Well-formed
 * records that simply aren't promotable (unanchored, or a decision-less
 * `phase_result`) are silent non-candidates — not skip-counted. Promotion
 * is idempotent — records whose fingerprint already exists in the effective
 * annotation stream are skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextEntry, ContractData, DecisionData } from '../state/types.js';
import { annotationFingerprint, appendAnnotation, readAnnotations } from './store.js';
import type { Anchor, AnnotationEntry, AnnotationType } from './types.js';

const ROUNDS_FILENAME = '.rounds.jsonl';
const WAVE_CONTEXT_FILENAME = '.wave-context.jsonl';
const ANCHOR_KINDS = ['symbol', 'file', 'table', 'endpoint', 'module'] as const;

/** Counts produced by a promotion pass. */
export interface PromoteResult {
  /** Records appended to the annotation stream. */
  promoted: number;
  /** Malformed lines plus records skipped as already-promoted duplicates. */
  skipped: number;
}

/** A rounds record after envelope validation (type-specific fields untyped). */
interface RoundsRecord {
  ts: string;
  type: string;
  anchors: Anchor[];
  [key: string]: unknown;
}

/** Read all non-empty lines from a JSONL file; absent/unreadable → empty. */
function readJsonlLines(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return content.split('\n').filter((line) => line.trim().length > 0);
}

/** Validate an unknown value as a non-empty array of well-formed anchors. */
function parseAnchors(value: unknown): Anchor[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const anchors: Anchor[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      return null;
    }
    const anchor = candidate as Partial<Anchor>;
    if (typeof anchor.ref !== 'string' || !ANCHOR_KINDS.includes(anchor.kind as never)) {
      return null;
    }
    anchors.push(
      anchor.file === undefined
        ? { kind: anchor.kind as Anchor['kind'], ref: anchor.ref }
        : { kind: anchor.kind as Anchor['kind'], ref: anchor.ref, file: String(anchor.file) },
    );
  }
  return anchors;
}

/** Read a string field off an untyped record, defaulting to empty. */
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Read a string-array field off an untyped record, keeping only non-empty strings. */
function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Join the non-empty parts of a record's salient fields into annotation text. */
function joinSalient(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(': ');
}

/** An annotation candidate mapped from one rounds record. */
interface MappedRoundsRecord {
  type: AnnotationType;
  text: string;
  /** Overrides the default `rounds:<type> run:<runId>` provenance when set. */
  provenance?: string;
}

/**
 * Map a `run_intent` record (a run's plan goal + originating request) to a
 * decision annotation. Missing fields are omitted gracefully; provenance
 * carries the record's own `run_id` — the run the intent belongs to — not
 * the promotion pass's runId parameter.
 */
function mapRunIntentRecord(record: RoundsRecord): MappedRoundsRecord {
  const plan = stringField(record, 'plan');
  const head = plan.length > 0 ? `Run ${plan}` : 'Run';
  const body = [stringField(record, 'intent_goal'), stringField(record, 'originating_request')]
    .filter((part) => part.length > 0)
    .join(' — ');
  const recordRunId = stringField(record, 'run_id');
  return {
    type: 'decision',
    text: body.length > 0 ? `${head}: ${body}` : head,
    provenance: `rounds:run_intent${recordRunId.length > 0 ? ` run:${recordRunId}` : ''}`,
  };
}

/**
 * Map a `phase_result` record to a claim annotation — but only when the
 * phase actually carried decisions or deviations. Routine anchored phase
 * completions return null (a valid record that just isn't promotable — a
 * silent non-candidate, distinct from malformed lines which are
 * skip-counted). This keeps annotation growth bounded to decision-bearing
 * phases.
 */
function mapPhaseResultRecord(record: RoundsRecord): MappedRoundsRecord | null {
  const decisions = stringArrayField(record, 'decisions');
  const deviations = stringArrayField(record, 'deviations');
  if (decisions.length === 0 && deviations.length === 0) {
    return null;
  }

  const phase = record.phase;
  const phaseLabel = typeof phase === 'number' || typeof phase === 'string' ? String(phase) : '';
  const plan = stringField(record, 'plan');
  let head = phaseLabel.length > 0 ? `Phase ${phaseLabel}` : 'Phase';
  if (plan.length > 0) {
    head += ` (${plan})`;
  }

  const detailParts: string[] = [];
  if (decisions.length > 0) {
    detailParts.push(`decisions: ${decisions.join(', ')}`);
  }
  if (deviations.length > 0) {
    detailParts.push(`deviations: ${deviations.join(', ')}`);
  }
  const summary = stringField(record, 'summary');
  const detail = [summary, detailParts.join('; ')].filter((part) => part.length > 0).join(' — ');

  return { type: 'claim', text: `${head}: ${detail}` };
}

/**
 * Map a rounds record to its annotation candidate; null when the record is
 * valid but not promotable (currently only decision-less `phase_result`).
 */
function mapRoundsRecord(record: RoundsRecord): MappedRoundsRecord | null {
  switch (record.type) {
    case 'plan_decision':
      return {
        type: 'decision',
        text: joinSalient(stringField(record, 'decision'), stringField(record, 'choice')),
      };
    case 'run_intent':
      return mapRunIntentRecord(record);
    case 'phase_result':
      return mapPhaseResultRecord(record);
    case 'review_verdict':
      return {
        type: stringField(record, 'classification') === 'kept' ? 'rule' : 'claim',
        text: joinSalient(stringField(record, 'finding_fingerprint'), stringField(record, 'reason')),
      };
    case 'escalation':
      return {
        type: 'claim',
        text: joinSalient(stringField(record, 'what'), stringField(record, 'choice')),
      };
    case 'risk':
      return {
        type: 'claim',
        text: joinSalient(stringField(record, 'risk_level'), stringField(record, 'risk_rationale')),
      };
    default:
      // Any other anchored rounds record is promoted as a claim about the run
      return {
        type: 'claim',
        text: joinSalient(record.type, stringField(record, 'summary')),
      };
  }
}

/** Outcome of parsing one source line: a candidate, malformed, or not a candidate. */
type ParseOutcome<T> = { kind: 'candidate'; value: T } | { kind: 'malformed' } | { kind: 'not-candidate' };

const MALFORMED: ParseOutcome<never> = { kind: 'malformed' };
const NOT_CANDIDATE: ParseOutcome<never> = { kind: 'not-candidate' };

/** Parse one rounds line into a candidate record. */
function parseRoundsLine(line: string): ParseOutcome<RoundsRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return MALFORMED;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return MALFORMED;
  }

  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.type !== 'string') {
    return MALFORMED;
  }

  const anchors = parseAnchors(envelope.anchors);
  if (anchors === null) {
    // Well-formed but unanchored (or invalid anchors) — not a candidate.
    // Backward compatible: records without anchors parse unchanged.
    return NOT_CANDIDATE;
  }

  return {
    kind: 'candidate',
    value: { ...envelope, ts: stringField(envelope, 'ts'), type: envelope.type, anchors },
  };
}

/** Parse one wave-context line into a promotable ContextEntry. */
function parseWaveContextLine(line: string): ParseOutcome<ContextEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return MALFORMED;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return MALFORMED;
  }

  const entry = parsed as Partial<ContextEntry>;
  if (typeof entry.type !== 'string' || typeof entry.data !== 'object' || entry.data === null) {
    return MALFORMED;
  }

  if (entry.type !== 'contract' && entry.type !== 'decision') {
    // progress entries (and unknown types) are never promoted
    return NOT_CANDIDATE;
  }

  return { kind: 'candidate', value: entry as ContextEntry };
}

/** Map an anchored wave-context entry to an annotation candidate; null when unanchored. */
function mapWaveContextEntry(
  entry: ContextEntry,
): { type: AnnotationType; text: string; anchors: Anchor[]; ts: string; sourceType: string } | null {
  const anchors = parseAnchors((entry.data as ContractData | DecisionData).anchors);
  if (anchors === null) {
    return null;
  }

  if (entry.type === 'contract') {
    const data = entry.data as ContractData;
    return {
      type: 'claim',
      text: joinSalient(data.name ?? '', data.signature ?? ''),
      anchors,
      ts: entry.timestamp ?? '',
      sourceType: 'contract',
    };
  }

  const data = entry.data as DecisionData;
  return {
    type: 'decision',
    text: joinSalient(data.choice ?? '', data.reason ?? ''),
    anchors,
    ts: entry.timestamp ?? '',
    sourceType: 'decision',
  };
}

/**
 * Promote anchored records from the run's rounds and wave-context files into
 * the annotation stream. Idempotent via fingerprint dedup against the
 * effective annotations (and within the pass itself).
 *
 * Returns `{ promoted, skipped }` where `skipped` counts malformed lines and
 * already-promoted duplicates.
 */
export function promoteRunRecords(
  flowDir: string,
  runId: string | null,
): PromoteResult {
  const seenFingerprints = new Set(
    readAnnotations(flowDir).map((entry) => annotationFingerprint(entry)),
  );

  let promoted = 0;
  let skipped = 0;

  const appendIfNew = (candidate: AnnotationEntry): void => {
    const fingerprint = annotationFingerprint(candidate);
    if (seenFingerprints.has(fingerprint)) {
      skipped += 1;
      return;
    }
    appendAnnotation(flowDir, candidate);
    seenFingerprints.add(fingerprint);
    promoted += 1;
  };

  for (const line of readJsonlLines(join(flowDir, ROUNDS_FILENAME))) {
    const result = parseRoundsLine(line);
    if (result.kind === 'malformed') {
      skipped += 1;
      continue;
    }
    if (result.kind === 'not-candidate') {
      continue;
    }

    const mapped = mapRoundsRecord(result.value);
    if (mapped === null) {
      // Valid record, just not promotable (e.g. decision-less phase_result)
      // — a silent non-candidate, never skip-counted.
      continue;
    }
    appendIfNew({
      ts: result.value.ts,
      runId,
      type: mapped.type,
      text: mapped.text,
      anchors: result.value.anchors,
      provenance:
        mapped.provenance ?? `rounds:${result.value.type}${runId === null ? '' : ` run:${runId}`}`,
      status: 'active',
    });
  }

  for (const line of readJsonlLines(join(flowDir, WAVE_CONTEXT_FILENAME))) {
    const result = parseWaveContextLine(line);
    if (result.kind === 'malformed') {
      skipped += 1;
      continue;
    }
    if (result.kind === 'not-candidate') {
      continue;
    }

    const candidate = mapWaveContextEntry(result.value);
    if (candidate === null) {
      continue;
    }

    appendIfNew({
      ts: candidate.ts,
      runId,
      type: candidate.type,
      text: candidate.text,
      anchors: candidate.anchors,
      provenance: `wave-context:${candidate.sourceType}${runId === null ? '' : ` run:${runId}`}`,
      status: 'active',
    });
  }

  return { promoted, skipped };
}
