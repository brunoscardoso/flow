import { turnUsageTotals } from './turn-usage'

// #1136: the SDK reports a turn's input in three buckets and `input_tokens` is
// only the uncached remainder. These pin the sum, using the numbers measured on
// the real 3-turn thread in the issue.

describe('turnUsageTotals', () => {
  it('sums the uncached remainder with both cache buckets', () => {
    expect(
      turnUsageTotals({
        input_tokens: 2,
        output_tokens: 47,
        cache_read_input_tokens: 7_400,
        cache_creation_input_tokens: 12,
      }),
    ).toEqual({ inputTokens: 7_414, cachedInputTokens: 7_412, outputTokens: 47 })
  })

  it('reports a first, uncached turn unchanged', () => {
    expect(
      turnUsageTotals({
        input_tokens: 4_059,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toEqual({ inputTokens: 4_059, cachedInputTokens: 0, outputTokens: 7 })
  })

  it('treats missing cache buckets as zero (provider that omits them)', () => {
    expect(turnUsageTotals({ input_tokens: 120, output_tokens: 8 })).toEqual({
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 8,
    })
  })

  it('never yields NaN from missing, null, or nonsense usage', () => {
    const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    expect(turnUsageTotals(undefined)).toEqual(zero)
    expect(turnUsageTotals(null)).toEqual(zero)
    expect(turnUsageTotals({ input_tokens: Number.NaN, output_tokens: -3 })).toEqual(zero)
  })

  it('grows as the thread grows — the regression the issue reported', () => {
    const turn2 = turnUsageTotals({
      input_tokens: 929,
      output_tokens: 63,
      cache_read_input_tokens: 4_059,
      cache_creation_input_tokens: 3_400,
    })
    const turn3 = turnUsageTotals({
      input_tokens: 2,
      output_tokens: 47,
      cache_read_input_tokens: 8_388,
      cache_creation_input_tokens: 0,
    })
    expect(turn3.inputTokens).toBeGreaterThan(turn2.inputTokens)
  })
})
