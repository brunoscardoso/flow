import type { BrainUsageTotals } from '../../shared/ipc-contract'
import { brainHitRatePercent, formatBrainUsageLine } from './brain-usage-model'

function totals(overrides: Partial<BrainUsageTotals> = {}): BrainUsageTotals {
  return {
    searches: 0,
    freshHits: 0,
    staleHits: 0,
    misses: 0,
    savedTokens: 0,
    updatedAt: null,
    ...overrides,
  }
}

describe('brainHitRatePercent', () => {
  it('is the share of searches not followed by a fallback burst', () => {
    expect(brainHitRatePercent(totals({ searches: 4, misses: 1 }))).toBe(75)
    expect(brainHitRatePercent(totals({ searches: 3, misses: 0 }))).toBe(100)
    expect(brainHitRatePercent(totals({ searches: 2, misses: 2 }))).toBe(0)
  })

  it('is 0 with no searches and never negative on corrupt counts', () => {
    expect(brainHitRatePercent(totals())).toBe(0)
    expect(brainHitRatePercent(totals({ searches: 1, misses: 5 }))).toBe(0)
  })
})

describe('formatBrainUsageLine', () => {
  it('hides the line when nothing was counted', () => {
    expect(formatBrainUsageLine(null)).toBeNull()
    expect(formatBrainUsageLine(totals())).toBeNull()
    // Misses without searches cannot happen (a miss requires a search), but
    // even a corrupt store must not surface a "0 searches" line.
    expect(formatBrainUsageLine(totals({ misses: 3 }))).toBeNull()
  })

  it('formats the compact counters line', () => {
    expect(
      formatBrainUsageLine(totals({ searches: 12, freshHits: 20, staleHits: 2, misses: 3 })),
    ).toBe('Brain retrieval — 12 searches · 75% hit-rate · 3 misses · 2 stale')
  })

  it('pluralizes honestly at one', () => {
    expect(formatBrainUsageLine(totals({ searches: 1, misses: 1, staleHits: 1 }))).toBe(
      'Brain retrieval — 1 search · 0% hit-rate · 1 miss · 1 stale',
    )
  })

  it('appends the estimated savings segment only when positive', () => {
    expect(
      formatBrainUsageLine(totals({ searches: 4, misses: 1, savedTokens: 24_000 })),
    ).toBe('Brain retrieval — 4 searches · 75% hit-rate · 1 miss · 0 stale · ~24k tokens saved')
    // Zero savings → no trailing segment (never render 0-savings chrome).
    expect(formatBrainUsageLine(totals({ searches: 2, misses: 2 }))).toBe(
      'Brain retrieval — 2 searches · 0% hit-rate · 2 misses · 0 stale',
    )
  })
})

describe('formatBrainUsageLine calibration (#1280)', () => {
  // Publishing 8,000 × hits as though it were measured is the bug reported as
  // "Always showing 8k tokens saved".
  const base = {
    searches: 4,
    freshHits: 3,
    staleHits: 0,
    misses: 1,
    savedTokens: 24000,
    updatedAt: '2026-08-06T10:00:00.000Z',
  }

  it('withholds the token figure while the per-hit price is the flat default', () => {
    const line = formatBrainUsageLine({ ...base, calibrated: false })
    expect(line).toContain('savings estimate calibrating')
    expect(line).not.toContain('24k')
    expect(line).not.toContain('tokens saved')
  })

  it('publishes it once the project has priced its own bursts', () => {
    expect(formatBrainUsageLine({ ...base, calibrated: true })).toContain('~24k tokens saved')
  })

  it('treats a store written before the field as calibrated, not blank', () => {
    // Absent means "we don't know" — the pre-#1280 behaviour, never a silent
    // regression in what an existing project displays.
    expect(formatBrainUsageLine(base)).toContain('~24k tokens saved')
  })
})
