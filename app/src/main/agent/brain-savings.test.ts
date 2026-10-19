import {
  BURST_CALL_CHAR_CAP,
  CHARS_PER_TOKEN,
  DEFAULT_BASELINE_TOKENS,
  MAX_BURST_SAMPLES,
  appendBurstSamples,
  baselineTokens,
  burstCallTokens,
  classifyBrainSearches,
  estimateSavedTokens,
  estimateThreadSavedTokens,
  estimateThreadSavings,
  medianOf,
  resolveBaseline,
  outputText,
  splitByTurnBoundaries,
  type TurnBoundedToolCall,
} from './brain-savings'
import { analyzeBrainUsage } from './brain-usage'

// ── helpers ────────────────────────────────────────────────────────────────

/** ISO timestamp `seconds` into a fixed minute — lexically ordered. */
function at(seconds: number): string {
  return `2026-07-28T10:00:${seconds.toFixed(0).padStart(2, '0')}.000Z`
}

function bash(command: string, output?: string, startedAt = at(0)): TurnBoundedToolCall {
  return {
    toolName: 'Bash',
    inputJson: JSON.stringify({ command }),
    outputJson: output === undefined ? null : JSON.stringify(output),
    startedAt,
  }
}

function tool(
  toolName: string,
  input: Record<string, unknown> = {},
  output?: string,
  startedAt = at(0),
): TurnBoundedToolCall {
  return {
    toolName,
    inputJson: JSON.stringify(input),
    outputJson: output === undefined ? null : JSON.stringify(output),
    startedAt,
  }
}

const SEARCH = 'planflow-ai brain search "thread scope"'

// ── outputText ─────────────────────────────────────────────────────────────

