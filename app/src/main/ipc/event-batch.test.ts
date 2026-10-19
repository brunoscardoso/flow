/**
 * A batch that never flushes is worse than one that flushes too often.
 *
 * Thread and task events are broadcast on a debounce: quiet for 50ms, then
 * send. A debounce RESETS on every event, so a stream that never pauses for
 * 50ms never sends at all — the sidebar, the composer and the board see nothing
 * while the agent is working hardest, then one enormous batch when it finally
 * breathes. Both failure modes come from the same missing bound.
 */
import { makeEventBatch } from './index'

describe('the broadcast batch has a ceiling, not just a floor', () => {
  it('keeps sending while a stream that never pauses keeps arriving', () => {
    const sent: number[][] = []
    let clock = 0
    const batch = makeEventBatch<number>(
      (events) => sent.push(events),
      () => clock,
    )
    // An event every 10ms for a second — never a 50ms gap anywhere in it.
    for (let i = 0; i < 100; i += 1) {
      batch.push(i)
      clock += 10
    }
    expect(sent.length).toBeGreaterThan(0)
    // Nothing waited much longer than the ceiling to be told about.
    expect(sent.flat().length).toBeGreaterThanOrEqual(75)
    batch.dispose()
  })

  it('still coalesces a burst that ends', () => {
    jest.useFakeTimers()
    const sent: number[][] = []
    let clock = 0
    const batch = makeEventBatch<number>(
      (events) => sent.push(events),
      () => clock,
    )
    for (let i = 0; i < 5; i += 1) {
      batch.push(i)
      clock += 5
    }
    expect(sent).toEqual([]) // still inside the quiet period
    jest.advanceTimersByTime(60)
    expect(sent).toEqual([[0, 1, 2, 3, 4]]) // one batch, not five
    batch.dispose()
    jest.useRealTimers()
  })

  it('drops what it was holding when disposed', () => {
    jest.useFakeTimers()
    const sent: number[][] = []
    const batch = makeEventBatch<number>((events) => sent.push(events))
    batch.push(1)
    batch.dispose()
    jest.advanceTimersByTime(500)
    expect(sent).toEqual([])
    jest.useRealTimers()
  })
})
