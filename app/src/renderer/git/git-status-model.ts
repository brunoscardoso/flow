// Section model for the unified Source Control panel (#335). VS Code splits the
// changed files into three sections — Merge Changes, Staged Changes, Changes — and
// a file that is staged then further edited appears in BOTH Staged and Changes. This
// pure module assigns each GitFileChange (with its index/worktree sub-states from
// Phase 1) to those sections; the panel renders the result. DOM-free so it's
// unit-testable under the node jest env.
import type { GitFileChange } from '../../shared/ipc-contract'

export interface SourceControlSections {
  /** Conflicted files — resolved via the Merge Changes section. */
  merge: GitFileChange[]
  /** Files with a staged (index) change. */
  staged: GitFileChange[]
  /** Files with an unstaged (working-tree) change (incl. untracked). */
  changes: GitFileChange[]
}

/** True when a file has a staged (index) change. Falls back to the legacy `staged`
 *  flag when the index/worktree sub-states are absent (older payloads). */
function hasStaged(file: GitFileChange): boolean {
  if (file.indexState !== undefined) return file.indexState !== null
  return file.staged
}

/** True when a file has an unstaged (working-tree) change. Falls back to the legacy
 *  `staged` flag (a non-staged change is a worktree change) when sub-states absent. */
function hasWorktree(file: GitFileChange): boolean {
  if (file.worktreeState !== undefined) return file.worktreeState !== null
  return !file.staged
}

/**
 * Split changes into Merge / Staged / Changes. A conflicted file goes ONLY to
 * merge; every other file goes to staged and/or changes based on its sub-states —
 * a staged-then-edited file appears in both.
 */
export function assignSections(changes: readonly GitFileChange[]): SourceControlSections {
  const sections: SourceControlSections = { merge: [], staged: [], changes: [] }
  for (const file of changes) {
    if (file.state === 'conflicted') {
      sections.merge.push(file)
      continue
    }
    if (hasStaged(file)) sections.staged.push(file)
    if (hasWorktree(file)) sections.changes.push(file)
  }
  return sections
}
