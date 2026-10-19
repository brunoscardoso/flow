// Session-start provisioning gate (#513, progressive-learning phase 2). The
// decision core is exhaustively pure; the awaiter is driven with an injected
// subscribe + fake timers so wait/settle/timeout are deterministic — no
// Electron/SDK/fs, plain CJS ts-jest.

import {
  awaitProvisioningSettled,
  decideSessionGate,
  SESSION_GATE_TIMEOUT_MS,
  type SessionGateOutcome,
} from './provision-gate'
import type { ProvisioningState } from '../../shared/ipc-contract'

// ── decision core (pure) ─────────────────────────────────────────────────────

describe('decideSessionGate (pure)', () => {
  it('awaits an in-flight provision', () => {
    expect(decideSessionGate('provisioning')).toBe('await')
  })

  it('warns (but proceeds) when the last run failed', () => {
    expect(decideSessionGate('failed')).toBe('warn-failed')
  })

  it('proceeds instantly for a ready root', () => {
    expect(decideSessionGate('ready')).toBe('proceed')
  })

  it('proceeds for idle (no run pending — never block forever)', () => {
    expect(decideSessionGate('idle')).toBe('proceed')
  })

  it('proceeds when the state is absent (legacy / never seeded)', () => {
    expect(decideSessionGate(undefined)).toBe('proceed')
  })
})

// ── awaiter (injected subscribe + timers) ────────────────────────────────────

/** A hand-driven subscribe: capture the listener so a test can push states. */
function manualSubscribe() {
  let listener: ((state: ProvisioningState) => void) | null = null
  let unsubscribed = false
  const subscribe = (onState: (state: ProvisioningState) => void): (() => void) => {
    listener = onState
    return () => {
      unsubscribed = true
    }
  }
  return {
    subscribe,
    push: (state: ProvisioningState) => listener?.(state),
    hasListener: () => listener !== null,
    wasUnsubscribed: () => unsubscribed,
  }
}

describe('awaitProvisioningSettled', () => {
  it('resolves proceed immediately for a ready root, never subscribing', async () => {
    const watch = manualSubscribe()
    const outcome = await awaitProvisioningSettled({
      initialState: 'ready',
      subscribe: watch.subscribe,
    })
    expect(outcome).toBe('proceed')
    expect(watch.hasListener()).toBe(false) // no wait, no subscription
  })

  it('resolves proceed immediately for idle', async () => {
    const watch = manualSubscribe()
    expect(
      await awaitProvisioningSettled({ initialState: 'idle', subscribe: watch.subscribe }),
    ).toBe('proceed')
    expect(watch.hasListener()).toBe(false)
  })

  it('resolves failed immediately when the root is already failed', async () => {
    const watch = manualSubscribe()
    expect(
      await awaitProvisioningSettled({ initialState: 'failed', subscribe: watch.subscribe }),
    ).toBe('failed')
    expect(watch.hasListener()).toBe(false)
  })

  it('waits for an in-flight provision, then resolves ready and unsubscribes', async () => {
    const watch = manualSubscribe()
    let settled: SessionGateOutcome | null = null
    const promise = awaitProvisioningSettled({
      initialState: 'provisioning',
      subscribe: watch.subscribe,
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>, // timer never fires
      clearTimeoutFn: () => undefined,
    }).then((o) => (settled = o))

    expect(watch.hasListener()).toBe(true)
    expect(settled).toBeNull() // still waiting
    watch.push('provisioning') // a redundant transition — keep waiting
    expect(settled).toBeNull()
    watch.push('ready')
    await promise
    expect(settled).toBe('ready')
    expect(watch.wasUnsubscribed()).toBe(true)
  })

  it('resolves failed when a watched run ends in failure', async () => {
    const watch = manualSubscribe()
    const promise = awaitProvisioningSettled({
      initialState: 'provisioning',
      subscribe: watch.subscribe,
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => undefined,
    })
    watch.push('failed')
    expect(await promise).toBe('failed')
  })

  it('times out (proceeds) when the run never settles, clearing nothing it did not set', async () => {
    const watch = manualSubscribe()
    let fire: (() => void) | null = null
    const cleared: Array<ReturnType<typeof setTimeout>> = []
    const promise = awaitProvisioningSettled({
      initialState: 'provisioning',
      subscribe: watch.subscribe,
      timeoutMs: 50,
      setTimeoutFn: (fn) => {
        fire = fn
        return 123 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: (handle) => cleared.push(handle),
    })
    expect(fire).not.toBeNull()
    fire!() // simulate the timeout firing
    expect(await promise).toBe('timeout')
    expect(cleared).toEqual([123])
    expect(watch.wasUnsubscribed()).toBe(true)
  })

  it('ignores transitions after it has already settled (idempotent finish)', async () => {
    const watch = manualSubscribe()
    const promise = awaitProvisioningSettled({
      initialState: 'provisioning',
      subscribe: watch.subscribe,
      setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => undefined,
    })
    watch.push('ready')
    expect(await promise).toBe('ready')
    // A late 'failed' after settling must not change the resolved value.
    expect(() => watch.push('failed')).not.toThrow()
  })

  it('exposes a 120s default cap', () => {
    expect(SESSION_GATE_TIMEOUT_MS).toBe(120_000)
  })
})
