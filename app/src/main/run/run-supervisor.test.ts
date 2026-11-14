// RunSupervisor — fakes only: a recording terminal port (no PTY, no signal
// ever sent), a fake setup store, and ready checks the test settles by hand.

import type { TerminalInfo } from '../../shared/ipc-contract'
import {
  resolveRunSteps,
  runScopeKey,
  type RunGroupState,
  type RunResolution,
  type RunScope,
  type RunSetup,
} from '../../shared/run-setup'
import type { ReadyOutcome, ReadyWait } from './ready-check'
import { RunSupervisor, type RunReadyChecks, type RunTerminalPort } from './run-supervisor'

const ROOT = '/repos/shop'
const SCOPE: RunScope = { rootPath: ROOT, threadId: 't1' }

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

class FakeTerminals implements RunTerminalPort {
  created: Array<Parameters<RunTerminalPort['createUserTerminal']>[0] & { terminalId: string }> = []
  disposed: string[] = []
  stopped: string[] = []
  #n = 0
  #exit = new Set<(e: { terminalId: string; exitCode: number }) => void>()
  #removed = new Set<(e: { terminalId: string }) => void>()
  createUserTerminal(request: Parameters<RunTerminalPort['createUserTerminal']>[0]): TerminalInfo {
    this.#n += 1
    const terminalId = `term-${this.#n}`
    this.created.push({ ...request, terminalId })
    return { terminalId, kind: 'user', title: request.title ?? '', cwd: request.cwd ?? '', ...(request.run ? { run: request.run } : {}) }
  }
  dispose(terminalId: string): void {
    this.disposed.push(terminalId)
    for (const l of [...this.#removed]) l({ terminalId })
  }
  stopProcess(terminalId: string): boolean {
    this.stopped.push(terminalId)
    return true
  }
  onExit(listener: (e: { terminalId: string; exitCode: number }) => void): () => void {
    this.#exit.add(listener)
    return () => this.#exit.delete(listener)
  }
  onRemoved(listener: (e: { terminalId: string }) => void): () => void {
    this.#removed.add(listener)
    return () => this.#removed.delete(listener)
  }
  exit(terminalId: string, exitCode: number): void {
    for (const l of [...this.#exit]) l({ terminalId, exitCode })
  }
  closeByUser(terminalId: string): void {
    for (const l of [...this.#removed]) l({ terminalId })
  }
  commands(): string[] {
    return this.created.map((c) => c.command ?? '')
  }
  listenerCount(): number {
    return this.#exit.size + this.#removed.size
  }
}

class ControlledWait implements ReadyWait {
  readonly result: Promise<ReadyOutcome>
  cancelled = false
  #resolve: (o: ReadyOutcome) => void = () => undefined
  constructor(readonly what: string) {
    this.result = new Promise((r) => {
      this.#resolve = r
    })
  }
  settle(outcome: ReadyOutcome): void {
    this.#resolve(outcome)
  }
  cancel(): void {
    this.cancelled = true
    this.#resolve('cancelled')
  }
}

class FakeReady implements RunReadyChecks {
  busy = new Set<number>()
  waits: ControlledWait[] = []
  freed: number[] = []
  async portInUse(port: number): Promise<boolean> {
    return this.busy.has(port)
  }
  waitForPort(port: number): ReadyWait {
    const wait = new ControlledWait(`port:${port}`)
    this.waits.push(wait)
    return wait
  }
  waitForLine(terminalId: string, text: string): ReadyWait {
    const wait = new ControlledWait(`line:${terminalId}:${text}`)
    this.waits.push(wait)
    return wait
  }
  async waitPortFree(port: number): Promise<boolean> {
    this.freed.push(port)
    return true
  }
  last(what: string): ControlledWait {
    const found = [...this.waits].reverse().find((w) => w.what === what)
    if (found === undefined) throw new Error(`no wait for ${what}`)
    return found
  }
}

function setupStore(initial: RunSetup): { resolve(scope: RunScope): Promise<RunResolution>; setup: RunSetup; resolves: number } {
  const holder = {
    setup: initial,
    resolves: 0,
    resolve: async (scope: RunScope): Promise<RunResolution> => {
      holder.resolves += 1
      const projects = [{ root: ROOT, name: 'shop', cwd: '/repos/.shop-threads/blue', setup: holder.setup, personal: {}, conversation: {}, hasSharedSetup: true, problems: [] }]
      return { scope, scopeKey: runScopeKey(scope), projects, steps: resolveRunSteps(projects) }
    },
  }
  return holder
}

const THREE: RunSetup = {
  version: 1,
  steps: [
    { id: 'db', name: 'Database', command: 'docker compose up db', start: 'now', ready: { kind: 'port', port: 5432 } },
    { id: 'api', name: 'API', command: 'npm run api', start: 'after-previous', ready: { kind: 'line', text: 'listening' } },
    { id: 'web', name: 'Web', command: 'npm run dev', start: 'after-previous' },
  ],
}

function harness(setup: RunSetup = THREE) {
  const terminals = new FakeTerminals()
  const ready = new FakeReady()
  const store = setupStore(setup)
  const supervisor = new RunSupervisor({ terminals, setups: store, ready })
  const updates: RunGroupState[] = []
  supervisor.onUpdated((state) => updates.push(state))
  const statusOf = (): Array<[string, string]> => supervisor.state(SCOPE).steps.map((s) => [s.key.split('::')[1]!, s.status])
  return { terminals, ready, store, supervisor, updates, statusOf }
}

describe('RunSupervisor — start', () => {
  it('starts in order, each after-previous step waiting for the one above to be ready', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db'])
    expect(h.statusOf()).toEqual([
      ['db', 'waiting'],
      ['api', 'waiting'],
      ['web', 'idle'],
    ])
    expect(h.supervisor.state(SCOPE).steps[0]?.detail).toBe('Waiting for port 5432 to answer.')
    expect(h.supervisor.state(SCOPE).steps[1]?.detail).toBe('Waiting for “Database” to be ready.')

    h.ready.last('port:5432').settle('ready')
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db', 'npm run api'])
    expect(h.supervisor.state(SCOPE).steps[1]?.detail).toBe('Waiting for “listening” to appear.')
    // The line check watches the API's own terminal.
    expect(h.ready.last('line:term-2:listening')).toBeDefined()

    h.ready.last('line:term-2:listening').settle('ready')
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db', 'npm run api', 'npm run dev'])
    expect(h.statusOf()).toEqual([
      ['db', 'ready'],
      ['api', 'ready'],
      ['web', 'running'],
    ])
    expect(h.supervisor.state(SCOPE).active).toBe(true)
  })

  it('spawns each step in its checkout, titled, linked to its scope, owned by the conversation', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.created[0]).toMatchObject({
      rootId: ROOT,
      cwd: '/repos/.shop-threads/blue',
      title: 'Database',
      owner: { rootPath: ROOT, threadId: 't1' },
      run: { scopeKey: runScopeKey(SCOPE), stepId: 'db', projectRoot: ROOT },
    })
  })

  it('a ready check that times out keeps later steps from starting, and says why', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    h.ready.last('port:5432').settle('timed-out')
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db'])
    const steps = h.supervisor.state(SCOPE).steps
    expect(steps[0]).toMatchObject({ status: 'timed-out', detail: 'Port 5432 did not answer within 60 seconds.' })
    expect(steps[1]).toMatchObject({ status: 'idle', detail: 'Not started, because “Database” is not ready.' })
    expect(steps[2]).toMatchObject({ status: 'idle', detail: 'Not started, because “API” is not ready.' })
  })

  it('a step that starts right away does not wait for the one above', async () => {
    const h = harness({
      version: 1,
      steps: [
        { id: 'db', name: 'Database', command: 'db', start: 'now', ready: { kind: 'port', port: 5432 } },
        { id: 'css', name: 'CSS', command: 'tailwind -w', start: 'now' },
      ],
    })
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['db', 'tailwind -w'])
  })

  it('a port already in use blocks the step with a reason; Reload on it starts it anyway', async () => {
    const h = harness()
    h.ready.busy.add(5432)
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.created).toHaveLength(0)
    expect(h.supervisor.state(SCOPE).steps[0]).toMatchObject({
      status: 'blocked',
      detail: 'Port 5432 is already in use, so this step was not started. Reload starts it anyway.',
    })
    expect(h.statusOf()[1]).toEqual(['api', 'idle'])

    await h.supervisor.reload(SCOPE, `${ROOT}::db`)
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db'])
    expect(h.statusOf()[0]).toEqual(['db', 'waiting'])
  })

  it('names another Flow Run that holds the port', async () => {
    const h = harness()
    const other: RunScope = { rootPath: ROOT, threadId: 't2' }
    await h.supervisor.start(other)
    await flush()
    h.ready.busy.add(5432)
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.supervisor.state(SCOPE).steps[0]?.detail).toBe(
      'Port 5432 is already in use by a Run in another conversation, so this step was not started. Reload starts it anyway.',
    )
  })

