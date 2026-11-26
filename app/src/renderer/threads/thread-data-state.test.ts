import type { RunGroupState } from '../../shared/run-setup'
import { LiveDataTracker, LIVE_DATA_DEBOUNCE_MS, runStateTouchesData, sameLiveSet, threadDataFace } from './thread-data-state'

const dockerState: RunGroupState = {
  scopeKey: '/w::t1',
  active: true,
  steps: [{ key: '/w::docker:db', name: 'db', projectRoot: '/w', status: 'running', terminalId: 'x', exitCode: null, detail: null, docker: { projectRoot: '/w', service: 'db' } }],
}
const localState: RunGroupState = {
  scopeKey: '/w::t2',
  active: true,
  steps: [{ key: '/w::web', name: 'web', projectRoot: '/w', status: 'running', terminalId: 'y', exitCode: null, detail: null }],
}

function harness(options: { visible?: boolean; answer?: string[] } = {}) {
  let visible = options.visible ?? true
  let answer = options.answer ?? ['t1']
  const timers: Array<() => void> = []
  const reads: number[] = []
  let changes = 0
  const tracker = new LiveDataTracker({
    read: async () => {
      reads.push(1)
      return answer
    },
    isVisible: () => visible,
    onChange: () => {
      changes += 1
    },
    setTimer: (run, ms) => {
      expect(ms).toBe(LIVE_DATA_DEBOUNCE_MS)
      timers.push(run)
      return timers.length
    },
    clearTimer: () => undefined,
  })
  const flush = async (): Promise<void> => {
    while (timers.length > 0) timers.shift()!()
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    tracker,
    flush,
    reads,
    timers,
    changes: () => changes,
    setVisible: (v: boolean) => (visible = v),
    setAnswer: (a: string[]) => (answer = a),
  }
}

describe('threadDataFace', () => {
  it('the green mark only on the thread whose data is live', () => {
    expect(threadDataFace('t1', new Set(['t1']))).toEqual({ label: 'Data running', title: "This thread's own data is the one running now." })
    expect(threadDataFace('t2', new Set(['t1']))).toBeNull()
  })
})

describe('what a Run change could move', () => {
  it('a Docker service or a Docker notice, never a plain local step', () => {
    expect(runStateTouchesData(dockerState)).toBe(true)
    expect(runStateTouchesData(localState)).toBe(false)
    expect(runStateTouchesData({ ...localState, dockerNotices: [{ projectRoot: null, kind: 'docker-unavailable', detail: 'x' }] })).toBe(true)
    expect(sameLiveSet(new Set(['a']), ['a'])).toBe(true)
    expect(sameLiveSet(new Set(['a']), ['b'])).toBe(false)
  })
})

describe('LiveDataTracker', () => {
  it('reads on first show, repaints only when the answer moves', async () => {
    const h = harness()
    h.tracker.shown()
    await h.flush()
    expect(h.reads).toHaveLength(1)
    expect([...h.tracker.live]).toEqual(['t1'])
    expect(h.changes()).toBe(1)
    h.tracker.runUpdated(dockerState)
    await h.flush()
    expect(h.reads).toHaveLength(2)
    expect(h.changes()).toBe(1) // same answer: no repaint
  })

  it('ignores Run changes that touch no Docker service (forbidden-pattern #14)', async () => {
    const h = harness()
    h.tracker.shown()
    await h.flush()
    for (let i = 0; i < 20; i += 1) h.tracker.runUpdated(localState)
    await h.flush()
    expect(h.reads).toHaveLength(1)
  })

  it('folds a burst into one read', async () => {
    const h = harness()
    h.tracker.shown()
    await h.flush()
    for (let i = 0; i < 5; i += 1) h.tracker.runUpdated(dockerState)
    expect(h.timers).toHaveLength(1)
    await h.flush()
    expect(h.reads).toHaveLength(2)
  })

  it('hidden: owes the read and pays it on the way back in, never while hidden', async () => {
    const h = harness({ visible: false })
    h.tracker.shown()
    h.tracker.runUpdated(dockerState)
    await h.flush()
    expect(h.reads).toHaveLength(0)
    h.setVisible(true)
    h.setAnswer(['t2'])
    h.tracker.shown()
    await h.flush()
    expect(h.reads).toHaveLength(1)
    expect([...h.tracker.live]).toEqual(['t2'])
  })
})
