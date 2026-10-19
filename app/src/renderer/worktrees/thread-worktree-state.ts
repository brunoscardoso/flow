/**
 * THIS CONVERSATION'S WORKTREE — the whole of what the panel shows.
 *
 * WHAT THIS REPLACED AND WHY. The first cut listed every worktree in the
 * project: fourteen rows on a real repository, most of them belonging to
 * conversations the reader was not in. It answered a question nobody had
 * ("what does this project hold?") and buried the one they did: *where is THIS
 * conversation working, and can I change that?* The correction was the user's
 * and it is the whole design — "only show the worktree related to that thread,
 * that's it, and give the user the ability to create, edit, delete and manage
 * his own worktree" (2026-09-16).
 *
 * THE API AGREED ALL ALONG. The verbs are keyed by thread — `prepareWorktree`
 * makes a worktree, `releaseWorktree` takes it away. A project-wide list had to
 * invent a scope the operations do not have; this one has exactly the scope they
 * do.
 *
 * HOW EXISTENCE IS DECIDED, AND WHY IT COSTS NOTHING. Compare where the
 * conversation works with where the project is. Different path → it is working
 * in a copy. Same path, or none → it is working in your files. That is a string
 * comparison: no git, no inventory, no subprocess, and it is correct the instant
 * the thread record arrives.
 *
 * The rule is the user's, and it fixed a real bug rather than only a slow one
 * (2026-09-16): *"when the user index the project, we know the exactly path, if
 * we are on the thread, and the path is dif, that means that this is a worktree
 * enabled."* The panel had been asking only whether `worktreePath` was set — and
 * on a conversation working in the project itself, that field is set, to the
 * project's own root. So the panel announced "its own copy" over the main
 * checkout, then described the project's own commits as the copy's unlanded
 * work.
 *
 * WHERE THE OTHERS WENT. Nowhere — they were never this panel's job. Disk-wide
 * housekeeping across every conversation is the Storage page, which owns it by
 * the split decided on 2026-09-16.
 *
 * Pure and DOM-free; no path, command or config key crosses it
 * (forbidden-pattern #12).
 */

import type { ThreadSummary } from '../../shared/ipc-contract'
import { checkoutName } from '../../shared/worktree-name'

/** What the panel is showing, and therefore what it can offer. */
export type ThreadWorktreeState =
  /** No project is open — nothing is addressable. */
  | { kind: 'no-project' }
  /** A project, but no conversation selected. */
  | { kind: 'no-thread' }
  /**
   * The conversation works in the project's own files. The ordinary case since
   * the default flipped, and NOT a deficiency — it is stated as a fact, with
   * the offer to change it beside it.
   */
  | { kind: 'in-project'; projectBranch: string | null }
  /**
   * The conversation has a worktree of its own.
   *
   * IT CARRIES NO STATE ABOUT WHAT IS INSIDE. Describing the contents meant
   * reading the project's whole inventory — per-root, a `git status`, a
   * `rev-list` and a `du` for every worktree in it. On a real project that took
   * **over thirty seconds**, and the answer it finally produced was wrong: the
   * commit count is measured against a local base branch that was 673 commits
   * behind its remote, so an ordinary worktree read as holding hundreds of
   * unlanded commits.
   *
   * Thirty seconds to display a wrong number is worse than not displaying one.
   * So the panel does not ask, and nothing is lost by not asking: `prune`
   * refuses a worktree that still holds work and hands back the sentence
   * explaining why (allowed-pattern #21). The check happens where it is
   * authoritative, at the moment it matters.
   */
  | {
      kind: 'own'
      /**
       * WHAT THE FOLDER IS CALLED — `worktree/<name>`, the two segments
       * together.
       *
       * A DIFFERENT FACT FROM THE BRANCH, and the panel showed only the branch:
       * a reader looking at `Branch using-claude-sonnet-5` had no way to see
       * that the directory holding it is `worktree/using-claude-sonnet-5`
       * (user, 2026-09-18: "on the folder we should always have worktree/
       * name"). The prefix is the part that says which of the two you are
       * looking at, so it is shown rather than stripped.
       *
       * Null for a checkout still named after a thread id: a uuid is the one
       * thing this panel must never print, and the migration is what fixes it.
       */
      folder: string | null
      branch: string | null
      /**
       * The conversation's OTHER projects, and the branch each copy is on.
       *
       * A thread can carry several projects. Until 2026-09-17 only the one it
       * started in got a copy, so the conversation was isolated in one
       * repository and writing straight into the others — and the panel, which
       * spoke only for the primary, had no way to say so. A project with no
       * copy is listed with a null branch: "this one is not apart" is the fact
       * the reader most needs, and hiding it is how the original bug hid.
       */
      others: Array<{ rootPath: string; name: string; path: string | null; branch: string | null }>
    }

