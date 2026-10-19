// Pure commit-box state for the unified Source Control panel (#335). DOM-free so
// it's unit-testable under the node-env jest that can't import the DOM-coupled
// git panel; the panel builds the box and drives the Commit button off this.

export interface CommitBoxState {
  /** Whether the Commit button is enabled. */
  canCommit: boolean
  /** Why it's disabled (button title / hint), or null when it's enabled. */
  disabledReason: string | null
}

/**
 * The Commit button is enabled only when there is something staged AND a
 * non-empty message — `git commit` with an empty index or blank message is a
 * no-op/error, so the panel must gate it (#335). Reason strings drive the
 * button's title so the user knows what's missing.
 */
export function commitBoxState(stagedCount: number, message: string): CommitBoxState {
  if (stagedCount <= 0) {
    return { canCommit: false, disabledReason: 'Stage changes to commit' }
  }
  if (message.trim().length === 0) {
    return { canCommit: false, disabledReason: 'Enter a commit message' }
  }
  return { canCommit: true, disabledReason: null }
}

/**
 * Whether a resolved ✨ generation may be written into the commit draft (#1020).
 * The generation is async (~5s) and the panel re-renders freely underneath it;
 * a re-render is NOT a cancel — the result still lands in the (recreated) box.
 * But if the user typed into the box since the click, their words win: a stale
 * AI suggestion must never replace text the user wrote themselves.
 *
 * `draftAtClick` is the draft snapshotted when ✨ was clicked; `draftNow` is the
 * live draft when the generation resolves. Any difference means the user edited
 * in between → drop the result. A null/empty message never applies.
 */
export function shouldApplyGeneratedMessage(
  draftAtClick: string,
  draftNow: string,
  message: string | null,
): boolean {
  if (message === null || message.length === 0) return false
  return draftNow === draftAtClick
}
