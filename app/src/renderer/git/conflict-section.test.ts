import type { GitFileChange } from '../../shared/ipc-contract'
import {
  hasResolvableConflicts,
  deriveFileResolutionStatus,
  deriveConflictOverview,
  fileResolutionStatusLabel,
  keepAllConfirmMessage,
  resolveSideConfirmMessage,
} from './conflict-section'

const change = (filePath: string, state: GitFileChange['state']): GitFileChange => ({
  filePath,
  state,
  staged: false,
  indexState: null,
  worktreeState: state === 'conflicted' ? null : state,
})

describe('hasResolvableConflicts', () => {
  it('is true iff at least one file is conflicted', () => {
    expect(hasResolvableConflicts([change('a.ts', 'conflicted')])).toBe(true)
    expect(hasResolvableConflicts([change('a.ts', 'modified')])).toBe(false)
    expect(hasResolvableConflicts([])).toBe(false)
  })
})

describe('deriveFileResolutionStatus (Phase 5 Task 2)', () => {
  it('a still-unmerged file is unresolved, even with a recorded hunk (partial)', () => {
    const unmerged = new Set(['a.ts'])
    expect(deriveFileResolutionStatus('a.ts', unmerged, [{ filePath: 'a.ts', auto: false }])).toBe(
      'unresolved',
    )
  })
  it('a resolved file with no auto hunks is resolved', () => {
    expect(deriveFileResolutionStatus('a.ts', new Set(), [{ filePath: 'a.ts', auto: false }])).toBe(
      'resolved',
    )
  })
  it('a resolved file with any auto hunk is auto-resolved', () => {
    expect(
      deriveFileResolutionStatus('a.ts', new Set(), [
        { filePath: 'a.ts', auto: false },
        { filePath: 'a.ts', auto: true },
      ]),
    ).toBe('auto-resolved')
  })
  it('a resolved file with no records at all is resolved (whole-file bulk resolve)', () => {
    expect(deriveFileResolutionStatus('a.ts', new Set(), [])).toBe('resolved')
  })
})

describe('deriveConflictOverview (Phase 5 Task 2)', () => {
  it('counts N of M across the full conflict set, keeping resolved files in M', () => {
    const overview = deriveConflictOverview({
      files: ['a.ts', 'b.ts', 'c.ts'],
      unmergedPaths: ['b.ts', 'c.ts'], // a.ts resolved and dropped out of unmerged
      resolutions: [{ filePath: 'a.ts', auto: true }],
    })
    expect(overview.total).toBe(3)
    expect(overview.resolvedCount).toBe(1)
    expect(overview.counterLabel).toBe('1 of 3 resolved')
    expect(overview.allResolved).toBe(false)
    const a = overview.rows.find((r) => r.filePath === 'a.ts')
    expect(a?.status).toBe('auto-resolved')
    expect(overview.rows.find((r) => r.filePath === 'b.ts')?.status).toBe('unresolved')
  })
  it('allResolved once nothing remains unmerged', () => {
    const overview = deriveConflictOverview({
      files: ['a.ts', 'b.ts'],
      unmergedPaths: [],
      resolutions: [{ filePath: 'b.ts', auto: false }],
    })
    expect(overview.resolvedCount).toBe(2)
    expect(overview.allResolved).toBe(true)
    expect(overview.counterLabel).toBe('2 of 2 resolved')
  })
  it('unions in files that only appear via unmergedPaths or resolutions', () => {
    const overview = deriveConflictOverview({
      files: [],
      unmergedPaths: ['x.ts'],
      resolutions: [{ filePath: 'y.ts', auto: false }],
    })
    expect(overview.rows.map((r) => r.filePath)).toEqual(['x.ts', 'y.ts'])
    expect(overview.total).toBe(2)
    expect(overview.resolvedCount).toBe(1)
  })
  it('empty everything → 0 of 0, not allResolved', () => {
    const overview = deriveConflictOverview({ files: [], unmergedPaths: [], resolutions: [] })
    expect(overview.counterLabel).toBe('0 of 0 resolved')
    expect(overview.allResolved).toBe(false)
  })
})

describe('fileResolutionStatusLabel', () => {
  it('renders human labels', () => {
    expect(fileResolutionStatusLabel('unresolved')).toBe('Unresolved')
    expect(fileResolutionStatusLabel('resolved')).toBe('Resolved')
    expect(fileResolutionStatusLabel('auto-resolved')).toContain('Auto-resolved')
  })
})

describe('destructive-resolution confirm copy', () => {
  it('keep-all names the action, counts the files, and states the finality', () => {
    const msg = keepAllConfirmMessage(7, 'Keep all from main')
    expect(msg).toContain('Keep all from main')
    expect(msg).toContain('7 conflicted files')
    expect(msg).toContain('cannot be undone')
    expect(keepAllConfirmMessage(1, 'Keep all from both')).toContain('1 conflicted file?')
  })

  it('per-row accept names the file and which side survives', () => {
    expect(resolveSideConfirmMessage('src/a.ts', 'ours')).toContain('current (your) side')
    expect(resolveSideConfirmMessage('src/a.ts', 'theirs')).toContain('incoming side')
    expect(resolveSideConfirmMessage('src/a.ts', 'ours')).toContain('src/a.ts')
  })
})
