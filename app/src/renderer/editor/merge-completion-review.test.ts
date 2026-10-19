import type { SideIdentity } from '../../shared/side-identity'
import { WHOLE_FILE_HUNK_ID, type HunkResolution } from './merge-resolution-record'
import {
  buildMergeCompletionReview,
  keptLabel,
} from './merge-completion-review'

const ours: SideIdentity = { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true }
const theirs: SideIdentity = {
  kind: 'theirs',
  ref: 'MERGE_HEAD',
  branch: 'feature',
  isCurrentUser: false,
}

function hunk(overrides: Partial<HunkResolution> = {}): HunkResolution {
  return {
    filePath: 'src/f.ts',
    hunkId: 'h1',
    choice: 'ours',
    auto: false,
    oursIdentity: ours,
    theirsIdentity: theirs,
    ...overrides,
  }
}

describe('keptLabel (Phase 5 Task 5) — identity terms, never ours/theirs', () => {
  it('ours → the ours-side branch label', () => {
    expect(keptLabel(hunk({ choice: 'ours' }))).toBe('main')
  })
  it('theirs → the theirs-side branch label', () => {
    expect(keptLabel(hunk({ choice: 'theirs' }))).toBe('feature')
  })
  it('both → both labels in ours-first order by default', () => {
    expect(keptLabel(hunk({ choice: 'both' }))).toBe('both (main + feature)')
  })
  it('both respects theirs-first concatenation order', () => {
    expect(keptLabel(hunk({ choice: 'both', order: 'theirs-first' }))).toBe(
      'both (feature + main)',
    )
  })
  it('falls back to neutral Side A/B when identity is absent', () => {
    expect(keptLabel(hunk({ choice: 'ours', oursIdentity: undefined }))).toBe('Side A')
    expect(keptLabel(hunk({ choice: 'theirs', theirsIdentity: undefined }))).toBe('Side B')
  })
  it('never leaks a stage word', () => {
    for (const choice of ['ours', 'theirs', 'both'] as const) {
      const label = keptLabel(hunk({ choice })).toLowerCase()
      expect(label).not.toContain('ours')
      expect(label).not.toContain('theirs')
    }
  })
})

describe('buildMergeCompletionReview (Phase 5 Task 5)', () => {
  it('lists every resolved hunk in identity terms, ordered by file then hunk', () => {
    const review = buildMergeCompletionReview([
      hunk({ filePath: 'src/b.ts', hunkId: 'h2', choice: 'theirs' }),
      hunk({ filePath: 'src/a.ts', hunkId: 'h1', choice: 'ours', auto: true }),
    ])
    expect(review.rows.map((r) => `${r.filePath}:${r.kept}`)).toEqual([
      'src/a.ts:main',
      'src/b.ts:feature',
    ])
    expect(review.autoCount).toBe(1)
    expect(review.manualCount).toBe(1)
    expect(review.hasResolutions).toBe(true)
    expect(review.headline).toContain('2 hunks resolved')
    expect(review.headline).toContain('1 auto-applied')
  })

  it('an empty set has no resolutions and a plain headline', () => {
    const review = buildMergeCompletionReview([])
    expect(review.hasResolutions).toBe(false)
    expect(review.rows).toEqual([])
    expect(review.headline).toContain('No recorded hunk resolutions')
  })

  it('singular wording for a single hunk, and no auto note when none were auto', () => {
    const review = buildMergeCompletionReview([hunk({ auto: false })])
    expect(review.headline).toContain('1 hunk resolved')
    expect(review.headline).not.toContain('auto-applied')
  })
})

describe('whole-file resolutions in the review (#1288)', () => {
  // The Source Control panel's own "keep this side" button resolved the
  // conflict and recorded NOTHING, so pressing the panel's own Complete merge
  // produced "No recorded hunk resolutions — confirm to complete": the one
  // screen that exists to answer "what am I about to commit?" answered nothing,
  // on the path the panel itself steers you down.
  const wholeFile = (filePath: string, choice: 'ours' | 'theirs' | 'both' = 'ours') => ({
    filePath,
    hunkId: WHOLE_FILE_HUNK_ID,
    choice,
    auto: false,
  })

  it('names the file and the side kept for a panel-button resolution', () => {
    const review = buildMergeCompletionReview([wholeFile('shared.txt')])
    expect(review.hasResolutions).toBe(true)
    expect(review.rows[0]?.filePath).toBe('shared.txt')
    expect(review.rows[0]?.kept).toBeTruthy()
    expect(review.headline).not.toContain('No recorded')
  })

  it('calls a whole-file resolution a CONFLICT, not a hunk', () => {
    // Counting it as a hunk is the same category error that made these
    // resolutions unreportable in the first place.
    const review = buildMergeCompletionReview([wholeFile('shared.txt')])
    expect(review.rows[0]?.wholeFile).toBe(true)
    expect(review.headline).toBe('1 conflict resolved — confirm to commit')
  })

  it('keeps the editor path’s wording byte-identical', () => {
    // The per-hunk path's string is what the live control asserts; a set with
    // no whole-file rows must read exactly as it always has.
    const review = buildMergeCompletionReview([
      { filePath: 'shared.txt', hunkId: '1-1-abc', choice: 'ours', auto: false },
    ])
    expect(review.rows[0]?.wholeFile).toBe(false)
    expect(review.headline).toBe('1 hunk resolved — confirm to commit')
  })

  it('counts a mixed set in conflicts, the weaker claim', () => {
    const review = buildMergeCompletionReview([
      wholeFile('a.txt'),
      { filePath: 'b.txt', hunkId: '1-1-abc', choice: 'theirs', auto: false },
    ])
    expect(review.headline).toBe('2 conflicts resolved — confirm to commit')
  })
})
