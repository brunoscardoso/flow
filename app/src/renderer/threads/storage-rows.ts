/**
 * WHAT THIS PROJECT IS HOLDING ON DISK, in three states instead of nine.
 *
 * THE COLLAPSE, AND WHY. The ledger this replaces told a row's story in nine
 * states — `Left over`, `Missing`, `No thread`, `Working`, `Unsaved work`,
 * `Not landed`, `No branch` and two different `Landed`s. Every one of them was
 * accurate. Together they asked the reader to learn a taxonomy in order to
 * answer the only question anybody opens this page with: CAN I GET THIS SPACE
 * BACK, AND WHAT DO I LOSE? Nine states answer it nine ways; three answer it
 * once:
 *
 *  - `working`  — something is still using it, or it holds changes that exist
 *                 nowhere else. Leave it alone.
 *  - `landed`   — everything it did has reached its branch. This is the row the
 *                 page exists to free, and freeing it loses nothing.
 *  - `orphaned` — the pairing between a conversation and its files is broken:
 *                 the conversation is gone, or the files are, or neither is
 *                 left and only a record of them remains. Nothing else in Flow
 *                 will ever mention these again, which is exactly why the one
 *                 page that can see them has to.
 *
 * THE NUANCE IS NOT DELETED, IT IS DEMOTED. The distinction between "has
 * unsaved files" and "has commits its branch has not got" is real, and it still
 * decides `freeRefusal`'s sentence — it simply stops being a state the reader
 * has to name.
 *
 * NOTHING HERE DELETES. This module returns decisions and sentences; the page
 * relays them and main does the work, through the one release path that already
 * existed (allowed-pattern #14).
 *
 * NO PATH CROSSES THIS FILE (forbidden-pattern #12). A row is a conversation, a
 * branch and a state. Where it sits on disk is Flow's business, and the wire
 * deliberately carries no field a renderer could print.
 *
 * Pure and DOM-free; the Storage page renders whatever this returns.
 */

import type { ThreadWorktreeEntry } from '../../shared/ipc-contract'

/**
 * The three answers to "can I get this space back?".
 *
 * Ordered the way the page sorts them, which is by how much attention each
 * deserves: the ones nobody owns first, then the ones still in use, then the
 * long tail the button is for.
 */
export type StorageRowState = 'working' | 'landed' | 'orphaned'

/**
 * What a state is decided from — a structural subset of the wire's own entry,
 * so a rename on the contract is a compile error here rather than a row that
 * quietly reads as safe.
 */
export type StorageRow = Pick<
  ThreadWorktreeEntry,
  'drift' | 'busy' | 'changedFiles' | 'aheadCommits'
>

/**
 * One row's state.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN. Drift is asked about first, because a
 * broken pairing is neither working nor landed — both of those words describe a
 * conversation and its files together, and drift means one of the two is not
 * there. Then a turn in flight, which makes every other fact provisional. Only
 * then the ordinary question of whether anything is still held.
 */
export function storageRowState(row: StorageRow): StorageRowState {
  if (row.drift !== 'none') return 'orphaned'
  if (row.busy) return 'working'
  // UNSAVED FILES AND UNLANDED COMMITS ARE THE SAME ANSWER HERE. They differ in
  // what would be lost — which is `freeRefusal`'s business — but not in whether
  // the reader should reach for this row, which is this function's.
  if (row.changedFiles > 0 || row.aheadCommits > 0) return 'working'
  return 'landed'
}

/**
 * Whether the free action can be pressed at all.
 *
 * NOT THE SAME QUESTION AS "IS IT SAFE". A row holding work that lives nowhere
 * else is freeable and dangerous; the page asks a second question before it
 * acts, and that question names what would be lost. This one is narrower: is
 * there anything here that pressing could act on, and is anything in the middle
 * of using it.
 *
 * It is the ledger's `selectable` rule, kept: a turn in flight is never touched,
 * and a record pointing at files that are already gone has nothing to free.
 */
export function freeable(row: StorageRow): boolean {
  if (row.busy) return false
  return row.drift !== 'gone'
}

/**
 * Why the free action is off, or null when it is on.
 *
 * A SENTENCE, NOT A CODE, and never a remedy the reader has to type
 * (forbidden-pattern #12). The busy wording is the ledger's own, word for word,
 * because it was already right and rewriting working copy is how the two
 * surfaces would have ended up saying different things about the same state.
 */
export function freeRefusal(row: StorageRow): string | null {
  if (row.busy) {
    return 'This thread is in the middle of a turn. Nothing here will touch it while it works.'
  }
  if (row.drift === 'gone') {
    // RESTATED RATHER THAN LIFTED. The ledger's sentence for this state named a
    // container, which is the one thing this whole change is removing from the
    // product's vocabulary. The fact is unchanged: the files are already gone,
    // so there is nothing here to free and nothing to lose by leaving it.
    return 'The files this thread was working in are already gone. There is nothing left here to free.'
  }
  return null
}

/**
 * Disk, rounded the way a person reads it, or null when it is not known.
 *
 * Lifted verbatim from the ledger. OMITTED RATHER THAN GUESSED: a `0 KB` that
 * really means "Flow could not tell" is a number the reader would act on.
 */
export function sizeLabel(diskKb: number | null): string | null {
  if (diskKb === null || !Number.isFinite(diskKb) || diskKb < 0) return null
  if (diskKb < 1024) return 'under 1 MB'
  const mb = diskKb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** Milliseconds in a day — the unit every age below is counted in. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When it was last worked in, or null when nothing ever was.
 *
 * Lifted verbatim from the ledger, including the same refusal to guess: no
 * timestamp prints no age rather than a reassuring "just now".
 */
export function ageLabel(lastActiveAt: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return null
  const days = Math.floor((now - lastActiveAt) / DAY_MS)
  if (days <= 0) return 'used today'
  if (days === 1) return 'used yesterday'
  if (days < 30) return `used ${String(days)} days ago`
  const months = Math.round(days / 30)
  if (months < 12) return months === 1 ? 'used last month' : `used ${String(months)} months ago`
  const years = Math.round(days / 365)
  return years <= 1 ? 'used over a year ago' : `used ${String(years)} years ago`
}
