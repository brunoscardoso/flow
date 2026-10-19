// Auto-attach decision (multi-project threads, phase 6).
//
// When an agent WRITE lands under a KNOWN project root that is not in the
// session thread's current root set, the containment hook attaches that root
// to the thread (thread_roots, via ThreadStore's one write seam) and allows
// the write — instead of blocking it. Writes outside EVERY known root stay
// blocked exactly as before (#62/#82 unchanged). Reads never attach: looking
// at an unselected project stays blocked (#503).
//
// This module is the PURE decision: given a write's target(s), the thread's
// current roots, and the known project roots, which known root (if any)
// should be attached? The AgentManager's PreToolUse hooks call it and perform
// the side effects (addThreadRoot + persisted system note). Path nesting and
// temp/dev-sink rules are imported from path-containment so both layers share
// ONE definition (allowed-pattern #14).

import { isAbsolute, resolve } from 'path'

import { bashWriteTargets, isAllowedOutsideWriteTarget, isInside } from './path-containment'

/**
 * The KNOWN project root a single escaping write path should attach, or null.
 *
 * Null when:
 * - the path is empty or the thread has no roots (nothing enforced — mirrors
 *   editEscapesRoots),
 * - the path is already inside a thread root (no escape, nothing to attach),
 * - the path is outside every known root (stays blocked, exactly as today).
 *
 * Relative paths resolve against the primary root (cwd = threadRoots[0]),
 * mirroring the containment checks.
 */
export function attachRootForWritePath(
  filePath: string | null,
  threadRoots: readonly string[],
  knownRoots: readonly string[],
): string | null {
  if (!filePath || threadRoots.length === 0) return null
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(threadRoots[0], filePath)
  if (threadRoots.some((root) => isInside(root, abs))) return null
  return knownRoots.find((root) => isInside(root, abs)) ?? null
}

/** The attach decision for a Bash command's write targets (may span roots). */
export interface BashAttachDecision {
  /** Known roots that would cover the command's escaping write targets. */
  attach: string[]
  /** True when at least one escaping write target is outside EVERY known root.
   *  The command must stay blocked; nothing is attached for it. */
  blockedOutsideKnown: boolean
}

/**
 * Decide which known roots a Bash command's escaping WRITE targets need.
 * Temp/dev sinks and targets already inside thread roots are skipped (same
 * rules as bashWriteEscapesRoots). Conservative: if ANY escaping target lands
 * outside every known root, the whole command is `blockedOutsideKnown` and the
 * caller must not attach anything — partial attach for a command that will be
 * denied anyway would silently widen the thread's scope.
 */
export function bashAttachDecision(
  command: string,
  threadRoots: readonly string[],
  knownRoots: readonly string[],
): BashAttachDecision {
  const attach = new Set<string>()
  let blockedOutsideKnown = false
  if (!command || threadRoots.length === 0) return { attach: [], blockedOutsideKnown }
  for (const target of bashWriteTargets(command)) {
    const abs = isAbsolute(target) ? resolve(target) : resolve(threadRoots[0], target)
    if (isAllowedOutsideWriteTarget(abs)) continue
    if (threadRoots.some((root) => isInside(root, abs))) continue
    const known = knownRoots.find((root) => isInside(root, abs))
    if (known) attach.add(known)
    else blockedOutsideKnown = true
  }
  if (blockedOutsideKnown) return { attach: [], blockedOutsideKnown }
  return { attach: [...attach], blockedOutsideKnown }
}

/**
 * Once-per-root-per-turn debounce for auto-attach. addThreadRoot is idempotent
 * and an attached root stops escaping, so this mainly guards the persisted
 * system note against duplicates when writes race within one turn — and keeps
 * a failed attach from being retried in a hot loop.
 */
export class TurnAttachTracker {
  readonly #byThread = new Map<string, Set<string>>()

  /** Start a fresh turn for the thread — clears its per-turn attach memory. */
  beginTurn(threadId: string): void {
    this.#byThread.delete(threadId)
  }

  /** True the FIRST time this root is marked for this thread's current turn. */
  markAttached(threadId: string, rootPath: string): boolean {
    let attached = this.#byThread.get(threadId)
    if (!attached) {
      attached = new Set()
      this.#byThread.set(threadId, attached)
    }
    if (attached.has(rootPath)) return false
    attached.add(rootPath)
    return true
  }

  /** Drop a thread's memory entirely (thread disposal). */
  clearThread(threadId: string): void {
    this.#byThread.delete(threadId)
  }
}
