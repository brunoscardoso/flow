import { historyWindow } from './history-window'

// #1088 — the rebuild must not re-collapse history the reader expanded.

describe('historyWindow', () => {
  it('mounts everything when the thread fits inside the window', () => {
    expect(historyWindow(120, 200, false)).toEqual({ earlierCount: 0, visibleFrom: 0 })
  })

  it('mounts everything at exactly the window size', () => {
    expect(historyWindow(200, 200, false)).toEqual({ earlierCount: 0, visibleFrom: 0 })
  })

  it('parks the overflow behind the control for a fresh load', () => {
    expect(historyWindow(221, 200, false)).toEqual({ earlierCount: 21, visibleFrom: 21 })
  })

  it('mounts the FULL history once the reader expanded the earlier chunk', () => {
    // The residual of #179: a completing turn used to re-chunk here, discarding
    // the expansion and — with scrollTop faithfully restored — landing the
    // reader ~21 entries away from the message they were reading.
    expect(historyWindow(221, 200, true)).toEqual({ earlierCount: 0, visibleFrom: 0 })
  })

  it('is stable across repeated rebuilds once expanded', () => {
    expect(historyWindow(222, 200, true)).toEqual(historyWindow(221, 200, true))
  })

  it('never returns a negative window', () => {
    expect(historyWindow(0, 200, false)).toEqual({ earlierCount: 0, visibleFrom: 0 })
    expect(historyWindow(0, 200, true)).toEqual({ earlierCount: 0, visibleFrom: 0 })
  })
})
