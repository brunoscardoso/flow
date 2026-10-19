import { makeRootsBroadcast, ROOTS_BROADCAST_DEBOUNCE_MS, ROOTS_BROADCAST_MAX_WAIT_MS } from './roots-broadcast'
import type { RegisteredProject } from '../../shared/ipc-contract'

function root(rootPath: string, provisioningState: RegisteredProject['provisioningState'] = 'ready'): RegisteredProject {
  return { id: rootPath, rootPath, name: rootPath, position: 0, addedAt: '2026-10-09', windowId: 'w', provisioningState } as unknown as RegisteredProject
}

function harness() {
  let clock = 0
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const sent: RegisteredProject[][] = []
  const broadcast = makeRootsBroadcast((roots) => sent.push(roots), {
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn, live: true }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { live: boolean }).live = false
    },
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const timer of timers) {
      if (timer.live && timer.at <= clock) {
        timer.live = false
        timer.fn()
      }
    }
  }
  return { broadcast, sent, advance, tick: (ms: number) => (clock += ms) }
}

describe('the project:listChanged broadcast (2026-10-09 flood)', () => {
  it('sends ONE broadcast — the latest list — for a burst of registry events', () => {
    const h = harness()
    h.broadcast.push([root('/a', 'provisioning')])
    h.broadcast.push([root('/a', 'provisioning'), root('/b', 'provisioning')])
    h.broadcast.push([root('/a'), root('/b')])
    expect(h.sent).toEqual([])
    h.advance(ROOTS_BROADCAST_DEBOUNCE_MS)
    expect(h.sent).toEqual([[root('/a'), root('/b')]])
  })

  it('drops a list identical to the last one sent', () => {
    const h = harness()
    h.broadcast.push([root('/a')])
    h.advance(ROOTS_BROADCAST_DEBOUNCE_MS)
    h.broadcast.push([root('/a')])
    h.advance(ROOTS_BROADCAST_DEBOUNCE_MS)
    expect(h.sent).toHaveLength(1)
    h.broadcast.push([root('/a', 'provisioning')])
    h.advance(ROOTS_BROADCAST_DEBOUNCE_MS)
    expect(h.sent).toHaveLength(2)
  })

  it('never starves: a burst that never pauses still goes out at the ceiling', () => {
    const h = harness()
    for (let i = 0; i * 20 < ROOTS_BROADCAST_MAX_WAIT_MS + 40; i += 1) {
      h.broadcast.push([root(`/r${i}`)])
      h.tick(20)
    }
    expect(h.sent.length).toBeGreaterThanOrEqual(1)
  })

  it('sends nothing after dispose', () => {
    const h = harness()
    h.broadcast.push([root('/a')])
    h.broadcast.dispose()
    h.advance(ROOTS_BROADCAST_DEBOUNCE_MS * 2)
    expect(h.sent).toEqual([])
  })
})
