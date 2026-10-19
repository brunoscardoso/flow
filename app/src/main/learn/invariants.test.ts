import { parseInvariants } from './invariants'

describe('parseInvariants (#898)', () => {
  it('legacy doc without the section → present:false, never errors', () => {
    const doc = '# billing\n\nDoes billing things.\n\n## Changelog\n- created'
    expect(parseInvariants(doc)).toEqual({ invariants: [], present: false })
    expect(parseInvariants('')).toEqual({ invariants: [], present: false })
  })

  it('rich section: one invariant per bullet, backticked files extracted', () => {
    const doc = [
      '# billing',
      '',
      '## Invariants',
      '- All writes go through `observe()` in `store.ts` and `writer.ts`',
      '- Amounts are integer cents, never floats (`invoice.ts`)',
      '* Retries are idempotent',
      '',
      '## Changelog',
      '- created',
    ].join('\n')
    const parsed = parseInvariants(doc)
    expect(parsed.present).toBe(true)
    expect(parsed.invariants).toHaveLength(3)
    expect(parsed.invariants[0].files).toEqual(['store.ts', 'writer.ts'])
    expect(parsed.invariants[0].text).toContain('All writes go through observe()')
    expect(parsed.invariants[1].files).toEqual(['invoice.ts'])
    expect(parsed.invariants[2]).toEqual({ text: 'Retries are idempotent', files: [] })
  })

  it('section ends at the next heading', () => {
    const doc = '## Invariants\n- real one\n\n### Notes\n- not an invariant'
    expect(parseInvariants(doc).invariants).toHaveLength(1)
  })

  it('"(none observed)" sentinel → present:true, zero invariants', () => {
    const doc = '# mod\n\n## Invariants\n- (none observed)'
    expect(parseInvariants(doc)).toEqual({ invariants: [], present: true })
  })

  it('non-file backtick spans are not treated as file refs', () => {
    const doc = '## Invariants\n- `git status` output is `porcelain v1` parsed by `git.ts`'
    const [inv] = parseInvariants(doc).invariants
    expect(inv.files).toEqual(['git.ts'])
  })
})
