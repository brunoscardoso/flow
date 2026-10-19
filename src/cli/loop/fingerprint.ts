/**
 * Fingerprints — the dedup key every loop queue is read through.
 *
 * A producer runs unattended, hour after hour, over a repo whose problems do
 * not change nearly as fast as its runs do. Without a dedup key it re-files
 * the same finding every night, and a queue that repeats itself is a queue
 * people stop reading — which costs the whole feature its value, silently.
 *
 * THE KEY IS COMPUTED, THEN EMBEDDED. `sha1(loop + normalizedTitle +
 * primaryFile)` is written into the filed item's body as
 * `<!-- loop-fp: <hash> -->`, so a later search matches an exact 40-character
 * string instead of guessing at title similarity. Title-similarity dedup was
 * rejected: it needs a threshold, a threshold needs judgment, and judgment in
 * the dedup path is how both halves of the failure mode arrive at once —
 * duplicates that slip through AND distinct findings collapsed into one.
 *
 * NORMALIZATION IS THE WHOLE TRICK, and it is deliberately lossy in exactly
 * three ways (`normalizeTitle`): case, punctuation, and digit runs. Two honest
 * reports of one finding differ cosmetically — "(line 42)" vs ", line 118!",
 * "Fix:" vs "fix" — and every one of those differences is noise the key must
 * not see. What it must still see is the words, so nothing else is collapsed.
 *
 * PURE. No I/O, no clock, no model call — the same inputs always produce the
 * same hash, on any machine, in any run.
 */

import { createHash } from 'node:crypto';

/** Length of a fingerprint in hex characters (sha1). */
export const FINGERPRINT_LENGTH = 40;

/** Shape of a valid fingerprint — lowercase hex, full sha1 width. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{40}$/;

/** Whether a value is a well-formed fingerprint. */
export function isFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}

/**
 * Separator between fingerprint fields.
 *
 * NUL rather than a newline or a dash: normalization never emits it, so no
 * field's content can impersonate a field boundary. (`loop: "a", title: "b c"`
 * and `loop: "a b", title: "c"` must not hash alike.)
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * Normalize a title down to the words it is made of.
 *
 * Three lossy steps, in order, each earning its place:
 *
 *   1. PUNCTUATION → space. `queue.ts` and `queue ts`, `Fix:` and `Fix` are the
 *      same report typed by two agents. Any non-letter, non-number character in
 *      ANY script collapses, so accented and non-Latin titles keep their words
 *      instead of being erased.
 *   2. CASE → lower. Sentence case, title case and a shouted title are one
 *      finding.
 *   3. DIGIT RUNS → `#`. Line numbers, counts and occurrence tallies drift
 *      between two reports of one problem, and they are the single most common
 *      cosmetic difference. A placeholder rather than deletion, so "fix 2 leaks"
 *      and "fix leaks" stay distinct.
 *
 * THE ACCEPTED COST, stated plainly: two titles differing ONLY in a number —
 * "upgrade react 17" vs "upgrade react 18" — collide. That is a real false
 * merge, and it is bounded, because a fingerprint also carries the loop and the
 * primary file: the collision can only happen within one loop, about one file,
 * with otherwise identical wording. Under those conditions the second report is
 * far more often a re-report than a new finding.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .replace(/\p{N}+/gu, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize the primary file path — separators, redundant prefixes, and case.
 *
 * DIGITS ARE NOT COLLAPSED here, unlike in a title: `plan_x_v1.md` and
 * `plan_x_v2.md` are different files, and `phase-1.ts` is not `phase-2.ts`. The
 * digit rule exists for line numbers, which live in titles and never in paths.
 *
 * Case IS folded, and that is the one debatable call. On a case-sensitive
 * filesystem `src/Foo.ts` and `src/foo.ts` could genuinely differ, so folding
 * risks a false merge — but only for two files whose names differ by case alone,
 * reported by the same loop, under the same normalized title. The opposite error
 * (a dedup MISS from `src/Foo.ts` vs `src/foo.ts`) refills the queue with
 * duplicates, which is the failure this module exists to prevent. Miss-avoidance
 * wins.
 */
export function normalizePrimaryFile(file: string): string {
  return file
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The three facts a fingerprint is computed from. */
export interface FingerprintInput {
  /** The loop that found it — two loops may legitimately report one file. */
  loop: string;
  /** The finding's title, as reported. Normalized here, never by the caller. */
  title: string;
  /**
   * The file the finding is primarily about. Optional: some findings are about
   * a dependency, a config value or the repo as a whole, and an absent primary
   * file is an honest empty field rather than an invented path.
   */
  primaryFile?: string;
}

/** The normalized fields a fingerprint is computed over — the audit trail. */
export interface NormalizedFingerprintInput {
  loop: string;
  title: string;
  primaryFile: string;
}

/**
 * Normalize a fingerprint input. Exported so a refusal, a log line or a test can
 * show WHY two reports collided (or did not) without re-deriving the rules.
 */
export function normalizeFingerprintInput(input: FingerprintInput): NormalizedFingerprintInput {
  return {
    loop: input.loop.trim().toLowerCase(),
    title: normalizeTitle(input.title),
    primaryFile:
      input.primaryFile === undefined ? '' : normalizePrimaryFile(input.primaryFile),
  };
}

/**
 * Compute a finding's fingerprint: `sha1(loop + normalizedTitle + primaryFile)`.
 *
 * Deterministic and total — an empty title yields a hash like any other, because
 * refusing here would push the decision into a caller that has no better answer.
 * (Emptiness is refused where it can be reported: filing.)
 */
export function loopFingerprint(input: FingerprintInput): string {
  const normalized = normalizeFingerprintInput(input);
  return createHash('sha1')
    .update(
      [normalized.loop, normalized.title, normalized.primaryFile].join(FIELD_SEPARATOR),
      'utf-8',
    )
    .digest('hex');
}

// ── the body marker (the searchable half) ────────────────
//
// The hash is only useful if it survives into the filed item, where a later
// run can search for it. The marker is an HTML comment, so it renders as
// nothing on GitHub and reads as nothing in a ledger body, while remaining an
// exact string match for both backends.

/** The marker as written into a filed body. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- loop-fp: ${fingerprint} -->`;
}

/** Matches a fingerprint marker anywhere in a body, tolerant of extra spacing. */
export const FINGERPRINT_MARKER_PATTERN = /<!--\s*loop-fp:\s*([0-9a-f]{40})\s*-->/;

/** The fingerprint carried by a body, or null when it carries none. */
export function extractFingerprint(body: string): string | null {
  const match = body.match(FINGERPRINT_MARKER_PATTERN);
  return match === null ? null : match[1];
}

/**
 * Whether a body carries EXACTLY this fingerprint.
 *
 * This is the real dedup test. A backend search (GitHub's, above all) is fuzzy
 * and may return items that merely mention the hash-shaped string; the exact
 * marker check is what turns a fuzzy candidate list into a yes/no answer.
 */
export function bodyHasFingerprint(body: string, fingerprint: string): boolean {
  return extractFingerprint(body) === fingerprint;
}

/** Remove every fingerprint marker from a body — used when re-composing one. */
export function stripFingerprintMarker(body: string): string {
  return body.replace(new RegExp(FINGERPRINT_MARKER_PATTERN.source, 'g'), '').trim();
}