  it('Run on a scope already going is left alone', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.created).toHaveLength(1)
    expect(h.store.resolves).toBe(1)
  })
})

describe('RunSupervisor — exits, reload, stop', () => {
  async function allRunning(h: ReturnType<typeof harness>): Promise<void> {
    await h.supervisor.start(SCOPE)
    await flush()
    h.ready.last('port:5432').settle('ready')
    await flush()
    h.ready.last('line:term-2:listening').settle('ready')
    await flush()
  }

  it('a step whose process ends reads exited with its code', async () => {
    const h = harness()
    await allRunning(h)
    h.terminals.exit('term-3', 1)
    await flush()
    expect(h.supervisor.state(SCOPE).steps[2]).toMatchObject({ status: 'exited', exitCode: 1, detail: 'Ended with code 1.', terminalId: 'term-3' })
  })

  it('an exit while waiting cancels the wait', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    h.terminals.exit('term-1', 2)
    await flush()
    expect(h.ready.last('port:5432').cancelled).toBe(true)
    expect(h.statusOf()).toEqual([
      ['db', 'exited'],
      ['api', 'idle'],
      ['web', 'idle'],
    ])
  })

  it('Reload one restarts only that step: its old tab goes, its port is let go first', async () => {
    const h = harness()
    await allRunning(h)
    await h.supervisor.reload(SCOPE, `${ROOT}::db`)
    await flush()
    expect(h.terminals.disposed).toEqual(['term-1'])
    expect(h.ready.freed).toEqual([5432])
    expect(h.terminals.commands()).toEqual(['docker compose up db', 'npm run api', 'npm run dev', 'docker compose up db'])
    expect(h.statusOf()).toEqual([
      ['db', 'waiting'],
      ['api', 'ready'],
      ['web', 'running'],
    ])
  })

  it('Reload all stops every step and starts them again in order, from the saved setup', async () => {
    const h = harness()
    await allRunning(h)
    h.store.setup = { version: 1, steps: [THREE.steps[0]!, { ...THREE.steps[2]!, command: 'pnpm dev' }] }
    await h.supervisor.reload(SCOPE)
    await flush()
    expect(h.terminals.disposed.sort()).toEqual(['term-1', 'term-2', 'term-3'])
    expect(h.terminals.commands().slice(3)).toEqual(['docker compose up db'])
    h.ready.last('port:5432').settle('ready')
    await flush()
    expect(h.terminals.commands().slice(3)).toEqual(['docker compose up db', 'pnpm dev'])
  })

  it('Stop all ends every process (the tabs stay), and stops a sequence still waiting', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    const stopped = await h.supervisor.stop(SCOPE)
    expect(h.terminals.stopped).toEqual(['term-1'])
    expect(h.terminals.disposed).toEqual([])
    expect(stopped.active).toBe(false)
    expect(h.ready.last('port:5432').cancelled).toBe(true)
    expect(stopped.steps.map((s) => s.status)).toEqual(['stopped', 'idle', 'idle'])
    // The exit that follows a Stop is a stop, not a failure.
    h.terminals.exit('term-1', 143)
    await flush()
    expect(h.supervisor.state(SCOPE).steps[0]).toMatchObject({ status: 'stopped', exitCode: 143 })
    // Nothing more starts afterwards.
    await flush()
    expect(h.terminals.created).toHaveLength(1)
    expect(h.supervisor.states()).toEqual([])
  })

  it('Run after Stop removes the stopped tabs and starts fresh', async () => {
    const h = harness()
    await allRunning(h)
    await h.supervisor.stop(SCOPE)
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.disposed.sort()).toEqual(['term-1', 'term-2', 'term-3'])
    expect(h.terminals.commands()).toHaveLength(4)
  })

  it('a tab the person closes reads stopped', async () => {
    const h = harness()
    await allRunning(h)
    h.terminals.closeByUser('term-3')
    await flush()
    expect(h.supervisor.state(SCOPE).steps[2]).toMatchObject({ status: 'stopped', terminalId: null })
  })
})

