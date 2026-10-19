/**
 * The one-line banner a diff needs when its two CONTENT panes cannot show the
 * change (#1185).
 *
 * `GitManager.diff()` compares content only, so a `chmod +x` produced two
 * byte-identical sides under a header still claiming "Working tree vs HEAD" —
 * indistinguishable from a diff that failed to load (#192's class): the panel
 * insisted the file changed and the diff insisted it didn't. A brand-new empty
 * file had the same shape, with both panes simply blank.
 *
 * Pure so the wording is unit-testable; diff-view renders whatever this returns.
 */
import type { GitDiff } from '../../shared/ipc-contract'

export function diffNote(diff: GitDiff): string | null {
  // Main already resolved the interesting case (it can read git's mode header).
  if (typeof diff.note === 'string' && diff.note.length > 0) return diff.note
  if (diff.binary === true) return null
  if (diff.beforeContent !== diff.afterContent) return null
  // Identical sides with no explanation from main: say the honest thing rather
  // than showing two blank panes that read as a failure.
  if (diff.beforeContent === '' && diff.afterContent === '') {
    return 'This file is empty.'
  }
  return 'No content changes.'
}
