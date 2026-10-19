import type { ConflictProposal } from '../editor/conflict-proposal'
import type { SideIdentity } from '../../shared/side-identity'
import {
  buildConflictReviewViewModel,
  choiceLabel,
  decideAll,
  decideRow,
  type ConflictReviewInput,
} from './conflict-review-card-model'

const NOW = new Date('2026-07-27T12:00:00Z')

const proposal = (over: Partial<ConflictProposal> = {}): ConflictProposal => ({
  file: 'src/app.ts',
  blockId: 0,
  choice: 'ours',
  risk: 'safe',
  confidence: 0.9,
  why: 'both sides renamed the same symbol differently',
  how: 'keep the current branch rename',
  ...over,
})

const identity = (over: Partial<SideIdentity> = {}): SideIdentity => ({
  kind: 'ours',
  ref: 'HEAD',
  branch: 'feature/login',
  author: 'Ada',
  isCurrentUser: false,
  when: '2026-07-27T09:00:00Z',
  ...over,
})

const input = (over: Partial<ConflictReviewInput> = {}): ConflictReviewInput => ({
  proposal: proposal(),
  identity: identity(),
  side: 'a',
  rootPath: '/repo',
  filePath: 'src/app.ts',
  now: NOW,
  ...over,
})

describe('choiceLabel', () => {
  it('maps ours/theirs/both to the v2 editor wording', () => {
    expect(choiceLabel('ours')).toBe('Accept Current')
    expect(choiceLabel('theirs')).toBe('Accept Incoming')
    expect(choiceLabel('both')).toBe('Accept Both')
  })

  it('presents synthesized neutrally (no side to accept)', () => {
    expect(choiceLabel('synthesized')).toBe('Review synthesized')
  })
})

describe('buildConflictReviewViewModel', () => {
  it('shapes one proposal into a pending row with its choice + rationale', () => {
    const model = buildConflictReviewViewModel([input()])
    expect(model.rows).toHaveLength(1)
    const row = model.rows[0]!
    expect(row.choiceLabel).toBe('Accept Current')
    expect(row.rationale).toBe('both sides renamed the same symbol differently')
    expect(row.confidence).toBe(0.9)
    expect(row.risk).toBe('safe')
    expect(row.state).toBe('pending')
  })

  it('names the chosen side by identity (branch · author · time)', () => {
    const model = buildConflictReviewViewModel([input()])
    expect(model.rows[0]!.sideLabel).toBe('feature/login · Ada · 3h ago')
  })

  it('labels the current user as "you"', () => {
    const model = buildConflictReviewViewModel([
      input({ identity: identity({ isCurrentUser: true, author: 'Ada' }) }),
    ])
    expect(model.rows[0]!.sideLabel).toBe('feature/login · you · 3h ago')
  })

  it('falls back to a neutral side label when identity is absent', () => {
    const model = buildConflictReviewViewModel([
      input({ identity: undefined, side: 'b' }),
    ])
    expect(model.rows[0]!.sideLabel).toBe('Side B')
  })

  it('uses a fallback label when identity has no branch/ref/hash', () => {
    const model = buildConflictReviewViewModel([
      input({ identity: undefined, fallbackLabel: 'incoming-branch' }),
    ])
    expect(model.rows[0]!.sideLabel).toBe('incoming-branch')
  })

  it('keys a hunk-scoped row by file#hunkId and preserves hunkId', () => {
    const model = buildConflictReviewViewModel([input({ hunkId: 'h7' })])
    expect(model.rows[0]!.id).toBe('src/app.ts#h7')
    expect(model.rows[0]!.hunkId).toBe('h7')
  })

  it('carries rootPath + hunkId on the row so the view can navigate to the hunk', () => {
    const model = buildConflictReviewViewModel([
      input({ rootPath: '/repo', filePath: 'src/app.ts', hunkId: 'h7' }),
    ])
    expect(model.rows[0]!.rootPath).toBe('/repo')
    expect(model.rows[0]!.filePath).toBe('src/app.ts')
    expect(model.rows[0]!.hunkId).toBe('h7')
  })

  it('keys a whole-file row by file#blockId and omits hunkId', () => {
    const model = buildConflictReviewViewModel([
      input({ proposal: proposal({ blockId: 2 }) }),
    ])
    expect(model.rows[0]!.id).toBe('src/app.ts#2')
    expect(model.rows[0]!.hunkId).toBeUndefined()
  })

  it('preserves input order across multiple proposals', () => {
    const model = buildConflictReviewViewModel([
      input({ filePath: 'a.ts', proposal: proposal({ file: 'a.ts', blockId: 0 }) }),
      input({ filePath: 'b.ts', proposal: proposal({ file: 'b.ts', blockId: 0 }) }),
    ])
    expect(model.rows.map((r) => r.filePath)).toEqual(['a.ts', 'b.ts'])
  })

  it('summarizes distinct files, total proposals, and hunk rows', () => {
    const model = buildConflictReviewViewModel([
      input({ filePath: 'a.ts', hunkId: 'h1', proposal: proposal({ file: 'a.ts', blockId: 0 }) }),
      input({ filePath: 'a.ts', hunkId: 'h2', proposal: proposal({ file: 'a.ts', blockId: 1 }) }),
      input({ filePath: 'b.ts', proposal: proposal({ file: 'b.ts', blockId: 0 }) }),
    ])
    expect(model.summary).toEqual({ proposalCount: 3, fileCount: 2, hunkCount: 2 })
  })

  it('an empty input set is resolved with no rows', () => {
    const model = buildConflictReviewViewModel([])
    expect(model.rows).toHaveLength(0)
    expect(model.resolved).toBe(true)
    expect(model.summary).toEqual({ proposalCount: 0, fileCount: 0, hunkCount: 0 })
  })

  it('starts unresolved while any row is pending', () => {
    expect(buildConflictReviewViewModel([input()]).resolved).toBe(false)
  })
})

