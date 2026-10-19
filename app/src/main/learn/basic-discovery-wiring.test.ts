// BASIC DISCOVERY, WIRED THE WAY THE APP WIRES IT — the REAL coordinator
// (createBasicDiscovery) over the REAL LearnOrchestrator, with the real
// learning-state store and the real completion record on temp folders. Only
// the agent pass, the CLI and the project graph are fakes.
//
// Why a wiring suite: each half had its own green tests while, live
// (2026-10-06), a sweep's modules all finished and the sweep never reported
// done — no record written, the chip on "Learning…" for good, and the queue
// (one sweep at a time) never reaching the next project. The cause lives in
// the seam between the two halves, which neither suite exercised.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BlueprintGraph, BlueprintLearningEntry, BlueprintNode, FlowNotification } from '../../shared/ipc-contract'
import type { LearnPassParams, LearnPassResult } from '../agent/learn-session'
import { LearnOrchestrator, BASIC_DISCOVERY_STALL_MS, type LearnProjectState } from '../project/learn-orchestrator'
import { LEARNING_STATE_FILE, readLearningState } from '../project/learning-state'
import {
  BASIC_DISCOVERY_FILE,
  createBasicDiscovery,
  ensureBasicDiscoveryRecord,
  recordBasicDiscovery,
  type BasicDiscovery,
  type BasicDiscoverySettled,
  type BasicDiscoveryStatus,
} from './basic-discovery'

// ── fixtures ────────────────────────────────────────────────────────────────

function moduleNode(sourceFile: string): BlueprintNode {
  return { id: `module:${sourceFile}`, kind: 'module', label: sourceFile, sourceFile, meta: { depth: 1 } }
}

function graphOf(modules: readonly string[]): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-10-06T00:00:00.000Z',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes: modules.map(moduleNode),
    edges: [],
  }
}

const structureOf = (root: string): string => join(root, 'flow', 'brain', '.structure')

type PassBehaviour = 'ok' | 'fail' | 'hang'

interface Rig {
  orchestrator: LearnOrchestrator
  discovery: BasicDiscovery
  roots: Record<string, string>
  passes: string[]
  derives: string[]
  notifications: FlowNotification[]
  changes: Array<{ root: string; status: BasicDiscoveryStatus }>
  logs: string[]
  setReady: (root: string, ready: boolean) => void
  advance: (ms: number) => void
  dispose: () => void
}

let made: string[] = []

afterEach(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  made = []
})

function makeRig(options: {
  /** Project name → its depth-1 modules. */
  projects: Record<string, string[]>
  /** How a pass on `<project>/<module>` ends. Default ok. */
  pass?: (project: string, modulePath: string) => PassBehaviour
  /** Seed learning-state per project. */
  learning?: Record<string, BlueprintLearningEntry[]>
  budget?: number
  /** Projects with NO derived graph on disk, and whether deriving one works. */
  underived?: Record<string, 'derives' | 'fails'>
}): Rig {
  const base = mkdtempSync(join(tmpdir(), 'flow-bd-wiring-'))
  made.push(base)
  const roots: Record<string, string> = {}
  const nameOf = new Map<string, string>()
  for (const name of Object.keys(options.projects)) {
    const root = join(base, name)
    mkdirSync(structureOf(root), { recursive: true })
    roots[name] = root
    nameOf.set(root, name)
    const seed = options.learning?.[name]
    if (seed !== undefined) {
      writeFileSync(join(structureOf(root), LEARNING_STATE_FILE), seed.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    }
  }
  const ready = new Map<string, boolean>(Object.values(roots).map((root) => [root, true]))
  let clock = Date.parse('2026-10-06T14:00:00.000Z')
  const passes: string[] = []
  const notifications: FlowNotification[] = []
  const changes: Array<{ root: string; status: BasicDiscoveryStatus }> = []
  const logs: string[] = []
  const derived = new Set<string>()
  const derives: string[] = []

  const runPass = (params: LearnPassParams): Promise<LearnPassResult> => {
    const project = nameOf.get(params.rootPath) ?? '?'
    passes.push(`${project}/${params.modulePath}`)
    const behaviour = options.pass?.(project, params.modulePath) ?? 'ok'
    if (behaviour === 'ok') return Promise.resolve({ ok: true, docPath: 'doc.md', noteFingerprint: 'fp' })
    if (behaviour === 'fail') return Promise.resolve({ ok: false, reason: 'boom' })
    return new Promise((resolve) => {
      params.abortSignal?.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))
    })
  }

  const orchestrator = new LearnOrchestrator({
    readProjectState: async (rootPath): Promise<LearnProjectState> => {
      const name = nameOf.get(rootPath) ?? ''
      return {
        graph: graphOf(options.projects[name] ?? []),
        learning: await readLearningState(structureOf(rootPath)),
        investigations: undefined,
        graphDerived: options.underived?.[name] === undefined || derived.has(name),
      }
    },
    deriveGraph: (rootPath) => {
      const name = nameOf.get(rootPath) ?? ''
      derives.push(name)
      if (options.underived?.[name] === 'derives') derived.add(name)
      return Promise.resolve(derived.has(name))
    },
    isRootReady: (rootPath) => ready.get(rootPath) === true,
    bundledCli: { execPath: '/electron', cliPath: '/planflow-ai.mjs' },
    notify: (notification) => notifications.push(notification),
    runPass,
    runCli: () => Promise.resolve({ ok: true, stdout: '{"notes":[]}' }),
    enumerateModuleFiles: (_root, modulePath) => Promise.resolve([{ path: `${modulePath}/index.ts`, size: 100 }]),
    now: () => new Date(clock),
    budget: options.budget ?? 10,
    onError: () => undefined,
  })

  const discovery = createBasicDiscovery({
    hasRecord: (rootPath) => ensureBasicDiscoveryRecord(structureOf(rootPath), () => new Date(clock)),
    record: (rootPath, outcome) =>
      recordBasicDiscovery(structureOf(rootPath), {
        completedAt: new Date(clock).toISOString(),
        learned: outcome.learned,
        failed: outcome.failed,
      }),
    // Exactly the app's wiring: an automatic sweep is quiet.
    run: (rootPath, runOptions) => orchestrator.runBasicDiscovery(rootPath, { ...runOptions, announce: false }),
    isReady: (rootPath) => ready.get(rootPath) === true,
    inWorkspace: () => Promise.resolve(true),
    automatic: () => true,
    onChange: (root, status) => changes.push({ root, status }),
    log: (message) => logs.push(message),
  })

  return {
    orchestrator,
    discovery,
    roots,
    passes,
    derives,
    notifications,
    changes,
    logs,
    setReady: (root, value) => ready.set(root, value),
    advance: (ms) => {
      clock += ms
    },
    dispose: () => orchestrator.dispose(),
  }
}

