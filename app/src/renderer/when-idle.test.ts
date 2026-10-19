import { whenIdle } from './when-idle'

describe('whenIdle — later, and not on the frame the reader is waiting for', () => {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  const saved = host.requestIdleCallback

  afterEach(() => {
    if (saved === undefined) delete host.requestIdleCallback
    else host.requestIdleCallback = saved
    jest.useRealTimers()
  })

  it('uses the idle API when there is one, WITH a deadline', () => {
    // The deadline is the whole point: an idle callback with none can be
    // starved indefinitely by a busy app, and a busy app is where this is used.
    const calls: Array<{ options?: { timeout: number } }> = []
    host.requestIdleCallback = (callback, options) => {
      calls.push({ ...(options === undefined ? {} : { options }) })
      callback()
      return 1
    }
    let ran = false
    whenIdle(() => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(calls[0]?.options?.timeout).toBeGreaterThan(0)
  })

  it('still runs where the API does not exist — a delay, never "now"', () => {
    delete host.requestIdleCallback
    jest.useFakeTimers()
    let ran = false
    whenIdle(() => {
      ran = true
    })
    // NOT this tick. "Now" is the tick the click is waiting on, which is the
    // whole thing being avoided.
    expect(ran).toBe(false)
    jest.runAllTimers()
    expect(ran).toBe(true)
  })

  it('honours a caller’s own deadline', () => {
    const seen: number[] = []
    host.requestIdleCallback = (_callback, options) => {
      seen.push(options?.timeout ?? -1)
      return 1
    }
    whenIdle(() => undefined, 1_500)
    expect(seen).toEqual([1_500])
  })
})
