/**
 * WHAT THE SOURCE-CONTROL HEADER OFFERS, PER MODE.
 *
 * WHY THIS EXISTS AT ALL. Four capabilities have exactly one door in this app
 * and it is the Git panel: **pull**, **merge branch**, **complete merge** and
 * **abort merge** (discovery C1, verified). The panel is being retired, so each
 * one needs a new home before the old one goes — and "needs a home" is a
 * decision about WHEN a control means anything, which is the part worth
 * testing. This module is that decision; the header renders whatever it says.
 *
 * NOTHING HERE REIMPLEMENTS THE MERGE RULES. `deriveMergeBanner` already decides
 * whether a merge is in progress, whether it can be completed, and what message
 * it carries — including the deliberate refusal to offer merge buttons during a
 * cherry-pick, which would run the wrong git command. It is CALLED, not copied
 * (allowed-pattern #14), exactly as `worktree-actions` calls the Storage page's
 * own rule rather than restating it.
 *
 * A VERB IS OFFERED ONLY WHERE IT MEANS SOMETHING. The old panel showed every
 * control all the time and disabled most of them; a header that does that in
 * three modes would be mostly grey. So a verb that cannot act in this mode is
 * ABSENT, and a verb that is present but blocked carries the reason.
 *
 * Pure and DOM-free; no path, command or config key crosses it
 * (forbidden-pattern #12).
 */

import type { GitMergeState } from '../../shared/ipc-contract'
import { deriveMergeBanner } from '../git/git-panel-state'
import type { SourceControlMode } from './source-control-mode'

/** The verbs the header can carry. Ids, never the words on screen. */
export type SourceControlVerb = 'pull' | 'merge-branch' | 'complete-merge' | 'abort-merge'

export interface HeaderVerb {
  id: SourceControlVerb
  label: string
  /** False when it is present but cannot act right now. */
  enabled: boolean
  /** Why it cannot act, or null. A sentence, never a command to type. */
  reason: string | null
}

/**
 * The verbs for one mode.
 *
 * CHANGES gets the two that bring work IN — pull and merge branch — because
 * that is the mode where a person is working on the tree and may want it
 * current. Neither is offered mid-merge: pulling into a stopped merge is how a
 * confusing state becomes an unrecoverable one.
 *
 * CONFLICTS gets the two that END the operation, and only while one is actually
 * in progress. Complete is present-but-blocked while anything is unresolved —
 * present, because it is the thing the reader is working toward and hiding it
 * makes the mode look like it has no exit.
 *
 * HISTORY gets none. Nothing in a list of what already happened is an action on
 * the working tree, and a header full of controls that act somewhere else is
 * how a reader ends up pulling while reading a commit from last week.
 */
export function headerVerbs(
  mode: SourceControlMode,
  merge: GitMergeState | null,
): HeaderVerb[] {
  const banner = deriveMergeBanner(merge)

  if (mode === 'history') return []

  if (mode === 'conflicts') {
    // Not wired for this op (a cherry-pick, say) — offering merge's buttons
    // would run the wrong command, so the mode carries none.
    if (!banner.visible) return []
    const isRebase = banner.op === 'rebase'
    return [
      {
        id: 'complete-merge',
        label: isRebase ? 'Continue rebase' : 'Complete merge',
        enabled: banner.canComplete,
        reason: banner.canComplete
          ? null
          : banner.unmergedCount === 1
            ? 'One file still has a conflict to settle.'
            : `${String(banner.unmergedCount)} files still have conflicts to settle.`,
      },
      { id: 'abort-merge', label: 'Abort', enabled: true, reason: null },
    ]
  }

  // CHANGES.
  if (banner.visible) {
    // A merge is in progress but this mode is showing — the tab only lands here
    // when nothing is unresolved. Bringing more work in now is still wrong.
    return [
      {
        id: 'pull',
        label: 'Pull',
        enabled: false,
        reason: 'Finish the merge that is in progress first.',
      },
      {
        id: 'merge-branch',
        label: 'Merge branch…',
        enabled: false,
        reason: 'Finish the merge that is in progress first.',
      },
    ]
  }
  return [
    { id: 'pull', label: 'Pull', enabled: true, reason: null },
    { id: 'merge-branch', label: 'Merge branch…', enabled: true, reason: null },
  ]
}

/** The message `complete-merge` should carry, or '' when there is none. */
export function completeMergeMessage(merge: GitMergeState | null): string {
  return deriveMergeBanner(merge).message
}
