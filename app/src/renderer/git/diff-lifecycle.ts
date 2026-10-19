// Diff-overlay lifecycle (#191). The git panel is scoped to the ACTIVE project
// (ADR-002), but the diff overlay it opens over the editor was only ever shown,
// never hidden on a project switch or root removal — so a diff opened in project
// A stayed on screen (as if it belonged to B) after switching to B, or lingered
// after A's root was removed. This pure predicate decides when an open diff has
// gone stale; the coordinator tracks the diff's owning root and calls hide().

/**
 * Whether an open diff overlay should be closed.
 *
 * @param diffRoot   The root the currently-open diff belongs to, or null if no
 *                   diff is open.
 * @param focusRoot  The now-active project root (null during early boot).
 * @param aliveRoots The set of roots that still exist in the project list.
 */
export function shouldCloseDiff(
  diffRoot: string | null,
  focusRoot: string | null,
  aliveRoots: ReadonlySet<string>,
): boolean {
  if (diffRoot === null) return false // nothing open
  if (!aliveRoots.has(diffRoot)) return true // the diff's repo was removed
  return diffRoot !== focusRoot // diff belongs to a different project than the one in focus
}

/**
 * Whether an in-flight diff request may still own the editor overlay (#315).
 * #288/#305 only re-checked staleness AFTER diffView.show(), so a late-resolving
 * request still painted the wrong project's content for a frame and could tear down
 * a newer, valid diff. Gating show() on this predicate keeps a superseded/stale
 * request from ever reaching the editor. A request is current only when it is the
 * LATEST one issued (not superseded by a newer click — even within the same project)
 * AND its project is still the focused, alive one.
 *
 * @param requestGen  The generation captured when this diff request was issued.
 * @param latestGen   The most recent diff-request generation.
 * @param requestedRoot The root this request's diff belongs to.
 * @param focusRoot   The now-active project root (null during early boot).
 * @param aliveRoots  The set of roots that still exist in the project list.
 */
export function isDiffCurrent(
  requestGen: number,
  latestGen: number,
  requestedRoot: string,
  focusRoot: string | null,
  aliveRoots: ReadonlySet<string>,
): boolean {
  if (requestGen !== latestGen) return false // superseded by a newer request
  return !shouldCloseDiff(requestedRoot, focusRoot, aliveRoots)
}

/**
 * What to do with an OPEN "working tree vs HEAD" file diff when its root's git
 * status refreshes (#402). The overlay was a one-shot snapshot — it never
 * re-synced, so it drifted from the CHANGES list beside it (stale content when
 * the file changed on disk, or a phantom diff after the file was committed
 * away). On each refresh of the diff's own root:
 *   - `refresh` — the file is still in the changes: re-issue the diff so it
 *                 reflects the current working tree.
 *   - `close`   — the file left the changes (committed/reverted): close the
 *                 overlay so it can't show a diff that no longer exists.
 *   - `idle`    — no working-tree file diff is open (or a commit diff is), so
 *                 file-content refreshes don't apply.
 *
 * @param openFilePath The path of the open working-tree file diff, or null.
 * @param changePaths  The file paths currently in the root's git status.
 */
export function resolveOpenDiffFate(
  openFilePath: string | null,
  changePaths: ReadonlySet<string>,
): 'refresh' | 'close' | 'idle' {
  if (openFilePath === null) return 'idle'
  return changePaths.has(openFilePath) ? 'refresh' : 'close'
}
