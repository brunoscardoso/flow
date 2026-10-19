/**
 * The run log — `flow/loops/runs.jsonl`.
 *
 * One structured line per run, plus the steering events (pause / resume /
 * approve) that explain why the runs around them look the way they do. It is
 * the only place that can answer "what have the loops actually been doing",
 * which is what both the session-start summary and the IDE panel ask.
 *
 * APPEND-ONLY, FAIL-SOFT PER LINE — the same shape as `ledger-queue.ts` and its
 * two older siblings, and deliberately not a fifth invention. A corrupt line
 * costs itself and nothing else: a log that refuses to be read is a log that
 * makes a run fail for a reason unrelated to the work.
 *
 * NO LOCK. Unlike the ledger, nothing here is derived from what is already in
 * the file — a run line carries its own content — so there is no sequence two
 * writers could fork. Appends of a single short line are the one case where the
 * lock would buy nothing.
 *
 * PURE DIGEST. `digestRunLog` is a fold over entries with no clock and no I/O,
 * so the roll-up the panel renders and the roll-up the CLI prints are the same
 * numbers computed once.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlLines } from '../blueprint/store.js';
import { LOOPS_DIRNAME } from './directive-parser.js';
import { isLoopStopCondition } from './types.js';
import type { LoopRunOutcome, LoopGateVerdict, LoopStopCondition } from './types.js';

/** Filename of the run log inside `<flowDir>/loops/`. */
export const RUN_LOG_FILENAME = 'runs.jsonl';

/**
 * What the log was called when a run was called a run.
 *
 * READ-ONLY, AND ONLY WHEN THE CURRENT FILE IS ABSENT. Every project that ran a
 * loop before the rename has its whole history in this file, and a rename that
 * silently starts counting from zero would answer "what have the loops been
 * doing" with a lie. Nothing ever writes here again — the first append after the
 * rename creates `runs.jsonl`, and from then on the old file is ignored.
 */
export const LEGACY_RUN_LOG_FILENAME = 'beats.jsonl';

/**
 * What a line records.
 *
 * - `run` — a run that ran (or was gated) and ended
 * - `pause` / `resume` — a steering decision, with its reason
 * - `approve` — a gate a human (or the panel) cleared
 * - `adopt` — a person took an item no loop filed into a loop
 * - `merge` — a loop landed its own branch, on captured evidence
 *
 * `adopt` is deliberately its own kind rather than folded into `approve`: they
 * are different decisions (one clears a gate on the loop's own item, the other
 * hands the loop someone else's), and an audit that could not tell them apart
 * would answer "who decided this loop could work that issue" with the wrong
 * line. It adds no digest counter — the roll-up's shape is mirrored across the
 * IPC contract and the panel, and a rare human act does not earn a schema
 * change to be readable in `loop log`.
 *
 * `merge` is its own kind for the same reason and one more: it is the only line
 * in this log recording that a loop changed the default branch. "What landed
 * overnight, and on what evidence" has to be answerable from the log alone
 * without opening a queue, and a merge folded into the run line would be
 * invisible in a run that also filed, closed and escalated.
 */
export type RunLogKind =
  | 'run'
  | 'beat'
  | 'pause'
  | 'resume'
  | 'approve'
  | 'adopt'
  | 'rework'
  | 'push'
  | 'merge';

/** Every kind, for validation. */
export const RUN_LOG_KINDS: readonly RunLogKind[] = [
  'run',
  'beat',
  'pause',
  'resume',
  'approve',
  'adopt',
  'rework',
  'push',
  'merge',
];

/** Whether a value is a known kind. */
export function isRunLogKind(value: string): value is RunLogKind {
  return (RUN_LOG_KINDS as readonly string[]).includes(value);
}

/**
 * The kind a finished turn of a loop records. Written as `run`.
 *
 * `run` is the same fact under its old name, and it is still ACCEPTED: every
 * line already in a project's log says `run`, and a reader that stopped
 * recognising them would report that the loops had never run. Nothing writes it
 * again.
 */
export const RUN_KIND: RunLogKind = 'run';

/** Whether this line records a finished turn, under either name. */
export function isRunKind(kind: RunLogKind): boolean {
  return kind === 'run' || kind === 'beat';
}

/**
 * One line of the run log.
 *
 * `loop` is the empty string for a GLOBAL pause or resume — the event belongs
 * to every loop, and inventing a loop name for it would make the digest attribute
 * a project-wide decision to whichever loop happened to be named.
 */
