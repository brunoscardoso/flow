// Drift-origin classifier (#drift phase 2) — a PURE, I/O-free labeller that
// tells WHO caused a file to drift from the blueprint's content-hash baseline:
//
//   • 'agent'    — a module currently IN PLAY for an active run (an execute-plan
//                  agent is touching it right now); the strongest signal.
//   • 'yours'    — an uncommitted working-tree edit, or your own committed change.
//   • 'external' — a committed change whose author is someone other than you.
//
// Every input is INJECTED (git authorship, current identity, dirtiness, the
// run's in-play set are all resolved by the caller) so this module stays unit-
// testable under plain `npx jest` — no fs, no git, no Electron. The git author
// lookup lives in git-manager.ts (`fileAuthors` / `currentUser`); the in-play
// set comes from LearnRunTriggers.isModuleInPlay; this file only decides.

/** Who a drifted file's change is attributed to. */
export type DriftOrigin = 'external' | 'yours' | 'agent'

/** The signals for one drifted file — all supplied by the caller. */
export interface ClassifyOriginInput {
  /** Repo-relative path (carried through for readability; not inspected here). */
  path: string
  /** Email of the author of the last commit that touched the file, if known. */
  committedAuthorEmail?: string
  /** The repo's configured `user.email`, if known (see git-manager currentUser). */
  currentUserEmail?: string
  /** True when the file has uncommitted working-tree changes. */
  isDirty: boolean
  /** True when the file's owning module is in play for an active run. */
  inPlay: boolean
}

/** Case-insensitive, trimmed email equality — git records emails verbatim, so a
 *  trailing-space or letter-case difference should not read as a different person. */
function emailsEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Classify one drifted file's origin. Precedence (highest first):
 *   1. `inPlay`  → 'agent'  — an active run owns this module right now.
 *   2. `isDirty` → 'yours'  — an uncommitted edit is your own working change.
 *   3. committed change: the author's email is compared to the current user's —
 *      a DIFFERENT author is 'external', your OWN committed change is 'yours'.
 *   4. Identity fallback: when the current user's email is unknown, a committed
 *      change (already past the `isDirty` gate) is treated as 'external' — we
 *      cannot prove it was yours, so it reads as someone else's.
 */
export function classifyOrigin(input: ClassifyOriginInput): DriftOrigin {
  if (input.inPlay) {
    return 'agent'
  }
  if (input.isDirty) {
    return 'yours'
  }
  // Past this point the change is COMMITTED (not in play, not dirty).
  const currentEmail = input.currentUserEmail
  if (currentEmail === undefined || currentEmail.length === 0) {
    // Identity unavailable → fall back to committed-vs-uncommitted: a committed
    // change we cannot attribute to ourselves reads as external.
    return 'external'
  }
  const committedEmail = input.committedAuthorEmail
  if (
    committedEmail !== undefined &&
    committedEmail.length > 0 &&
    !emailsEqual(committedEmail, currentEmail)
  ) {
    return 'external'
  }
  // Your own committed change (or an unknown committed author matching identity
  // we cannot distinguish) — attributed to you.
  return 'yours'
}

/** Shared context for a batch classify — the identity is the same for every file. */
export interface DriftClassifyContext {
  /** The repo's configured `user.email`, if known. */
  currentUserEmail?: string
}

/** One drifted file's signals, minus the shared current-user identity. */
export type DriftEntryInput = Omit<ClassifyOriginInput, 'currentUserEmail'>

/** A drifted file paired with its classified origin. */
export interface ClassifiedDriftEntry {
  path: string
  origin: DriftOrigin
}

/**
 * Classify a list of drifted files against a shared identity context. Pure —
 * a thin map over `classifyOrigin`, kept as the single entry point Phase 4's
 * panel builder calls so the per-file precedence lives in exactly one place.
 */
export function classifyDriftEntries(
  entries: readonly DriftEntryInput[],
  ctx: DriftClassifyContext,
): ClassifiedDriftEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    origin: classifyOrigin({ ...entry, currentUserEmail: ctx.currentUserEmail }),
  }))
}
