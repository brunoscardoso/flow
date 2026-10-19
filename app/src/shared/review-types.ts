// Shared shapes for the phase-grouped review panel. Kept out of
// ipc-contract.ts so the (frequently-edited) contract only references them.

import type { GitFileState } from './ipc-contract'

export interface ReviewFile {
  /** Project-relative path, as git reports it. */
  filePath: string
  state: GitFileState
  /** True when the index (staging area) carries this file — the review
   *  surface's "approved" state IS staged-ness (#857): approving stages,
   *  staging in the git panel reads back as approved here. */
  staged: boolean
  /** True when the file was approved (staged) but the WORKING TREE has moved on
   *  since (`MM`-class: index holds the reviewed content, disk holds newer,
   *  unreviewed edits) — #1052. The panel downgrades the ✓ to a re-approve
   *  affordance and the phase button treats the file as unapproved, so content
   *  the user never saw can't commit under a mark that says they did. */
  unreviewedSinceApproval?: boolean
  /** For `state: 'renamed'`, the path the file was renamed FROM (#1182). The
   *  pair is ONE change: commit/stage/unstage must always cover both paths, or
   *  the rename lands as half a rename (both files in HEAD) or shatters into
   *  `D old` + `?? new`. Absent for every other state. */
  renamedFrom?: string
}

export interface ReviewGroup {
  /** Phase id (e.g. "phase-2"), or null for the "Other changes" group. */
  phase: string | null
  label: string
  files: ReviewFile[]
  /** Conventional-commit message suggested for this group (editable in the UI). */
  suggestedMessage: string
}

export interface ReviewListResult {
  groups: ReviewGroup[]
  /**
   * #1332: whether git could answer at all. The Phases panel had exactly ONE
   * empty state — "No changes to review" — shown for every condition in which
   * git did not answer, so a folder that is not a repository, and a repo whose
   * `.git` vanished mid-session, both produced the same confident "your tree
   * is clean" sentence. The Changes view beside it says "Not a git repository"
   * for the same folder.
   *
   * `no-repo` is exact: GitManager.status returns null ONLY for a
   * not-a-repository error; anything else throws and surfaces as a failure
   * (#1333). Absent on older payloads — treated as `ok`, the previous
   * behaviour.
   */
  gitState?: 'ok' | 'no-repo'
}
