import { createCoalescer } from './refresh-coalesce'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createCoalescer', () => {
  it('a mid-flight caller joins the running refresh, and ONE trailing re-read is queued for all of them', async () => {
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
    const fresh = coalescer.request('/repo', { fresh: true })
    const fresh2 = coalescer.request('/repo', { fresh: true })
    // Joiners share the running refresh; fresh callers share the trailing one.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(fresh).toBe(fresh2)
    expect(fresh).not.toBe(first)
    expect(run).toHaveBeenCalledTimes(1)

    let freshSettled = false
    void fresh.then(() => {
      freshSettled = true
    })
    gates[0]?.resolve()
    await second // answered by the FIRST run
    await Promise.resolve()
    await Promise.resolve()
    // ONE trailing run started after they asked, whoever was waiting.
    expect(run).toHaveBeenCalledTimes(2)
    expect(freshSettled).toBe(false)
    gates[1]?.resolve()
    await fresh
    expect(freshSettled).toBe(true)
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
