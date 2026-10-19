import { startPerformanceLog } from './perf-log'

/**
 * The observer half, wired against a stub Chromium: an instrument nobody has
 * seen produce a line is a hope, not a measurement.
 */
/** The shape the module reads off an entry — the jest tsconfig has no DOM lib,
 *  which is fine: this test is about the wiring, not about Chromium's types. */
interface PerfEntry {
  duration: number
  name: string
}

type ObserverCallback = (list: { getEntries: () => PerfEntry[] }) => void

class StubObserver {
  static live: Array<{ init: unknown; emit: (entries: PerfEntry[]) => void }> = []
  #callback: ObserverCallback
  constructor(callback: ObserverCallback) {
    this.#callback = callback
  }
  observe(init: unknown): void {
    StubObserver.live.push({
      init,
      emit: (entries) => this.#callback({ getEntries: () => entries }),
    })
  }
  disconnect(): void {
    StubObserver.live = []
  }
}

function fakeApi(recorded: string[][]): Parameters<typeof startPerformanceLog>[0] {
  return {
    diagnostics: {
      record: async ({ lines }: { lines: string[] }) => {
        recorded.push(lines)
      },
      report: async () => ({ text: '', empty: true }),
      inFlight: () => ['project:listAllFiles 820ms'],
    },
  } as Parameters<typeof startPerformanceLog>[0]
}

describe('the renderer records what it alone can see', () => {
  const realObserver = globalThis.PerformanceObserver

  beforeEach(() => {
    StubObserver.live = []
    ;(globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = StubObserver
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = realObserver
  })

  it('writes a blocked frame with what it was waiting for', () => {
    const recorded: string[][] = []
    startPerformanceLog(fakeApi(recorded))
    StubObserver.live[0]?.emit([{ duration: 900, name: 'self' }])
    jest.advanceTimersByTime(1_100)

    expect(recorded.flat()).toEqual([
      '[renderer] blocked for 900ms (waiting on project:listAllFiles 820ms)',
    ])
  })

  it('ignores a frame nobody could feel', () => {
    const recorded: string[][] = []
    startPerformanceLog(fakeApi(recorded))
    StubObserver.live[0]?.emit([{ duration: 60, name: 'self' }])
    jest.advanceTimersByTime(1_100)
    expect(recorded).toEqual([])
  })

  it('batches a burst into one round trip, collapsed', () => {
    // The instrument must not add IPC to the moments already struggling.
    const recorded: string[][] = []
    startPerformanceLog(fakeApi(recorded))
    for (let i = 0; i < 5; i += 1) {
      StubObserver.live[0]?.emit([{ duration: 300 + i, name: 'self' }])
    }
    jest.advanceTimersByTime(1_100)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual(['[renderer] blocked for 300ms (waiting on project:listAllFiles 820ms) (×5)'])
  })

  it('degrades to silence where there is no observer at all', () => {
    ;(globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = undefined
    const recorded: string[][] = []
    expect(() => startPerformanceLog(fakeApi(recorded)).stop()).not.toThrow()
    expect(recorded).toEqual([])
  })
})
