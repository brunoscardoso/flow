/**
 * THE RUN SUPERVISOR — the one owner of every Run (allowed-pattern #14). The
 * renderer and the agent send intents (start, reload, stop, apply); this
 * decides and reports each step's state.
 *
 *   - Steps start in order, each in its own terminal. A step that starts
 *     `after-previous` waits for the step above to be READY (its ready check
 *     passed) — or merely started, when that step has no check.
 *   - A step whose port is already answering before it starts is BLOCKED with
 *     a reason; Reload on it starts it anyway.
 *   - A step whose project is not on this computer is BLOCKED too, and no
 *     Reload — forced or not — starts it: there is nowhere to run it.
 *   - Reload all / Reload one / Stop all / apply a saved setup (start new,
 *     restart changed, stop removed, keep the rest).
 *   - State is broadcast only when it CHANGED (allowed-pattern #17): changes
 *     inside one tick are coalesced, and a report identical to the last one
 *     is never sent.
 *
 * Nothing here runs a command until a person asks (NFR-5): a setup is only
 * read on `start`, `reload` and `apply`.
 *
 * Every dependency — the terminals, the setup store, the ready checks — is
 * injected; the tests drive fakes only and never spawn or signal a process
 * (forbidden-pattern #15).
 */
import type { TerminalInfo } from '../../shared/ipc-contract'
import {
  runScopeKey,
  type ResolvedRunStep,
  type RunGroupState,
  type RunReady,
  type RunResolution,
  type RunScope,
  type RunScopeSummary,
  type RunStepState,
  type RunStepStatus,
} from '../../shared/run-setup'
import type { ReadyWait } from './ready-check'

export interface RunTerminalPort {
  createUserTerminal(request: {
    rootId?: string
    cols: number
    rows: number
    owner?: { rootPath: string; threadId: string | null }
    command?: string
    cwd?: string
    title?: string
    run?: TerminalInfo['run']
  }): TerminalInfo
  /** Remove the tab; a run terminal's process group is hard-killed after a grace. */
  dispose(terminalId: string): void
  /** End the process but keep the tab (it shows the step's last output). */
  stopProcess(terminalId: string): boolean
  onExit(listener: (event: { terminalId: string; exitCode: number }) => void): () => void
  onRemoved(listener: (event: { terminalId: string }) => void): () => void
}

export interface RunReadyChecks {
  portInUse(port: number): Promise<boolean>
  waitForPort(port: number, timeoutMs: number): ReadyWait
  waitForLine(terminalId: string, text: string, timeoutMs: number): ReadyWait
  /** Resolves true once nothing answers on the port any more (or false at the limit). */
  waitPortFree(port: number, timeoutMs: number): Promise<boolean>
}

export interface RunSupervisorDeps {
  terminals: RunTerminalPort
  setups: { resolve(scope: RunScope): Promise<RunResolution> }
  ready: RunReadyChecks
  /** Defer the coalesced report — `queueMicrotask` by default. */
  defer?: (fn: () => void) => void
}

/** How long a reload waits for the old process to let go of its port. */
export const PORT_RELEASE_LIMIT_MS = 4_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 32

interface Gate {
  promise: Promise<boolean>
  settled: boolean
  resolve(ok: boolean): void
}

function newGate(): Gate {
  let resolver: (ok: boolean) => void = () => undefined
  const gate: Gate = {
    promise: new Promise<boolean>((resolve) => {
      resolver = resolve
    }),
    settled: false,
    resolve: (ok) => {
      if (gate.settled) return
      gate.settled = true
      resolver(ok)
    },
  }
  return gate
}

interface StepRun {
  step: ResolvedRunStep
  status: RunStepStatus
  terminalId: string | null
  /** The process in `terminalId` has not exited. */
  alive: boolean
  exitCode: number | null
  detail: string | null
  /** Stop was asked for: the exit that follows reads as stopped, not as a failure. */
  stopping: boolean
  wait: ReadyWait | null
  /** Settles true when later steps may start, false when they may not. */
  gate: Gate
  /** Bumped by every launch and retirement, so a stale sequence never double-starts a step. */
  epoch: number
}

interface ScopeRun {
  scope: RunScope
  key: string
  steps: StepRun[]
  /** Bumped by Stop and Reload all: every sequence started before it stops at its next await. */
  generation: number
  lastReported: string | null
  reportQueued: boolean
}

function newStepRun(step: ResolvedRunStep): StepRun {
  return {
    step,
    status: 'idle',
    terminalId: null,
    alive: false,
    exitCode: null,
    detail: null,
    stopping: false,
    wait: null,
    gate: newGate(),
    epoch: 0,
  }
}

