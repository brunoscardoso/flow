import { fuzzyScore } from './palette-fuzzy'

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'command')).toBeNull()
    expect(fuzzyScore('cmz', 'command')).toBeNull() // 'z' missing
    expect(fuzzyScore('a', '')).toBeNull() // empty target, non-empty query
  })

  it('matches a case-insensitive subsequence (non-contiguous allowed)', () => {
    expect(fuzzyScore('cmd', 'command')).not.toBeNull()
    expect(fuzzyScore('CMD', 'command')).not.toBeNull()
    expect(fuzzyScore('cmd', 'CoMmanD')).not.toBeNull()
  })

  it('empty query scores 0 (matches everything, no ranking signal)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('', '')).toBe(0)
  })

  it('ranks a contiguous run above a scattered match', () => {
    const contiguous = fuzzyScore('com', 'command') as number
    const scattered = fuzzyScore('com', 'c_o_m_x') as number
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('ranks a boundary hit above a mid-word hit', () => {
    // 's' at a '/' boundary vs 's' buried mid-segment.
    const boundary = fuzzyScore('s', 'src/store') as number
    const midWord = fuzzyScore('s', 'assets') as number
    expect(boundary).toBeGreaterThan(midWord)
  })

  it('rewards an earlier match position', () => {
    const early = fuzzyScore('a', 'apple') as number
    const late = fuzzyScore('a', 'zzzza') as number
    expect(early).toBeGreaterThan(late)
  })

  it('is deterministic for identical inputs', () => {
    expect(fuzzyScore('cmd', 'command')).toBe(fuzzyScore('cmd', 'command'))
  })
})