/** A value worth printing, or null. Blank is not a name. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * One directory path, comparably.
 *
 * Trailing separators only — nothing else is touched. Case is left alone on
 * purpose: these paths come from the same two sources within one process, so
 * folding case would only create a way for two genuinely different directories
 * to read as one.
 */
function samePath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const trim = (value: string): string => value.replace(/\/+$/, '')
  return trim(a) === trim(b)
}

/**
 * Whether a conversation is working in a copy of the project.
 *
 * THE WHOLE DETECTION, and it reads no git. A path that IS the project's is not
 * a worktree, however it got recorded.
 */
export function worksInOwnCopy(worktreePath: string | null, projectRoot: string | null): boolean {
  const path = named(worktreePath)
  if (path === null) return false
  return !samePath(path, named(projectRoot))
}

/**
 * What to show.
 *
 * `worktreePath` IS THE ANSWER to "does this conversation have one", and it is
 * the same field `isolationMark` keys on — so the panel and the sidebar mark
 * can never disagree about whether a conversation is apart.
 *
 * THE ENTRY MAY BE MISSING AND THAT IS NOT AN ERROR. The inventory is a
 * separate, slower read; a worktree whose entry has not arrived is still a
 * worktree, and saying so beats blanking the panel for a second. What it cannot
 * do is offer a removal, because the rule that decides a removal reads the
 * entry — `pending` is how the panel knows to wait rather than to guess.
 */
export function threadWorktreeState(
  rootPath: string | null,
  thread:
    | (Pick<ThreadSummary, 'id' | 'worktreePath' | 'worktreeBranch'> &
        Partial<Pick<ThreadSummary, 'additionalRoots' | 'attachedWorktrees'>>)
    | null,
  projectBranch: string | null,
): ThreadWorktreeState {
  if (rootPath === null) return { kind: 'no-project' }
  if (thread === null) return { kind: 'no-thread' }
  // The whole question, answered by comparing two strings. No git, no wait.
  if (!worksInOwnCopy(thread.worktreePath, rootPath)) {
    return { kind: 'in-project', projectBranch }
  }
  return {
    kind: 'own',
    // READ OFF THE PATH, never stored beside it: the directory's name IS the
    // worktree's name, and a second copy would disagree on the first rename
    // (allowed-pattern #23).
    folder: checkoutName(thread.worktreePath),
    branch: named(thread.worktreeBranch),
    others: otherProjects(thread),
  }
}

/** The last segment of a path — what a project is called. */
function projectName(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/**
 * The conversation's other projects, each with the branch its copy is on.
 *
 * EVERY ATTACHED PROJECT IS LISTED, including the ones with no copy. A project
 * that could not be isolated is exactly what the reader needs to see — it is
 * where the agent is editing real files — and leaving it out would reproduce
 * the bug this exists to surface, one level down.
 */
function otherProjects(
  thread: Partial<Pick<ThreadSummary, 'additionalRoots' | 'attachedWorktrees'>>,
): Array<{ rootPath: string; name: string; path: string | null; branch: string | null }> {
  const byRoot = new Map(
    (thread.attachedWorktrees ?? []).map((entry) => [entry.rootPath, entry]),
  )
  return (thread.additionalRoots ?? []).map((rootPath) => ({
    rootPath,
    name: projectName(rootPath),
    // TWO DIFFERENT FACTS, kept apart. `path` says whether this project has a
    // copy at all; `branch` says what that copy is on, and is legitimately
    // null for a detached one. Reading the second as the first is the bug this
    // carries the path to prevent.
    path: byRoot.get(rootPath)?.path ?? null,
    branch: byRoot.get(rootPath)?.branch ?? null,
  }))
}

/** What the panel says about a conversation working in the project. */
export function inProjectLine(projectBranch: string | null): string {
  return projectBranch === null
    ? 'This conversation changes the files you have open.'
    : `This conversation changes the files you have open, on ${projectBranch}.`
}
