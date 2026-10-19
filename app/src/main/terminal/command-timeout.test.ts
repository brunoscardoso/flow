import { armCommandTimeout } from './command-timeout'

describe('armCommandTimeout (#272)', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const spies = () => ({ softKill: jest.fn(), forceKill: jest.fn(), settle: jest.fn() })

  it('soft-kills at the timeout, then force-kills AND settles after the grace', () => {
    const s = spies()
    armCommandTimeout({ timeoutMs: 100, graceMs: 20, ...s })

    jest.advanceTimersByTime(100)
    expect(s.softKill).toHaveBeenCalledTimes(1)
    expect(s.forceKill).not.toHaveBeenCalled()
    expect(s.settle).not.toHaveBeenCalled()

    jest.advanceTimersByTime(20)
    // The never-hang guarantee: settle always fires even if the process ignored
    // the soft kill.
    expect(s.forceKill).toHaveBeenCalledTimes(1)
    expect(s.settle).toHaveBeenCalledTimes(1)
  })

  it('does nothing when cancelled before the timeout (command finished in time)', () => {
    const s = spies()
    const t = armCommandTimeout({ timeoutMs: 100, graceMs: 20, ...s })
    jest.advanceTimersByTime(50)
    t.cancel()
    jest.advanceTimersByTime(1000)
    expect(s.softKill).not.toHaveBeenCalled()
    expect(s.forceKill).not.toHaveBeenCalled()
    expect(s.settle).not.toHaveBeenCalled()
  })

  it('soft-kills but does NOT force-kill/settle when cancelled during the grace (exited on SIGHUP)', () => {
    const s = spies()
    const t = armCommandTimeout({ timeoutMs: 100, graceMs: 50, ...s })
    jest.advanceTimersByTime(100)
    expect(s.softKill).toHaveBeenCalledTimes(1)
    t.cancel() // the process exited during the grace window
    jest.advanceTimersByTime(1000)
    expect(s.forceKill).not.toHaveBeenCalled()
    expect(s.settle).not.toHaveBeenCalled()
  })
})