export interface RunLogEntry {
  /** ISO timestamp. */
  ts: string;
  kind: RunLogKind;
  /** The loop, or '' for a global event. */
  loop: string;
  /** Who ran the run — the lock owner. */
  owner?: string;
  /** How the run ended. Required for `run`, absent otherwise. */
  outcome?: LoopRunOutcome;
  /** The gate verdict the run opened with, when it recorded one. */
  verdict?: LoopGateVerdict;
  /** Why — a pause reason, a resume reason, a failure reason. */
  reason?: string;
  /**
   * The pipeline stage key the run worked (`pipeline-state.ts`'s `stageKey`).
   *
   * SINCE PHASE 6 IT IS ONLY WHAT THE RUN SAID. `loop log --record` used to
   * derive it when a payload named none, so the stalled-pipeline counter could
   * not depend on a prompt remembering the field; that counter is gone, and
   * paying a queue round trip to stamp a value nothing counts is a cost with no
   * reader.
   * Absent for a run that took no pipeline stage — a producer, or a direct
   * fix. It is what the stalled-pipeline policy counts attempts against, which
   * is why it is recorded on the line rather than kept in a second store.
   */
  stage?: string;
  /**
   * Which condition ended the run, from the closed vocabulary — `cap`,
   * `empty`, `budget` or `none`.
   *
   * A run works until something stops it, so "why did it stop" is the question
   * the log has to answer; free text could not be counted, and its absence is
   * what made "it did one item and halted" indistinguishable from "there was
   * nothing else to do". Absent on records written before the vocabulary
   * existed, and on steering events, which nothing stops.
   */
  stopCondition?: LoopStopCondition;
  /** Items filed this run. */
  filed?: number;
  /** Items closed this run. */
  closed?: number;
  /** How long the run took. */
  durationMs?: number;
  /**
   * Whether recording this outcome tripped the loop's breaker.
   *
   * HISTORY ONLY, SINCE PHASE 6. The breaker is gone — nothing schedules
   * unattended re-runs for it to protect any more — so nothing WRITES this
   * field. It is still read and still counted into the digest because the log is
   * append-only: entries written before the deletion carry it, and a reader
   * asking "did this loop ever trip" is asking about exactly those. A digest
   * that silently stopped counting them would rewrite the past.
   */
  breakerTripped?: boolean;
  /** Free-text note (e.g. a soft-failed pull). */
  note?: string;
  /**
   * The queue item this entry is about, when it is about one.
   *
   * `reason` already NAMES the item in prose, and prose is what a person reads;
   * this is what a CHECK reads. The stranded-work rule has to pair a `push`
   * against a `merge` for the same item, and pairing them by grepping a sentence
   * would make the invariant depend on how the sentence is worded.
   */
  item?: string;
  /**
   * What a person aimed this run at, when they aimed it.
   *
   * THIS FIELD IS WHY AIMING A BEAT BY HAND IS ALLOWED AT ALL. `/run` used to
   * refuse any word after the loop name, on the grounds that a run steered by
   * throwaway text leaves a log nobody can read back — a fair objection to
   * un-recorded steering, and this is the record. Read off the run's own lock
   * rather than from the payload, so a run cannot report an aim it did not
   * take, or forget one it did.
   */
  focus?: string;
}

/** Absolute path of the run log for a flow directory. */
export function runLogPath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, RUN_LOG_FILENAME);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse one raw record. Returns null when a REQUIRED field is missing or
 * malformed — the caller skips it and counts it.
 */
export function parseRunLogEntry(raw: unknown): RunLogEntry | null {
  if (!isRecordObject(raw)) return null;
  if (typeof raw.ts !== 'string' || raw.ts.length === 0) return null;
  if (typeof raw.kind !== 'string' || !isRunLogKind(raw.kind)) return null;
  if (typeof raw.loop !== 'string') return null;

  const entry: RunLogEntry = { ts: raw.ts, kind: raw.kind, loop: raw.loop };
  if (typeof raw.owner === 'string') entry.owner = raw.owner;
  if (raw.outcome === 'success' || raw.outcome === 'failure') entry.outcome = raw.outcome;
  if (typeof raw.verdict === 'string') entry.verdict = raw.verdict as LoopGateVerdict;
  if (typeof raw.reason === 'string') entry.reason = raw.reason;
  if (typeof raw.stage === 'string') entry.stage = raw.stage;
  // An unknown word is DROPPED rather than kept: the vocabulary is closed, and a
  // line carrying a fifth condition would make the log uncountable. The writer
  // (`loop log --record`) refuses one outright — this is the read-side half.
  if (typeof raw.stopCondition === 'string' && isLoopStopCondition(raw.stopCondition)) {
    entry.stopCondition = raw.stopCondition;
  }
  const filed = readNumber(raw.filed);
  if (filed !== undefined) entry.filed = filed;
  const closed = readNumber(raw.closed);
  if (closed !== undefined) entry.closed = closed;
  const durationMs = readNumber(raw.durationMs);
  if (durationMs !== undefined) entry.durationMs = durationMs;
  if (typeof raw.breakerTripped === 'boolean') entry.breakerTripped = raw.breakerTripped;
  if (typeof raw.note === 'string') entry.note = raw.note
  if (typeof raw.item === 'string' && raw.item.length > 0) entry.item = raw.item;
  return entry;
}

/** Raw parse of the run log, before any windowing. */
export interface ParsedRunLog {
  /** Valid entries, in file order. */
  entries: RunLogEntry[];
  /** Malformed lines skipped. */
  skipped: number;
}