describe('outputText', () => {
  it('flattens strings, content-block arrays, and text objects', () => {
    expect(outputText(JSON.stringify('plain'))).toBe('plain')
    expect(outputText(JSON.stringify([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))).toBe(
      'a\nb',
    )
    expect(outputText(JSON.stringify({ text: 'obj' }))).toBe('obj')
  })

  it('treats non-JSON as raw text and missing output as empty', () => {
    expect(outputText('not json at all')).toBe('not json at all')
    expect(outputText(null)).toBe('')
  })

  it('caps oversized raw output BEFORE parsing — a multi-MB blob is never materialized', () => {
    // 3MB of valid JSON: must come back as exactly the raw 50k-char slice
    // (truncated JSON no longer parses, so the raw-text branch serves it).
    const giant = JSON.stringify('a'.repeat(3_000_000))
    const text = outputText(giant)
    expect(text.length).toBe(BURST_CALL_CHAR_CAP)
    expect(text).toBe(giant.slice(0, BURST_CALL_CHAR_CAP))
  })
})

// ── burst measurement ──────────────────────────────────────────────────────

describe('burstCallTokens', () => {
  it('measures output chars / 4 as tokens', () => {
    expect(burstCallTokens(bash('rg x', 'a'.repeat(4_000)))).toBe(1_000)
  })

  it('caps a single call at 50k chars so one giant dump cannot skew', () => {
    const giant = bash('rg x', 'a'.repeat(300_000))
    expect(burstCallTokens(giant)).toBe(BURST_CALL_CHAR_CAP / CHARS_PER_TOKEN)
  })

  it('reads zero for missing output', () => {
    expect(burstCallTokens(bash('rg x'))).toBe(0)
  })
})

// ── classification (must agree with the brain-usage analyzer) ──────────────

describe('classifyBrainSearches', () => {
  it('classifies a search with no following exploration as a hit', () => {
    const analysis = classifyBrainSearches([bash(SEARCH), tool('Read', { file_path: '/x' })])
    expect(analysis).toEqual({ hits: 1, misses: 0, burstCosts: [] })
  })

  it('classifies a search followed by an exploration burst as a miss and sums the burst', () => {
    const analysis = classifyBrainSearches([
      bash(SEARCH),
      tool('Grep', { pattern: 'x' }, 'g'.repeat(400)),
      bash('rg fallback', 'r'.repeat(800)),
    ])
    expect(analysis.hits).toBe(0)
    expect(analysis.misses).toBe(1)
    expect(analysis.burstCosts).toEqual([100 + 200])
  })

  it('does not let non-exploration calls (Read etc.) close or extend a window', () => {
    const analysis = classifyBrainSearches([
      bash(SEARCH),
      tool('Read', { file_path: '/x' }),
      tool('Grep', {}, 'g'.repeat(400)),
    ])
    expect(analysis).toEqual({ hits: 0, misses: 1, burstCosts: [100] })
  })

  it('scopes windows per search and measures each burst separately', () => {
    const analysis = classifyBrainSearches([
      bash(SEARCH), // miss — grep below
      tool('Grep', {}, 'g'.repeat(4_000)),
      bash(SEARCH), // hit — nothing after
    ])
    expect(analysis).toEqual({ hits: 1, misses: 1, burstCosts: [1_000] })
  })

  it('ignores exploration before the first search', () => {
    expect(classifyBrainSearches([tool('Grep'), bash('rg x')])).toEqual({
      hits: 0,
      misses: 0,
      burstCosts: [],
    })
  })

  it('agrees with analyzeBrainUsage hit/miss semantics on the same window', () => {
    const windows: TurnBoundedToolCall[][] = [
      [bash(SEARCH), tool('Read')],
      [bash(SEARCH), tool('Grep'), tool('Glob'), bash('rg x')],
      [bash(SEARCH), tool('Grep'), bash(SEARCH), tool('Read')],
      [tool('Grep'), bash(SEARCH)],
      [bash(SEARCH), bash(SEARCH), tool('Grep')],
    ]
    for (const calls of windows) {
      const tally = analyzeBrainUsage(calls)
      const analysis = classifyBrainSearches(calls)
      expect(analysis.misses).toBe(tally.misses)
      expect(analysis.hits + analysis.misses).toBe(tally.searches)
    }
  })
})

// ── baseline (median + fallback) ───────────────────────────────────────────

describe('medianOf / baselineTokens', () => {
  it('takes the middle value (odd) and the mean of the middle two (even)', () => {
    expect(medianOf([5_000, 1_000, 9_000])).toBe(5_000)
    expect(medianOf([1_000, 2_000, 8_000, 10_000])).toBe(5_000)
  })

  it('falls back to the documented conservative default below 3 samples', () => {
    expect(baselineTokens([])).toBe(DEFAULT_BASELINE_TOKENS)
    expect(baselineTokens([1_000])).toBe(DEFAULT_BASELINE_TOKENS)
    expect(baselineTokens([1_000, 2_000])).toBe(DEFAULT_BASELINE_TOKENS)
  })

  it('uses the project median at 3+ samples, rounded', () => {
    expect(baselineTokens([1_000, 3_000, 2_000])).toBe(2_000)
    expect(baselineTokens([1, 2, 2, 3])).toBe(2)
  })
})

// ── rolling samples ────────────────────────────────────────────────────────

describe('appendBurstSamples', () => {
  it('appends without mutating and keeps only the newest 50', () => {
    const existing = Array.from({ length: MAX_BURST_SAMPLES }, (_, index) => index)
    const next = appendBurstSamples(existing, [999])
    expect(existing).toHaveLength(MAX_BURST_SAMPLES) // untouched
    expect(next).toHaveLength(MAX_BURST_SAMPLES)
    expect(next[0]).toBe(1) // oldest dropped
    expect(next[next.length - 1]).toBe(999)
  })

  it('handles empty inputs', () => {
    expect(appendBurstSamples([], [])).toEqual([])
    expect(appendBurstSamples([], [5])).toEqual([5])
  })
})

// ── savings ────────────────────────────────────────────────────────────────

describe('estimateSavedTokens', () => {
  it('prices each hit at one baseline; misses save nothing', () => {
    expect(estimateSavedTokens({ hits: 2 }, 8_000)).toBe(16_000)
    expect(estimateSavedTokens({ hits: 0 }, 8_000)).toBe(0)
  })
})

describe('splitByTurnBoundaries', () => {
  it('slices at user-message times — a boundary at-or-before a call opens a new turn', () => {
    const calls = [bash('a', undefined, at(1)), bash('b', undefined, at(11)), bash('c', undefined, at(12))]
    expect(splitByTurnBoundaries(calls, [at(0), at(10)])).toEqual([
      [calls[0]],
      [calls[1], calls[2]],
    ])
  })

  it('keeps the whole list as one turn with no boundaries or only a leading one', () => {
    const calls = [bash('a', undefined, at(1)), bash('b', undefined, at(2))]
    expect(splitByTurnBoundaries(calls, [])).toEqual([calls])
    expect(splitByTurnBoundaries(calls, [at(0)])).toEqual([calls])
  })

  it('collapses multiple boundaries between two calls into one cut (no empty turns)', () => {
    const calls = [bash('a', undefined, at(1)), bash('b', undefined, at(20))]
    expect(splitByTurnBoundaries(calls, [at(5), at(10), at(15)])).toEqual([[calls[0]], [calls[1]]])
  })
})

describe('estimateThreadSavedTokens', () => {
  it('recomputes across a full thread window (#1419: priced at a MEASURED baseline)', () => {
    const calls = [
      bash(SEARCH), // hit
      tool('Read'),
      bash(SEARCH), // miss
      tool('Grep', {}, 'g'.repeat(4_000)),
      bash(SEARCH), // hit
    ]
    // #1419: an unmeasured baseline banks NOTHING, so this prices against a
    // real 3-sample store (median 700) — the window semantics are the point.
    expect(estimateThreadSavedTokens(calls, [], [600, 700, 800])).toBe(2 * 700)
    // …and with no samples at all, there is no number to report.
    expect(estimateThreadSavedTokens(calls, [], [])).toBe(0)
  })

  it('prices hits at the project median once samples exist', () => {
    expect(estimateThreadSavedTokens([bash(SEARCH)], [], [4_000, 6_000, 5_000])).toBe(5_000)
  })

  it('is zero for a thread with no searches', () => {
    expect(estimateThreadSavedTokens([tool('Grep'), bash('rg x')], [], [])).toBe(0)
  })

  it('TRACKER PARITY: a turn-1 hit search stays a HIT when turn 2 merely explores', () => {
    // Turn 1 (user message at t=0): a hit search, answer sufficed.
    // Turn 2 (user message at t=10): unrelated grep exploration.
    // Unbounded classification read the later burst as this search's miss —
    // the live orbit-app bug (store said 8k saved, thread recompute said 0).
    const calls = [
      bash(SEARCH, '1. ● fresh symbol a.ts:1', at(1)),
      tool('Read', { file_path: '/x' }, undefined, at(2)),
      tool('Grep', { pattern: 'y' }, 'g'.repeat(4_000), at(11)),
      bash('rg follow-up', 'r'.repeat(400), at(12)),
    ]
    const userMessageTimes = [at(0), at(10)]
    expect(estimateThreadSavedTokens(calls, userMessageTimes, [600, 700, 800])).toBe(700)

    // Exactly what the tracker's per-turn slices would price: sum of each
    // turn's own hit classification (turn 1 → 1 hit, turn 2 → 0 searches).
    const turnSlices = [calls.slice(0, 2), calls.slice(2)]
    const trackerHits = turnSlices.reduce(
      (sum, turn) => sum + classifyBrainSearches(turn).hits,
      0,
    )
    // Parity is about the CLASSIFICATION, so both sides price the same way —
    // against the same measured baseline (#1419).
    expect(estimateSavedTokens({ hits: trackerHits }, 700)).toBe(
      estimateThreadSavedTokens(calls, userMessageTimes, [600, 700, 800]),
    )
  })

  it('still counts a genuine same-turn miss as a miss under turn bounding', () => {
    const calls = [
      bash(SEARCH, undefined, at(1)),
      tool('Grep', {}, 'g'.repeat(4_000), at(2)), // same turn — a real miss
    ]
    expect(estimateThreadSavedTokens(calls, [at(0)], [])).toBe(0)
  })
})

// ── baseline provenance (#1280) ────────────────────────────────────────────

describe('resolveBaseline (#1280)', () => {
  // "Always showing 8k tokens saved": with fewer than 3 samples every hit is
  // priced at a flat 8,000, so one hit reports exactly ~8k — a constant
  // wearing an estimate's clothes.
  it('marks the flat default as NOT measured', () => {
    const baseline = resolveBaseline([])
    expect(baseline.tokens).toBe(DEFAULT_BASELINE_TOKENS)
    expect(baseline.measured).toBe(false)
    expect(baseline.samples).toBe(0)
  })

  it('stays unmeasured below the sample minimum', () => {
    // A project that mostly HITS never produces miss-bursts, so it can sit
    // here forever — which is exactly how the constant became permanent.
    expect(resolveBaseline([1200, 3400]).measured).toBe(false)
    expect(resolveBaseline([1200, 3400]).tokens).toBe(DEFAULT_BASELINE_TOKENS)
  })

  it('becomes measured at the minimum, and reports the project’s own median', () => {
    const baseline = resolveBaseline([1000, 3000, 5000])
    expect(baseline.measured).toBe(true)
    expect(baseline.tokens).toBe(3000)
    expect(baseline.samples).toBe(3)
  })

  it('keeps baselineTokens answering exactly as before', () => {
    expect(baselineTokens([])).toBe(resolveBaseline([]).tokens)
    expect(baselineTokens([1000, 3000, 5000])).toBe(resolveBaseline([1000, 3000, 5000]).tokens)
  })
})

describe('estimateThreadSavings (#1280)', () => {
  const hitThread: TurnBoundedToolCall[] = [bash(SEARCH, 'result', at(1))]

  it('carries the hit count and the baseline’s provenance with the figure', () => {
    const estimate = estimateThreadSavings(hitThread, [], [])
    expect(estimate.hits).toBe(1)
    expect(estimate.baseline.measured).toBe(false)
    // #1419: and the number is ZERO, not `hits × 8_000`. #1280 stopped
    // DISPLAYING an uncalibrated figure; it was still computed and banked into
    // the project's cumulative total, mixing two scales. An absent number
    // beats a wrong one.
    expect(estimate.savedTokens).toBe(0)
  })

  it('reports measured once the project has priced its own bursts', () => {
    const estimate = estimateThreadSavings(hitThread, [], [1000, 3000, 5000])
    expect(estimate.baseline.measured).toBe(true)
    expect(estimate.savedTokens).toBe(3000)
  })

  it('agrees with estimateThreadSavedTokens, which now delegates to it', () => {
    expect(estimateThreadSavedTokens(hitThread, [], [1000, 3000, 5000])).toBe(
      estimateThreadSavings(hitThread, [], [1000, 3000, 5000]).savedTokens,
    )
  })
})
