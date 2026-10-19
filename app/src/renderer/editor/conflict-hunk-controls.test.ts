import { hunkControlSpecs, keepBothOrderOptions } from './conflict-hunk-controls'

/** The reorder-menu labels must still stay free of stage words (they name the two
 *  sides, e.g. "main first"); the primary Accept actions deliberately use the v2
 *  "Current / Incoming / Both" wording, disambiguated by the per-side annotation. */
const FORBIDDEN = /\b(ours|theirs|current|incoming)\b/i

describe('hunkControlSpecs', () => {
  it('maps the three controls to the right hunk choices', () => {
    const specs = hunkControlSpecs()
    expect(specs.map((spec) => ({ key: spec.key, choice: spec.choice, order: spec.order }))).toEqual([
      { key: 'keep-a', choice: 'ours', order: undefined },
      { key: 'keep-b', choice: 'theirs', order: undefined },
      { key: 'keep-both', choice: 'both', order: 'ours-first' },
    ])
  })

  it('labels each control with the fixed v2 Accept wording', () => {
    const specs = hunkControlSpecs()
    expect(specs.map((spec) => spec.label)).toEqual(['Accept Current', 'Accept Incoming', 'Accept Both'])
  })
})

describe('keepBothOrderOptions', () => {
  it('offers side-A-first then side-B-first, mapped to the concatenation order', () => {
    expect(keepBothOrderOptions('main', 'feature')).toEqual([
      { label: 'main first', order: 'ours-first' },
      { label: 'feature first', order: 'theirs-first' },
    ])
  })

  it('never emits a stage word in an order label', () => {
    for (const option of keepBothOrderOptions('main', 'feature')) {
      expect(option.label).not.toMatch(FORBIDDEN)
    }
  })
})
