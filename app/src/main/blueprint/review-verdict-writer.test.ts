// Pure-only tests for the review-verdict writer's entry builder (Board Review
// Mode, #609). fs I/O (appendReviewVerdict) is intentionally NOT exercised here
// — app jest is CJS ts-jest and these assertions stay clock-free and pure.

import {
  boardReviewRunId,
  buildReviewVerdictEntry,
  buildVerdictFingerprint,
  type ReviewVerdictEntry,
} from './review-verdict-writer'

describe('buildVerdictFingerprint', () => {
  it('uses the stable file-level convention <file>+file-change+board-review', () => {
    expect(buildVerdictFingerprint('src/app.ts')).toBe('src/app.ts+file-change+board-review')
  })
})

describe('boardReviewRunId', () => {
  it('derives board-review-<YYYYMMDD> in UTC', () => {
    // 2026-07-16T23:30:00Z → still the 16th in UTC.
    expect(boardReviewRunId(new Date('2026-07-16T23:30:00Z'))).toBe('board-review-20260716')
  })

  it('zero-pads month and day', () => {
    expect(boardReviewRunId(new Date('2026-01-05T00:00:00Z'))).toBe('board-review-20260105')
  })
})

describe('buildReviewVerdictEntry', () => {
  const base = {
    file: 'src/main/index.ts',
    classification: 'kept' as const,
    runId: 'board-review-20260716',
    ts: '2026-07-16T12:00:00.000Z',
  }

  it('produces the full review_verdict rounds shape', () => {
    const entry = buildReviewVerdictEntry(base)
    const expected: ReviewVerdictEntry = {
      ts: '2026-07-16T12:00:00.000Z',
      run_id: 'board-review-20260716',
      type: 'review_verdict',
      phase: null,
      finding_fingerprint: 'src/main/index.ts+file-change+board-review',
      classification: 'kept',
      reason: '',
      anchors: [{ kind: 'file', ref: 'src/main/index.ts', file: 'src/main/index.ts' }],
    }
    expect(entry).toEqual(expected)
  })

  it('pins phase to null and type to the literal review_verdict', () => {
    const entry = buildReviewVerdictEntry(base)
    expect(entry.phase).toBeNull()
    expect(entry.type).toBe('review_verdict')
  })

  it('defaults reason to the empty string when omitted', () => {
    expect(buildReviewVerdictEntry(base).reason).toBe('')
  })

  it('preserves a supplied reason verbatim', () => {
    const entry = buildReviewVerdictEntry({ ...base, reason: 'looks intentional' })
    expect(entry.reason).toBe('looks intentional')
  })

  it('carries the dismissed classification through unchanged', () => {
    const entry = buildReviewVerdictEntry({ ...base, classification: 'dismissed' })
    expect(entry.classification).toBe('dismissed')
  })

  it('anchors the verdict to its file for promotion', () => {
    const entry = buildReviewVerdictEntry(base)
    expect(entry.anchors).toEqual([
      { kind: 'file', ref: 'src/main/index.ts', file: 'src/main/index.ts' },
    ])
  })

  it("fingerprint matches the standalone builder's output", () => {
    const entry = buildReviewVerdictEntry(base)
    expect(entry.finding_fingerprint).toBe(buildVerdictFingerprint(base.file))
  })
})
