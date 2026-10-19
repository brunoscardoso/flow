// Review-verdict writer (Board Review Mode, #609) — the MAIN-process I/O
// boundary that records one board file decision as a `review_verdict` rounds
// entry, appended to `<root>/flow/.rounds.jsonl` (schema in
// `.claude/resources/skills/execute-plan-skill.md`).
//
// `buildReviewVerdictEntry` is a pure, clock-free entry builder; everything
// except `appendReviewVerdict` is deterministic. The writer is the I/O
// boundary, so it is the one place that reads a real clock (injectable for
// tests). Fail-soft: an unwritable rounds file logs and returns `{ ok: false }`
// rather than throwing across the IPC boundary.
//
// This module touches only node:fs/path (no Electron) — plain-Node loadable,
// same discipline as learn-run-triggers.ts (which tail-reads the same file).

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROUNDS_FILE = '.rounds.jsonl'

// ── Pure entry model (mirror of renderer's ReviewVerdictEntry) ─────────────

/** How a board review finding was resolved — `kept` (finding stands) or
 *  `dismissed` (finding waved off). Mirrors the rounds `classification` field. */
export type ReviewClassification = 'kept' | 'dismissed'

/** A blueprint file anchor — all a board file-verdict needs to be promotable
 *  into the annotation stream. */
export interface ReviewVerdictAnchor {
  kind: 'file'
  ref: string
  file: string
}

/**
 * A `review_verdict` rounds entry (append-only `flow/.rounds.jsonl`). Shape is
 * IDENTICAL to the renderer's `ReviewVerdictEntry`: `phase` is always `null`,
 * `finding_fingerprint` is the `<file>+file-change+board-review` string,
 * `classification` is `kept`/`dismissed`, `reason` is free text (never omitted —
 * empty string when none), and `anchors` carries the file anchor for promotion.
 */
export interface ReviewVerdictEntry {
  ts: string
  run_id: string
  type: 'review_verdict'
  phase: null
  finding_fingerprint: string
  classification: ReviewClassification
  reason: string
  anchors: ReviewVerdictAnchor[]
}

/**
 * Fingerprint for a board-review verdict. The rounds schema fingerprints a
 * finding as `<file>+<title>+<category>`; board Review Mode decides a whole file
 * at once (no per-line title/category), so it uses the stable file-level
 * convention `<file>+file-change+board-review` — one verdict per changed file.
 */
export function buildVerdictFingerprint(file: string): string {
  return `${file}+file-change+board-review`
}

/**
 * Derive the per-day board-review run id `board-review-<YYYYMMDD>` from a date.
 * Uses UTC so the id is stable regardless of the host timezone.
 */
export function boardReviewRunId(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0')
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = date.getUTCDate().toString().padStart(2, '0')
  return `board-review-${yyyy}${mm}${dd}`
}

/**
 * Build a `review_verdict` rounds entry for a board file decision. Pure — `ts`
 * and `runId` are supplied by the caller (no clock read here). `reason` defaults
 * to the empty string so the field is always present.
 */
export function buildReviewVerdictEntry(input: {
  file: string
  classification: ReviewClassification
  reason?: string
  runId: string
  ts: string
}): ReviewVerdictEntry {
  return {
    ts: input.ts,
    run_id: input.runId,
    type: 'review_verdict',
    phase: null,
    finding_fingerprint: buildVerdictFingerprint(input.file),
    classification: input.classification,
    reason: input.reason ?? '',
    anchors: [{ kind: 'file', ref: input.file, file: input.file }],
  }
}

// ── I/O boundary (real clock lives here) ───────────────────────────────────

/** Injectable clock — production reads `new Date()`; tests pin it. */
export type Clock = () => Date

/**
 * Append one `review_verdict` entry to `<rootPath>/flow/.rounds.jsonl`. The
 * `ts`/`run_id` are stamped from `clock()` at this boundary. The file is created
 * on first write (fs append mode) and existing content is never rewritten — one
 * JSON object per line, newline-terminated. Fail-soft: any error (bad path,
 * unwritable file) is logged and reported as `{ ok: false }` — never thrown.
 */
export async function appendReviewVerdict(
  rootPath: string,
  input: { filePath: string; classification: ReviewClassification; reason?: string },
  clock: Clock = () => new Date(),
): Promise<{ ok: boolean; fingerprint: string }> {
  const fingerprint = buildVerdictFingerprint(input.filePath)
  try {
    const now = clock()
    const entry = buildReviewVerdictEntry({
      file: input.filePath,
      classification: input.classification,
      reason: input.reason,
      runId: boardReviewRunId(now),
      ts: now.toISOString(),
    })
    const roundsPath = join(rootPath, 'flow', ROUNDS_FILE)
    await appendFile(roundsPath, `${JSON.stringify(entry)}\n`, 'utf-8')
    return { ok: true, fingerprint }
  } catch (error) {
    console.warn(
      `[ReviewVerdictWriter] failed to append verdict for ${rootPath}/${input.filePath}`,
      error,
    )
    return { ok: false, fingerprint }
  }
}
