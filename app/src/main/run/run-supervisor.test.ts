// RunSupervisor — fakes only: a recording terminal port (no PTY, no signal
// ever sent), a fake setup store, and ready checks the test settles by hand.

import type { TerminalInfo } from '../../shared/ipc-contract'
import {
  resolveOnceSteps,
  resolveRunSteps,
  runScopeKey,
  type RunGroupState,
  type RunPlace,
  type RunResolution,
  type RunScope,
  type RunSetup,
} from '../../shared/run-setup'
import type { ReadyOutcome, ReadyWait } from './ready-check'
import { RunSetupStore } from './run-setup-store'
import { RunOnceError, RunSupervisor, type RunReadyChecks, type RunSupervisorDeps, type RunTerminalPort } from './run-supervisor'
import { createRunScriptFiles } from './run-script-files'
import { mkdtempSync, promises as fsp, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function setupStore(initial: RunSetup): {
  resolve(scope: RunScope): Promise<RunResolution>
  setup: RunSetup
  resolves: number
  places: RunPlace[]
} {
  const holder = {
    setup: initial,
    resolves: 0,
    places: [] as RunPlace[],
    resolve: async (scope: RunScope): Promise<RunResolution> => {
      holder.resolves += 1
      const project = { root: ROOT, name: 'shop', cwd: '/repos/.shop-threads/blue', setup: holder.setup, personal: {}, conversation: {}, hasSharedSetup: true, problems: [] }
      return {
        scope,
        scopeKey: runScopeKey(scope),
        project,
        places: holder.places,
        steps: resolveRunSteps(project, holder.places),
        once: resolveOnceSteps(project, holder.places),
      }
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

/** Script files that are never written: a test that runs a script passes real ones over a temp folder. */
const NO_SCRIPTS: RunSupervisorDeps['scripts'] = {
  prepare: async () => {
    throw new Error('this test runs no script')
  },
  remove: async () => undefined,
}

function harness(setup: RunSetup = THREE, clock: { now: number } = { now: 0 }, scripts: RunSupervisorDeps['scripts'] = NO_SCRIPTS) {
  const terminals = new FakeTerminals()
  const ready = new FakeReady()
  const store = setupStore(setup)
  const supervisor = new RunSupervisor({ terminals, setups: store, ready, scripts, now: () => clock.now })
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

  it('runs a step in the project it names, in that project folder', async () => {
    const h = harness({
      version: 1,
      steps: [
        { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'core' },
        { id: 'app', name: 'app', command: 'npm run dev', start: 'after-previous' },
      ],
    })
    h.store.places = [{ name: 'core', root: '/repos/core', cwd: '/repos/core', from: 'workspace' }]
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.created[0]).toMatchObject({ rootId: '/repos/core', cwd: '/repos/core', run: { projectRoot: '/repos/core' } })
    expect(h.terminals.created[1]).toMatchObject({ rootId: ROOT, cwd: '/repos/.shop-threads/blue' })
  })

  it('a step whose project is not on this computer is blocked, later steps wait, and no Reload starts it', async () => {
    const h = harness({
      version: 1,
      steps: [
        { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'core' },
        { id: 'app', name: 'app', command: 'npm run dev', start: 'after-previous' },
      ],
    })
    // Before any Run, the idle state already says why.
    expect((await h.store.resolve(SCOPE)).steps[0]?.unavailable).toBe("core is not on this computer, so this step can't start.")
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.created).toHaveLength(0)
    expect(h.supervisor.state(SCOPE).steps[0]).toMatchObject({
      status: 'blocked',
      notHere: true,
      detail: "core is not on this computer, so this step can't start.",
    })
    expect(h.supervisor.state(SCOPE).steps[1]).toMatchObject({ status: 'idle', detail: 'Not started, because “temporal” is not ready.' })

    await h.supervisor.reload(SCOPE, `${ROOT}::temporal`, true)
    await flush()
    expect(h.terminals.created).toHaveLength(0)
    expect(h.statusOf()[0]).toEqual(['temporal', 'blocked'])
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
      'Port 5432 is already in use by a Launchpad in another conversation, so this step was not started. Reload starts it anyway.',
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

  it('Stop one ends only that step: the others keep running and nothing is disposed', async () => {
    const h = harness()
    await allRunning(h)
    expect(h.statusOf()).toEqual([
      ['db', 'ready'],
      ['api', 'ready'],
      ['web', 'running'],
    ])
    const state = await h.supervisor.stop(SCOPE, `${ROOT}::api`)
    expect(h.terminals.stopped).toEqual(['term-2'])
    expect(h.terminals.disposed).toEqual([])
    expect(state.steps.map((s) => s.status)).toEqual(['ready', 'stopped', 'running'])
    expect(state.active).toBe(true)
    // Its exit is a stop, not a failure.
    h.terminals.exit('term-2', 143)
    await flush()
    expect(h.supervisor.state(SCOPE).steps[1]).toMatchObject({ status: 'stopped', exitCode: 143 })
    // Restart brings it back on its own.
    await h.supervisor.reload(SCOPE, `${ROOT}::api`)
    await flush()
    expect(h.terminals.commands()).toEqual(['docker compose up db', 'npm run api', 'npm run dev', 'npm run api'])
  })

  it('Stop one with a step the Run does not have changes nothing', async () => {
    const h = harness()
    await allRunning(h)
    await h.supervisor.stop(SCOPE, `${ROOT}::nope`)
    expect(h.terminals.stopped).toEqual([])
    expect(h.statusOf().map(([, status]) => status)).toEqual(['ready', 'ready', 'running'])
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

describe('RunSupervisor — apply with steps combined across projects', () => {
  it('keys steps by the project they are stored with, so a save keeps, restarts, starts and stops by those keys', async () => {
    const A = '/repos/a'
    const B = '/repos/b'
    const setups = new Map<string, string>()
    let order: string[] = []
    const store = new RunSetupStore({
      threads: {
        getThread: () => ({ projectRoot: A, worktreePath: null }),
        getThreadRoots: () => [B],
        getThreadRootWorktrees: () => [],
      },
      personal: {
        getRunSetup: (root) => setups.get(root) ?? null,
        setRunSetup: (root, text) => {
          if (text === null) setups.delete(root)
          else setups.set(root, text)
        },
        listRunSetupRoots: () => [...setups.keys()],
        getRunOrder: () => [...order],
        setRunOrder: (refs) => {
          order = [...refs]
        },
      },
    })
    const scope: RunScope = { rootPath: A, threadId: 't1' }
    await store.save(scope, {
      layer: 'shared',
      steps: [
        { id: 'db', name: 'db', command: 'db', start: 'now', runsIn: 'b' },
        { id: 'web', name: 'web', command: 'web', start: 'now' },
        { id: 'old', name: 'old', command: 'old', start: 'now', runsIn: 'b' },
      ],
    })
    const terminals = new FakeTerminals()
    const supervisor = new RunSupervisor({ terminals, setups: store, ready: new FakeReady(), scripts: NO_SCRIPTS })
    await supervisor.start(scope)
    await flush()
    expect(supervisor.state(scope).steps.map((s) => s.key)).toEqual([`${B}::db`, `${A}::web`, `${B}::old`])
    expect(terminals.created.map((c) => [c.command, c.cwd])).toEqual([
      ['db', B],
      ['web', A],
      ['old', B],
    ])

    // The panel sends the combined list back: db kept, web changed, old removed, a new step.
    const combined = (await store.resolve(scope)).project.setup!.steps
    await store.save(scope, {
      layer: 'shared',
      steps: [
        combined[0]!,
        { ...combined[1]!, command: 'web --port 4000' },
        { id: 'jobs', name: 'jobs', command: 'jobs', start: 'now', runsIn: 'b' },
      ],
    })
    const state = await supervisor.apply(scope)
    await flush()
    expect(state.steps.map((s) => s.key)).toEqual([`${B}::db`, `${A}::web`, `${B}::jobs`])
    expect(terminals.disposed.sort()).toEqual(['term-2', 'term-3'])
    expect(terminals.commands().slice(3)).toEqual(['web --port 4000', 'jobs'])
    expect(supervisor.state(scope).steps.map((s) => s.terminalId)).toEqual(['term-1', 'term-4', 'term-5'])
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

describe('RunSupervisor — one-time actions', () => {
  const MIXED: RunSetup = {
    version: 1,
    steps: [
      { id: 'web', name: 'Web', command: 'npm run dev', start: 'now' },
      { id: 'migrate', name: 'Migrate', command: 'uv run alembic upgrade head', start: 'now', kind: 'once', confirm: true },
      { id: 'gen', name: 'Codegen', command: 'npm run codegen', start: 'now', kind: 'once' },
    ],
  }
  const MIGRATE = `${ROOT}::migrate`

  it('Run, Reload all and a save never start a one-time action', async () => {
    const h = harness(MIXED)
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['npm run dev'])
    await h.supervisor.reload(SCOPE)
    await flush()
    await h.supervisor.apply(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['npm run dev', 'npm run dev'])
    expect(h.supervisor.state(SCOPE).steps.map((step) => step.key)).toEqual([`${ROOT}::web`])
    expect(h.supervisor.state(SCOPE).once).toBeUndefined()
  })

  it('adding a one-time action while Run is going only lists it — nothing starts until it is pressed', async () => {
    const h = harness({ version: 1, steps: [MIXED.steps[0]!] })
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['npm run dev'])
    h.store.setup = MIXED // the Save that added Migrate and Codegen
    await h.supervisor.apply(SCOPE)
    await flush()
    expect(h.terminals.commands()).toEqual(['npm run dev'])
    expect((await h.store.resolve(SCOPE)).once?.map((step) => step.key)).toEqual([MIGRATE, `${ROOT}::gen`])
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    await flush()
    expect(h.terminals.commands()).toEqual(['npm run dev', 'uv run alembic upgrade head'])
  })

  it('runs one once, in its own tab, in the conversation checkout, and counts nothing as a running step', async () => {
    const h = harness(MIXED, { now: 1_000 })
    const state = await h.supervisor.runOnce(SCOPE, MIGRATE)
    expect(h.terminals.created).toHaveLength(1)
    expect(h.terminals.created[0]).toMatchObject({
      command: 'uv run alembic upgrade head',
      cwd: '/repos/.shop-threads/blue',
      title: 'Migrate',
      owner: { rootPath: ROOT, threadId: 't1' },
      run: { scopeKey: runScopeKey(SCOPE), stepId: 'migrate', projectRoot: ROOT },
    })
    expect(state.active).toBe(false)
    expect(state.steps.every((step) => step.status === 'idle')).toBe(true)
    expect(state.once).toEqual([
      { key: MIGRATE, name: 'Migrate', projectRoot: ROOT, projectName: 'shop', status: 'running', terminalId: 'term-1', exitCode: null, durationMs: null },
    ])
    expect(h.supervisor.states()).toEqual([])
  })

  it('a second press while it runs starts nothing; two quick presses start one copy', async () => {
    const h = harness(MIXED)
    await Promise.all([h.supervisor.runOnce(SCOPE, MIGRATE), h.supervisor.runOnce(SCOPE, MIGRATE)])
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    expect(h.terminals.created).toHaveLength(1)
    expect(h.terminals.disposed).toEqual([])
  })

  it('reads finished with how long it took, or ended with its code; the tab stays', async () => {
    const clock = { now: 10_000 }
    const h = harness(MIXED, clock)
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::gen`)
    clock.now = 12_400
    h.terminals.exit('term-1', 0)
    h.terminals.exit('term-2', 3)
    await flush()
    expect(h.supervisor.state(SCOPE).once).toEqual([
      expect.objectContaining({ key: MIGRATE, status: 'exited', exitCode: 0, durationMs: 2_400, terminalId: 'term-1' }),
      expect.objectContaining({ key: `${ROOT}::gen`, status: 'exited', exitCode: 3, durationMs: 2_400, terminalId: 'term-2' }),
    ])
    expect(h.terminals.disposed).toEqual([])
    expect(h.updates.at(-1)?.once?.map((once) => once.status)).toEqual(['exited', 'exited'])
  })

  it('pressing it after it ended runs it again in a fresh tab that replaces the old one', async () => {
    const h = harness(MIXED)
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    h.terminals.exit('term-1', 1)
    const again = await h.supervisor.runOnce(SCOPE, MIGRATE)
    expect(h.terminals.disposed).toEqual(['term-1'])
    expect(again.once).toEqual([expect.objectContaining({ key: MIGRATE, status: 'running', terminalId: 'term-2', exitCode: null })])
  })

  it('closing its tab removes it; Stop all leaves a running action alone', async () => {
    const h = harness(MIXED)
    await h.supervisor.start(SCOPE)
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    await flush()
    await h.supervisor.stop(SCOPE)
    expect(h.terminals.stopped).toEqual(['term-1'])
    expect(h.supervisor.state(SCOPE).once?.[0]).toMatchObject({ status: 'running', terminalId: 'term-2' })
    h.terminals.closeByUser('term-2')
    await flush()
    expect(h.supervisor.state(SCOPE).once).toBeUndefined()
    expect(h.updates.at(-1)?.once).toBeUndefined()
  })

  it('a Run after a one-time action keeps its tab; quitting removes it', async () => {
    const h = harness(MIXED)
    await h.supervisor.runOnce(SCOPE, MIGRATE)
    await h.supervisor.start(SCOPE)
    await flush()
    expect(h.terminals.disposed).toEqual([])
    expect(h.supervisor.state(SCOPE).once?.[0]?.terminalId).toBe('term-1')
    h.supervisor.disposeAll()
    expect(h.terminals.disposed.sort()).toEqual(['term-1', 'term-2'])
  })

  it('refuses a key that is not a one-time action, or whose project is not here — nothing starts', async () => {
    const h = harness(MIXED)
    await expect(h.supervisor.runOnce(SCOPE, `${ROOT}::web`)).rejects.toBeInstanceOf(RunOnceError)
    await expect(h.supervisor.runOnce(SCOPE, `${ROOT}::nope`)).rejects.toBeInstanceOf(RunOnceError)
    const away = harness({ version: 1, steps: [{ id: 'm', name: 'm', command: 'make migrate', start: 'now', kind: 'once', runsIn: 'elsewhere' }] })
    await expect(away.supervisor.runOnce(SCOPE, `${ROOT}::m`)).rejects.toThrow('elsewhere is not on this computer')
    expect(h.terminals.created).toEqual([])
    expect(away.terminals.created).toEqual([])
  })
})

describe('RunSupervisor — one-time actions that hold a script', () => {
  const SCRIPT = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'until docker compose exec -T postgres pg_isready >/dev/null 2>&1; do',
    '  sleep 1',
    'done',
    'echo "done for $USER" \'it\'s fine\'',
  ].join('\n')
  const SETUP: RunSetup = {
    version: 1,
    steps: [
      { id: 'reset', name: 'Reset database', command: SCRIPT, start: 'now', kind: 'once', body: 'script' },
      { id: 'plain', name: 'Codegen', command: 'npm run codegen', start: 'now', kind: 'once' },
      { id: 'nobang', name: 'Loop', command: 'for i in 1 2; do\n  echo $i\ndone', start: 'now', kind: 'once', body: 'script' },
    ],
  }
  let dir: string
  let removed: Array<Promise<void>>
  let scripts: RunSupervisorDeps['scripts']

  beforeEach(() => {
    // A folder with a quote and a space in its name: the command must quote the path.
    const parent = mkdtempSync(join(tmpdir(), 'flow-run-scripts-'))
    dir = join(parent, "it's private")
    removed = []
    const files = createRunScriptFiles({ dir, platform: 'darwin' })
    scripts = {
      prepare: (script) => files.prepare(script),
      remove: (file) => {
        const done = files.remove(file)
        removed.push(done)
        return done
      },
    }
  })
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  function onlyFile(): string {
    const command = harnessLastCommand
    const match = /'((?:[^']|'\\'')*)'$/.exec(command)
    if (match === null) throw new Error(`no quoted path in ${command}`)
    return match[1]!.replace(/'\\''/g, "'")
  }
  let harnessLastCommand = ''

  it('writes the script to one private file and runs that file — the file itself when it names its program', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)
    expect(h.terminals.created).toHaveLength(1)
    harnessLastCommand = h.terminals.created[0]!.command ?? ''
    const file = onlyFile()
    expect(file.startsWith(dir)).toBe(true)
    // Single-quoted, the quote in the folder name escaped for the shell.
    expect(harnessLastCommand).toBe(`'${file.replace(/'/g, `'\\''`)}'`)
    expect(await fsp.readFile(file, 'utf8')).toBe(`${SCRIPT}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o700)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(h.terminals.created[0]).toMatchObject({ cwd: '/repos/.shop-threads/blue', title: 'Reset database' })
  })

  it('runs a script without a first-line program through bash', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::nobang`)
    harnessLastCommand = h.terminals.created[0]!.command ?? ''
    expect(harnessLastCommand.startsWith("bash '")).toBe(true)
    expect(await fsp.readFile(onlyFile(), 'utf8')).toBe('for i in 1 2; do\n  echo $i\ndone\n')
  })

  it('removes the file when the run exits', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)
    harnessLastCommand = h.terminals.created[0]!.command ?? ''
    const file = onlyFile()
    expect(existsSync(file)).toBe(true)
    h.terminals.exit('term-1', 0)
    await Promise.all(removed)
    expect(removed).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
  })

  it('removes the file when the run is stopped (its process ends) or its tab is closed', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)
    harnessLastCommand = h.terminals.created[0]!.command ?? ''
    const first = onlyFile()
    // Stopped: the terminal ends the process, which reports its exit.
    h.terminals.stopProcess('term-1')
    h.terminals.exit('term-1', 130)
    await Promise.all(removed)
    expect(existsSync(first)).toBe(false)

    await h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)
    harnessLastCommand = h.terminals.created[1]!.command ?? ''
    const second = onlyFile()
    expect(second).not.toBe(first)
    expect(existsSync(second)).toBe(true)
    h.terminals.closeByUser('term-2')
    await Promise.all(removed)
    expect(existsSync(second)).toBe(false)
    // Each file removed once.
    expect(removed).toHaveLength(2)
  })

  it('leaves a plain command exactly as before — no file', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await h.supervisor.runOnce(SCOPE, `${ROOT}::plain`)
    expect(h.terminals.commands()).toEqual(['npm run codegen'])
    expect(existsSync(dir)).toBe(false)
  })

  it('two quick presses of a script write one file and open one tab', async () => {
    const h = harness(SETUP, { now: 0 }, scripts)
    await Promise.all([h.supervisor.runOnce(SCOPE, `${ROOT}::reset`), h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)])
    expect(h.terminals.created).toHaveLength(1)
    expect((await fsp.readdir(dir)).length).toBe(1)
  })

  it('a script that cannot be written is refused with a sentence and opens no tab', async () => {
    const h = harness(SETUP, { now: 0 }, NO_SCRIPTS)
    await expect(h.supervisor.runOnce(SCOPE, `${ROOT}::reset`)).rejects.toThrow('could not get this script ready')
    expect(h.terminals.created).toEqual([])
  })
})
