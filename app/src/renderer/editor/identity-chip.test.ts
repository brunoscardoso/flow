import type { SideIdentity } from '../../shared/side-identity'
import {
  identityChipParts,
  relativeTimeFrom,
  sideDisplayLabel,
} from './identity-chip-parts'

const NOW = new Date('2026-07-21T12:00:00Z')

function identity(overrides: Partial<SideIdentity> = {}): SideIdentity {
  return {
    kind: 'ours',
    ref: 'HEAD',
    isCurrentUser: false,
    ...overrides,
  }
}

describe('identityChipParts', () => {
  it('prefers branch, then ref, then short hash, then fallback, then neutral', () => {
    expect(
      identityChipParts(identity({ branch: 'main', ref: 'HEAD', hash: 'abcdef1234' }), { side: 'a' })
        .primary,
    ).toBe('main')
    expect(identityChipParts(identity({ branch: undefined, ref: 'MERGE_HEAD' }), { side: 'b' }).primary).toBe(
      'MERGE_HEAD',
    )
    expect(
      identityChipParts(identity({ branch: undefined, ref: '', hash: 'abcdef1234567' }), { side: 'a' })
        .primary,
    ).toBe('abcdef1')
    expect(
      identityChipParts(undefined, { side: 'b', fallbackLabel: 'feature/login' }).primary,
    ).toBe('feature/login')
    expect(identityChipParts(undefined, { side: 'a' }).primary).toBe('Side A')
    expect(identityChipParts(undefined, { side: 'b' }).primary).toBe('Side B')
  })

  it('renders "you" for the current user and the author name otherwise', () => {
    expect(identityChipParts(identity({ isCurrentUser: true, author: 'Grace Hopper' }), { side: 'a' })).toMatchObject({
      isYou: true,
      author: 'you',
    })
    expect(identityChipParts(identity({ author: 'Ada Lovelace' }), { side: 'b' })).toMatchObject({
      isYou: false,
      author: 'Ada Lovelace',
    })
    expect(identityChipParts(identity({ author: undefined }), { side: 'a' }).author).toBeUndefined()
  })

  it('carries a relative time when the commit instant is known', () => {
    const parts = identityChipParts(
      identity({ when: '2026-07-18T12:00:00Z' }),
      { side: 'a', now: NOW },
    )
    expect(parts.relativeTime).toBe('3d ago')
  })

  it('never emits a stage word in any resolved part', () => {
    const forbidden = /\b(ours|theirs|current|incoming)\b/i
    const cases: Array<[SideIdentity | undefined, 'a' | 'b']> = [
      [undefined, 'a'],
      [undefined, 'b'],
      [identity({ branch: 'main', author: 'Ada', when: NOW.toISOString() }), 'a'],
      [identity({ isCurrentUser: true }), 'b'],
    ]
    for (const [id, side] of cases) {
      const parts = identityChipParts(id, { side, now: NOW })
      const text = [parts.primary, parts.author, parts.relativeTime].filter(Boolean).join(' ')
      expect(text).not.toMatch(forbidden)
    }
  })
})

describe('sideDisplayLabel', () => {
  it('is the primary label alone', () => {
    expect(sideDisplayLabel(identity({ branch: 'release' }), { side: 'a' })).toBe('release')
    expect(sideDisplayLabel(undefined, { side: 'b', fallbackLabel: 'topic' })).toBe('topic')
  })
})

describe('relativeTimeFrom', () => {
  it('returns undefined for missing or unparseable input', () => {
    expect(relativeTimeFrom(undefined, NOW)).toBeUndefined()
    expect(relativeTimeFrom('not-a-date', NOW)).toBeUndefined()
  })

  it('bins across the coarse scale', () => {
    expect(relativeTimeFrom('2026-07-21T11:59:40Z', NOW)).toBe('just now')
    expect(relativeTimeFrom('2026-07-21T11:30:00Z', NOW)).toBe('30m ago')
    expect(relativeTimeFrom('2026-07-21T08:00:00Z', NOW)).toBe('4h ago')
    expect(relativeTimeFrom('2026-07-11T12:00:00Z', NOW)).toBe('10d ago')
    expect(relativeTimeFrom('2026-05-21T12:00:00Z', NOW)).toBe('2mo ago')
    expect(relativeTimeFrom('2024-07-21T12:00:00Z', NOW)).toBe('2y ago')
  })

  it('collapses a future instant to "just now"', () => {
    expect(relativeTimeFrom('2026-07-21T12:05:00Z', NOW)).toBe('just now')
  })
})
