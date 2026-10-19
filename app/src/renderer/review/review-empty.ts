/**
 * The Review (Phases) empty state (#1332) — pure, DOM-free.
 *
 * The panel had exactly ONE empty state, `No changes to review`, and showed it
 * for every condition in which git did not (or could not) answer: no project
 * open, a folder that is not a repository, and a repo whose `.git` vanished
 * mid-session while it was listing a modified file. All three read as a
 * confident "your tree is clean" — the most reassuring possible sentence for
 * the two states that are anything but.
 *
 * The Changes view sitting beside it has always told them apart. These are its
 * strings, so the two views stop contradicting each other about the same
 * folder.
 */

export interface ReviewEmptyState {
  /** A project root is open. */
  hasProject: boolean
  /** What git said — absent on older payloads, treated as `ok`. */
  gitState?: 'ok' | 'no-repo'
}

export function reviewEmptyMessage(state: ReviewEmptyState): string {
  // #1359: "project root" is internal jargon that appears nowhere a user
  // can see. The Files pane's wording is the app's own.
  if (!state.hasProject) return 'No project open'
  if (state.gitState === 'no-repo') return 'Not a git repository'
  return 'No changes to review'
}
