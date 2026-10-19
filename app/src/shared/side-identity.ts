/**
 * Side identity — the concrete, unambiguous identity of one side of a git
 * conflict, DERIVED from the in-progress operation rather than the hardcoded
 * "ours/theirs" (or "current/incoming") labels that silently invert on rebase.
 *
 * A `SideIdentity` describes WHO/WHAT a conflict side really is: which branch
 * or commit it came from, its author, and whether that author is the current
 * user. The renderer consumes this to label the two panes truthfully; git
 * produces it today, and a wave-execution provider produces it in a later phase.
 *
 * Types only — no logic lives here (mirrors `ipc-contract.ts`). The concrete
 * git-backed provider lives in the main process (`main/git/conflict-context.ts`).
 */

import type { GitMergeState } from './ipc-contract'

/**
 * The concrete identity of one conflict side.
 *
 * `kind` names the git stage the side maps to (stage 2 = `ours`, stage 3 =
 * `theirs`, stage 1 = `base`) — this is stable across operations. The
 * *meaning* of that stage is what inverts between merge and rebase, which is
 * why `branch`/`author`/`isCurrentUser` carry the human-facing truth rather
 * than the raw stage label.
 */
export interface SideIdentity {
  /** The git conflict stage this side maps to. Stable regardless of operation. */
  kind: 'ours' | 'theirs' | 'base'
  /** The git ref this side was resolved from (e.g. `HEAD`, `MERGE_HEAD`, a SHA). */
  ref: string
  /** Human-readable branch name for the side, when one could be resolved. */
  branch?: string
  /** The commit SHA that authored this side's change, when known. */
  hash?: string
  /** Subject line of that commit, when known. */
  subject?: string
  /** Display name of that commit's author, when known. */
  author?: string
  /** True when the side's author is the repo's configured current user. */
  isCurrentUser: boolean
  /** ISO-8601 author date of the commit, when known. */
  when?: string
}

/**
 * The context a {@link SideIdentityProvider} needs to resolve a side's identity.
 * Minimal by design: the in-progress operation (`mergeState`) supplies the
 * side↔ref mapping, `rootPath` locates the repo, and `filePath` scopes the
 * lookup to a single conflicted file when identity is resolved per-file.
 */
export interface SideIdentityContext {
  /** Absolute path to the repository root the operation is running in. */
  rootPath: string
  /** The in-progress merge/rebase/cherry-pick state — the source of truth for the mapping. */
  mergeState: GitMergeState
  /** The conflicted file to scope the identity lookup to, when resolving per-file. */
  filePath?: string
}

/**
 * Resolves the concrete identity of a conflict side from operation context.
 *
 * The `side` argument is the git stage label (`ours` = stage 2, `theirs` =
 * stage 3); the returned {@link SideIdentity} maps that stage to its true
 * branch/commit/author for the current operation. Implemented by git now and
 * by a wave-execution provider in a later phase; consumed by the editor.
 */
export interface SideIdentityProvider {
  identify(
    side: 'ours' | 'theirs',
    ctx: SideIdentityContext,
  ): SideIdentity | Promise<SideIdentity>
}
