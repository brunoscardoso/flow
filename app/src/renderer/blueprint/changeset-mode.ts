// Changeset decoration mode (#898 Phase A) — the board's AMBIENT review layer.
//
// When the working tree has uncommitted changes, the board decorates itself:
// modules with changed files light up (their count badges already render),
// everything else dims. This module is the PURE state: given the existing
// per-card rollup and the current decoration ownership, decide whether the
// changeset layer is active, which cards it lights, and what the header chip
// says. DOM-free so it runs under the CJS node jest.
//
// Precedence (one place, per #832's lesson): the changeset layer is the
// weakest owner — simulation scrubber and story/neighborhood decorations
// always win; the changeset re-applies when they clear.
//
// Dismissal is fingerprint-scoped: dismissing hides the layer for THIS
// changeset; any change to the set (new file, count change, clean tree →
// new edits) re-arms it.

export interface ChangesetModeInput {
  /** Existing #609 rollup: displayed card id → changed-file count. */
  changedByCard: ReadonlyMap<string, number>
  /** Displayed card id → staged-file count. Folded into the fingerprint so a
   *  stage/unstage counts as "the changeset changed" and re-arms a dismissal. */
  stagedByCard?: ReadonlyMap<string, number>
  /** A stronger decoration owner (simulation / story / neighborhood) is active. */
  otherDecorationActive: boolean
  /** Fingerprint the user dismissed, or null. */
  dismissedFingerprint: string | null
}

export interface ChangesetModeState {
  /** True when the board should apply the changeset decoration. */
  active: boolean
  /** Cards to light (sorted for determinism). */
  litCardIds: string[]
  /** Total changed files across the changeset. */
  totalFiles: number
  /** Header chip label, e.g. "12 changed files". Empty when nothing changed. */
  chipLabel: string
  /** Stable identity of this changeset (drives dismissal scoping). */
  fingerprint: string
  /** The chip renders even while a stronger owner decorates (context stays
   *  visible); it hides only when dismissed or the tree is clean. */
  chipVisible: boolean
}

/** Stable identity: sorted `card:count[:staged]` pairs. Membership, count, or
 *  staged-state changes all re-arm a dismissal. */
export function changesetFingerprint(
  changedByCard: ReadonlyMap<string, number>,
  stagedByCard?: ReadonlyMap<string, number>,
): string {
  return [...changedByCard.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([card, count]) => `${card}:${count}:${stagedByCard?.get(card) ?? 0}`)
    .join('|')
}

export function resolveChangesetMode(input: ChangesetModeInput): ChangesetModeState {
  const { changedByCard, stagedByCard, otherDecorationActive, dismissedFingerprint } = input
  const fingerprint = changesetFingerprint(changedByCard, stagedByCard)
  const litCardIds = [...changedByCard.keys()].sort((a, b) => a.localeCompare(b))
  let totalFiles = 0
  for (const count of changedByCard.values()) totalFiles += count

  const empty = totalFiles === 0
  const dismissed = dismissedFingerprint !== null && dismissedFingerprint === fingerprint

  return {
    active: !empty && !dismissed && !otherDecorationActive,
    litCardIds,
    totalFiles,
    chipLabel: empty ? '' : `${totalFiles} changed file${totalFiles === 1 ? '' : 's'}`,
    fingerprint,
    chipVisible: !empty && !dismissed,
  }
}
