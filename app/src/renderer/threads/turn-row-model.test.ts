/**
 * Tests for the turn row's ONE piece of decidable logic: which segment of the
 * summary line wears the error tint.
 *
 * The view (`turn-row.ts`) is deliberately not imported — the app suite runs
 * under `testEnvironment: 'node'` with no DOM lib, so a test that reached for
 * it would not even compile. That is why the tinting rule is a pure module
 * rather than a branch inside the constructor: the risky half of this whole
 * design is that a collapsed failure goes unnoticed (R-1), and the rule that
 * keeps it visible has to be assertable.
 */
import { turnRowSegments } from './turn-row-model'
import type { TurnSummary } from './turn-summary'

const summary = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  tools: 0,
  failed: 0,
  filesEdited: 0,
  status: 'success',
  ...over,
})

describe('turnRowSegments', () => {
  it('returns no segments for a turn that ran nothing', () => {
    expect(turnRowSegments(summary())).toEqual([])
  })

  it('renders a clean turn as one untinted segment', () => {
    expect(turnRowSegments(summary({ tools: 12 }))).toEqual([
      { text: 'Ran 12 tools', failed: false },
    ])
  })

  it('tints ONLY the failure segment', () => {
    const segments = turnRowSegments(
      summary({ tools: 12, failed: 2, filesEdited: 3, status: 'error' }),
    )
    expect(segments).toEqual([
      { text: 'Ran 12 tools', failed: false },
      { text: '2 failed', failed: true },
      { text: '3 files edited', failed: false },
    ])
  })

  it('never invents a failure segment when nothing failed', () => {
    const segments = turnRowSegments(summary({ tools: 1, filesEdited: 1 }))
    expect(segments.some((segment) => segment.failed)).toBe(false)
    expect(segments.map((segment) => segment.text)).toEqual(['Ran 1 tool', '1 file edited'])
  })

  it('keeps the failure segment when it is the only count besides the tools', () => {
    // The single most important row in the screenshots that motivated this
    // work: five failed commits inside a wall of successes. Collapsed, that
    // turn must still say so on its face.
    expect(turnRowSegments(summary({ tools: 16, failed: 5, status: 'error' }))).toEqual([
      { text: 'Ran 16 tools', failed: false },
      { text: '5 failed', failed: true },
    ])
  })

  it('reassembles to exactly the model’s label', () => {
    // The view may re-split the line, but it may never re-word it — the model
    // owns what a turn's row says, including which segments are omitted.
    const facts = summary({ tools: 7, failed: 1, filesEdited: 2, status: 'error' })
    const joined = turnRowSegments(facts)
      .map((segment) => segment.text)
      .join(' ' + String.fromCharCode(183) + ' ')
    expect(joined).toBe('Ran 7 tools · 1 failed · 2 files edited')
  })
})