describe('RunSupervisor — apply a saved setup', () => {
  it('starts new steps, restarts changed ones, stops removed ones, keeps the rest', async () => {
    const h = harness({
      version: 1,
      steps: [
        { id: 'db', name: 'Database', command: 'db', start: 'now' },
        { id: 'api', name: 'API', command: 'api', start: 'now' },
        { id: 'old', name: 'Old', command: 'old', start: 'now' },
      ],
    })
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['db', 'api', 'old'])
    h.store.setup = {
      version: 1,
      steps: [
        { id: 'db', name: 'Database', command: 'db', start: 'now' },
        { id: 'api', name: 'API', command: 'api --port 4000', start: 'now' },
        { id: 'web', name: 'Web', command: 'web', start: 'after-previous' },
      ],
    }
    const state = await h.supervisor.apply(SCOPE)
    await flush()
    expect(h.terminals.disposed.sort()).toEqual(['term-2', 'term-3'])
    expect(h.terminals.commands().slice(3)).toEqual(['api --port 4000', 'web'])
    expect(state.steps.map((s) => s.key.split('::')[1])).toEqual(['db', 'api', 'web'])
    expect(h.supervisor.state(SCOPE).steps.map((s) => [s.status, s.terminalId])).toEqual([
      ['running', 'term-1'],
      ['running', 'term-4'],
      ['running', 'term-5'],
    ])
  })

  it('a scope with no Run going only takes the new step list; nothing starts', async () => {
    const h = harness()
    const state = await h.supervisor.apply(SCOPE)
    await flush()
    expect(h.terminals.created).toHaveLength(0)
    expect(state).toMatchObject({ active: false })
    expect(state.steps.map((s) => s.status)).toEqual(['idle', 'idle', 'idle'])
  })
})

