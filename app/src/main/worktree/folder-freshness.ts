/**
 * Is the project folder this conversation is about to work in behind its
 * remote branch? (user, 2026-10-12.)
 *
 * THE TWO PATHS A NEW THREAD CAN TAKE, and why only one of them needed this:
 *
 *  - A thread with a BRANCH OF ITS OWN already starts from the latest. The cut
 *    fetches the base under a ceiling and the CLI then puts the fresh checkout
 *    on `<remote>/<base>` (`refreshWorktree`), so its first commit sits on top
 *    of what the remote had moments earlier. Nothing here applies to it.
 *
 *  - A thread that works in the PROJECT FOLDER works on whatever that folder
 *    is sitting on. Since the default placement became the folder itself, that
 *    is the common case — and there was no step anywhere that looked at how
 *    stale it was. This module is that look.
 *
 * IT LOOKS AND IT SAYS. It does not pull: the folder is the person's own
 * working tree, with their editors open on it, and fast-forwarding it under
 * them to start a conversation is not a decision a conversation gets to make
 * (chosen by the user over the two alternatives, 2026-10-12). The notice
 * carries the action; a person presses it.
 *
 * Every function here is pure — the git transcripts come in as strings, the
 * verdict goes out as data — so the decision is testable without a repository,
 * and the one caller that owns the subprocesses (`ThreadWorktree`) owns them
 * alone.
 */

/** How far apart a branch and its upstream are, as git counted them. */
export interface AheadBehind {
  ahead: number
  behind: number
}

/**
 * `git rev-list --count --left-right <branch>...<upstream>` — one line, two
 * tab-separated counts: commits only we have, then commits only it has.
 *
 * Null for anything else. A repository with no upstream, an unborn branch and a
 * git that failed all reach here as something this cannot read, and every one
 * of them means "say nothing" rather than "nothing is behind" — the difference
 * matters, because the second is a claim.
 */
export function parseAheadBehind(stdout: string): AheadBehind | null {
  const line = stdout.trim()
  if (line === '') return null
  const parts = line.split(/\s+/)
  if (parts.length !== 2) return null
  const ahead = Number(parts[0])
  const behind = Number(parts[1])
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null
  if (ahead < 0 || behind < 0) return null
  return { ahead, behind }
}

/**
 * `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` — the tracking
 * branch's short name, e.g. `origin/main`.
 *
 * Null when the branch tracks nothing. Git exits non-zero in that case, so the
 * caller's failed-run branch covers it too; this also refuses the empty and the
 * whitespace-bearing answers rather than passing them on to a marker that
 * cannot round-trip them.
 */
export function parseUpstreamName(stdout: string): string | null {
  const name = stdout.trim()
  if (name === '' || /\s/.test(name)) return null
  return name
}

/** What the folder's state is, as the decision needs to see it. */
export interface FolderFreshnessFacts {
  /** True when the thread has a checkout of its own — then there is nothing to say. */
  hasOwnCheckout: boolean
  /** The folder's branch, or null when HEAD is detached or unborn. */
  branch: string | null
  /** The branch it tracks, or null when it tracks nothing. */
  upstream: string | null
  /** How far apart the two are, or null when git could not say. */
  distance: AheadBehind | null
}

/** Why no notice was written — for the log, and for the tests to name. */
export type FolderFreshnessVerdict =
  | { note: false; reason: 'own-checkout' | 'no-branch' | 'no-upstream' | 'unreadable' | 'current' }
  | { note: true; branch: string; upstream: string; behind: number; ahead: number }

/**
 * Whether this conversation should say the folder is behind.
 *
 * SILENT IS THE DEFAULT, and every silence has a name. A line that appears at
 * the top of every conversation stops being read by the third one, so the only
 * case that earns the notice is the one where something is actually behind.
 *
 * A DIVERGED FOLDER IS STILL NOTED. It is the state most worth knowing about —
 * commits on both sides — and the notice says so without offering to merge
 * them: whether a person's own commits should be merged into is their call, not
 * a new conversation's. The card reads the live numbers and decides which of
 * the two it is showing.
 */
export function folderFreshnessVerdict(facts: FolderFreshnessFacts): FolderFreshnessVerdict {
  if (facts.hasOwnCheckout) return { note: false, reason: 'own-checkout' }
  if (facts.branch === null || facts.branch === '') return { note: false, reason: 'no-branch' }
  if (facts.upstream === null || facts.upstream === '') return { note: false, reason: 'no-upstream' }
  // UNREADABLE IS NOT ZERO. A fetch that timed out, a git that failed, a
  // transcript in a shape this cannot parse — none of them is evidence that the
  // folder is current, so none of them produces a notice claiming a count.
  if (facts.distance === null) return { note: false, reason: 'unreadable' }
  if (facts.distance.behind === 0) return { note: false, reason: 'current' }
  return {
    note: true,
    branch: facts.branch,
    upstream: facts.upstream,
    behind: facts.distance.behind,
    ahead: facts.distance.ahead,
  }
}
