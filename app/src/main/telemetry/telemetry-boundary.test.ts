import { createTelemetryBoundary } from './telemetry-boundary'

function harness(enabled = true) {
  const sent: Record<string, unknown>[] = []
  const refused: { payload: Record<string, unknown>; fields: string[] }[] = []
  let on = enabled
  const boundary = createTelemetryBoundary({
    isEnabled: () => on,
    transport: (payload) => sent.push(payload),
    onRefused: (payload, fields) => refused.push({ payload, fields }),
  })
  return { boundary, sent, refused, setEnabled: (v: boolean) => (on = v) }
}

describe('the one door', () => {
  it('sends an allowed payload', () => {
    const h = harness()
    expect(h.boundary.send({ event: 'session.started', at: 1 })).toBe('sent')
    expect(h.sent).toHaveLength(1)
  })

  it('SENDS NOTHING AT ALL when the switch is off', () => {
    // The claim the whole feature rests on. Not "sends less" — nothing.
    const h = harness(false)
    expect(h.boundary.send({ event: 'session.started', at: 1 })).toBe('disabled')
    expect(h.sent).toEqual([])
    expect(h.refused).toEqual([])
  })

  it('reads the switch at SEND time, not at construction', () => {
    // A switch that only takes effect after a restart is a switch that lied.
    const h = harness(true)
    h.boundary.send({ event: 'session.started', at: 1 })
    h.setEnabled(false)
    h.boundary.send({ event: 'session.ended', at: 2 })
    h.setEnabled(true)
    h.boundary.send({ event: 'session.started', at: 3 })
    expect(h.sent.map((p) => p['at'])).toEqual([1, 3])
  })

  it('refuses the WHOLE payload, not just the offending field', () => {
    // Stripping the bad key and sending the rest is the shape that quietly
    // normalises a leak: the event still arrives, so nobody investigates.
    const h = harness()
    expect(h.boundary.send({ event: 'session.started', filePath: '/Users/x/secret.ts' })).toBe(
      'refused',
    )
    expect(h.sent).toEqual([])
    expect(h.refused[0]?.fields).toEqual(['filePath'])
  })

  it('never lets a broken transport reach the caller', () => {
    // The caller is a feature doing its actual job; telemetry is never worth
    // failing it.
    const boundary = createTelemetryBoundary({
      isEnabled: () => true,
      transport: () => {
        throw new Error('network is on fire')
      },
    })
    expect(() => boundary.send({ event: 'session.started', at: 1 })).not.toThrow()
    expect(boundary.send({ event: 'session.started', at: 1 })).toBe('refused')
  })

  it('does not inspect the payload when disabled', () => {
    // With the switch off there is no path from here to anywhere: a payload
    // full of forbidden fields produces no refusal, because nothing looked.
    const h = harness(false)
    expect(h.boundary.send({ prompt: 'secret', stackTrace: 'x' })).toBe('disabled')
    expect(h.refused).toEqual([])
  })
})
