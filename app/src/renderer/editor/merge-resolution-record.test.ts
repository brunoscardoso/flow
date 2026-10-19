import type { MergeSummaryConflict } from '../../shared/ipc-contract'
import {
  clearHunkResolutions,
  clearMergeResolutionSession,
  getHunkResolutions,
  getHunkResolutionsForFile,
  getAutoResolutions,
  hasAutoResolution,
  getMergeResolutionSession,
  recordHunkResolution,
  recordMergeResolutionConflicts,
  recordMergeResolutionVerify,
  undoHunkResolution,
  type HunkResolution,
} from './merge-resolution-record'

const ROOT = '/repo/a'

function hunk(overrides: Partial<HunkResolution> = {}): HunkResolution {
  return {
    filePath: 'src/f.ts',
    hunkId: 'hunk-abc',
    choice: 'ours',
    auto: false,
    ...overrides,
  }
}

// Each test starts from a clean store (module state is process-global).
afterEach(() => {
  clearMergeResolutionSession(ROOT)
})

describe('per-hunk resolution record', () => {
  it('records and reads back a hunk choice', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', choice: 'theirs', auto: true }))
    const all = getHunkResolutions(ROOT)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ hunkId: 'h1', choice: 'theirs', auto: true })
  })

  it('re-resolving the same hunk REPLACES rather than stacking', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', choice: 'ours' }))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', choice: 'theirs' }))
    const all = getHunkResolutions(ROOT)
    expect(all).toHaveLength(1)
    expect(all[0].choice).toBe('theirs')
  })

  it('keeps distinct hunks in one file, and filters by file', () => {
    recordHunkResolution(ROOT, hunk({ filePath: 'a.ts', hunkId: 'h1' }))
    recordHunkResolution(ROOT, hunk({ filePath: 'a.ts', hunkId: 'h2' }))
    recordHunkResolution(ROOT, hunk({ filePath: 'b.ts', hunkId: 'h3' }))
    expect(getHunkResolutions(ROOT)).toHaveLength(3)
    expect(getHunkResolutionsForFile(ROOT, 'a.ts')).toHaveLength(2)
    expect(getHunkResolutionsForFile(ROOT, 'b.ts')).toHaveLength(1)
  })

  it('carries order + side identities through', () => {
    recordHunkResolution(
      ROOT,
      hunk({
        hunkId: 'h1',
        choice: 'both',
        order: 'theirs-first',
        oursIdentity: { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true },
        theirsIdentity: { kind: 'theirs', ref: 'MERGE_HEAD', branch: 'feature', isCurrentUser: false },
      }),
    )
    const [rec] = getHunkResolutions(ROOT)
    expect(rec.order).toBe('theirs-first')
    expect(rec.oursIdentity?.branch).toBe('main')
    expect(rec.theirsIdentity?.branch).toBe('feature')
  })

  it('undo removes exactly one hunk and returns the removed record', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1' }))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h2', choice: 'theirs' }))

    const removed = undoHunkResolution(ROOT, 'src/f.ts', 'h1')
    expect(removed).toMatchObject({ hunkId: 'h1', choice: 'ours' })
    const remaining = getHunkResolutions(ROOT)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].hunkId).toBe('h2')
  })

  it('undo of an unknown hunk returns null and changes nothing', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1' }))
    expect(undoHunkResolution(ROOT, 'src/f.ts', 'nope')).toBeNull()
    expect(getHunkResolutions(ROOT)).toHaveLength(1)
  })

  it('a resolved-then-undone hunk can be re-resolved (reversible)', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', choice: 'ours' }))
    undoHunkResolution(ROOT, 'src/f.ts', 'h1')
    expect(getHunkResolutions(ROOT)).toHaveLength(0)
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', choice: 'theirs' }))
    expect(getHunkResolutions(ROOT)[0].choice).toBe('theirs')
  })

  it('clearHunkResolutions drops the per-hunk layer only', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1' }))
    clearHunkResolutions(ROOT)
    expect(getHunkResolutions(ROOT)).toHaveLength(0)
  })
})

describe('per-file summary layer coexists with per-hunk (backward compat)', () => {
  const conflict: MergeSummaryConflict = {
    file: 'src/f.ts',
    oursIntent: '',
    theirsIntent: '',
    choice: 'ours',
    finalRisk: 'safe',
    confidence: 1,
    why: '',
    how: '',
  }

  it('records/reads the per-file session unchanged', () => {
    recordMergeResolutionConflicts(new Map([[ROOT, [conflict]]]))
    recordMergeResolutionVerify(ROOT, { ok: true, ran: ['tsc'] })
    const session = getMergeResolutionSession(ROOT)
    expect(session?.conflicts).toHaveLength(1)
    expect(session?.verify?.ok).toBe(true)
  })

  it('clearMergeResolutionSession drops BOTH layers', () => {
    recordMergeResolutionConflicts(new Map([[ROOT, [conflict]]]))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1' }))
    clearMergeResolutionSession(ROOT)
    expect(getMergeResolutionSession(ROOT)).toBeNull()
    expect(getHunkResolutions(ROOT)).toHaveLength(0)
  })
})

describe('inspectable + reversible auto-resolve (Phase 5 Task 4)', () => {
  afterEach(() => clearHunkResolutions(ROOT))

  it('getAutoResolutions returns only AI-applied hunks', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', auto: true }))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h2', auto: false }))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h3', auto: true }))
    expect(getAutoResolutions(ROOT).map((r) => r.hunkId).sort()).toEqual(['h1', 'h3'])
  })

  it('hasAutoResolution is true only for a file with an auto hunk', () => {
    recordHunkResolution(ROOT, hunk({ filePath: 'src/a.ts', hunkId: 'h1', auto: true }))
    recordHunkResolution(ROOT, hunk({ filePath: 'src/b.ts', hunkId: 'h2', auto: false }))
    expect(hasAutoResolution(ROOT, 'src/a.ts')).toBe(true)
    expect(hasAutoResolution(ROOT, 'src/b.ts')).toBe(false)
    expect(hasAutoResolution(ROOT, 'src/missing.ts')).toBe(false)
  })

  it('captures originalBlock so undo can reverse the hunk (re-introduce markers)', () => {
    const markers = '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature'
    recordHunkResolution(
      ROOT,
      hunk({ hunkId: 'h1', auto: true, choice: 'ours', originalBlock: markers }),
    )
    const removed = undoHunkResolution(ROOT, 'src/f.ts', 'h1')
    expect(removed?.originalBlock).toBe(markers)
    // The record is gone after undo — the hunk is no longer counted as resolved.
    expect(getHunkResolutions(ROOT)).toHaveLength(0)
    expect(getAutoResolutions(ROOT)).toHaveLength(0)
  })

  it('undo of an auto hunk leaves sibling auto hunks intact', () => {
    recordHunkResolution(ROOT, hunk({ hunkId: 'h1', auto: true }))
    recordHunkResolution(ROOT, hunk({ hunkId: 'h2', auto: true }))
    undoHunkResolution(ROOT, 'src/f.ts', 'h1')
    expect(getAutoResolutions(ROOT).map((r) => r.hunkId)).toEqual(['h2'])
  })
})
