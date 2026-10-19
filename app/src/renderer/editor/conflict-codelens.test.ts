/**
 * The conflict CodeLens (conflict-codelens.ts) is a Monaco/DOM surface the app
 * jest env (no DOM lib) cannot import. These tests cover the DOM-free logic it
 * composes for its Accept lenses: the fixed v2 action wording and the choice
 * mapping the shared control specs supply (conflict-UX v2 Phase 2 — the per-side
 * identity annotation, not the label, is the disambiguator).
 */
import { hunkControlSpecs } from './conflict-hunk-controls'

/** Reproduce how the CodeLens titles a hunk's Accept lenses. */
function acceptLensTitles(): string[] {
  return hunkControlSpecs().map((spec) => spec.label)
}

describe('conflict CodeLens Accept-lens titling', () => {
  it('titles the Accept lenses with the fixed v2 wording', () => {
    expect(acceptLensTitles()).toEqual(['Accept Current', 'Accept Incoming', 'Accept Both'])
  })

  it('maps each Accept lens to the right hunk choice', () => {
    expect(hunkControlSpecs().map((spec) => spec.choice)).toEqual(['ours', 'theirs', 'both'])
  })

  it('the both lens defaults to Current-first (ours-first)', () => {
    const bothSpec = hunkControlSpecs().find((spec) => spec.key === 'keep-both')
    expect(bothSpec?.choice).toBe('both')
    expect(bothSpec?.order).toBe('ours-first')
  })
})
