// In-flight commit guard for the Review panel (#434). "Commit phase" / "Commit
// approved" wasn't disabled while its git:commit was in flight, so a double-
// click (or Enter double-fire) dispatched TWO concurrent commits on the same
// repo. They race on .git/index.lock: the first succeeds, the second fails with
// a raw lock error — surfaced as a misleading "Commit failed … not committed"
// toast even though the commit landed. Dropping the redundant call in the
// coordinator (mirroring the tasks-modal #311 fix) covers both the button and
// the keyboard path. DOM-free → unit-testable.

/**
 * Whether a commit for `root` may be dispatched right now — false when one is
 * already in flight for that root (the redundant concurrent call is dropped).
 */
export function canDispatchCommit(inFlight: ReadonlySet<string>, root: string): boolean {
  return !inFlight.has(root)
}
