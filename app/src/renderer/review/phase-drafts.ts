// Phase-mode commit-message draft lifecycle (#342). ReviewPanel keeps per-group
// commit-message drafts keyed by group label. #183 clears the MANUAL-mode message
// on a successful commit and #281 clears everything on a project switch, but the
// Phase-mode drafts map was cleared in NEITHER after a commit — so committing one
// changeset left its message behind, and a later unrelated changeset that reused the
// label ("Other changes", "Phase N") re-displayed the stale, already-committed
// message (a user could commit new files under the previous commit's description).
// This pure helper drops exactly the committed group's draft while preserving every
// OTHER group's in-progress message; the panel applies it, only on the success path.

/** Return a new drafts map with the committed group's draft removed; all other
 *  groups' drafts are preserved. */
export function dropCommittedDraft(
  drafts: ReadonlyMap<string, string>,
  committedLabel: string,
): Map<string, string> {
  const next = new Map(drafts)
  next.delete(committedLabel)
  return next
}

/**
 * Drop every draft whose group is no longer in the listing (#1140).
 *
 * `dropCommittedDraft` fixed ONE exit — commit. Every other way a changeset can
 * stop existing left its message behind to be re-offered, pre-filled, over
 * somebody else's files: "Discard all", a reject that empties the group, or a
 * commit taken from the sibling Changes view. The label is the only key we
 * have, and labels are recycled ("Other changes", "Phase 1"), so a draft that
 * outlives its changeset is a wrong commit subject waiting for two clicks.
 *
 * Keying the lifetime to PRESENCE closes all of those at once: a group that is
 * on screen keeps its draft (including through a failed commit, whose files are
 * still listed and still retryable), and a group that is gone takes its message
 * with it. Nothing typed is lost that the user can still see — a vanished
 * group has no message box on screen to type into.
 */
export function pruneVanishedDrafts(
  drafts: ReadonlyMap<string, string>,
  presentLabels: readonly string[],
): Map<string, string> {
  const present = new Set(presentLabels)
  const next = new Map<string, string>()
  for (const [label, draft] of drafts) {
    if (present.has(label)) next.set(label, draft)
  }
  return next
}
