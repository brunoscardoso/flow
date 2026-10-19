/**
 * Unit tests for the pure proposal -> review-input mapping (conflict-UX v2, Phase
 * 4). This covers the DOM-free core the resolve-flow orchestration
 * (conflict-resolve-index.ts) extracts into conflict-review-inputs.ts: side
 * selection, hunk resolution, apply-target construction, and original-block
 * capture. Named to match the `conflict-resolve-index` verify pattern.
 */
import {
  buildConflictReviewItems,
  markerBlockText,
  type ConflictFileReview,
} from './conflict-review-inputs'
import { parseConflicts } from './conflict-parser'
import type { ConflictProposal } from './conflict-proposal'
import { rowIdForInput } from '../threads/conflict-review-card-model'
import type { SideIdentity } from '../../shared/side-identity'

const MARKERED = [
  'const a = 1',
  '<<<<<<< HEAD',
  'const b = 2',
  '=======',
  'const b = 3',
  '>>>>>>> feature-branch',
  'const c = 4',
  '<<<<<<< HEAD',
  'const d = 5',
  '=======',
  'const d = 6',
  '>>>>>>> feature-branch',
].join('\n')

const OURS: SideIdentity = {
  kind: 'ours',
  ref: 'HEAD',
  branch: 'main',
  isCurrentUser: true,
  author: 'Me',
  when: '2020-01-01T00:00:00Z',
}
const THEIRS: SideIdentity = {
  kind: 'theirs',
  ref: 'MERGE_HEAD',
  branch: 'feature',
  isCurrentUser: false,
  author: 'Them',
}

function proposal(overrides: Partial<ConflictProposal> = {}): ConflictProposal {
  return {
    file: 'src/a.ts',
    blockId: 0,
    choice: 'ours',
    risk: 'safe',
    confidence: 0.9,
    why: 'both edited the same line',
    how: 'kept ours',
    ...overrides,
  }
}

function file(overrides: Partial<ConflictFileReview> = {}): ConflictFileReview {
  return {
    rootPath: '/repo',
    filePath: 'src/a.ts',
    markered: MARKERED,
    proposals: [proposal()],
    oursIdentity: OURS,
    theirsIdentity: THEIRS,
    ...overrides,
  }
}

const BLOCKS = parseConflicts(MARKERED)

describe('buildConflictReviewItems — side selection', () => {
  it('maps an ours choice to side a with the ours identity + ours marker fallback', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ choice: 'ours' })] })])
    expect(item.input.side).toBe('a')
    expect(item.input.identity).toBe(OURS)
    expect(item.input.fallbackLabel).toBe('HEAD')
    expect(item.apply?.choice).toBe('ours')
  })

  it('maps a theirs choice to side b with the theirs identity + theirs marker fallback', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ choice: 'theirs' })] })])
    expect(item.input.side).toBe('b')
    expect(item.input.identity).toBe(THEIRS)
    expect(item.input.fallbackLabel).toBe('feature-branch')
    expect(item.apply?.choice).toBe('theirs')
  })

  it('maps a both choice to the primary side a with a both apply target', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ choice: 'both' })] })])
    expect(item.input.side).toBe('a')
    expect(item.input.identity).toBe(OURS)
    expect(item.apply?.choice).toBe('both')
  })

  it('presents a synthesized choice neutrally — no identity, no fallback, no apply target', () => {
    const [item] = buildConflictReviewItems([
      file({ proposals: [proposal({ choice: 'synthesized', risk: 'risky' })] }),
    ])
    expect(item.input.side).toBe('a')
    expect(item.input.identity).toBeUndefined()
    expect(item.input.fallbackLabel).toBeUndefined()
    expect(item.apply).toBeUndefined()
  })
})

describe('buildConflictReviewItems — hunk resolution + apply target', () => {
  it('resolves blockId to the matching hunk id and captures the original marker block', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ blockId: 0 })] })])
    expect(item.input.hunkId).toBe(BLOCKS[0].hunkId)
    expect(item.apply?.hunkId).toBe(BLOCKS[0].hunkId)
    expect(item.apply?.rootId).toBe('/repo')
    expect(item.apply?.filePath).toBe('src/a.ts')
    const expectedBlock = markerBlockText(MARKERED, BLOCKS[0].startLine, BLOCKS[0].endLine)
    expect(item.apply?.originalBlock).toBe(expectedBlock)
    expect(item.apply?.originalBlock).toContain('<<<<<<< HEAD')
    expect(item.apply?.originalBlock).toContain('>>>>>>> feature-branch')
  })

  it('targets the SECOND block for blockId 1 (siblings never collide)', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ blockId: 1 })] })])
    expect(item.input.hunkId).toBe(BLOCKS[1].hunkId)
    expect(item.apply?.originalBlock).toContain('const d = 5')
  })

  it('holds an out-of-range blockId — no hunk id, no apply target', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ blockId: 99 })] })])
    expect(item.input.hunkId).toBeUndefined()
    expect(item.apply).toBeUndefined()
  })

  it('coerces a numeric-string blockId to its block index', () => {
    const [item] = buildConflictReviewItems([file({ proposals: [proposal({ blockId: '1' })] })])
    expect(item.input.hunkId).toBe(BLOCKS[1].hunkId)
  })
})

describe('buildConflictReviewItems — identity fallback + ordering', () => {
  it('omits identity when the side has none, leaving the marker label as fallback', () => {
    const [item] = buildConflictReviewItems([
      file({ proposals: [proposal({ choice: 'theirs' })], theirsIdentity: undefined }),
    ])
    expect(item.input.identity).toBeUndefined()
    expect(item.input.fallbackLabel).toBe('feature-branch')
  })

  it('preserves file-then-proposal order across multiple files', () => {
    const items = buildConflictReviewItems([
      file({ filePath: 'src/a.ts', proposals: [proposal({ file: 'src/a.ts', blockId: 0 })] }),
      file({
        filePath: 'src/b.ts',
        proposals: [
          proposal({ file: 'src/b.ts', blockId: 0, choice: 'theirs' }),
          proposal({ file: 'src/b.ts', blockId: 1, choice: 'both' }),
        ],
      }),
    ])
    expect(items.map((item) => item.input.filePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/b.ts'])
    expect(items.map((item) => item.input.side)).toEqual(['a', 'b', 'a'])
  })

  it('keys each item by the SAME row id the card derives', () => {
    const items = buildConflictReviewItems([file({ proposals: [proposal({ blockId: 0 }), proposal({ blockId: 1 })] })])
    for (const item of items) {
      expect(item.rowId).toBe(rowIdForInput(item.input))
    }
    // Two blocks of one file never collide on a single row id.
    expect(new Set(items.map((item) => item.rowId)).size).toBe(items.length)
  })

  it('never mutates the input proposals', () => {
    const original = proposal({ choice: 'ours' })
    const snapshot = JSON.stringify(original)
    buildConflictReviewItems([file({ proposals: [original] })])
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})
