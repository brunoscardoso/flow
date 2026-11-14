// Ready checks — fake clock, fake connect, fake observer. Nothing touches the network.

import type { TerminalOutputObserver } from '../../shared/terminal-stamp'
import { stripAnsi, waitForLine, waitForPort, waitForPortFree, type ReadyClock } from './ready-check'

class FakeClock implements ReadyClock {
  now = 0
  #timers = new Map<number, { at: number; fn: () => void }>()
  #next = 1
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number)
  }
  get pending(): number {
    return this.#timers.size
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      await flush()
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      this.#timers.delete(due[0])
      this.now = due[1].at
      due[1].fn()
    }
    this.now = end
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function fakeObserve(): { observe: (o: TerminalOutputObserver) => () => void; emit: (terminalId: string, data: string) => void; count: () => number } {
  const observers = new Set<TerminalOutputObserver>()
  return {
    observe: (o) => {
      observers.add(o)
      return () => observers.delete(o)
    },
    emit: (terminalId, data) => {
      for (const o of [...observers]) o({ terminalId, at: 0, data })
    },
    count: () => observers.size,
  }
}

describe('waitForPort', () => {
  it('probes on the interval and settles ready the moment the port answers, leaving no timers', async () => {
    const clock = new FakeClock()
    const answers = [false, false, true]
    const connect = jest.fn(async () => answers.shift() ?? true)
    const wait = waitForPort(3000, { timeoutMs: 10_000, intervalMs: 500, connect, clock })
    await clock.advance(1_000)
    await expect(wait.result).resolves.toBe('ready')
    expect(connect).toHaveBeenCalledTimes(3)
    expect(connect).toHaveBeenCalledWith(3000)
    expect(clock.pending).toBe(0)
  })

  it('times out when nothing answers, and stops probing', async () => {
    const clock = new FakeClock()
    const connect = jest.fn(async () => false)
    const wait = waitForPort(3000, { timeoutMs: 2_000, intervalMs: 500, connect, clock })
    await clock.advance(2_000)
    await expect(wait.result).resolves.toBe('timed-out')
    const calls = connect.mock.calls.length
    await clock.advance(5_000)
    expect(connect.mock.calls.length).toBe(calls)
    expect(clock.pending).toBe(0)
  })

  it('a failing probe counts as not answering', async () => {
    const clock = new FakeClock()
    let n = 0
    const connect = jest.fn(async () => {
      n += 1
      if (n === 1) throw new Error('boom')
      return true
    })
    const wait = waitForPort(3000, { timeoutMs: 5_000, intervalMs: 100, connect, clock })
    await clock.advance(100)
    await expect(wait.result).resolves.toBe('ready')
  })

  it('cancel settles cancelled and clears its timers', async () => {
    const clock = new FakeClock()
    const wait = waitForPort(3000, { timeoutMs: 5_000, connect: async () => false, clock })
    await flush()
    wait.cancel()
    await expect(wait.result).resolves.toBe('cancelled')
    expect(clock.pending).toBe(0)
  })
})

describe('waitForPortFree', () => {
  it('resolves true once the port stops answering, false when it never does', async () => {
    const clock = new FakeClock()
    const answers = [true, true, false]
    const freed = waitForPortFree(3000, { timeoutMs: 3_000, intervalMs: 200, connect: async () => answers.shift() ?? false, clock })
    await clock.advance(400)
    await expect(freed).resolves.toBe(true)

    const held = waitForPortFree(3000, { timeoutMs: 1_000, intervalMs: 200, connect: async () => true, clock })
    await clock.advance(1_000)
    await expect(held).resolves.toBe(false)
  })
})

describe('waitForLine', () => {
  it('watches only while waiting, only its own terminal, and matches across chunks without colour codes', async () => {
    const clock = new FakeClock()
    const output = fakeObserve()
    const wait = waitForLine('t1', 'Ready in', { timeoutMs: 5_000, observe: output.observe, clock })
    expect(output.count()).toBe(1)
    output.emit('t2', 'ready in 3s')
    output.emit('t1', 'compiling…\n  \x1b[32mRea')
    output.emit('t1', 'dy\x1b[0m IN 812ms')
    await expect(wait.result).resolves.toBe('ready')
    expect(output.count()).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('times out and disarms', async () => {
    const clock = new FakeClock()
    const output = fakeObserve()
    const wait = waitForLine('t1', 'listening', { timeoutMs: 1_000, observe: output.observe, clock })
    await clock.advance(1_000)
    await expect(wait.result).resolves.toBe('timed-out')
    expect(output.count()).toBe(0)
  })

  it('cancel disarms', async () => {
    const clock = new FakeClock()
    const output = fakeObserve()
    const wait = waitForLine('t1', 'listening', { timeoutMs: 1_000, observe: output.observe, clock })
    wait.cancel()
    await expect(wait.result).resolves.toBe('cancelled')
    expect(output.count()).toBe(0)
    expect(clock.pending).toBe(0)
  })
})

describe('stripAnsi', () => {
  it('removes CSI, OSC and carriage returns', () => {
    expect(stripAnsi('\x1b]0;title\x07\x1b[1;31mred\x1b[0m\r\n')).toBe('red\n')
  })
})