function sameDefinition(a: ResolvedRunStep, b: ResolvedRunStep): boolean {
  return (
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.start === b.start &&
    a.unavailable === b.unavailable &&
    a.readyTimeoutMs === b.readyTimeoutMs &&
    JSON.stringify(a.ready ?? null) === JSON.stringify(b.ready ?? null)
  )
}

function seconds(ms: number): number {
  return Math.round(ms / 1000)
}

function waitingSentence(ready: RunReady): string {
  return ready.kind === 'port' ? `Waiting for port ${ready.port} to answer.` : `Waiting for “${ready.text}” to appear.`
}

function timedOutSentence(ready: RunReady, timeoutMs: number): string {
  return ready.kind === 'port'
    ? `Port ${ready.port} did not answer within ${seconds(timeoutMs)} seconds.`
    : `“${ready.text}” did not appear within ${seconds(timeoutMs)} seconds.`
}

function portOf(step: ResolvedRunStep): number | null {
  return step.ready?.kind === 'port' ? step.ready.port : null
}

/** A group's state with every step idle — what a scope looks like before its first Run. */
export function idleGroupState(scopeKey: string, steps: ResolvedRunStep[]): RunGroupState {
  return {
    scopeKey,
    active: false,
    steps: steps.map((step) => ({
      key: step.key,
      name: step.name,
      projectRoot: step.projectRoot,
      status: 'idle',
      terminalId: null,
      exitCode: null,
      detail: step.unavailable ?? null,
      ...(step.unavailable !== undefined ? { notHere: true } : {}),
    })),
  }
}

export class RunSupervisor {
  readonly #deps: RunSupervisorDeps
  readonly #defer: (fn: () => void) => void
  readonly #runs = new Map<string, ScopeRun>()
  readonly #owned = new Map<string, { run: ScopeRun; step: StepRun }>()
  readonly #listeners = new Set<(state: RunGroupState) => void>()
  readonly #unsubscribe: Array<() => void>
  #disposed = false

