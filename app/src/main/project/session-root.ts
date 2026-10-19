// sessionRootFor — the one definition of "where does this thread work".
//
// Lives in its own dependency-free module so small modules (brain capture,
// chain gates) can import it without pulling in the whole agent manager.
// `agent-manager` re-exports it for its existing importers.

/**
 * The checkout a thread's session actually runs in: its own git worktree when
 * it has one, else the project's shared tree (every thread that predates the
 * feature, and every chat-only thread — unchanged).
 *
 * Threads got worktrees because parallel agents on ONE checkout silently commit
 * onto whatever branch another session just switched to (forbidden-pattern #11,
 * observed twice in a single run). That only holds if the session's cwd, its
 * permission scope and its containment all answer with the SAME root, so they
 * all ask here (allowed-pattern #14) instead of each reading the record.
 *
 * NEVER recompute this path from the project root: it is stored exactly as the
 * `worktree` CLI returned it — git's own spelling, realpathed — and a derived
 * one disagrees the moment a root is reached through a symlink.
 */
export function sessionRootFor(thread: {
  projectRoot: string
  worktreePath: string | null
}): string {
  return thread.worktreePath ?? thread.projectRoot
}