describe('RunSupervisor — reporting and quit', () => {
  it('reports only transitions, coalesced per tick, and never repeats an identical state', async () => {
    const h = harness({ version: 1, steps: [{ id: 'web', name: 'Web', command: 'web', start: 'now' }] })
    await h.supervisor.start(SCOPE)
    await flush()
    const after = h.updates.length
    expect(h.updates.at(-1)?.steps[0]?.status).toBe('running')
    await h.supervisor.start(SCOPE) // already going: no-op, no report
    await flush()
    expect(h.updates.length).toBe(after)
  })

  it('states() lists the scopes that have a Run going', async () => {
    const h = harness({ version: 1, steps: [{ id: 'web', name: 'Web', command: 'web', start: 'now' }] })
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.supervisor.states()).toEqual([{ scopeKey: runScopeKey(SCOPE), rootPath: ROOT, threadId: 't1', running: 1 }])
  })

  it('disposeAll removes every Run terminal, cancels waits and stops listening', async () => {
    const h = harness()
    await h.supervisor.start(SCOPE)
    await flush()
    h.supervisor.disposeAll()
    expect(h.terminals.disposed).toEqual(['term-1'])
    expect(h.ready.last('port:5432').cancelled).toBe(true)
    expect(h.terminals.listenerCount()).toBe(0)
    expect(h.supervisor.state(SCOPE).steps).toEqual([])
  })
})