  constructor(deps: RunSupervisorDeps) {
    this.#deps = deps
    this.#defer = deps.defer ?? queueMicrotask
    this.#unsubscribe = [
      deps.terminals.onExit((event) => this.#onExit(event.terminalId, event.exitCode)),
      deps.terminals.onRemoved((event) => this.#onRemoved(event.terminalId)),
    ]
  }

  /** Listen for state changes (transitions only). Returns its own removal. */
  onUpdated(listener: (state: RunGroupState) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  state(scope: RunScope): RunGroupState {
    const run = this.#runs.get(runScopeKey(scope))
    return run === undefined ? { scopeKey: runScopeKey(scope), active: false, steps: [] } : this.#snapshot(run)
  }

  /** Which scopes have a Run going — the sidebar's running mark. */
  states(): RunScopeSummary[] {
    const out: RunScopeSummary[] = []
    for (const run of this.#runs.values()) {
      const running = run.steps.filter((step) => this.#isGoing(step)).length
      if (running > 0) out.push({ scopeKey: run.key, rootPath: run.scope.rootPath, threadId: run.scope.threadId, running })
    }
    return out
  }

  /** The terminal a step of a scope is shown in, or null. */
  terminalOf(scope: RunScope, stepKey: string): string | null {
    return this.#runs.get(runScopeKey(scope))?.steps.find((step) => step.step.key === stepKey)?.terminalId ?? null
  }

  // ─── intents ───────────────────────────────────────────────────────────────

  /** Run: start every step in order. A Run already going is left alone. */
  async start(scope: RunScope): Promise<RunGroupState> {
    const existing = this.#runs.get(runScopeKey(scope))
    if (existing !== undefined && this.#isActive(existing)) return this.#snapshot(existing)
    const resolution = await this.#deps.setups.resolve(scope)
    const run = this.#replaceRun(scope, resolution)
    this.#launch(run, run.steps, { force: false, waitSettledOnly: false })
    return this.#snapshot(run)
  }

  /**
   * Reload all (no `stepKey`): stop every step, re-read the setup, start in
   * order again. Reload one: restart only that step; a blocked step (or
   * `force`) starts even though its port is in use.
   */
  async reload(scope: RunScope, stepKey?: string, force?: boolean): Promise<RunGroupState> {
    const run = this.#runs.get(runScopeKey(scope))
    if (stepKey === undefined) {
      if (run === undefined) return this.start(scope)
      run.generation += 1
      await Promise.all(run.steps.map((step) => this.#retire(run, step)))
      const resolution = await this.#deps.setups.resolve(scope)
      const fresh = this.#replaceRun(scope, resolution)
      this.#launch(fresh, fresh.steps, { force: false, waitSettledOnly: false })
      return this.#snapshot(fresh)
    }
    if (run === undefined) return this.state(scope)
    const step = run.steps.find((candidate) => candidate.step.key === stepKey)
    if (step === undefined) return this.#snapshot(run)
    const forced = force === true || step.status === 'blocked'
    await this.#retire(run, step)
    this.#launch(run, [step], { force: forced, waitSettledOnly: true })
    return this.#snapshot(run)
  }

  /** Stop all: end every step's process (the tabs stay, showing stopped). */
  async stop(scope: RunScope): Promise<RunGroupState> {
    const run = this.#runs.get(runScopeKey(scope))
    if (run === undefined) return this.state(scope)
    run.generation += 1
    for (const step of run.steps) {
      step.epoch += 1
      this.#cancelWait(step)
      if (step.alive && step.terminalId !== null) {
        step.stopping = true
        this.#deps.terminals.stopProcess(step.terminalId)
        this.#set(run, step, { status: 'stopped', detail: null })
      } else if (step.status === 'waiting' || step.status === 'starting') {
        this.#set(run, step, { status: 'idle', detail: null })
      }
      step.gate.resolve(false)
    }
    return this.#snapshot(run)
  }

  /**
   * A setup was saved: start new steps, restart changed ones, stop removed
   * ones, keep the rest running. A scope with no Run going only takes the new
   * step list — nothing starts.
   */
  async apply(scope: RunScope): Promise<RunGroupState> {
    const resolution = await this.#deps.setups.resolve(scope)
    const run = this.#runs.get(resolution.scopeKey)
    if (run === undefined) return idleGroupState(resolution.scopeKey, resolution.steps)
    const active = this.#isActive(run)
    const byKey = new Map(run.steps.map((step) => [step.step.key, step]))
    const toLaunch: StepRun[] = []
    const toRestart: StepRun[] = []
    const next = resolution.steps.map((definition) => {
      const old = byKey.get(definition.key)
      if (old === undefined) {
        const fresh = newStepRun(definition)
        toLaunch.push(fresh)
        return fresh
      }
      byKey.delete(definition.key)
      const changed = !sameDefinition(old.step, definition)
      old.step = definition
      if (changed) toRestart.push(old)
      return old
    })
    const removed = [...byKey.values()]
    run.steps = next
    await Promise.all(removed.map((step) => this.#retire(run, step, { removeTab: true })))
    if (active) {
      await Promise.all(toRestart.map((step) => this.#retire(run, step)))
      const launch = next.filter((step) => toLaunch.includes(step) || toRestart.includes(step))
      this.#launch(run, launch, { force: false, waitSettledOnly: false })
    }
    this.#report(run)
    return this.#snapshot(run)
  }

  /** Quit: end every Run's processes and tabs, and stop listening. */
  disposeAll(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    for (const run of this.#runs.values()) {
      run.generation += 1
      for (const step of run.steps) {
        this.#cancelWait(step)
        step.gate.resolve(false)
        if (step.terminalId !== null) this.#deps.terminals.dispose(step.terminalId)
        step.terminalId = null
      }
    }
    this.#runs.clear()
    this.#owned.clear()
    this.#listeners.clear()
  }

  // ─── the machinery ─────────────────────────────────────────────────────────

  /** A new ScopeRun for a resolution, removing the tabs a finished Run left behind. */
  #replaceRun(scope: RunScope, resolution: RunResolution): ScopeRun {
    const previous = this.#runs.get(resolution.scopeKey)
    if (previous !== undefined) {
      previous.generation += 1
      for (const step of previous.steps) {
        this.#cancelWait(step)
        step.gate.resolve(false)
        if (step.terminalId !== null) {
          this.#owned.delete(step.terminalId)
          this.#deps.terminals.dispose(step.terminalId)
        }
      }
    }
    const run: ScopeRun = {
      scope,
      key: resolution.scopeKey,
      steps: resolution.steps.map(newStepRun),
      generation: (previous?.generation ?? 0) + 1,
      lastReported: previous?.lastReported ?? null,
      reportQueued: false,
    }
    this.#runs.set(run.key, run)
    this.#report(run)
    return run
  }

  /**
   * Start `steps` in their order within the Run. `waitSettledOnly`: a Reload
   * of one step waits for the step above only while it is still getting
   * ready — a person who asks for one step gets it.
   */
  #launch(run: ScopeRun, steps: StepRun[], options: { force: boolean; waitSettledOnly: boolean }): void {
    const generation = run.generation
    const epochs = new Map<StepRun, number>()
    for (const step of steps) {
      step.epoch += 1
      step.gate = newGate()
      step.stopping = false
      epochs.set(step, step.epoch)
    }
    const current = (step: StepRun): boolean =>
      !this.#disposed && run.generation === generation && step.epoch === epochs.get(step) && this.#runs.get(run.key) === run

    void (async () => {
      for (const step of steps) {
        if (!current(step)) continue
        const index = run.steps.indexOf(step)
        const previous = index > 0 ? run.steps[index - 1] : undefined
        if (step.step.start === 'after-previous' && previous !== undefined) {
          const mustWait = !options.waitSettledOnly || !previous.gate.settled
          if (mustWait) {
            if (!previous.gate.settled) {
              this.#set(run, step, { status: 'waiting', detail: `Waiting for “${previous.step.name}” to be ready.` })
            }
            const ok = await previous.gate.promise
            if (!current(step)) continue
            if (!ok && !options.waitSettledOnly) {
              this.#set(run, step, {
                status: 'idle',
                detail: `Not started, because “${previous.step.name}” is not ready.`,
              })
              step.gate.resolve(false)
              continue
            }
          }
        }
        await this.#startStep(run, step, options.force, current)
      }
    })().catch((error: unknown) => {
      console.warn('[Run] a launch sequence failed', error)
    })
  }

  async #startStep(run: ScopeRun, step: StepRun, force: boolean, current: (step: StepRun) => boolean): Promise<void> {
    if (step.step.unavailable !== undefined) {
      // Nowhere to run it: not even a forced Reload starts it.
      this.#set(run, step, { status: 'blocked', exitCode: null, detail: step.step.unavailable })
      step.gate.resolve(false)
      return
    }
    const port = portOf(step.step)
    if (port !== null && !force) {
      let busy = false
      try {
        busy = await this.#deps.ready.portInUse(port)
      } catch {
        busy = false
      }
      if (!current(step)) return
      if (busy) {
        const holder = this.#flowRunHolding(port, run)
        this.#set(run, step, {
          status: 'blocked',
          exitCode: null,
          detail:
            holder === null
              ? `Port ${port} is already in use, so this step was not started. Reload starts it anyway.`
              : `Port ${port} is already in use by ${holder}, so this step was not started. Reload starts it anyway.`,
        })
        step.gate.resolve(false)
        return
      }
    }

    this.#set(run, step, { status: 'starting', exitCode: null, detail: null })
    let info: TerminalInfo
    try {
      info = this.#deps.terminals.createUserTerminal({
        rootId: step.step.projectRoot,
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        owner: { rootPath: run.scope.rootPath, threadId: run.scope.threadId },
        command: step.step.command,
        cwd: step.step.cwd,
        title: step.step.name,
        run: { scopeKey: run.key, stepId: step.step.id, projectRoot: step.step.projectRoot },
      })
    } catch {
      this.#set(run, step, { status: 'exited', detail: 'This step could not be started.' })
      step.gate.resolve(false)
      return
    }
    step.terminalId = info.terminalId
    step.alive = true
    this.#owned.set(info.terminalId, { run, step })

    const ready = step.step.ready
    if (ready === undefined) {
      this.#set(run, step, { status: 'running' })
      step.gate.resolve(true)
      return
    }
    const wait =
      ready.kind === 'port'
        ? this.#deps.ready.waitForPort(ready.port, step.step.readyTimeoutMs)
        : this.#deps.ready.waitForLine(info.terminalId, ready.text, step.step.readyTimeoutMs)
    step.wait = wait
    this.#set(run, step, { status: 'waiting', detail: waitingSentence(ready) })
    void wait.result.then((outcome) => {
      if (step.wait !== wait) return
      step.wait = null
      if (outcome === 'ready') {
        this.#set(run, step, { status: 'ready', detail: null })
        step.gate.resolve(true)
      } else if (outcome === 'timed-out') {
        this.#set(run, step, { status: 'timed-out', detail: timedOutSentence(ready, step.step.readyTimeoutMs) })
        step.gate.resolve(false)
      }
    })
  }

  /**
   * Take a step out of service before it starts again (or goes away): stop
   * its wait, remove its tab — the terminal hard-kills the process group
   * after a grace — and, if it held a port, give the port a moment to free.
   */
  async #retire(run: ScopeRun, step: StepRun, options: { removeTab?: boolean } = {}): Promise<void> {
    step.epoch += 1
    this.#cancelWait(step)
    step.gate.resolve(false)
    const wasAlive = step.alive
    if (step.terminalId !== null) {
      const terminalId = step.terminalId
      this.#owned.delete(terminalId)
      step.terminalId = null
      step.alive = false
      this.#deps.terminals.dispose(terminalId)
    }
    if (options.removeTab === true) return
    this.#set(run, step, { status: 'idle', exitCode: null, detail: null })
    const port = portOf(step.step)
    if (wasAlive && port !== null) {
      try {
        await this.#deps.ready.waitPortFree(port, PORT_RELEASE_LIMIT_MS)
      } catch {
        // The start that follows checks the port itself and says so.
      }
    }
  }

