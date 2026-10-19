/**
 * WHICH CHECKOUT A CLICKED FILE REFERENCE MEANS.
 *
 * THE DEFECT. An agent working in a thread's own checkout wrote a file and
 * named it back in the chat. Clicking the name said "File not found —
 * couldn't locate handbook-section-4-security.md in this project", because the
 * click resolved the bare name against the PROJECT root and the file was in
 * the thread's worktree, which is a different directory on disk. Every part of
 * that worked as written: the agent really did write it, the resolver really
 * did search, and the project really does not contain it. The click was asking
 * the wrong checkout.
 *
 * WHY IT IS ORDERED AND NOT REPLACED. A thread's checkout is a checkout OF the
 * project, so most paths exist in both. When they do, the thread's copy is the
 * one meant: it is the tree the agent has been editing, the tree the panel
 * shows changes for, and opening the project's copy instead would put the
 * user's edits in a checkout the thread never touches. So the thread's own
 * root is asked FIRST and the project remains the fallback — a file that lives
 * only in the project (a doc outside the worktree, a sibling's artifact) still
 * opens exactly as before.
 *
 * EVERY ROOT THE THREAD HAS, NOT JUST ITS FIRST. The fix above asked the
 * thread's PRIMARY checkout and stopped, which is right for a thread that works
 * in one project and wrong for every thread that does not. A thread can reach
 * into several projects (`additionalRoots`), the agent can write in any of
 * them, and `ThreadScope.roots` has carried the whole ordered set all along —
 * primary first, then the additional ones. Keeping only `[0]` reproduced the
 * original defect one level in: a file written into a SECOND root was named in
 * the chat and could not be opened, and the message still said "in this
 * project" about a project it was never in. Reported 2026-09-09 against a
 * thread spanning three repositories.
 *
 * WHAT IS DELIBERATELY NOT DONE. A click that NAMES a project other than the
 * one on screen — the blueprint board peeking a file in a second repository —
 * is left alone entirely. It asked for a specific tree; preferring some other
 * thread's checkout over it would be the same class of bug in the opposite
 * direction.
 */

export interface FileRefRootsInput {
  /** The project this click named, if it named one. */
  requested: string | null
  /**
   * The open thread's checkouts, in `ThreadScope` order — primary first, then
   * its additional roots. Empty when the thread works in the project itself,
   * or when no thread is open.
   */
  threadRoots: readonly string[]
  /** The project currently on screen. */
  activeRoot: string | null
}

/**
 * The checkouts to ask, in order, for one clicked file reference.
 *
 * Empty when there is nothing to ask — the caller notifies rather than opening
 * a phantom path. Never contains a duplicate: a thread with no checkout of its
 * own, or one whose checkout IS the active project, yields a single root and
 * the same single lookup the click has always done.
 */
export function fileRefRoots(input: FileRefRootsInput): string[] {
  const requested = clean(input.requested)
  const active = clean(input.activeRoot)
  const target = requested ?? active

  // The click named a different project — it means that one, and only it.
  const namedElsewhere = requested !== null && active !== null && requested !== active
  // Order is the thread's own: the primary checkout is the tree the agent has
  // most likely been editing, and a file present in two of them means the
  // earlier one for the same reason the thread beats the project below.
  const thread = namedElsewhere ? [] : input.threadRoots.map(clean)

  const ordered = [...thread, target]
  const roots: string[] = []
  for (const root of ordered) {
    if (root === null || roots.includes(root)) continue
    roots.push(root)
  }
  return roots
}

/**
 * The root a "not found" message belongs to.
 *
 * The PROJECT, never the thread's checkout: the notification is filed under a
 * root id the rest of the shell knows by name, and a thread's checkout is a
 * directory the user never named and should not have to recognise.
 */
export function fileRefNotifyRoot(input: FileRefRootsInput): string | null {
  return clean(input.requested) ?? clean(input.activeRoot) ?? clean(input.threadRoots[0])
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}
