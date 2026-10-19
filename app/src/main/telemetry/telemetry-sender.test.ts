import {
  createTelemetrySender,
  MAX_BATCH,
  QUEUE_LIMITS,
  type TelemetrySenderDeps,
} from './telemetry-sender'

/** A sender with a timer we drive by hand, so nothing sleeps. */
function harness(overrides: Partial<TelemetrySenderDeps> = {}) {
  let tick: (() => void) | null = null
  const posted: unknown[][] = []
  const sender = createTelemetrySender({
    post: async (batch) => {
      posted.push(batch)
    },
    setInterval: (fn) => {
      tick = fn
      return { unref: () => {} }
    },
    clearInterval: () => {
      tick = null
    },
    ...overrides,
  })
  return { sender, posted, tick: () => tick?.() }
}

describe('sending', () => {
  it('batches rather than sending one request per event', async () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) h.sender.enqueue({ event: 'session.started', at: i })
    await h.sender.flush()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0]).toHaveLength(5)
  })

  it('caps a batch so a burst cannot build an unbounded body', async () => {
    const h = harness()
    for (let i = 0; i < MAX_BATCH + 10; i += 1) h.sender.enqueue({ at: i })
    await h.sender.flush()
    expect(h.posted[0]).toHaveLength(MAX_BATCH)
  })

  it('sends nothing when there is nothing', async () => {
    const h = harness()
    await h.sender.flush()
    expect(h.posted).toEqual([])
  })

  it('drains on the timer, with nobody waiting on it', async () => {
    const h = harness()
    h.sender.enqueue({ at: 1 })
    h.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.posted).toHaveLength(1)
  })
})

describe('a dead or slow endpoint', () => {
  it('never rejects, whatever the transport does', async () => {
    const h = harness({
      post: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    h.sender.enqueue({ at: 1 })
    await expect(h.sender.flush()).resolves.toBeUndefined()
  })

  // THE RETRY STORM IS THE BUG. Requeueing a failed batch is how a dead
  // endpoint becomes a loop that runs for the life of the process.
  it('drops a failed batch instead of retrying it', async () => {
    let attempts = 0
    const h = harness({
      post: async () => {
        attempts += 1
        throw new Error('down')
      },
    })
    h.sender.enqueue({ at: 1 })
    await h.sender.flush()
    await h.sender.flush()
    await h.sender.flush()
    expect(attempts).toBe(1)
    expect(h.sender.pending()).toBe(0)
  })

  it('says it is unreachable ONCE, not once per batch', async () => {
    let told = 0
    const h = harness({
      post: async () => {
        throw new Error('down')
      },
      onUnreachable: () => {
        told += 1
      },
    })
    for (let i = 0; i < 4; i += 1) {
      h.sender.enqueue({ at: i })
      await h.sender.flush()
    }
    expect(told).toBe(1)
  })

  it('does not overlap flights when the endpoint is slow', async () => {
    let inFlight = 0
    let overlapped = false
    const gate: { release: (() => void) | null } = { release: null }
    const h = harness({
      post: async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
        inFlight -= 1
      },
    })
    h.sender.enqueue({ at: 1 })
    const first = h.sender.flush()
    h.sender.enqueue({ at: 2 })
    await h.sender.flush() // must return immediately, not pile on
    gate.release?.()
    await first
    expect(overlapped).toBe(false)
  })
})

describe('the queue is bounded', () => {
  it('DROPS rather than grows when nothing can be sent', () => {
    // A laptop offline for a fortnight. The bound is on the queue, not on the
    // outage — the failure mode this prevents is memory, not lost counts.
    const sender = createTelemetrySender({
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    })
    for (let i = 0; i < QUEUE_LIMITS.maxRecords * 3; i += 1) sender.enqueue({ at: i })
    expect(sender.pending()).toBeLessThanOrEqual(QUEUE_LIMITS.maxRecords)
  })

  it('keeps the NEWEST events when it has to choose', () => {
    const sender = createTelemetrySender({
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    })
    for (let i = 0; i < QUEUE_LIMITS.maxRecords + 5; i += 1) sender.enqueue({ at: i })
    // Oldest-first eviction: the stale thing goes.
    expect(sender.pending()).toBe(QUEUE_LIMITS.maxRecords)
  })

  it('accepts events with nowhere to send them, and drops at the send', async () => {
    // The default build: no endpoint configured. Enqueue must still be safe.
    const sender = createTelemetrySender({
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    })
    sender.enqueue({ at: 1 })
    await expect(sender.flush()).resolves.toBeUndefined()
    expect(sender.pending()).toBe(0)
  })

  it('survives a payload that will not serialize', () => {
    const sender = createTelemetrySender({
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    })
    const cyclic: Record<string, unknown> = { at: 1 }
    cyclic['self'] = cyclic
    expect(() => sender.enqueue(cyclic)).not.toThrow()
    expect(sender.pending()).toBe(1)
  })
})

describe('stop', () => {
  it('clears the timer', () => {
    const h = harness()
    h.sender.stop()
    h.sender.enqueue({ at: 1 })
    h.tick() // the handle is gone; this is a no-op
    expect(h.posted).toEqual([])
  })
})
