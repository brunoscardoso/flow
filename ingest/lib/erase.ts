/**
 * REMOVING A PERSON'S DATA — performable, not promised.
 *
 * A privacy notice that says "you can ask us to delete your data" and has no
 * operation behind it is a sentence, not a capability. This is the operation.
 *
 * ── THE SUBTLETY THAT MAKES THIS NOT A ONE-LINER ────────────────────────────
 *
 * The join runs BACKWARDS here. Events carry an `installId` always and an
 * `identityId` only after somebody signs in — and the whole point of the join
 * is that the events an installation sent BEFORE the sign-in belong to that
 * person too. So deleting "rows where identityId = X" leaves behind precisely
 * the anonymous history the join exists to claim for them.
 *
 * Erasing a person is therefore two steps, in this order:
 *
 *   1. find every installation that has EVER carried their identity
 *   2. delete everything those installations ever sent, signed in or not
 *
 * Step 2 is deliberately broader than step 1. It can over-delete: a shared
 * machine where two people signed into the same installation loses both
 * histories. That is the right way to be wrong — the alternative is telling
 * somebody their data is gone while their first month of it is still sitting
 * there under a null identity.
 *
 * ── IT CANNOT RUN BY ACCIDENT ───────────────────────────────────────────────
 *
 * This deletes real rows and there is no undo, so it follows forbidden-pattern
 * #15: the destructive path requires something a caller has to say on purpose.
 * A call with no confirmation returns a refusal and touches nothing.
 */

/** What to erase, and on whose say-so. */
export interface EraseRequest {
  /** The signed-in person to erase. */
  identityId?: string
  /** Or one specific installation, for somebody who never signed in. */
  installId?: string
  /**
   * PROOF THAT A PERSON ASKED.
   *
   * Not a boolean: a boolean is what a test passes by accident and what a
   * refactor flips. A caller has to write the subject out again, and it has to
   * match — so an erase cannot be triggered by a truthy variable, and cannot
   * erase a different subject from the one somebody typed.
   */
  confirmSubject?: string
}

export type ErasePlan =
  | { ok: true; installIds: 'lookup-required'; subject: string }
  | { ok: false; reason: string }

/** The statements an erase runs, in order. Exported so they can be read. */
export const ERASE_SQL = {
  /** Every installation that has ever carried this identity. */
  installsForIdentity: `select distinct install_id from events
    where body->>'identityId' = $1 and install_id is not null`,
  /** Everything those installations ever sent — including before the sign-in. */
  eventsForInstalls: `delete from events where install_id = any($1::text[])`,
  /** Their rate-limit counters, which are also about them. */
  countersForInstalls: `delete from ingest_counters where install_id = any($1::text[])`,
  /**
   * Rows carrying the identity but NO installation.
   *
   * Should not exist — every event carries an install id — but "should not
   * exist" is not "does not exist", and a row this misses is a row that
   * survives a deletion somebody was told had happened.
   */
  orphansForIdentity: `delete from events where body->>'identityId' = $1 and install_id is null`,
}

/**
 * Decide whether an erase may run, and for whom.
 *
 * Pure. The lookup and the deletes are the caller's — this is the part that
 * says no.
 */
export function planErase(request: EraseRequest): ErasePlan {
  const subject = request.identityId ?? request.installId
  if (subject === undefined || subject === '') {
    return { ok: false, reason: 'nothing was named to erase' }
  }
  if (request.identityId !== undefined && request.installId !== undefined) {
    // Two subjects is an ambiguous instruction, and the wrong one to guess at.
    return { ok: false, reason: 'name a person or an installation, not both' }
  }
  if (request.confirmSubject !== subject) {
    return {
      ok: false,
      reason: 'an erase must be confirmed by naming the same subject again',
    }
  }
  return { ok: true, installIds: 'lookup-required', subject }
}

/** What an erase actually did — so it can be reported rather than assumed. */
export interface EraseReport {
  subject: string
  installationsTouched: number
  eventsDeleted: number
  countersDeleted: number
}

export interface EraseDb {
  installsForIdentity(identityId: string): Promise<string[]>
  deleteEvents(installIds: string[]): Promise<number>
  deleteCounters(installIds: string[]): Promise<number>
  deleteOrphans(identityId: string): Promise<number>
}

/**
 * Run it.
 *
 * Returns what was removed. A caller that reports "done" without reading this
 * is making the same promise the operation exists to stop being empty.
 */
export async function erase(
  request: EraseRequest,
  db: EraseDb,
): Promise<{ ok: true; report: EraseReport } | { ok: false; reason: string }> {
  const plan = planErase(request)
  if (!plan.ok) return plan

  const byIdentity = request.identityId !== undefined
  // For an identity, find every installation it ever appeared on — the
  // anonymous history before the sign-in is theirs too. For a bare
  // installation, the subject IS the installation.
  const installIds = byIdentity
    ? await db.installsForIdentity(plan.subject)
    : [plan.subject]

  const eventsDeleted =
    installIds.length > 0 ? await db.deleteEvents(installIds) : 0
  const countersDeleted =
    installIds.length > 0 ? await db.deleteCounters(installIds) : 0
  const orphans = byIdentity ? await db.deleteOrphans(plan.subject) : 0

  return {
    ok: true,
    report: {
      subject: plan.subject,
      installationsTouched: installIds.length,
      eventsDeleted: eventsDeleted + orphans,
      countersDeleted,
    },
  }
}