/** Poll until `predicate` holds (real fs underneath: microtask flushes are not enough). */
async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

/** Settle within `ms`, or answer 'pending'. */
async function settledWithin(promise: Promise<BasicDiscoverySettled>, ms = 1500): Promise<BasicDiscoverySettled | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const hasRecordFile = (root: string): boolean => existsSync(join(structureOf(root), BASIC_DISCOVERY_FILE))

// ── the suite ───────────────────────────────────────────────────────────────

describe('basic discovery, coordinator + orchestrator wired as in the app', () => {
  it('(a) a clean sweep records itself, reads done, and the next project starts — quietly', async () => {
    const rig = makeRig({ projects: { alpha: ['a1', 'a2'], beta: ['b1'] } })
    await rig.discovery.reconcile([rig.roots.alpha as string, rig.roots.beta as string])
    await expect(settledWithin(rig.discovery.whenSettled(rig.roots.alpha as string))).resolves.toEqual({ ok: true })
    await expect(settledWithin(rig.discovery.whenSettled(rig.roots.beta as string))).resolves.toEqual({ ok: true })
    expect(hasRecordFile(rig.roots.alpha as string)).toBe(true)
    expect(hasRecordFile(rig.roots.beta as string)).toBe(true)
    expect(rig.discovery.status(rig.roots.alpha as string)).toBe('done')
    expect(rig.discovery.status(rig.roots.beta as string)).toBe('done')
    // `announce:false` reaches the orchestrator: no started / finished toasts.
    expect(rig.notifications.map((n) => n.title)).toEqual([])
    // One line per sweep start and end, naming the project, never a path.
    expect(rig.logs.filter((line) => line.startsWith('sweep '))).toEqual([
      'sweep started for alpha',
      'sweep ended for alpha: done (2 learned, 0 failed)',
      'sweep started for beta',
      'sweep ended for beta: done (1 learned, 0 failed)',
    ])
    rig.dispose()
  })

  it('(b) a relaunch that resumes persisted queued entries still settles and records', async () => {
    const queued = (module: string): BlueprintLearningEntry => ({
      module,
      status: 'queued',
      notedAt: '2026-10-06T13:00:00.000Z',
      reason: 'basic-discovery',
      deliberate: true,
    })
    const rig = makeRig({ projects: { alpha: ['a1', 'a2', 'a3'] }, learning: { alpha: [queued('a1'), queued('a2'), queued('a3')] } })
    const root = rig.roots.alpha as string
    // Launch order in index.ts: resume first, then the coordinator's re-check.
    void rig.orchestrator.resumeInterrupted(root)
    await rig.discovery.reconcile([root])
    await expect(settledWithin(rig.discovery.whenSettled(root))).resolves.toEqual({ ok: true })
    expect(hasRecordFile(root)).toBe(true)
    rig.dispose()
  })

  it('(c) a module already queued by an automatic re-learn, then dropped for budget, still ends the sweep', async () => {
    const rig = makeRig({ projects: { alpha: ['a1', 'a2'] }, budget: 0 })
    const root = rig.roots.alpha as string
    // A person's agent turn is live: learning stands aside, so the automatic
    // job stays queued while the sweep joins it.
    rig.orchestrator.setYielding(true)
    rig.orchestrator.enqueueModule(root, 'a1', { reason: 'stale', deliberate: false })
    await rig.discovery.reconcile([root])
    await waitFor(() => rig.discovery.status(root) === 'running')
    await new Promise((resolve) => setTimeout(resolve, 50))
    rig.orchestrator.setYielding(false)
    const answer = await settledWithin(rig.discovery.whenSettled(root))
    expect(answer).not.toBe('pending')
    expect(rig.discovery.status(root)).toBe('done')
    expect(rig.passes).toEqual(['alpha/a1', 'alpha/a2'])
    rig.dispose()
  })

  it('(d) LIVE 2026-10-06: a sweep that starts after learning paused itself ends as a failure instead of waiting forever', async () => {
    // core fails every module → three in a row pause the learner → core's
    // sweep fails → the coordinator starts argo's sweep into a paused queue.
    const rig = makeRig({
      projects: { core: ['c1', 'c2', 'c3', 'c4'], argo: ['g1', 'g2'] },
      pass: (project) => (project === 'core' ? 'fail' : 'ok'),
    })
    const core = rig.roots.core as string
    const argo = rig.roots.argo as string
    await rig.discovery.reconcile([core, argo])
    await expect(settledWithin(rig.discovery.whenSettled(core))).resolves.toMatchObject({ ok: false })
    expect(rig.orchestrator.isPaused()).toBe(true)
    // The bug: argo's sweep waited on a drain nobody would restart, "Learning…" for good.
    const argoAnswer = await settledWithin(rig.discovery.whenSettled(argo))
    expect(argoAnswer).toMatchObject({ ok: false })
    expect(rig.discovery.status(argo)).toBe('failed')
    // A plain sentence, no path or setting.
    expect(rig.discovery.failure(argo)).toMatch(/paused/i)
    expect(rig.discovery.failure(argo)).not.toMatch(/\//)
    // Try again (a person) lifts the pause and argo is learned.
    await rig.discovery.require([argo], { priority: true, retry: true })
    await expect(settledWithin(rig.discovery.whenSettled(argo))).resolves.toEqual({ ok: true })
    expect(hasRecordFile(argo)).toBe(true)
    rig.dispose()
  })

  it('(e) a sweep that makes no progress for a long time fails with a plain reason instead of "Learning…" forever', async () => {
    const rig = makeRig({ projects: { alpha: ['a1'] }, pass: () => 'hang' })
    const root = rig.roots.alpha as string
    await rig.discovery.reconcile([root])
    await waitFor(() => rig.passes.length === 1)
    // Just under the limit: still running.
    rig.advance(BASIC_DISCOVERY_STALL_MS - 1000)
    rig.orchestrator.checkStalledDiscoveries()
    expect(await settledWithin(rig.discovery.whenSettled(root), 100)).toBe('pending')
    rig.advance(2000)
    rig.orchestrator.checkStalledDiscoveries()
    await expect(settledWithin(rig.discovery.whenSettled(root))).resolves.toMatchObject({ ok: false })
    expect(rig.discovery.status(root)).toBe('failed')
    expect(rig.discovery.failure(root)).toMatch(/stopped making progress/i)
    rig.dispose()
  })

  it('(e2) waiting behind a person\'s own agent turn is not a stall — up to a far longer limit', async () => {
    const rig = makeRig({ projects: { alpha: ['a1'] } })
    const root = rig.roots.alpha as string
    rig.orchestrator.setYielding(true)
    await rig.discovery.reconcile([root])
    await waitFor(() => rig.discovery.status(root) === 'running')
    await new Promise((resolve) => setTimeout(resolve, 50))
    rig.advance(BASIC_DISCOVERY_STALL_MS * 2)
    rig.orchestrator.checkStalledDiscoveries()
    expect(await settledWithin(rig.discovery.whenSettled(root), 100)).toBe('pending')
    rig.orchestrator.setYielding(false)
    await expect(settledWithin(rig.discovery.whenSettled(root))).resolves.toEqual({ ok: true })
    rig.dispose()
  })

  it('(f) self-heal: a project that already has learned modules counts as discovered and gets its record lazily', async () => {
    const learned = (module: string): BlueprintLearningEntry => ({ module, status: 'learned', notedAt: '2026-10-06T14:00:00.000Z' })
    const rig = makeRig({ projects: { argo: ['g1', 'g2'] }, learning: { argo: [learned('g1'), learned('g2')] } })
    const root = rig.roots.argo as string
    await rig.discovery.reconcile([root])
    expect(rig.discovery.status(root)).toBe('done')
    expect(rig.passes).toEqual([])
    const lines = readFileSync(join(structureOf(root), BASIC_DISCOVERY_FILE), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ learned: 2, failed: 0 })
    // A second check does not append another line.
    await rig.discovery.reconcile([root])
    await expect(ensureBasicDiscoveryRecord(structureOf(root))).resolves.toBe(true)
    expect(readFileSync(join(structureOf(root), BASIC_DISCOVERY_FILE), 'utf-8').trim().split('\n')).toHaveLength(1)
    rig.dispose()
  })

  it('(f2) a sweep whose remaining modules are all learned settles at once', async () => {
    const rig = makeRig({ projects: { argo: ['g1', 'g2'] } })
    const root = rig.roots.argo as string
    // Learned between the coordinator's check and the run (e.g. by a resumed queue).
    writeFileSync(
      join(structureOf(root), LEARNING_STATE_FILE),
      ['g1', 'g2'].map((module) => JSON.stringify({ module, status: 'learned', notedAt: '2026-10-06T14:00:00.000Z' })).join('\n') + '\n',
    )
    await expect(rig.orchestrator.runBasicDiscovery(root, { announce: false })).resolves.toEqual({ kind: 'done', learned: 0, failed: 0 })
    expect(rig.passes).toEqual([])
    rig.dispose()
  })

  it('(h) LIVE 2026-10-06: a project with no derived graph is derived first, and one that cannot be is a single plain failure — not an agent session per module', async () => {
    const rig = makeRig({ projects: { core: ['c1', 'c2'], storefront: ['m1'] }, underived: { core: 'fails', storefront: 'derives' } })
    const core = rig.roots.core as string
    const storefront = rig.roots.storefront as string
    await rig.discovery.reconcile([core, storefront])
    await expect(settledWithin(rig.discovery.whenSettled(core))).resolves.toMatchObject({ ok: false })
    expect(rig.discovery.failure(core)).toMatch(/structure/)
    await expect(settledWithin(rig.discovery.whenSettled(storefront))).resolves.toEqual({ ok: true })
    expect(rig.derives).toEqual(['core', 'storefront'])
    // No pass was spent on the project whose notes would all be refused.
    expect(rig.passes).toEqual(['storefront/m1'])
    expect(rig.orchestrator.isPaused()).toBe(false)
    rig.dispose()
  })

  it('(h2) a job resumed from an earlier session for an underived project derives once and never spends a pass or a toast', async () => {
    const queued = (module: string): BlueprintLearningEntry => ({
      module,
      status: 'queued',
      notedAt: '2026-10-06T13:00:00.000Z',
      reason: 'basic-discovery',
      deliberate: true,
    })
    const rig = makeRig({
      projects: { core: ['c1', 'c2', 'c3'] },
      underived: { core: 'fails' },
      learning: { core: [queued('c1'), queued('c2'), queued('c3')] },
    })
    const core = rig.roots.core as string
    await rig.orchestrator.resumeInterrupted(core)
    await waitFor(() => rig.orchestrator.status().queued === 0 && !rig.orchestrator.status().running)
    expect(rig.passes).toEqual([])
    expect(rig.notifications.filter((n) => n.title === 'Learning failed')).toEqual([])
    // Setup failures are not a run of failed passes: nothing paused for everyone else.
    expect(rig.orchestrator.isPaused()).toBe(false)
    rig.dispose()
  })

  it('(g) a project parked until setup finishes is picked up by the next check once it is ready, even if the ready signal was missed', async () => {
    const rig = makeRig({ projects: { alpha: ['a1'] } })
    const root = rig.roots.alpha as string
    rig.setReady(root, false)
    await rig.discovery.reconcile([root])
    expect(rig.discovery.status(root)).toBe('queued')
    rig.setReady(root, true)
    // No rootReady call — the next re-check notices on its own.
    await rig.discovery.reconcile([root])
    await expect(settledWithin(rig.discovery.whenSettled(root))).resolves.toEqual({ ok: true })
    rig.dispose()
  })
})