/**
 * The card model's side label uses the coarse "N<unit> ago" bucketing from
 * identity-chip-parts' shared `relativeTimeFrom` (imported directly — one source
 * of truth for the labelling). The buildConflictReviewViewModel tests above only
 * ever exercise the hours bucket, so these pin the remaining buckets directly on
 * the card's own sideLabel — minutes, days, months, years, plus the "just now"
 * floor for both a sub-threshold delta and a future (clock-skew) timestamp.
 */
describe('buildConflictReviewViewModel — side-label relative time buckets', () => {
  const at = (when: string): string =>
    buildConflictReviewViewModel([input({ identity: identity({ when }) })]).rows[0]!.sideLabel

  it('renders a minutes bucket', () => {
    expect(at('2026-07-27T11:50:00Z')).toBe('feature/login · Ada · 10m ago')
  })

  it('renders a days bucket', () => {
    expect(at('2026-07-22T12:00:00Z')).toBe('feature/login · Ada · 5d ago')
  })

  it('renders a months bucket', () => {
    expect(at('2026-05-28T12:00:00Z')).toBe('feature/login · Ada · 2mo ago')
  })

  it('renders a years bucket', () => {
    expect(at('2024-07-27T12:00:00Z')).toBe('feature/login · Ada · 2y ago')
  })

  it('floors a sub-threshold delta to "just now"', () => {
    expect(at('2026-07-27T11:59:40Z')).toBe('feature/login · Ada · just now')
  })

  it('collapses a future (clock-skew) timestamp to "just now", never a negative delta', () => {
    expect(at('2026-07-27T12:00:30Z')).toBe('feature/login · Ada · just now')
  })

  it('omits the time entirely when the identity has no commit instant', () => {
    const model = buildConflictReviewViewModel([input({ identity: identity({ when: undefined }) })])
    expect(model.rows[0]!.sideLabel).toBe('feature/login · Ada')
  })
})

describe('decideRow', () => {
  it('accepts one row by id, leaving the rest pending', () => {
    const before = buildConflictReviewViewModel([
      input({ filePath: 'a.ts', proposal: proposal({ file: 'a.ts', blockId: 0 }) }),
      input({ filePath: 'b.ts', proposal: proposal({ file: 'b.ts', blockId: 0 }) }),
    ])
    const after = decideRow(before, 'a.ts#0', 'accept')
    expect(after.rows[0]!.state).toBe('accepted')
    expect(after.rows[1]!.state).toBe('pending')
    expect(after.resolved).toBe(false)
  })

  it('rejects one row by id', () => {
    const before = buildConflictReviewViewModel([input()])
    const after = decideRow(before, 'src/app.ts#0', 'reject')
    expect(after.rows[0]!.state).toBe('rejected')
    expect(after.resolved).toBe(true)
  })

  it('does not mutate the input view-model or its rows', () => {
    const before = buildConflictReviewViewModel([input()])
    const after = decideRow(before, 'src/app.ts#0', 'accept')
    expect(before.rows[0]!.state).toBe('pending')
    expect(after).not.toBe(before)
    expect(after.rows).not.toBe(before.rows)
  })

  it('returns the model unchanged for an unknown id', () => {
    const before = buildConflictReviewViewModel([input()])
    const after = decideRow(before, 'nope#0', 'accept')
    expect(after.rows[0]!.state).toBe('pending')
    expect(after.resolved).toBe(false)
  })

  it('flips resolved once the last pending row is decided', () => {
    const first = buildConflictReviewViewModel([
      input({ filePath: 'a.ts', proposal: proposal({ file: 'a.ts', blockId: 0 }) }),
      input({ filePath: 'b.ts', proposal: proposal({ file: 'b.ts', blockId: 0 }) }),
    ])
    const second = decideRow(first, 'a.ts#0', 'accept')
    const third = decideRow(second, 'b.ts#0', 'reject')
    expect(third.resolved).toBe(true)
  })
})

describe('decideAll', () => {
  it('accepts every row and resolves the model', () => {
    const before = buildConflictReviewViewModel([
      input({ filePath: 'a.ts', proposal: proposal({ file: 'a.ts', blockId: 0 }) }),
      input({ filePath: 'b.ts', proposal: proposal({ file: 'b.ts', blockId: 0 }) }),
    ])
    const after = decideAll(before, 'accept')
    expect(after.rows.every((r) => r.state === 'accepted')).toBe(true)
    expect(after.resolved).toBe(true)
  })

  it('rejects every row and resolves the model', () => {
    const before = buildConflictReviewViewModel([input()])
    const after = decideAll(before, 'reject')
    expect(after.rows.every((r) => r.state === 'rejected')).toBe(true)
    expect(after.resolved).toBe(true)
  })

  it('does not mutate the input view-model', () => {
    const before = buildConflictReviewViewModel([input()])
    decideAll(before, 'accept')
    expect(before.rows[0]!.state).toBe('pending')
  })
})
