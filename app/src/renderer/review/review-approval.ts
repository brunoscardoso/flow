// Pure state for the review panel's phase button. It was a disabled "Commit"
// button mislabeled "Approve all" — clicking did nothing (#50). Now the button
// has two live modes: while files remain unapproved it "Approve all"s them; once
// all are approved it becomes "Commit phase" (enabled with a message). DOM-free
// so the transitions unit-test directly.

import type { ReviewFile } from '../../shared/ipc-contract'

export interface CommitButtonState {
  label: string
  disabled: boolean
  /** What a click should do in this state. */
  action: 'approve-all' | 'commit' | 'resolve-conflicts' | 'none'
}

/**
 * The git pathspecs to hand `git:commit` for a review selection. Trailing-slash
 * entries are wholly-new untracked DIRECTORIES — git rolls a brand-new dir up as
 * a single `newfeature/` entry — and they are KEPT: `git add -- newfeature/`
 * stages the directory (the git layer's ensureInsideRoot strips the slash).
 * Filtering them out (the old behavior) silently dropped new directories, making
 * a directory-only group's Commit a dead no-op and partially committing mixed
 * groups (#176). Mirrors discardGroup, which reverts every entry incl. dirs.
 * Blank/whitespace entries are dropped so the caller's emptiness guard is real.
 */
export function commitPaths(filePaths: readonly string[]): string[] {
  return filePaths.filter((path) => path.trim().length > 0)
}

/**
 * Every path a set of review files occupies — for a rename, BOTH sides (#1182).
 *
 * A rename is one change across two paths. Naming only the new one meant the
 * path-scoped commit (#1051) left the staged deletion of the old path out: HEAD
 * ended up holding both files, rename tracking was lost, and a `D old` stayed
 * pending in the worktree where #1181 made it un-committable. Staging is the
 * same story — un-approving only the new path turned git's `R old -> new` into
 * `D old` + `?? new` and wedged the group at "Approve all (1/2)".
 */
export function filePathsWithRenameSources(files: readonly ReviewFile[]): string[] {
  const paths: string[] = []
  for (const file of files) {
    if (file.renamedFrom !== undefined && file.renamedFrom.trim().length > 0) {
      paths.push(file.renamedFrom)
    }
    paths.push(file.filePath)
  }
  return [...new Set(paths.filter((path) => path.trim().length > 0))]
}

/**
 * The file paths whose approval is BACKED by the staging area. Approval implies
 * staged-ness (#857) — but only while the approval is FRESH: a file rewritten
 * after it was approved (`unreviewedSinceApproval`, #1052) is excluded, so the
 * ✓ downgrades to a re-approve affordance and `commitButtonState` re-gates the
 * phase button until the newer content is approved too.
 *
 * For a file SEVERAL groups claim, staged-ness alone satisfies no group's gate
 * (#1432) — the panel intersects this set with the approvals GIVEN in each
 * group (`effectiveGroupApprovals`) before gating.
 */
export function approvedFilePaths(files: readonly ReviewFile[]): Set<string> {
  return new Set(
    files
      .filter((file) => file.staged && file.unreviewedSinceApproval !== true)
      .map((file) => file.filePath),
  )
}

/**
 * Every file path claimed by MORE than one review group — the shape
 * ReviewService documents as "a file claimed by several phases appears under
 * each". For these paths a per-FILE fact (staged-ness) cannot answer the
 * per-GROUP question "was this reviewed HERE?" (#1432).
 */
export function pathsClaimedBySeveralGroups(
  groups: ReadonlyArray<{ files: readonly ReviewFile[] }>,
): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const group of groups) {
    for (const file of group.files) {
      if (seen.has(file.filePath)) shared.add(file.filePath)
      else seen.add(file.filePath)
    }
  }
  return shared
}

/**
 * The approvals a group may count toward its own gate.
 *
 * A file only THIS group claims keeps #857's full two-way sync: staged (and
 * fresh, #1052) means approved — a rename staged by `git mv`, or a file staged
 * from the Source Control panel, arrives committable exactly as before.
 *
 * A file several groups claim (#1432) counts only while an approval GIVEN in
 * this group (its ✓ clicks / "Approve all") still has staging backing it.
 * Staged-ness stays authoritative in the NEGATIVE direction — unstaging, or a
 * rewrite since approval (#1052, excluded from `staged`), revokes here too —
 * but it never GRANTS across groups: one ✓ inside Phase 1 cannot arm a
 * Phase 2 the user never opened.
 */
export function effectiveGroupApprovals(
  given: ReadonlySet<string>,
  staged: ReadonlySet<string>,
  sharedAcrossGroups: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...staged].filter((path) => !sharedAcrossGroups.has(path) || given.has(path)),
  )
}

/**
 * Reconcile a group's given-approval memory with the files its listing now
 * shows. Entries whose file left the listing are dropped — that file's review
 * lifecycle ended (committed, discarded, rejected away). One exception: a
 * wholly-new untracked DIRECTORY is a single rolled-up `dir/` entry until it
 * is staged (#176), after which the listing swaps it for the concrete staged
 * paths beneath it — an approval given on the rolled-up entry carries to
 * those paths, or "Approve all" on a group holding a new directory could
 * never arm its own commit (#1432).
 */
export function reconcileInGroupApprovals(
  given: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>()
  for (const path of given) {
    if (present.has(path)) {
      next.add(path)
      continue
    }
    if (path.endsWith('/')) {
      for (const candidate of present) {
        if (candidate.startsWith(path)) next.add(candidate)
      }
    }
  }
  return next
}

/** True when every file in the group is approved (an empty group is not). */
export function allFilesApproved(filePaths: string[], approved: Set<string>): boolean {
  return filePaths.length > 0 && filePaths.every((path) => approved.has(path))
}

/**
 * Decide the phase button's label / enabled state / click action from the file
 * set, the approved set, the current commit message, and the set of files whose
 * merge conflict is still unresolved (#986).
 *
 * Conflicted files are excluded from "Approve all" (staging an unmerged path
 * tells git the conflict is resolved), and while any remain the button becomes
 * "Resolve N conflicts first" — kept ENABLED so a click can explain itself via
 * the `resolve-conflicts` action (a toast pointing at the merge resolver)
 * instead of dying silently. The authoritative gate lives main-side in
 * GitManager.unresolvedConflictPaths; this only mirrors the `conflicted` state
 * the listing already derived from git.
 */
export function commitButtonState(
  filePaths: string[],
  approved: Set<string>,
  message: string,
  conflicted: ReadonlySet<string> = new Set(),
): CommitButtonState {
  const approvable = filePaths.filter((path) => !conflicted.has(path))
  const conflictCount = filePaths.length - approvable.length
  const approvableRemain = approvable.some((path) => !approved.has(path))
  if (approvableRemain || (conflictCount === 0 && !allFilesApproved(filePaths, approved))) {
    const done = approvable.filter((path) => approved.has(path)).length
    return {
      label: `Approve all (${done}/${approvable.length})`,
      disabled: false,
      action: 'approve-all',
    }
  }
  if (conflictCount > 0) {
    return {
      label: `Resolve ${conflictCount} conflict${conflictCount === 1 ? '' : 's'} first`,
      disabled: false,
      action: 'resolve-conflicts',
    }
  }
  const hasMessage = message.trim().length > 0
  return { label: 'Commit phase', disabled: !hasMessage, action: hasMessage ? 'commit' : 'none' }
}
