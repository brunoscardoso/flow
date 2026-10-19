// ForeignRefreshScheduler (#1931 follow-up) — the two child-pane failure modes
// this module exists to close, reproduced as units:
//   1. the busy/streaming DROP (a deferred write must survive the turn), and
//   2. debounce STARVATION (touched batches arriving faster than the debounce
//      must still refresh within the max-wait bound).
// Timers and the clock are injected, so nothing here sleeps.

import { ForeignRefreshScheduler } from './foreign-refresh'

interface FakeTimerEntry {
  run: () => void
  at: number
}

/** A deterministic clock + timer queue the scheduler runs against. */
function makeHarness(state?: { busy?: boolean; loading?: boolean }) {
  const flags = { busy: state?.busy ?? false, loading: state?.loading ?? false }
  let nowMs = 0
  let nextId = 1
  const timers = new Map<number, FakeTimerEntry>()
  let refreshes = 0
  const scheduler = new ForeignRefreshScheduler(
    {
      busy: () => flags.busy,
      loading: () => flags.loading,
      refresh: () => {
        refreshes += 1
      },
    },
    {
      debounceMs: 300,
      maxWaitMs: 1000,
      now: () => nowMs,
      schedule: (run, ms) => {
        const id = nextId++
        timers.set(id, { run, at: nowMs + ms })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      cancel: (timer) => {
        timers.delete(timer as unknown as number)
      },
    },
  )
  /** Advance the clock, firing timers whose moment passed (in order). */
  const advance = (ms: number): void => {
    const target = nowMs + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      nowMs = due[1].at
      due[1].run()
    }
    nowMs = target
  }
  return {
    scheduler,
    flags,
    advance,
    get refreshes() {
      return refreshes
    },
    get armedTimers() {
      return timers.size
    },
  }
}

describe('ForeignRefreshScheduler (#1931)', () => {
  it('debounces a quiet burst into one refresh', () => {
    const h = makeHarness()
    h.scheduler.touched()
    h.scheduler.touched()
    h.scheduler.touched()
    expect(h.refreshes).toBe(0)
    h.advance(300)
    expect(h.refreshes).toBe(1)
    expect(h.armedTimers).toBe(0)
  })

  it('STARVATION (bug A): batches every 250ms — a sliding debounce never fires; the max-wait bound does', () => {
    // The parent session's broadcast batcher flushes at most every 250ms while
    // it streams, and 250 < the 300ms debounce — the old sliding timer was
    // reset forever and the child pane showed nothing until the stream paused.
    const h = makeHarness()
    for (let i = 0; i < 20; i += 1) {
      h.scheduler.touched()
      h.advance(250)
    }
    // 20 batches over 5s: served at least once per max-wait window (1s),
    // instead of the zero refreshes the sliding debounce produced.
    expect(h.refreshes).toBeGreaterThanOrEqual(4)
    // …and still bounded — nowhere near one refresh per batch.
    expect(h.refreshes).toBeLessThanOrEqual(7)
  })

  it('DROP (bug A): a write arriving while busy is deferred, never dropped, and consumed when the turn settles', () => {
    const h = makeHarness({ busy: true })
    h.scheduler.touched()
    h.advance(2000)
    // Still busy: nothing ran, but the deferral is owed.
    expect(h.refreshes).toBe(0)
    expect(h.scheduler.pending).toBe(true)
    // consume() while still busy keeps the deferral (the next settle point owns it).
    h.scheduler.consume()
    expect(h.refreshes).toBe(0)
    expect(h.scheduler.pending).toBe(true)
    // The turn ends → the one follow-up runs.
    h.flags.busy = false
    h.scheduler.consume()
    expect(h.refreshes).toBe(1)
    expect(h.scheduler.pending).toBe(false)
  })

  it('a timer that fires into a now-busy pane defers instead of refreshing mid-turn', () => {
    const h = makeHarness()
    h.scheduler.touched()
    h.flags.busy = true // a turn started inside the debounce window
    h.advance(300)
    expect(h.refreshes).toBe(0)
    expect(h.scheduler.pending).toBe(true)
    h.flags.busy = false
    h.scheduler.consume()
    expect(h.refreshes).toBe(1)
  })

  it('a write during a history load defers and is consumed at the load settle', () => {
    const h = makeHarness({ loading: true })
    h.scheduler.touched()
    expect(h.scheduler.pending).toBe(true)
    h.flags.loading = false
    h.scheduler.consume()
    expect(h.refreshes).toBe(1)
  })

  it('loadStarted clears the deferral — events before the fetch are captured by the fetch', () => {
    const h = makeHarness({ busy: true })
    h.scheduler.touched()
    expect(h.scheduler.pending).toBe(true)
    h.flags.busy = false
    h.scheduler.loadStarted()
    h.scheduler.consume()
    expect(h.refreshes).toBe(0)
    expect(h.scheduler.pending).toBe(false)
  })

  it('consume without a deferral is a no-op', () => {
    const h = makeHarness()
    h.scheduler.consume()
    expect(h.refreshes).toBe(0)
  })

  it('reset drops both the armed timer and the deferral (thread switch)', () => {
    const h = makeHarness()
    h.scheduler.touched()
    expect(h.armedTimers).toBe(1)
    h.scheduler.reset()
    h.advance(2000)
    expect(h.refreshes).toBe(0)
    const busy = makeHarness({ busy: true })
    busy.scheduler.touched()
    busy.scheduler.reset()
    busy.flags.busy = false
    busy.scheduler.consume()
    expect(busy.refreshes).toBe(0)
  })

  it('a lone write after a served stream refreshes on the ordinary debounce', () => {
    const h = makeHarness()
    h.scheduler.touched()
    h.advance(300)
    expect(h.refreshes).toBe(1)
    h.advance(5000)
    h.scheduler.touched()
    h.advance(300)
    expect(h.refreshes).toBe(2)
  })
})
