import { createTelemetryDelivery } from './telemetry-delivery'

describe('what a build decides at startup', () => {
  it('is NOWHERE when no endpoint was configured — the ordinary case', () => {
    const d = createTelemetryDelivery({ endpoint: null })
    expect(d.state).toBe('nowhere')
    expect(d.reason).toBeNull()
    // Still accepts events; they are dropped at the send.
    expect(() => d.transport({ at: 1 })).not.toThrow()
  })

  it('is CONFIGURED for a write-only key over https', () => {
    const d = createTelemetryDelivery({
      endpoint: { url: 'https://x.example/ingest', key: 'flw_ingest_abc' },
      postFn: async () => {},
    })
    expect(d.state).toBe('configured')
  })

  // THE TRIPWIRE. A key that can read must never reach a client, and the moment
  // to find out is the build.
  it('REFUSES an endpoint whose key can read, and sends nothing at all', async () => {
    let posted = 0
    const d = createTelemetryDelivery({
      endpoint: { url: 'https://x.example/ingest', key: 'postgres://u:p@h/db' },
      postFn: async () => {
        posted += 1
      },
    })
    expect(d.state).toBe('refused')
    expect(d.reason).toContain('write-only')
    d.transport({ at: 1 })
    await d.flush()
    expect(posted).toBe(0)
  })
})

describe('delivery', () => {
  it('sends the batch as a JSON document, not a column per property', async () => {
    const bodies: unknown[] = []
    const d = createTelemetryDelivery({
      endpoint: { url: 'https://x.example/ingest', key: 'flw_k' },
      postFn: async (_url, _key, batch) => {
        bodies.push(batch)
      },
    })
    d.transport({ event: 'session.started', at: 1 })
    d.transport({ event: 'session.ended', at: 2, durationMs: 1 })
    await d.flush()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual([
      { event: 'session.started', at: 1 },
      { event: 'session.ended', at: 2, durationMs: 1 },
    ])
  })

  it('carries the url and key it was configured with', async () => {
    const seen: string[] = []
    const d = createTelemetryDelivery({
      endpoint: { url: 'https://x.example/ingest', key: 'flw_k' },
      postFn: async (url, key) => {
        seen.push(url, key)
      },
    })
    d.transport({ at: 1 })
    await d.flush()
    expect(seen).toEqual(['https://x.example/ingest', 'flw_k'])
  })

  it('never lets a dead endpoint reach the caller', async () => {
    const d = createTelemetryDelivery({
      endpoint: { url: 'https://x.example/ingest', key: 'flw_k' },
      postFn: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    d.transport({ at: 1 })
    await expect(d.flush()).resolves.toBeUndefined()
  })

  it('stops cleanly in every state', () => {
    for (const endpoint of [
      null,
      { url: 'https://x.example/i', key: 'flw_k' },
      { url: 'https://x.example/i', key: 'postgres://u:p@h/d' },
    ]) {
      const d = createTelemetryDelivery({ endpoint, postFn: async () => {} })
      expect(() => d.stop()).not.toThrow()
    }
  })
})