  #cancelWait(step: StepRun): void {
    const wait = step.wait
    step.wait = null
    wait?.cancel()
  }

  #onExit(terminalId: string, exitCode: number): void {
    const owned = this.#owned.get(terminalId)
    if (owned === undefined) return
    const { run, step } = owned
    if (step.terminalId !== terminalId || !step.alive) return
    step.alive = false
    this.#cancelWait(step)
    step.gate.resolve(false)
    if (step.stopping) {
      this.#set(run, step, { status: 'stopped', exitCode, detail: null })
    } else {
      this.#set(run, step, {
        status: 'exited',
        exitCode,
        detail: exitCode === 0 ? 'Finished.' : `Ended with code ${exitCode}.`,
      })
    }
  }

  /** A person closed a step's tab: the step is stopped and has no tab. */
  #onRemoved(terminalId: string): void {
    const owned = this.#owned.get(terminalId)
    if (owned === undefined) return
    this.#owned.delete(terminalId)
    const { run, step } = owned
    if (step.terminalId !== terminalId) return
    step.epoch += 1
    step.terminalId = null
    this.#cancelWait(step)
    step.gate.resolve(false)
    if (step.alive) {
      step.alive = false
      this.#set(run, step, { status: 'stopped', detail: null })
    } else {
      this.#report(run)
    }
  }

  /** The other Flow Run whose step holds this port, in plain words — or null. */
  #flowRunHolding(port: number, self: ScopeRun): string | null {
    for (const run of this.#runs.values()) {
      for (const step of run.steps) {
        if (step.alive && portOf(step.step) === port) {
          if (run === self) return `“${step.step.name}” in this Run`
          return run.scope.threadId === null ? "the project's own Run" : 'a Run in another conversation'
        }
      }
    }
    return null
  }

  #isGoing(step: StepRun): boolean {
    // A step being stopped is not "going" even before its process has exited.
    return (step.alive && !step.stopping) || step.status === 'waiting' || step.status === 'starting'
  }

  #isActive(run: ScopeRun): boolean {
    return run.steps.some((step) => this.#isGoing(step))
  }

  #set(run: ScopeRun, step: StepRun, patch: Partial<Pick<StepRun, 'status' | 'exitCode' | 'detail'>>): void {
    if (patch.status !== undefined) step.status = patch.status
    if (patch.exitCode !== undefined) step.exitCode = patch.exitCode
    if (patch.detail !== undefined) step.detail = patch.detail
    this.#report(run)
  }

  /** Queue one report for this tick; it is sent only if it differs from the last one. */
  #report(run: ScopeRun): void {
    if (run.reportQueued || this.#disposed) return
    run.reportQueued = true
    this.#defer(() => {
      run.reportQueued = false
      if (this.#disposed || this.#runs.get(run.key) !== run) return
      const state = this.#snapshot(run)
      const text = JSON.stringify(state)
      if (text === run.lastReported) return
      run.lastReported = text
      for (const listener of this.#listeners) {
        try {
          listener(state)
        } catch (error) {
          console.warn('[Run] an update listener threw', error)
        }
      }
    })
  }

  #snapshot(run: ScopeRun): RunGroupState {
    const steps: RunStepState[] = run.steps.map((step) => ({
      key: step.step.key,
      name: step.step.name,
      projectRoot: step.step.projectRoot,
      status: step.status,
      terminalId: step.terminalId,
      exitCode: step.exitCode,
      detail: step.detail,
      ...(step.step.unavailable !== undefined ? { notHere: true } : {}),
    }))
    return { scopeKey: run.key, active: this.#isActive(run), steps }
  }
}
