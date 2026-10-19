/**
 * The inline resolver (conflict-merge-editor.ts) is a Monaco/DOM surface that the
 * app jest env (no DOM lib) cannot import. These tests cover the DOM-free logic it
 * composes.
 *
 * v2 (conflict-resolution-ux): the per-hunk accept controls now carry FIXED,
 * identity-independent labels — `Accept Current` / `Accept Incoming` / `Accept Both`.
 * The disambiguation moved OFF the button and onto the per-side identity annotation
 * (conflict-annotation.ts), so `Current`/`Incoming` here are intentional and paired
 * with that annotation at render time. The identity still drives (a) the annotation
 * and (b) the Keep-both REORDER menu, which names each side — and that menu must
 * still stay free of stage words.
 */
import type { SideIdentity } from '../../shared/side-identity'
import { sideDisplayLabel } from './identity-chip-parts'
import { hunkControlSpecs, keepBothOrderOptions } from './conflict-hunk-controls'

/** Stage words are still forbidden in the side-naming REORDER labels (they name a
 *  branch/side, never a git stage). The Accept-action labels are exempt (v2: the
 *  identity annotation disambiguates them). */
const FORBIDDEN = /\b(ours|theirs|current|incoming)\b/i

describe('inline resolver control labelling (v2)', () => {
  it('uses fixed Accept-action labels, independent of side identity', () => {
    const labels = hunkControlSpecs().map((spec) => spec.label)
    expect(labels).toEqual(['Accept Current', 'Accept Incoming', 'Accept Both'])
  })

  it('maps each accept action to the correct hunk choice', () => {
    const specs = hunkControlSpecs()
    expect(specs.map((spec) => spec.choice)).toEqual(['ours', 'theirs', 'both'])
  })

  it('resolves side identity for the annotation + reorder menu', () => {
    const ours: SideIdentity = { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true }
    const theirs: SideIdentity = { kind: 'theirs', ref: 'MERGE_HEAD', branch: 'feature', isCurrentUser: false }
    const sideA = sideDisplayLabel(ours, { side: 'a' })
    const sideB = sideDisplayLabel(theirs, { side: 'b' })
    expect(sideA).toBe('main')
    expect(sideB).toBe('feature')
  })

  it('keeps the Keep-both reorder labels free of stage words (they name sides)', () => {
    const ours: SideIdentity = { kind: 'ours', ref: 'HEAD', isCurrentUser: true }
    const sideA = sideDisplayLabel(ours, { side: 'a' })
    const sideB = sideDisplayLabel(undefined, { side: 'b', fallbackLabel: 'release-2.0' })
    for (const option of keepBothOrderOptions(sideA, sideB)) {
      expect(option.label).not.toMatch(FORBIDDEN)
    }
  })
})
