import { computeCommandInsertion } from './command-insertion'

describe('computeCommandInsertion (#391)', () => {
  it('replaces the leading /token with the command + trailing space', () => {
    const { text, caret } = computeCommandInsertion('/br', 'brainstorm')
    expect(text).toBe('/brainstorm ')
    expect(caret).toBe('/brainstorm '.length)
  })

  it('is race-proof: a shorter-typed prefix never strands a trailing char (#391 repro)', () => {
    // The exact reported failure: value is `/br`, but a stale range once made
    // acceptance produce `/brainstorm r`. Deriving the span from the value fixes it.
    expect(computeCommandInsertion('/br', 'brainstorm').text).toBe('/brainstorm ')
    expect(computeCommandInsertion('/b', 'brainstorm').text).toBe('/brainstorm ')
    expect(computeCommandInsertion('/', 'brainstorm').text).toBe('/brainstorm ')
  })

  it('replaces the whole existing token, not a prefix of it', () => {
    // Even if the user typed the full name before picking, no duplication.
    expect(computeCommandInsertion('/brainstorm', 'brainstorm').text).toBe('/brainstorm ')
  })

  it('preserves anything after the first whitespace (the token ends at the space)', () => {
    expect(computeCommandInsertion('/br already typed', 'brainstorm').text).toBe(
      '/brainstorm  already typed',
    )
  })

  it('handles an empty value (bare accept)', () => {
    expect(computeCommandInsertion('', 'brainstorm').text).toBe('/brainstorm ')
  })
})