/** Read and parse every line. A missing file yields empty results. */
export function parseRunLogFile(filePath: string): ParsedRunLog {
  const entries: RunLogEntry[] = [];
  let skipped = 0;
  for (const line of readJsonlLines(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: a corrupt line costs itself, never the whole read
      skipped += 1;
      continue;
    }
    const entry = parseRunLogEntry(parsed);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped };
}

/**
 * Read the run log for a flow directory, in file order — LEGACY LINES FIRST.
 *
 * This used to pick ONE file: legacy only while `runs.jsonl` did not exist. The
 * grace period that bought was exactly one write long. `appendRunLogEntry`
 * creates `runs.jsonl` with the first post-rename entry, and from that instant
 * every pre-rename line was unreachable — no merge, no migration, no copy. This
 * repo lost the 2026-08-12 global pause that way and then printed a resume with
 * no pause before it (#1576).
 *
 * The old comment justified the choice by saying a merge "would double-count
 * every line the old file already holds". That is only true if something had
 * copied `beats.jsonl` into `runs.jsonl`, and nothing ever did — the rename
 * shipped no migration, and the ONLY writer (`appendRunLogEntry`) appends
 * exclusively to `runs.jsonl`. So the two files are disjoint by construction,
 * and concatenating them is the whole history rather than a doubled one.
 *
 * Order is legacy-then-current, which is also chronological: every legacy line
 * was written before the rename and every current line after it.
 */
export function readRunLog(flowDir: string): RunLogEntry[] {
  const legacy = join(flowDir, LOOPS_DIRNAME, LEGACY_RUN_LOG_FILENAME);
  return [
    ...parseRunLogFile(legacy).entries,
    ...parseRunLogFile(runLogPath(flowDir)).entries,
  ];
}

/** Append one entry — the ONLY writer of the run log. */
export function appendRunLogEntry(flowDir: string, entry: RunLogEntry): void {
  const filePath = runLogPath(flowDir);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

// ── the digest ───────────────────────────────────────────

/** One loop's roll-up. */
export interface RunDigestRow {
  loop: string;
  beats: number;
  success: number;
  failure: number;
  filed: number;
  closed: number;
  breakerTrips: number;
  /** ISO timestamp of the most recent run in the window. */
  lastRunAt?: string;
}

/** The rolled-up digest the session summary and the panel both read. */
export interface RunDigest {
  /** Entries the digest was computed over (runs AND steering events). */
  entries: number;
  beats: number;
  success: number;
  failure: number;
  filed: number;
  closed: number;
  breakerTrips: number;
  pauses: number;
  resumes: number;
  approvals: number;
  /** Per-loop rows, sorted by loop name so two reads render identically. */
  loops: RunDigestRow[];
  /** ISO timestamp of the first entry in the window. */
  since?: string;
  /** ISO timestamp of the last entry in the window. */
  until?: string;
}

function emptyRow(loop: string): RunDigestRow {
  return { loop, beats: 0, success: 0, failure: 0, filed: 0, closed: 0, breakerTrips: 0 };
}

/**
 * Fold entries into the digest. Pure — no clock, no I/O — so the window is
 * whatever the caller passed in, and the same window always yields the same
 * numbers.
 *
 * Global events (`loop: ''`) count toward the totals but get no per-loop row:
 * a project-wide pause is not one loop's event.
 */
export function digestRunLog(entries: readonly RunLogEntry[]): RunDigest {
  const digest: RunDigest = {
    entries: entries.length,
    beats: 0,
    success: 0,
    failure: 0,
    filed: 0,
    closed: 0,
    breakerTrips: 0,
    pauses: 0,
    resumes: 0,
    approvals: 0,
    loops: [],
  };
  const rows = new Map<string, RunDigestRow>();

  for (const entry of entries) {
    const row =
      entry.loop.length === 0 ? null : (rows.get(entry.loop) ?? emptyRow(entry.loop));
    if (row !== null) rows.set(entry.loop, row);

    switch (entry.kind) {
      case 'beat':
      case 'run': {
        digest.beats += 1;
        if (row !== null) row.beats += 1;
        if (entry.outcome === 'success') {
          digest.success += 1;
          if (row !== null) row.success += 1;
        } else if (entry.outcome === 'failure') {
          digest.failure += 1;
          if (row !== null) row.failure += 1;
        }
        digest.filed += entry.filed ?? 0;
        digest.closed += entry.closed ?? 0;
        if (row !== null) {
          row.filed += entry.filed ?? 0;
          row.closed += entry.closed ?? 0;
          row.lastRunAt = entry.ts;
        }
        if (entry.breakerTripped === true) {
          digest.breakerTrips += 1;
          if (row !== null) row.breakerTrips += 1;
        }
        break;
      }
      case 'pause':
        digest.pauses += 1;
        break;
      case 'resume':
        digest.resumes += 1;
        break;
      case 'approve':
        digest.approvals += 1;
        break;
    }
  }

  digest.loops = [...rows.values()].sort((a, b) => a.loop.localeCompare(b.loop));
  if (entries.length > 0) {
    digest.since = entries[0].ts;
    digest.until = entries[entries.length - 1].ts;
  }
  return digest;
}
