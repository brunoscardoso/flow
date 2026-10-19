// Fire-time guard for the Review panel's destructive armed actions (#951).
//
// The panel's transient interactions — the "Discard all" two-step confirm and
// the per-file Reject prompt — are ARMED against the project that was active
// when they opened, but they FIRE later, against whatever root is active at
// click time. A project switch in between (whose rebuild the #182 refresh gate
// defers) would otherwise let a confirm armed in project A revert project B's
// uncommitted work.
//
// This is the ONE code path (allowed-pattern #14) every armed destructive
// action must pass through at fire time: the root stamped when the interaction
// was armed must still be the active root, otherwise the action is refused.
// `ReviewPanel.reset()` also tears armed interactions down on a switch — this
// guard is the defence in depth beneath it: no destructive action may ever
// execute against a root it wasn't armed on.

export function mayFireArmedAction(
  armedRoot: string | null,
  activeRoot: string | null,
): boolean {
  return armedRoot !== null && armedRoot === activeRoot
}
