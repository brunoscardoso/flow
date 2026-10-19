import { assignSections } from './git-status-model'
import type { GitFileChange, GitFileState } from '../../shared/ipc-contract'

const file = (
  filePath: string,
  index: GitFileState | null,
  worktree: GitFileState | null,
  state: GitFileState = worktree ?? index ?? 'modified',
): GitFileChange => ({
  filePath,
  state,
  staged: index !== null,
  indexState: index,
  worktreeState: worktree,
})

describe('assignSections (#335)', () => {
  it('routes a staged-only file to Staged only', () => {
    const s = assignSections([file('a.ts', 'modified', null)])
    expect(s.staged.map((f) => f.filePath)).toEqual(['a.ts'])
    expect(s.changes).toEqual([])
    expect(s.merge).toEqual([])
  })

  it('routes a worktree-only file to Changes only', () => {
    const s = assignSections([file('b.ts', null, 'modified')])
    expect(s.changes.map((f) => f.filePath)).toEqual(['b.ts'])
    expect(s.staged).toEqual([])
  })

  it('shows a staged-then-modified file in BOTH Staged and Changes', () => {
    const s = assignSections([file('c.ts', 'modified', 'modified')])
    expect(s.staged.map((f) => f.filePath)).toEqual(['c.ts'])
    expect(s.changes.map((f) => f.filePath)).toEqual(['c.ts'])
  })

  it('routes an untracked file to Changes', () => {
    const s = assignSections([file('new.ts', null, 'untracked', 'untracked')])
    expect(s.changes.map((f) => f.filePath)).toEqual(['new.ts'])
    expect(s.staged).toEqual([])
  })

  it('routes a conflicted file to Merge ONLY', () => {
    const s = assignSections([file('x.ts', null, null, 'conflicted')])
    expect(s.merge.map((f) => f.filePath)).toEqual(['x.ts'])
    expect(s.staged).toEqual([])
    expect(s.changes).toEqual([])
  })

  it('falls back to the legacy `staged` flag when sub-states are absent', () => {
    const stagedLegacy: GitFileChange = { filePath: 'legacy.ts', state: 'modified', staged: true }
    const unstagedLegacy: GitFileChange = { filePath: 'legacy2.ts', state: 'modified', staged: false }
    const s = assignSections([stagedLegacy, unstagedLegacy])
    expect(s.staged.map((f) => f.filePath)).toEqual(['legacy.ts'])
    expect(s.changes.map((f) => f.filePath)).toEqual(['legacy2.ts'])
  })

  it('returns empty sections for no changes', () => {
    expect(assignSections([])).toEqual({ merge: [], staged: [], changes: [] })
  })
})
