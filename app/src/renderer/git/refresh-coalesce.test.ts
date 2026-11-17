import { createCoalescer } from './refresh-coalesce'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createCoalescer', () => {
  it('shares one trailing run among every caller that arrives mid-flight', async () => {
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
    const run = jest.fn(async () => {
      const gate = deferred()
      gates.push(gate)
      await gate.promise
    })
    const coalescer = createCoalescer<string>(run)

    const first = coalescer.request('/repo')
    // Positive first: a run IS going (allowed #28).
    expect(coalescer.running('/repo')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    const second = coalescer.request('/repo')
    const third = coalescer.request('/repo')
    const fourth = coalescer.request('/repo')
    expect(second).toBe(third)
    expect(third).toBe(fourth)
    expect(run).toHaveBeenCalledTimes(1)

    gates[0]?.resolve()
    await first
    await Promise.resolve()
    await Promise.resolve()
    // The waiting callers get ONE fresh run that started after they asked.
    expect(run).toHaveBeenCalledTimes(2)
    gates[1]?.resolve()
    await second
    expect(run).toHaveBeenCalledTimes(2)
    expect(coalescer.running('/repo')).toBe(false)
  })

  it('keeps keys apart, and a failed run does not wedge the key', async () => {
    let calls = 0
    const coalescer = createCoalescer<string>(async (key) => {
      calls += 1
      if (key === 'bad') throw new Error('boom')
    })
    await Promise.all([coalescer.request('a'), coalescer.request('b')])
    expect(calls).toBe(2)
    await coalescer.request('bad')
    await coalescer.request('bad')
    expect(calls).toBe(4)
  })
})
