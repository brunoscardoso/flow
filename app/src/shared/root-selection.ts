// Availability-aware project-root selection — the ONE decision seam for
// "which root may we bind to, and where do we land when the answer is no"
// (allowed-pattern #14: invariants live in one code path, not in convention
// restated per surface).
//
// History: #263 added the `available` flag so a persisted-but-unreachable root
// renders greyed + tagged `unavailable` instead of vanishing. #350 found four
// renderer paths that ignored it and centralized the filter — but only inside
// `src/renderer/threads/**`, which left the titlebar switcher (#974), boot
// restore (#975), the removal path's next-launch pointer (#1080) and the live
// mid-session vanish (#1118) each free to invent their own answer. Those are
// the same question asked from main and from the renderer, so the helpers live
// in `shared/` and BOTH sides import them:
//
//   main     → boot restore, setActiveProject guard, post-remove hand-off
//   renderer → thread sidebar rows, project choosers, titlebar switcher
//
// Pure + dependency-free by design (no fs, no Electron) so it unit-tests
// directly and can be imported from either process.
import type { RegisteredProject } from './ipc-contract'

/** A root is usable unless the project list explicitly flagged it unreachable.
 *  Absent `available` means "never partitioned" → treat as usable (#263). */
export function isRootAvailable(root: Pick<RegisteredProject, 'available'>): boolean {
  return root.available !== false
}

/** Roots whose location is currently reachable (`available !== false`). */
export function availableRoots(roots: readonly RegisteredProject[]): RegisteredProject[] {
  return roots.filter(isRootAvailable)
}

/** First selectable (available) root's path, or null when none are reachable. */
export function firstAvailableRoot(roots: readonly RegisteredProject[]): string | null {
  return availableRoots(roots)[0]?.rootPath ?? null
}

/** Whether ANY root is reachable — drives "New Thread" vs "Open Project" empty state. */
export function hasAvailableRoot(roots: readonly RegisteredProject[]): boolean {
  return roots.some(isRootAvailable)
}

/** The next root to activate after removing `removedPath`: the first available root
 *  that isn't the one being removed, or null (don't rebind to an unavailable one). */
export function nextActiveRootAfterRemove(
  roots: readonly RegisteredProject[],
  removedPath: string,
): string | null {
  return firstAvailableRoot(roots.filter((root) => root.rootPath !== removedPath))
}

/** Why {@link resolveActiveRoot} landed where it did — callers log/report it. */
export type ActivationReason =
  /** The requested root is a known, reachable root — bind to it. */
  | 'requested'
  /** The request was absent/unknown/unreachable; we landed on a surviving root. */
  | 'fallback'
  /** Nothing is reachable — there is honestly nowhere to land. */
  | 'none'

export interface ActivationDecision {
  /** The root to activate, or null when no reachable root exists. */
  rootPath: string | null
  reason: ActivationReason
  /** The root that was asked for but could not be honored (`fallback`/`none`
   *  only) — so the caller can NAME the problem instead of silently swapping. */
  rejected: string | null
}

/**
 * Decide which root to activate given the full root list and the root the
 * caller *wants* (a persisted `last_active_at` pointer at boot, a switcher
 * click, or null for "just put me somewhere").
 *
 * The invariant every caller needs and none should re-derive: **never activate
 * a root that isn't there, and always land somewhere valid when something is.**
 * A request for an unknown or unreachable root degrades to the first available
 * root — exactly the policy `nextActiveRootAfterRemove` already implements for
 * removal (#350) — and reports `rejected` so the surface can say why.
 */
export function resolveActiveRoot(
  roots: readonly RegisteredProject[],
  desired: string | null,
): ActivationDecision {
  if (desired !== null) {
    const match = roots.find((root) => root.rootPath === desired)
    if (match && isRootAvailable(match)) {
      return { rootPath: desired, reason: 'requested', rejected: null }
    }
  }
  const fallback = firstAvailableRoot(roots)
  if (fallback !== null) {
    return { rootPath: fallback, reason: 'fallback', rejected: desired }
  }
  return { rootPath: null, reason: 'none', rejected: desired }
}
