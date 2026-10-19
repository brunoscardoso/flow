// Session-start provisioning gate (#513, progressive-learning phase 2).
//
// When a thread's project root is still `provisioning`, starting an agent
// session against it races the bundled-CLI init — the session could run before
// plan-flow's assets (skills, .flowconfig, brain) exist. This module holds the
// PURE gate decision (`decideSessionGate`) plus a small, injected-effects
// awaiter (`awaitProvisioningSettled`) that blocks a session start until the
// root settles — bounded so a hung provision NEVER hard-blocks the user.
//
// Both pieces are unit-tested with no Electron/SDK/fs dependency: the decision
// is a pure function, and the awaiter takes an injected `subscribe` + timer so
// its wait/timeout/settle behavior is deterministic under fake timers.

import type { ProvisioningState } from '../../shared/ipc-contract'

/** Hard cap on how long a session start waits for an in-flight provision. A
 *  timeout NEVER blocks — it proceeds with a one-line warning. Matches the
 *  Provisioner's own per-run timeout (a run can't outlive its own cap). */
export const SESSION_GATE_TIMEOUT_MS = 120_000

/**
 * What a session start should do given a root's current provisioning readiness:
 *   `provisioning` → `await`   (a run is in flight — wait, bounded, for it)
 *   `failed`       → `warn-failed` (the last run errored — proceed, but warn)
 *   everything else (`ready` / `idle` / absent) → `proceed` (nothing to wait on)
 *
 * `idle` proceeds rather than waits: it means no run is pending (a root that
 * will never provision — no bundled CLI — or one waiting for a later trigger),
 * so blocking on it would hang forever. Gating is a best-effort convenience,
 * never a hard barrier.
 */
export type SessionGateDecision = 'proceed' | 'await' | 'warn-failed'

export function decideSessionGate(state: ProvisioningState | undefined): SessionGateDecision {
  if (state === 'provisioning') return 'await'
  if (state === 'failed') return 'warn-failed'
  return 'proceed'
}

/**
 * How a gated session start resolved (drives the caller's toast, if any):
 *   `proceed` — no wait was needed (`idle`/`ready`/absent start state)
 *   `ready`   — an in-flight provision completed successfully while we waited
 *   `failed`  — the root was already `failed`, or a watched run ended `failed`
 *   `timeout` — the wait hit its cap before the run settled (proceed anyway)
 */
export type SessionGateOutcome = 'proceed' | 'ready' | 'failed' | 'timeout'

export interface AwaitProvisioningDeps {
  /** The root's readiness at the moment the session is starting. */
  initialState: ProvisioningState | undefined
  /**
   * Subscribe to this root's SUBSEQUENT readiness transitions; the returned
   * function unsubscribes. Only called when the initial decision is `await`.
   */
  subscribe: (onState: (state: ProvisioningState) => void) => () => void
  /** Wait cap (defaults to SESSION_GATE_TIMEOUT_MS). */
  timeoutMs?: number
  /** Injected timers (tests); default to the globals. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Block until an in-flight provision settles, bounded by a timeout. Resolves
 * immediately (never subscribes) unless the initial state is `provisioning`.
 * Never rejects — a timeout resolves `timeout` so the caller always proceeds.
 */
export function awaitProvisioningSettled(
  deps: AwaitProvisioningDeps,
): Promise<SessionGateOutcome> {
  const decision = decideSessionGate(deps.initialState)
  if (decision === 'proceed') return Promise.resolve('proceed')
  if (decision === 'warn-failed') return Promise.resolve('failed')

  const timeoutMs = deps.timeoutMs ?? SESSION_GATE_TIMEOUT_MS
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle))

  return new Promise<SessionGateOutcome>((resolve) => {
    let settled = false
    let unsubscribe: () => void = () => undefined
    const timer = setTimeoutFn(() => finish('timeout'), timeoutMs)

    function finish(outcome: SessionGateOutcome): void {
      if (settled) return
      settled = true
      clearTimeoutFn(timer)
      unsubscribe()
      resolve(outcome)
    }

    unsubscribe = deps.subscribe((state) => {
      if (state === 'ready') finish('ready')
      else if (state === 'failed') finish('failed')
      // 'provisioning' / 'idle' — a run is still in flight; keep waiting.
    })
  })
}
