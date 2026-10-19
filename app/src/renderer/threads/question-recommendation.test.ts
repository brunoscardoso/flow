import { parseOptionLabel } from './question-recommendation'

describe('parseOptionLabel', () => {
  it('strips the canonical trailing marker and flags the option', () => {
    expect(parseOptionLabel('Bundle en-US locally (Recommended)')).toEqual({
      label: 'Bundle en-US locally',
      recommended: true,
    })
  })

  it('accepts the separators and casing agents actually write', () => {
    const written = [
      'Ship it (recommended)',
      'Ship it — (Recommended)',
      'Ship it - (RECOMMENDED)',
      'Ship it [Recommended]',
      'Ship it(Recommended)',
    ]
    for (const label of written) {
      expect(parseOptionLabel(label)).toEqual({ label: 'Ship it', recommended: true })
    }
  })

  it('accepts the marker written as a prefix', () => {
    expect(parseOptionLabel('(Recommended) Ship it')).toEqual({
      label: 'Ship it',
      recommended: true,
    })
  })

  it('leaves an unmarked label alone', () => {
    expect(parseOptionLabel('Larger initial JS bundle')).toEqual({
      label: 'Larger initial JS bundle',
      recommended: false,
    })
  })

  it('does not flag a label that merely mentions the word', () => {
    expect(parseOptionLabel('Recommended by the linter')).toEqual({
      label: 'Recommended by the linter',
      recommended: false,
    })
    expect(parseOptionLabel('Follow the (recommended) path exactly')).toEqual({
      label: 'Follow the (recommended) path exactly',
      recommended: false,
    })
  })

  it('leaves a marker-only label intact rather than emptying it', () => {
    // No choice text would survive the strip — a badge beside an empty label
    // reads as a rendering bug, so the label is shown as written.
    expect(parseOptionLabel('(Recommended)')).toEqual({
      label: '(Recommended)',
      recommended: false,
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseOptionLabel('  Ship it  ')).toEqual({ label: 'Ship it', recommended: false })
  })
})
