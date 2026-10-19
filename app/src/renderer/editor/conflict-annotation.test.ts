/**
 * The per-side identity annotation (conflict-annotation.ts) is applied to the real
 * editor as a Monaco decoration, but its STRING logic is pure and DOM-free. These
 * tests pin the format `<branch/ref> · <you|author> · <relative time>   (Current|
 * Incoming)`, the graceful fallbacks, and the rule that the stage tag is the ONLY
 * place a stage word appears — always paired with a concrete identity, never a
 * bare stage word standing in for the branch/author/time.
 */
import type { SideIdentity } from '../../shared/side-identity'
import { conflictAnnotationText } from './conflict-annotation'

const NOW = new Date('2026-07-21T12:00:00Z')

function identity(overrides: Partial<SideIdentity> = {}): SideIdentity {
  return { kind: 'ours', ref: 'HEAD', isCurrentUser: false, ...overrides }
}

describe('conflictAnnotationText', () => {
  it('formats branch · you · time with the (Current) tag for side A', () => {
    const text = conflictAnnotationText(
      identity({ branch: 'main', isCurrentUser: true, when: '2026-07-18T12:00:00Z' }),
      { side: 'a', now: NOW },
    )
    expect(text).toBe('main · you · 3d ago   (Current)')
  })

  it('formats branch · author · time with the (Incoming) tag for side B', () => {
    const text = conflictAnnotationText(
      identity({
        kind: 'theirs',
        ref: 'MERGE_HEAD',
        branch: 'feature/api',
        author: 'Ada Lovelace',
        when: '2026-07-20T12:00:00Z',
      }),
      { side: 'b', now: NOW },
    )
    expect(text).toBe('feature/api · Ada Lovelace · 1d ago   (Incoming)')
  })

  it('falls back to the marker/branch label when identity is absent', () => {
    expect(conflictAnnotationText(undefined, { side: 'a', fallbackLabel: 'HEAD' })).toBe('HEAD   (Current)')
    expect(conflictAnnotationText(undefined, { side: 'b', fallbackLabel: 'origin/main' })).toBe(
      'origin/main   (Incoming)',
    )
  })

  it('collapses to the bare stage tag when nothing is known (no neutral placeholder)', () => {
    expect(conflictAnnotationText(undefined, { side: 'a' })).toBe('(Current)')
    expect(conflictAnnotationText(undefined, { side: 'b' })).toBe('(Incoming)')
  })

  it('omits author and time when only a primary label is known', () => {
    expect(conflictAnnotationText(identity({ branch: 'release-2.0' }), { side: 'a', now: NOW })).toBe(
      'release-2.0   (Current)',
    )
  })

  it('uses a short hash when no branch or ref names the side', () => {
    const text = conflictAnnotationText(
      { kind: 'theirs', ref: '', hash: 'abcdef1234567', isCurrentUser: false },
      { side: 'b', now: NOW },
    )
    expect(text).toBe('abcdef1   (Incoming)')
  })

  it('never emits a bare stage word — the only stage token is the paired tag', () => {
    const forbidden = /\b(ours|theirs|current|incoming)\b/i
    const cases: string[] = [
      conflictAnnotationText(identity({ branch: 'main' }), { side: 'a', now: NOW }),
      conflictAnnotationText(undefined, { side: 'b', fallbackLabel: 'topic' }),
    ]
    for (const text of cases) {
      // Strip the permitted, identity-paired stage tag before asserting no bare word.
      const withoutTag = text.replace(/\((?:Current|Incoming)\)/g, '')
      expect(withoutTag).not.toMatch(forbidden)
    }
  })
})
