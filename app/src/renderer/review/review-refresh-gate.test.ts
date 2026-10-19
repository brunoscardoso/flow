import { ReviewRefreshGate } from './review-refresh-gate'

describe('ReviewRefreshGate (#182)', () => {
  it('renders immediately when no interaction is open', () => {
    const gate = new ReviewRefreshGate<string[]>()
    expect(gate.isOpen).toBe(false)
    expect(gate.receive(['a'])).toEqual(['a']) // render now
  })

  it('DEFERS a background update while a reject/discard prompt is open', () => {
    const gate = new ReviewRefreshGate<string[]>()
    gate.open()
    expect(gate.isOpen).toBe(true)
    expect(gate.receive(['a', 'b'])).toBeNull() // deferred, not rendered
  })

  it('flushes only the NEWEST deferred update when the interaction closes', () => {
    const gate = new ReviewRefreshGate<string[]>()
    gate.open()
    gate.receive(['stale'])
    gate.receive(['newer']) // supersedes the earlier deferred update
    const flushed = gate.close()
    expect(flushed).toEqual(['newer'])
    expect(gate.isOpen).toBe(false)
  })

  it('returns null on close when nothing was deferred', () => {
    const gate = new ReviewRefreshGate<string[]>()
    gate.open()
    expect(gate.close()).toBeNull()
  })

  it('does not re-flush a stale pending update after it was consumed', () => {
    const gate = new ReviewRefreshGate<string[]>()
    gate.open()
    gate.receive(['x'])
    expect(gate.close()).toEqual(['x'])
    // A fresh cycle with no new deferral must not resurrect ['x'].
    gate.open()
    expect(gate.close()).toBeNull()
  })

  it('markRendered lowers the open flag but keeps pending for the next receive', () => {
    const gate = new ReviewRefreshGate<string[]>()
    gate.open()
    gate.receive(['deferred'])
    gate.markRendered() // e.g. a mode-toggle render bypassing close()
    expect(gate.isOpen).toBe(false)
    // Next background update renders immediately (flag lowered) and clears pending.
    expect(gate.receive(['fresh'])).toEqual(['fresh'])
    expect(gate.close()).toBeNull() // the old 'deferred' was dropped, not resurrected
  })

  describe('overlapping interactions are ref-counted (#188)', () => {
    it('STAYS open when one of two overlapping prompts closes', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open() // reject prompt A
      gate.open() // reject prompt B (or a discard confirm)
      expect(gate.close()).toBeNull() // A closes — B still open, no flush
      expect(gate.isOpen).toBe(true)
      // A background refresh while B is open must still defer, not render.
      expect(gate.receive(['bg'])).toBeNull()
    })

    it('flushes the newest deferred update only when the LAST interaction closes', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open()
      gate.open()
      gate.receive(['bg'])
      expect(gate.close()).toBeNull() // still one open → hold
      const flushed = gate.close() // last one closes → flush
      expect(flushed).toEqual(['bg'])
      expect(gate.isOpen).toBe(false)
    })

    it('markRendered clears all depth at once even with multiple prompts open', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open()
      gate.open()
      gate.markRendered() // a full render tore down every transient prompt
      expect(gate.isOpen).toBe(false)
      expect(gate.receive(['x'])).toEqual(['x']) // renders immediately now
    })

    it('never drops below zero if close is called more than open', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open()
      expect(gate.close()).toBeNull() // depth 1 → 0 (no pending)
      expect(gate.isOpen).toBe(false)
      expect(gate.close()).toBeNull() // extra close is a harmless no-op
      expect(gate.isOpen).toBe(false)
      expect(gate.receive(['y'])).toEqual(['y']) // still renders normally
    })
  })

  describe('forceClose — a completed destructive action hard-closes the gate (#1018)', () => {
    it('zeroes the depth past open siblings and flushes the newest deferred update', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open() // a reject prompt is open…
      gate.open() // …and the discard confirm on top of it
      gate.receive(['stale'])
      gate.receive(['newest'])
      // Discard N fired: every row is invalid — no sibling may keep deferring.
      expect(gate.forceClose()).toEqual(['newest'])
      expect(gate.isOpen).toBe(false)
      // The completion's own refresh renders immediately instead of deferring.
      expect(gate.receive(['post-discard'])).toEqual(['post-discard'])
    })

    it('returns null when nothing was deferred, still lowering the gate', () => {
      const gate = new ReviewRefreshGate<string[]>()
      gate.open()
      gate.open()
      expect(gate.forceClose()).toBeNull()
      expect(gate.isOpen).toBe(false)
    })
  })
})
