/**
 * Auto-verify gate (doc-verification Phase 4) — pure helpers.
 *
 * Auto-verification covers ARRIVALS only: a NEW (or newly-unadjudicated,
 * i.e. content-changed — a changed doc voids its verdict at derive) Tier-2
 * doc may be verified automatically when the project opted in
 * (`doc_auto_verify: true` in flow/.flowconfig) and the per-session budget
 * allows. Stale-revoked verdicts are NEVER auto-re-verified — re-checking
 * expired trust is a deliberate human action (brainstorm decision #5).
 */

/** Per-session cap on automatic verifications (budget gate, T3 idiom). */
export const AUTO_VERIFY_SESSION_BUDGET = 5

/** Is the flowconfig opt-in present? Default OFF — auto costs agent runs. */
export function parseDocAutoVerify(configRaw: string | null): boolean {
  if (configRaw === null) return false
  return /^\s*doc_auto_verify\s*[:=]\s*true\s*$/m.test(configRaw)
}

export interface TierFileLike {
  path: string
  verdict: string
  stale?: boolean
}

/**
 * The docs eligible for THIS round of auto-verification: unadjudicated now,
 * and NOT unadjudicated in the previous snapshot (new arrival or content
 * change that voided a verdict). Stale verdicts are excluded by definition
 * (they still carry their verdict — revocation is surfaced, not auto-fixed).
 * `previousUnadjudicated === null` (first snapshot) yields NOTHING — the
 * backlog is the user's Verify-all call, never a surprise agent storm.
 */
export function newAutoVerifyCandidates(
  previousUnadjudicated: ReadonlySet<string> | null,
  files: readonly TierFileLike[],
): string[] {
  if (previousUnadjudicated === null) return []
  return files
    .filter((file) => file.verdict === 'unadjudicated' && file.stale !== true)
    .map((file) => file.path)
    .filter((path) => !previousUnadjudicated.has(path))
    .sort()
}

/** The unadjudicated set to remember for the next round's diff. */
export function unadjudicatedSet(files: readonly TierFileLike[]): Set<string> {
  return new Set(files.filter((file) => file.verdict === 'unadjudicated').map((file) => file.path))
}
