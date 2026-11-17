import {
  diffFile,
  diffFollowsTree,
  diffSubtitle,
  diffTabTitle,
  hunkActions,
  hunkAnchorLine,
  sameDiffTarget,
} from './diff-tab-model'

describe('diff tab model', () => {
  const worktree = { kind: 'worktree' as const, rootPath: '/r', filePath: 'src/a.ts' }
  const index = { kind: 'index' as const, rootPath: '/r', filePath: 'src/a.ts' }
  const commit = { kind: 'commit' as const, rootPath: '/r', filePath: 'src/a.ts', commit: 'abcdef1234' }

  it('titles each comparison in VS Code’s words', () => {
    expect(diffTabTitle(worktree)).toBe('a.ts (Working Tree)')
    expect(diffTabTitle(index)).toBe('a.ts (Index)')
    expect(diffTabTitle(commit)).toBe('a.ts (abcdef1)')
    expect(diffTabTitle({ kind: 'commit-all', rootPath: '/r', commit: 'abcdef1234', subject: 'feat: x' })).toBe(
      'feat: x (abcdef1)',
    )
    expect(diffSubtitle(worktree)).toBe('Working tree vs index')
    expect(diffSubtitle(index)).toBe('Staged vs HEAD')
  })

  it('offers stage + revert on the working tree, unstage on the index, nothing on a commit', () => {
    expect(hunkActions(worktree)).toEqual(['stage', 'revert'])
    expect(hunkActions(index)).toEqual(['unstage'])
    expect(hunkActions(commit)).toEqual([])
  })

  it('follows the tree only for live comparisons, and knows its file', () => {
    expect(diffFollowsTree(worktree)).toBe(true)
    expect(diffFollowsTree(commit)).toBe(false)
    expect(diffFile(commit)).toBe('src/a.ts')
    expect(diffFile({ kind: 'commit-all', rootPath: '/r', commit: 'abcd', subject: 's' })).toBeNull()
    expect(sameDiffTarget(worktree, { ...worktree })).toBe(true)
    expect(sameDiffTarget(worktree, index)).toBe(false)
  })

  it('anchors a hunk button above its first line, and after the line a deletion follows', () => {
    expect(hunkAnchorLine({ newStart: 12, newLines: 3 })).toEqual({ afterLine: 11 })
    expect(hunkAnchorLine({ newStart: 12, newLines: 0 })).toEqual({ afterLine: 12 })
    expect(hunkAnchorLine({ newStart: 0, newLines: 0 })).toEqual({ afterLine: 0 })
    expect(hunkAnchorLine({ newStart: 1, newLines: 1 })).toEqual({ afterLine: 0 })
  })
})
