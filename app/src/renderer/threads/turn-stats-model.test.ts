import {
  THREAD_SAVINGS_TOOLTIP,
  UNCALIBRATED_SAVINGS_TOOLTIP,
  knowledgeHitsLabel,
  turnSavedSegmentLabel,
  turnTokensLabel,
} from './turn-stats-model'

describe('turnTokensLabel (#1136)', () => {
  it('omits the cached parenthetical when nothing was cached', () => {
    expect(turnTokensLabel(4059, 0, 7)).toBe('↑ 4059 · ↓ 7 tokens')
  })

  it('breaks out the cached portion OF the total, never as a separate addend', () => {
    // Turn 3 of the issue's thread: 2 uncached on top of 7,412 cached. The
    // footer used to read "↑ 2"; the total is what the turn actually sent.
    expect(turnTokensLabel(7414, 7412, 47)).toBe('↑ 7414 (7412 cached) · ↓ 47 tokens')
  })

  it('abbreviates both halves past the thousands threshold', () => {
    expect(turnTokensLabel(24_300, 21_800, 12)).toBe('↑ 24.3k (21.8k cached) · ↓ 12 tokens')
  })

  it('grows with the conversation instead of shrinking', () => {
    const turn1 = turnTokensLabel(4059, 0, 7)
    const turn2 = turnTokensLabel(7459, 4059, 63)
    expect(turn1).toBe('↑ 4059 · ↓ 7 tokens')
    expect(turn2).toBe('↑ 7459 (4059 cached) · ↓ 63 tokens')
  })

  it('never renders NaN or a negative count', () => {
    expect(turnTokensLabel(Number.NaN, Number.NaN, -5)).toBe('↑ 0 · ↓ 0 tokens')
  })
})

// The two surfaces share the ONE shared formatter — these tests pin the full
// formatting contract through the renderer-facing entry points.

describe('turnSavedSegmentLabel', () => {
  it('renders nothing at zero, negative, or invalid savings', () => {
    expect(turnSavedSegmentLabel(0)).toBeNull()
    expect(turnSavedSegmentLabel(-500)).toBeNull()
    expect(turnSavedSegmentLabel(Number.NaN)).toBeNull()
    expect(turnSavedSegmentLabel(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('renders sub-1000 raw and thousands with one decimal, always ~-prefixed', () => {
    expect(turnSavedSegmentLabel(640)).toBe('~640 saved')
    expect(turnSavedSegmentLabel(8_200)).toBe('~8.2k saved')
    expect(turnSavedSegmentLabel(12_400)).toBe('~12.4k saved')
  })

  it('strips a trailing .0 (never ~12.0k)', () => {
    expect(turnSavedSegmentLabel(12_000)).toBe('~12k saved')
    expect(turnSavedSegmentLabel(1_000)).toBe('~1k saved')
  })

  it('rounds fractional estimates before formatting', () => {
    expect(turnSavedSegmentLabel(999.6)).toBe('~1k saved')
    expect(turnSavedSegmentLabel(0.4)).toBeNull()
  })
})

describe('THREAD_SAVINGS_TOOLTIP', () => {
  it('states the model and that it is an estimate', () => {
    expect(THREAD_SAVINGS_TOOLTIP).toContain('Estimated tokens saved')
    expect(THREAD_SAVINGS_TOOLTIP).toContain('median')
    expect(THREAD_SAVINGS_TOOLTIP).toContain('Estimate, not a meter')
  })
})

// #1280: "Always showing 8k tokens saved — we are not estimating that
// correctly." Below the sample minimum every hit is priced at a flat 8,000, so
// the surface reported a constant × hits as though it were measured.
//
// This used to be asserted against the thread-cumulative CHIP, which is gone —
// it duplicated the same number the stats line already showed, one line below
// it. The guard moved rather than went: the stats line is the surviving
// surface, and it is the one that must not publish a constant as an estimate.

describe('knowledgeHitsLabel', () => {
  it('counts hits, or says nothing at zero', () => {
    expect(knowledgeHitsLabel(0)).toBeNull()
    expect(knowledgeHitsLabel(-2)).toBeNull()
    expect(knowledgeHitsLabel(1)).toBe('1 knowledge hit')
    expect(knowledgeHitsLabel(4)).toBe('4 knowledge hits')
  })
})

describe('uncalibrated savings (#1280)', () => {
  it('shows the hits it counted instead of a constant dressed as an estimate', () => {
    const label = turnSavedSegmentLabel(8000, { calibrated: false, hits: 1 })
    expect(label).toBe('1 knowledge hit')
    expect(label).not.toContain('~')
  })

  it('pluralises the hits', () => {
    expect(turnSavedSegmentLabel(24000, { calibrated: false, hits: 3 })).toBe('3 knowledge hits')
  })

  it('renders nothing when uncalibrated with no hits — no chrome at zero', () => {
    expect(turnSavedSegmentLabel(8000, { calibrated: false, hits: 0 })).toBeNull()
  })

  it('publishes the token figure once the baseline is measured', () => {
    expect(turnSavedSegmentLabel(12400, { calibrated: true, hits: 2 })).toBe('~12.4k saved')
  })

  it('reads an older main with no provenance fields as calibrated', () => {
    // Never a silently blank segment because main is out of date.
    expect(turnSavedSegmentLabel(12400)).toBe('~12.4k saved')
  })
})

describe('UNCALIBRATED_SAVINGS_TOOLTIP', () => {
  it('says why there is no number yet', () => {
    expect(UNCALIBRATED_SAVINGS_TOOLTIP.length).toBeGreaterThan(0)
  })
})
