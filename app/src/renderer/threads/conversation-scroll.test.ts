import { reconcileScrollTop } from './conversation-scroll'

describe('reconcileScrollTop (#179)', () => {
  it('returns to the bottom when the reader was following live output (pinned)', () => {
    expect(reconcileScrollTop(true, 120, 900)).toBe(900)
  })

  it('keeps a scrolled-up reader at their previous position', () => {
    expect(reconcileScrollTop(false, 120, 900)).toBe(120)
  })

  it('clamps a restored position to the new (possibly shorter) content height', () => {
    // The rebuild dropped an optimistic node → content shrank below the old scrollTop.
    expect(reconcileScrollTop(false, 800, 500)).toBe(500)
  })

  it('never returns a negative scrollTop', () => {
    expect(reconcileScrollTop(false, -10, 300)).toBe(0)
    expect(reconcileScrollTop(true, 0, -5)).toBe(0)
  })
})
