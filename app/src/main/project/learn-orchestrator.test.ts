// Tests for the learn orchestrator (progressive-learning #513 phase 6).
//
// The PURE decision core is tested directly (folds over plain values). The
// orchestrator CLASS is tested against fully injected fakes — no fs, no SDK, no
// CLI — asserting the learning-state transitions, dedupe, budget drops,
// supersede resolution, readiness gating, and abort behavior.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  BlueprintGraph,
  BlueprintInvestigation,
  BlueprintLearningEntry,
  BlueprintNode,
  FlowNotification,
} from '../../shared/ipc-contract'
import type { BundledCli } from '../blueprint/derive-runner'
import type { LearnPassParams, LearnPassResult, ModuleFile } from '../agent/learn-session'
import {
  LearnOrchestrator,
  defaultEnumerateModuleEntries,
  LARGE_PAYLOAD_BYTES,
  abortRootJobs,
  claimQueuedJobs,
  completeActive,
  enqueueJob,
  filterUnlearned,
  parseConfirmedCount,
  initialQueueState,
  jobKey,
  pickLearnModel,
  reconcileNoteless,
  resolveSupersede,
  selectAllModulePaths,
  selectDepthOneModules,
  selectOnboardingModules,
  takeNext,
  totalPayloadBytes,
  type LearnJob,
  type LearnOrchestratorDeps,
  type LearnProjectState,
} from './learn-orchestrator'
import { makeLearningStateFake } from './learning-state-fake'

// ── helpers ────────────────────────────────────────────────────────────────

const BUNDLED_CLI: BundledCli = { execPath: '/electron', cliPath: '/planflow-ai.mjs' }

function job(overrides: Partial<LearnJob> = {}): LearnJob {
  return {
    rootPath: '/repo',
    modulePath: 'src/a',
    reason: 'test',
    deliberate: false,
    ...overrides,
  }
}

function moduleNode(sourceFile: string, depth: number | undefined): BlueprintNode {
  return {
    id: `module:${sourceFile}`,
    kind: 'module',
    label: sourceFile,
    sourceFile,
    ...(depth === undefined ? {} : { meta: { depth } }),
  }
}

function graphWith(nodes: BlueprintNode[]): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-15T00:00:00.000Z',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes,
    edges: [],
  }
}

// ════════════════════════════════════════════════════════════════════════
// PURE CORE
// ════════════════════════════════════════════════════════════════════════

describe('jobKey', () => {
  it('is stable per (root, module) and distinguishes both halves', () => {
    expect(jobKey('/repo', 'src/a')).toBe(jobKey('/repo', 'src/a'))
    expect(jobKey('/repo', 'src/a')).not.toBe(jobKey('/repo', 'src/b'))
    expect(jobKey('/repo', 'src/a')).not.toBe(jobKey('/other', 'src/a'))
  })
})

describe('enqueueJob', () => {
  it('admits a new (root, module) and records its key', () => {
    const { state, admitted } = enqueueJob(initialQueueState(), job())
    expect(admitted).toBe(true)
    expect(state.queued).toHaveLength(1)
    expect(state.keys.has(jobKey('/repo', 'src/a'))).toBe(true)
  })

  it('rejects a duplicate of a queued pair (no double-enqueue)', () => {
    const first = enqueueJob(initialQueueState(), job()).state
    const { state, admitted } = enqueueJob(first, job({ reason: 'again' }))
    expect(admitted).toBe(false)
    expect(state.queued).toHaveLength(1)
  })

  it('admits the same module under a different root', () => {
    const first = enqueueJob(initialQueueState(), job()).state
    const { admitted } = enqueueJob(first, job({ rootPath: '/other' }))
    expect(admitted).toBe(true)
  })
})

describe('claimQueuedJobs', () => {
  it("moves a basic discovery's modules to the front, deliberate, leaving everything else in order", () => {
    let state = initialQueueState()
    for (const queued of [
      job({ rootPath: '/other', modulePath: 'x' }),
      job({ modulePath: 'src/a', deliberate: false, reason: 'stale' }),
      job({ rootPath: '/other', modulePath: 'y' }),
      job({ modulePath: 'src/b', deliberate: true }),
    ]) {
      state = enqueueJob(state, queued).state
    }
    const claimed = claimQueuedJobs(state, '/repo', ['src/a', 'src/b'])
    expect(claimed.queued.map((entry) => [entry.rootPath, entry.modulePath, entry.deliberate])).toEqual([
      ['/repo', 'src/a', true],
      ['/repo', 'src/b', true],
      ['/other', 'x', false],
      ['/other', 'y', false],
    ])
    // Pure: the input is untouched.
    expect(state.queued[1]?.deliberate).toBe(false)
  })

  it('is the same state when none of its modules is queued', () => {
    const state = enqueueJob(initialQueueState(), job({ rootPath: '/other' })).state
    expect(claimQueuedJobs(state, '/repo', ['src/a'])).toBe(state)
  })
})

describe('takeNext', () => {
  it('returns empty for an empty queue', () => {
    expect(takeNext(initialQueueState(), 10).kind).toBe('empty')
  })

  it('skips a paused project — its jobs keep their places, the next project runs (2026-10-06)', () => {
    let state = enqueueJob(initialQueueState(), job({ rootPath: '/a', modulePath: 'src/x', deliberate: true })).state
    state = enqueueJob(state, job({ rootPath: '/b', modulePath: 'src/y', deliberate: true })).state
    const result = takeNext(state, 10, new Set(['/a']))
    if (result.kind !== 'run') throw new Error('expected a run')
    expect(result.job.rootPath).toBe('/b')
    expect(result.state.queued.map((queued) => queued.rootPath)).toEqual(['/a'])
    // Only paused work left: nothing to run, nothing lost.
    expect(takeNext(result.state, 10, new Set(['/a'])).kind).toBe('empty')
  })

  it('runs a deliberate job and increments runsThisSession', () => {
    const state = enqueueJob(initialQueueState(), job({ deliberate: true })).state
    const result = takeNext(state, 10)
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('unreachable')
    expect(result.state.active).toEqual(job({ deliberate: true }))
    expect(result.state.runsThisSession).toBe(1)
    expect(result.state.queued).toHaveLength(0)
  })

  it('runs an auto job while within budget', () => {
    const state = enqueueJob(initialQueueState(), job()).state
    expect(takeNext(state, 1).kind).toBe('run')
  })

  it('drops an auto job once the budget is spent and frees its key', () => {
    const state = { ...enqueueJob(initialQueueState(), job()).state, runsThisSession: 5 }
    const result = takeNext(state, 5)
    expect(result.kind).toBe('dropped')
    expect(result.state.keys.has(jobKey('/repo', 'src/a'))).toBe(false)
    expect(result.state.runsThisSession).toBe(5) // dropped jobs don't consume budget
  })

  it('runs a deliberate job even past the budget', () => {
    const state = {
      ...enqueueJob(initialQueueState(), job({ deliberate: true })).state,
      runsThisSession: 99,
    }
    expect(takeNext(state, 5).kind).toBe('run')
  })
})

describe('completeActive', () => {
  it('clears the active job and frees its key', () => {
    const run = takeNext(enqueueJob(initialQueueState(), job()).state, 10)
    if (run.kind !== 'run') throw new Error('unreachable')
    const done = completeActive(run.state)
    expect(done.active).toBeNull()
    expect(done.keys.has(jobKey('/repo', 'src/a'))).toBe(false)
  })

  it('is a no-op when nothing is active', () => {
    expect(completeActive(initialQueueState()).active).toBeNull()
  })
})

describe('abortRootJobs', () => {
  it('drops queued jobs for the root, keeps other roots', () => {
    let state = enqueueJob(initialQueueState(), job({ modulePath: 'src/a' })).state
    state = enqueueJob(state, job({ modulePath: 'src/b' })).state
    state = enqueueJob(state, job({ rootPath: '/other', modulePath: 'src/c' })).state
    const { state: next, abortedActive } = abortRootJobs(state, '/repo')
    expect(abortedActive).toBe(false)
    expect(next.queued).toEqual([job({ rootPath: '/other', modulePath: 'src/c' })])
    expect(next.keys.has(jobKey('/repo', 'src/a'))).toBe(false)
    expect(next.keys.has(jobKey('/other', 'src/c'))).toBe(true)
  })

  it('signals when the active job belongs to the aborted root', () => {
    const run = takeNext(enqueueJob(initialQueueState(), job()).state, 10)
    if (run.kind !== 'run') throw new Error('unreachable')
    const { state, abortedActive } = abortRootJobs(run.state, '/repo')
    expect(abortedActive).toBe(true)
    expect(state.active).toBeNull()
  })

  it('leaves the active job when it belongs to a different root', () => {
    const run = takeNext(enqueueJob(initialQueueState(), job()).state, 10)
    if (run.kind !== 'run') throw new Error('unreachable')
    const { abortedActive } = abortRootJobs(run.state, '/other')
    expect(abortedActive).toBe(false)
  })
})

describe('resolveSupersede', () => {
  const note = (fingerprint: string, anchorRefs: string[]): BlueprintInvestigation => ({
    anchorRefs,
    summary: 's',
    provenance: 'p',
    ts: 't',
    fingerprint,
  })

  it('returns the fingerprint of an active note anchored to the module', () => {
    const result = resolveSupersede([note('fp-1', ['src/a']), note('fp-2', ['src/b'])], 'src/a')
    expect(result).toEqual({ fingerprint: 'fp-1', reason: 're-learned src/a' })
  })

  it('returns undefined when no note names the module (first learn)', () => {
    expect(resolveSupersede([note('fp-2', ['src/b'])], 'src/a')).toBeUndefined()
    expect(resolveSupersede(undefined, 'src/a')).toBeUndefined()
  })

  it('matches a kind-prefixed learn target against its bare anchor ref (2026-07-30)', () => {
    // The note stores refs with the kind stripped, so an `endpoint:` learn
    // target is anchored under `GET /api/x` — comparing the raw module path
    // found nothing and every re-learn contradicted itself forever.
    const result = resolveSupersede(
      [note('fp-endpoint', ['GET /api/x'])],
      'endpoint:GET /api/x',
    )
    expect(result).toEqual({ fingerprint: 'fp-endpoint', reason: 're-learned endpoint:GET /api/x' })
  })

  it('matches a pre-fix ORPHAN note by the module doc it links', () => {
    // Notes written before the identity-anchor fix carry only decoration;
    // the doc path in the note text (part of the fingerprint) is the only
    // handle left to supersede them.
    const orphan = note(
      'a GET endpoint\n\nDoc: flow/brain/modules/endpoint-get-api-x.md+["GET","Thing"]',
      ['GET', 'Thing'],
    )
    const result = resolveSupersede([orphan], 'endpoint:GET /api/x')
    expect(result?.fingerprint).toBe(orphan.fingerprint)
  })
})

describe('selectDepthOneModules', () => {
  it('returns sorted, deduped depth-1 module sourceFiles only', () => {
    const graph = graphWith([
      moduleNode('src/b', 1),
      moduleNode('src/a', 1),
      moduleNode('src/a/deep', 2), // deeper — excluded
      moduleNode('src/a', 1), // duplicate
      { id: 'ep:x', kind: 'endpoint', label: 'x', sourceFile: 'src/x.ts' }, // non-module
      moduleNode('src/c', undefined), // no depth meta — excluded
    ])
    expect(selectDepthOneModules(graph)).toEqual(['src/a', 'src/b'])
  })

  it('returns [] for a null graph', () => {
    expect(selectDepthOneModules(null)).toEqual([])
  })
})

describe('selectOnboardingModules', () => {
  it('descends into a container module — the depth-2 children, not the blob', () => {
    const graph = graphWith([
      moduleNode('src', 1),
      moduleNode('src/app', 2),
      moduleNode('src/lib', 2),
    ])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['src/app', 'src/lib'],
      skipped: [],
    })
  })

  it('keeps a leaf depth-1 module (no children) as itself', () => {
    const graph = graphWith([moduleNode('prisma', 1), moduleNode('public', 1)])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['prisma', 'public'],
      skipped: [],
    })
  })

  it('skips an ignored depth-1 parent AND its whole subtree', () => {
    const graph = graphWith([
      moduleNode('__mocks__', 1),
      moduleNode('__mocks__/@apollo', 2),
      moduleNode('src', 1),
    ])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['src'],
      skipped: ['__mocks__'], // the parent stands for its subtree
    })
  })

  it('skips dot-dir depth-1 modules by default (.cursor, .github)', () => {
    const graph = graphWith([
      moduleNode('.cursor', 1),
      moduleNode('.github', 1),
      moduleNode('src', 1),
    ])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['src'],
      skipped: ['.cursor', '.github'],
    })
  })

  it('excludes an ignored child while keeping its siblings', () => {
    const graph = graphWith([
      moduleNode('src', 1),
      moduleNode('src/app', 2),
      moduleNode('src/__tests__', 2),
      moduleNode('src/vendor', 2),
    ])
    expect(selectOnboardingModules(graph, ['src/vendor'])).toEqual({
      modules: ['src/app'],
      skipped: ['src/__tests__', 'src/vendor'],
    })
  })

  it('never descends past depth 2 — depth-3 modules roll up into their parent', () => {
    const graph = graphWith([
      moduleNode('src', 1),
      moduleNode('src/app', 2),
      moduleNode('src/app/deep', 3),
    ])
    expect(selectOnboardingModules(graph)).toEqual({ modules: ['src/app'], skipped: [] })
  })

  it('does not confuse sibling prefixes (src vs src2)', () => {
    const graph = graphWith([
      moduleNode('src', 1),
      moduleNode('src2', 1),
      moduleNode('src2/app', 2),
    ])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['src', 'src2/app'],
      skipped: [],
    })
  })

  it('is deterministic — sorted + deduped regardless of node order', () => {
    const graph = graphWith([
      moduleNode('src/lib', 2),
      moduleNode('.github', 1),
      moduleNode('src', 1),
      moduleNode('src/app', 2),
      moduleNode('src/app', 2), // duplicate
      moduleNode('.cursor', 1),
    ])
    expect(selectOnboardingModules(graph)).toEqual({
      modules: ['src/app', 'src/lib'],
      skipped: ['.cursor', '.github'],
    })
  })

  it('returns empty for a null graph', () => {
    expect(selectOnboardingModules(null)).toEqual({ modules: [], skipped: [] })
  })
})

describe('filterUnlearned', () => {
  const entry = (module: string, status: BlueprintLearningEntry['status']): BlueprintLearningEntry => ({
    module,
    status,
    notedAt: '2026-07-15T00:00:00.000Z',
  })

  it('removes learned-fresh modules, keeps stale/learning/absent', () => {
    const learning = [entry('src/a', 'learned'), entry('src/b', 'stale'), entry('src/c', 'learning')]
    expect(filterUnlearned(['src/a', 'src/b', 'src/c', 'src/d'], learning)).toEqual([
      'src/b',
      'src/c',
      'src/d',
    ])
  })

  it('keeps everything when there is no learning state', () => {
    expect(filterUnlearned(['src/a'], undefined)).toEqual(['src/a'])
  })
})

describe('pickLearnModel + totalPayloadBytes', () => {
  it('routes small payloads to haiku and large payloads to sonnet', () => {
    expect(pickLearnModel(1024)).toBe('haiku')
    expect(pickLearnModel(LARGE_PAYLOAD_BYTES + 1)).toBe('sonnet')
  })

  it('sums file sizes', () => {
    expect(totalPayloadBytes([{ path: 'a', size: 10 }, { path: 'b', size: 5 }])).toBe(15)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR CLASS
// ════════════════════════════════════════════════════════════════════════

interface Harness {
  orchestrator: LearnOrchestrator
  transitions: Array<{ module: string; status: string }>
  passCalls: LearnPassParams[]
  notifications: FlowNotification[]
  learningEntries: BlueprintLearningEntry[]
  errors: Array<{ message: string; error: unknown }>
  setReady: (ready: boolean) => void
  resolvePass: (result: LearnPassResult) => void
  /** Args of every bundled-CLI call the orchestrator made (supersede queries). */
  cliCalls: string[][]
}

function makeHarness(options: {
  projectState?: LearnProjectState
  files?: ModuleFile[]
  /** When set, the harness injects enumerateModuleEntries (files + claims). */
  claimFiles?: ModuleFile[]
  budget?: number
  passResult?: LearnPassResult | ((params: LearnPassParams) => Promise<LearnPassResult>)
  /** Canned `blueprint notes --json` result for supersede resolution. */
  cliResult?: { ok: boolean; stdout: string }
  /** Pre-seed the persisted learning-state (the fake store's initial contents). */
  learning?: BlueprintLearningEntry[]
  /** Ignore-list extras returned by the injected readLearnIgnore dep — a
   *  rejecting function to probe the fail-soft path. Omit → dep not wired. */
  learnIgnore?: string[] | (() => Promise<string[]>)
  /** Make the project-structure read fail, to probe the #1169 error path. */
  projectReadFails?: boolean
} = {}): Harness {
  // ONE in-memory store, shared by every suite that fakes this seam — the
  // orchestrator gets a single read-modify-write function, never a read and a
  // write it could put on either side of an await.
  const store = makeLearningStateFake(options.learning ?? [])
  const transitions = store.transitions
  const passCalls: LearnPassParams[] = []
  const notifications: FlowNotification[] = []
  const errors: Array<{ message: string; error: unknown }> = []
  let ready = true
  let deferredResolve: ((result: LearnPassResult) => void) | null = null

  const projectState: LearnProjectState = options.projectState ?? {
    graph: null,
    learning: undefined,
    investigations: undefined,
  }

  const runPass: LearnOrchestratorDeps['runPass'] = (params) => {
    passCalls.push(params)
    if (typeof options.passResult === 'function') {
      return options.passResult(params)
    }
    if (options.passResult) {
      return Promise.resolve(options.passResult)
    }
    return new Promise<LearnPassResult>((resolve) => {
      deferredResolve = resolve
    })
  }

  const cliCalls: string[][] = []
  const deps: LearnOrchestratorDeps = {
    readProjectState: () =>
      options.projectReadFails === true
        ? Promise.reject(new Error('EACCES'))
        : Promise.resolve(projectState),
    isRootReady: () => ready,
    bundledCli: BUNDLED_CLI,
    notify: (n) => notifications.push(n),
    runPass,
    // Supersede is resolved by ASKING THE CLI (a capped snapshot projection
    // could not answer it at scale). Default: no active note on the anchor.
    runCli: (_cwd, args) => {
      cliCalls.push([...args])
      return Promise.resolve(options.cliResult ?? { ok: true, stdout: '{"notes":[]}' })
    },
    enumerateModuleFiles: () => Promise.resolve(options.files ?? [{ path: 'src/a/index.ts', size: 100 }]),
    ...(options.claimFiles
      ? {
          enumerateModuleEntries: () =>
            Promise.resolve({
              files: options.files ?? [{ path: 'src/a/index.ts', size: 100 }],
              claimFiles: options.claimFiles ?? [],
            }),
        }
      : {}),
    mutateLearning: store.mutate,
    structureDirFor: (root) => `${root}/.structure`,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    budget: options.budget ?? 10,
    onError: (message, error) => errors.push({ message, error }),
    ...(options.learnIgnore !== undefined
      ? {
          readLearnIgnore:
            typeof options.learnIgnore === 'function'
              ? options.learnIgnore
              : () => Promise.resolve(options.learnIgnore as string[]),
        }
      : {}),
  }

  return {
    orchestrator: new LearnOrchestrator(deps),
    transitions,
    passCalls,
    notifications,
    errors,
    cliCalls,
    get learningEntries() {
      return store.entries()
    },
    setReady: (value) => {
      ready = value
    },
    resolvePass: (result) => {
      deferredResolve?.(result)
      deferredResolve = null
    },
  } as Harness
}

/** Flush the microtask queue so the async drain loop settles. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('LearnOrchestrator.enqueueModule', () => {
  it('runs a pass and records learning → learned on success', async () => {
    const h = makeHarness({ passResult: { ok: true, docPath: '/repo/doc.md', noteFingerprint: 'fp' } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.passCalls[0].modulePath).toBe('src/a')
    expect(h.transitions).toEqual([
      { module: 'src/a', status: 'queued' },
      { module: 'src/a', status: 'learning' },
      { module: 'src/a', status: 'learned' },
    ])
    expect(h.notifications).toHaveLength(0)
  })

  // "Learn all" (#learn-all) enqueues every module at once — a burst of
  // un-awaited transition('queued') calls plus the drain loop's learning/learned
  // transitions, all read-modify-writing the SAME learning-state store. Before
  // serialization, concurrent transitions read stale state and clobbered each
  // other (lost updates) + raced on the temp file (ENOENT). Every module must
  // survive the burst.
  it('serializes a burst of transitions without losing updates (Learn all)', async () => {
    const h = makeHarness({ budget: 100, passResult: { ok: true } })
    const mods = Array.from({ length: 20 }, (_, i) => `src/m${i}`)
    for (const m of mods) {
      h.orchestrator.enqueueModule('/repo', m, { reason: 'manual', deliberate: true })
    }
    for (let i = 0; i < 12; i += 1) await flush() // let the burst + drain settle
    const present = new Set(h.learningEntries.map((e) => e.module))
    for (const m of mods) expect(present.has(m)).toBe(true) // none lost
    expect(h.learningEntries.filter((e) => e.status === 'learned')).toHaveLength(mods.length)
  })

  // #learn-stuck: after an app restart mid-learn, orphaned 'learning'/'queued'
  // entries would pin the panel on "Learning…" forever. Startup reconcile resets
  // them to 'stale' (needs re-learn) and leaves terminal states untouched.
  it('reconcileInterrupted resets orphaned learning/queued to stale, keeps learned', async () => {
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [
        { module: 'src/a', status: 'learning', notedAt: at },
        { module: 'src/b', status: 'queued', notedAt: at },
        { module: 'src/c', status: 'learned', notedAt: at },
        { module: 'src/d', status: 'stale', notedAt: at },
      ],
      // A healthy store: the learned module HAS its investigation note — the
      // noteless-integrity pass must leave it alone.
      projectState: {
        graph: null,
        learning: undefined,
        investigations: [
          { anchorRefs: ['src/c'], summary: 's', provenance: 'learn:module', ts: at, fingerprint: 'fp-c' },
        ],
      },
    })
    await h.orchestrator.reconcileInterrupted('/repo')
    const byModule = new Map(h.learningEntries.map((e) => [e.module, e.status]))
    expect(byModule.get('src/a')).toBe('stale') // was learning → reset
    expect(byModule.get('src/b')).toBe('stale') // was queued → reset
    expect(byModule.get('src/c')).toBe('learned') // untouched
    expect(byModule.get('src/d')).toBe('stale') // untouched
    // A SINGLE batched write, not one per interrupted module (the fake store
    // records one transition per rewrite) — hundreds would never settle.
    expect(h.transitions).toHaveLength(1)
  })

  it('resumeInterrupted re-runs the queue a previous session left behind (#1132)', async () => {
    // BEFORE the harness clock (2026-07-15T12:00Z). The store keeps the LATEST
    // record per module, so a fixture stamped in the future would make every
    // transition this test provokes lose to its own seed.
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [
        { module: 'src/a', status: 'learning', notedAt: at, reason: 'basic-discovery', deliberate: true },
        { module: 'src/b', status: 'queued', notedAt: at, reason: 'basic-discovery', deliberate: true },
        { module: 'src/c', status: 'learned', notedAt: at },
      ],
      passResult: { ok: true },
      projectState: {
        graph: null,
        learning: undefined,
        investigations: [
          { anchorRefs: ['src/c'], summary: 's', provenance: 'learn:module', ts: at, fingerprint: 'fp-c' },
        ],
      },
    })

    await h.orchestrator.resumeInterrupted('/repo')
    await flush()
    await flush()

    // Both interrupted modules actually ran again, with their original reason.
    expect(h.passCalls.map((call) => call.modulePath).sort()).toEqual(['src/a', 'src/b'])
    const byModule = new Map(h.learningEntries.map((entry) => [entry.module, entry.status]))
    expect(byModule.get('src/a')).toBe('learned')
    expect(byModule.get('src/b')).toBe('learned')
    expect(byModule.get('src/c')).toBe('learned') // untouched
  })

  it('resumeInterrupted keeps the queue on disk when the root is not provisioned yet', async () => {
    // BEFORE the harness clock (2026-07-15T12:00Z). The store keeps the LATEST
    // record per module, so a fixture stamped in the future would make every
    // transition this test provokes lose to its own seed.
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [{ module: 'src/a', status: 'learning', notedAt: at }],
      passResult: { ok: true },
    })
    h.setReady(false)

    await h.orchestrator.resumeInterrupted('/repo')
    await flush()

    // Nothing ran, and the work is still queued for the next attempt — a
    // half-provisioned root must not silently discard the user's queue.
    expect(h.passCalls).toHaveLength(0)
    expect(h.learningEntries.find((entry) => entry.module === 'src/a')?.status).toBe('queued')

    // …and when provisioning finishes, the retry picks it up.
    h.setReady(true)
    await h.orchestrator.resumeInterrupted('/repo')
    await flush()
    await flush()
    expect(h.passCalls.map((call) => call.modulePath)).toEqual(['src/a'])
  })

  it('resumeInterrupted is idempotent — a second call re-admits nothing', async () => {
    // BEFORE the harness clock (2026-07-15T12:00Z). The store keeps the LATEST
    // record per module, so a fixture stamped in the future would make every
    // transition this test provokes lose to its own seed.
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [{ module: 'src/a', status: 'queued', notedAt: at }],
    })

    await h.orchestrator.resumeInterrupted('/repo')
    await h.orchestrator.resumeInterrupted('/repo')
    await flush()

    // One in-flight pass, not two: the queue's dedupe keys absorb the retry
    // that the roots-changed event fires on every current root.
    expect(h.passCalls).toHaveLength(1)
  })

  it('reconcileInterrupted writes NOTHING when nothing is interrupted', async () => {
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [
        { module: 'src/a', status: 'learned', notedAt: at },
        { module: 'src/b', status: 'stale', notedAt: at },
      ],
      projectState: {
        graph: null,
        learning: undefined,
        investigations: [
          { anchorRefs: ['src/a'], summary: 's', provenance: 'learn:module', ts: at, fingerprint: 'fp-a' },
        ],
      },
    })
    await h.orchestrator.reconcileInterrupted('/repo')
    expect(h.transitions).toHaveLength(0) // no write at all
  })

  it('reconcileInterrupted flips learned-without-notes to stale (lost investigations store)', async () => {
    // The orbit-app state (2026-07-21): a vault re-provision preserved
    // learning-state (361 'learned') but dropped investigations.jsonl — with no
    // stamps to re-hash, staleness could NEVER fire and the board read 100%
    // learned forever. The integrity pass flips those to stale so re-learn heals.
    const at = '2026-07-20T17:10:00.000Z'
    const h = makeHarness({
      learning: [
        { module: 'src/a', status: 'learned', notedAt: at },
        { module: 'src/b', status: 'learned', notedAt: at },
      ],
      projectState: { graph: null, learning: undefined, investigations: undefined },
    })
    await h.orchestrator.reconcileInterrupted('/repo')
    const byModule = new Map(h.learningEntries.map((e) => [e.module, e.status]))
    expect(byModule.get('src/a')).toBe('stale')
    expect(byModule.get('src/b')).toBe('stale')
    expect(h.transitions).toHaveLength(1) // still ONE batched write
  })

  it('marks a second module queued the moment it is admitted (visible queue)', async () => {
    const h = makeHarness() // deferred pass — first job stays in-flight
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'manual', deliberate: true })
    await flush()
    // The user's second click is visible BEFORE the first pass finishes.
    expect(h.transitions).toEqual([
      { module: 'src/a', status: 'queued' },
      { module: 'src/a', status: 'learning' },
      { module: 'src/b', status: 'queued' },
    ])
  })

  it('records learning → stale and toasts on a failed pass', async () => {
    const h = makeHarness({ passResult: { ok: false, reason: 'malformed output' } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.transitions).toEqual([
      { module: 'src/a', status: 'queued' },
      { module: 'src/a', status: 'learning' },
      { module: 'src/a', status: 'stale' },
    ])
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0].body).toContain('malformed output')
    expect(h.notifications[0].level).toBe('warn')
  })

  it('refuses to enqueue while the root is not ready', async () => {
    const h = makeHarness()
    h.setReady(false)
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(0)
    expect(h.transitions).toHaveLength(0)
  })

  it('SAYS it refused, when a person asked', async () => {
    // The refusal used to be a bare `return`: no error, no log, nothing on
    // screen. The panel went on reading "Idle · 0/362 learned" while every
    // press did nothing, and the user's report was "the learning is not working
    // at all" — with no way for them or anyone reading the panel to find out
    // why. #1169 already settled this for basic discovery on the same panel: a
    // click that costs an agent run is owed an answer.
    const h = makeHarness()
    h.setReady(false)
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]).toMatchObject({ level: 'error', rootId: '/repo' })
    // It names the state of the PROJECT and what has to happen — never a
    // command, a path or a config key (forbidden-pattern #12).
    expect(h.notifications[0]?.body).toContain('setting this project up')
    expect(h.notifications[0]?.body).not.toMatch(/planflow-ai|`|\.flowconfig|\//)
  })

  it('stays quiet when nobody asked — an automatic sweep is not a refusal to report', async () => {
    // T3 probes roots constantly and expects to find some mid-provision.
    // Toasting that would be noise about a decision the user never made.
    const h = makeHarness()
    h.setReady(false)
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'stale' })
    await flush()
    expect(h.notifications).toHaveLength(0)
    expect(h.passCalls).toHaveLength(0)
  })

  it('dedupes a module already queued/running', async () => {
    const h = makeHarness() // deferred pass — first stays running
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    h.resolvePass({ ok: true })
    await flush()
  })

  it('passes a supersede request resolved by ASKING THE CLI (re-learn)', async () => {
    // Was resolved by scanning the snapshot's investigation projection, which
    // is capped at a display limit — on orbit-app the note it needed sat at
    // index 356 of 362, so nothing resolved and every re-learn failed.
    const h = makeHarness({
      passResult: { ok: true },
      cliResult: {
        ok: true,
        stdout: JSON.stringify({
          anchor: 'module:src/a',
          notes: [{ fingerprint: 'note-fp', text: 'summary\n\nDoc: flow/brain/modules/src-a.md' }],
        }),
      },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.cliCalls[0]).toEqual(['blueprint', 'notes', '--anchor', 'module:src/a', '--json'])
    expect(h.passCalls[0].supersede).toEqual({ fingerprint: 'note-fp', reason: 're-learned src/a' })
  })

  it('asks for the anchor with no active note and passes no supersede (first learn)', async () => {
    const h = makeHarness({ passResult: { ok: true } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls[0].supersede).toBeUndefined()
  })

  it('is fail-soft when the CLI query fails — no throw, no pointer', async () => {
    const h = makeHarness({
      passResult: { ok: true },
      cliResult: { ok: false, stdout: '' },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.passCalls[0].supersede).toBeUndefined()
  })

  it('is fail-soft on unparseable CLI output', async () => {
    const h = makeHarness({
      passResult: { ok: true },
      cliResult: { ok: true, stdout: 'not json' },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls[0].supersede).toBeUndefined()
  })

  it('processes jobs serially (concurrency 1)', async () => {
    const h = makeHarness() // deferred — controls completion
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1) // only the first runs until it resolves
    h.resolvePass({ ok: true })
    await flush()
    expect(h.passCalls).toHaveLength(2)
    h.resolvePass({ ok: true })
    await flush()
  })
})

describe('parseConfirmedCount', () => {
  it('reads the real CLI line', () => {
    // Verified against the live verb on a repo whose feature store was emptied.
    expect(parseConfirmedCount('features: confirmed 1 candidate(s)\n')).toBe(1)
    expect(parseConfirmedCount('features: confirmed 12 candidate(s) (kind core)\n')).toBe(12)
  })

  it('never counts a dry run as features that appeared', () => {
    expect(parseConfirmedCount('features: would confirm 3 candidate(s)\n')).toBe(0)
  })

  it('is 0 for a refusal or any line it does not recognise', () => {
    expect(parseConfirmedCount('features refused: no staged candidates')).toBe(0)
    expect(parseConfirmedCount('')).toBe(0)
    expect(parseConfirmedCount('some unrelated output')).toBe(0)
  })
})

describe('LearnOrchestrator.enqueueBasicDiscovery', () => {
  it('enqueues depth-1 modules, skipping learned-fresh ones', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1), moduleNode('src/b', 1), moduleNode('src/c', 1)]),
        learning: [{ module: 'src/b', status: 'learned', notedAt: '2026-07-15T00:00:00.000Z' }],
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    const learned = h.passCalls.map((call) => call.modulePath).sort()
    expect(learned).toEqual(['src/a', 'src/c']) // src/b skipped (already learned)
  })

  // #1169: the ask is one-time and destroys its own affordance, so a click that
  // enqueues nothing must still say what happened — silence reads as "the button
  // is broken". The explanation was already composed and then thrown away: the
  // skipped clause lived inside `if (modules.length > 0)`.
  it('says WHY when everything was skipped as scaffolding (#1169)', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('__mocks__', 1), moduleNode('tests', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls).toHaveLength(0)
    expect(h.notifications[0]?.title).toBe('Nothing to learn yet')
    expect(h.notifications[0]?.body).toContain('Skipped 2 scaffolding module(s)')
    expect(h.notifications[0]?.body).toContain('mocks, tests and hidden folders')
    expect(h.notifications[0]?.body).not.toMatch(/learn_ignore|flowconfig/)
  })

  it('says so when every module is already learned (#1169)', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1)]),
        learning: [{ module: 'src/a', status: 'learned', notedAt: '2026-07-15T00:00:00.000Z' }],
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls).toHaveLength(0)
    expect(h.notifications[0]?.body).toContain('already been learned')
  })

  it('says so when the graph has no modules at all (#1169)', async () => {
    const h = makeHarness({
      projectState: { graph: graphWith([]), learning: undefined, investigations: undefined },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.notifications[0]?.body).toContain('No modules were found')
  })

  it('surfaces a failed structure read instead of console-warning it (#1169)', async () => {
    const h = makeHarness({
      projectState: { graph: graphWith([moduleNode('src/a', 1)]), learning: undefined, investigations: undefined },
      passResult: { ok: true },
      projectReadFails: true,
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.notifications[0]?.level).toBe('error')
    expect(h.notifications[0]?.title).toBe("Couldn't start basic discovery")
  })

  it('is a no-op when the root is not ready', async () => {
    const h = makeHarness({ projectState: { graph: graphWith([moduleNode('src/a', 1)]), learning: undefined, investigations: undefined } })
    h.setReady(false)
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls).toHaveLength(0)
  })

  it('skips learning-ignored modules — built-in defaults, even with no reader wired (#learn-ignore)', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src', 1), moduleNode('__mocks__', 1), moduleNode('e2e', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls.map((call) => call.modulePath)).toEqual(['src'])
    // The STARTED toast counts only the modules actually enqueued AND says what
    // was skipped and why (one line — "detect and suggest that ignore").
    expect(h.notifications[0]?.body).toBe(
      'Learning 1 module(s) — skipped 2 scaffolding module(s) (mocks, tests and hidden folders)',
    )
  })

  // Basic discovery answers "what does this project do". Until this shipped it
  // only answered "what modules does it have": nothing in the app EVER invoked
  // feature generation, so a project whose one derive-time bootstrap found
  // nothing was left with a permanently empty feature board.
  it('generates the FEATURE LIST before learning any module', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
    })

    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()

    const featureCalls = h.cliCalls.filter((args) => args[1] === 'features')
    expect(featureCalls).toEqual([
      ['blueprint', 'features', 'discover'],
      ['blueprint', 'features', 'confirm', '--all'],
      // …and then the ROSTER, once per learn job: the names a pass may record a
      // relationship to. It comes last on purpose — the features have to exist
      // before there is a vocabulary to hand the pass.
      ['blueprint', 'features', 'roster', '--json'],
    ])
  })

  it('reports the features it actually created', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
      cliResult: { ok: true, stdout: 'features: confirmed 3 candidate(s)\n' },
    })

    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()

    expect(h.notifications[0]).toMatchObject({
      title: 'Features discovered',
      body: 'Added 3 feature(s) to the board',
    })
  })

  it('says nothing when a repo names no capability — matching derive’s own rule', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
      cliResult: { ok: true, stdout: 'features: confirmed 0 candidate(s)\n' },
    })

    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()

    expect(h.notifications.map((n) => n.title)).not.toContain('Features discovered')
  })

  // FAIL-SOFT is the load-bearing property: feature generation is a bonus step
  // bolted onto a flow the user asked for. A missing CLI or a refusal must cost
  // them nothing they already had.
  it('still learns every module when feature generation fails', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src/a', 1), moduleNode('src/b', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
      cliResult: { ok: false, stdout: 'features refused: no flow/ directory' },
    })

    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()

    expect(h.passCalls.map((call) => call.modulePath).sort()).toEqual(['src/a', 'src/b'])
    expect(h.notifications.map((n) => n.title)).not.toContain('Features discovered')
  })

  it('learns the depth-2 children of a container module, not the root blob', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([
          moduleNode('src', 1),
          moduleNode('src/app', 2),
          moduleNode('src/lib', 2),
          moduleNode('prisma', 1),
          moduleNode('.cursor', 1),
        ]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    // Children of `src` instead of `src`; leaf `prisma` kept; `.cursor` skipped.
    expect(h.passCalls.map((call) => call.modulePath).sort()).toEqual([
      'prisma',
      'src/app',
      'src/lib',
    ])
    expect(h.notifications[0]?.body).toBe(
      'Learning 3 module(s) — skipped 1 scaffolding module(s) (mocks, tests and hidden folders)',
    )
  })

  it('keeps the plain STARTED copy when nothing was skipped', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.notifications[0]?.body).toBe('Learning 1 module(s)…')
  })

  it('also skips modules matched by the injected learn_ignore extras', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src', 1), moduleNode('vendor', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
      learnIgnore: ['vendor'],
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls.map((call) => call.modulePath)).toEqual(['src'])
  })

  it('falls back to the built-in defaults when the ignore reader fails (fail-soft)', async () => {
    const h = makeHarness({
      projectState: {
        graph: graphWith([moduleNode('src', 1), moduleNode('__tests__', 1)]),
        learning: undefined,
        investigations: undefined,
      },
      passResult: { ok: true },
      learnIgnore: () => Promise.reject(new Error('unreadable flowconfig')),
    })
    await h.orchestrator.enqueueBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls.map((call) => call.modulePath)).toEqual(['src'])
  })

  it('still runs a MANUAL enqueueModule for an ignored module (deliberate override)', async () => {
    const h = makeHarness({ passResult: { ok: true }, learnIgnore: ['vendor'] })
    h.orchestrator.enqueueModule('/repo', '__mocks__', { reason: 'manual', deliberate: true })
    h.orchestrator.enqueueModule('/repo', 'vendor', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls.map((call) => call.modulePath)).toEqual(['__mocks__', 'vendor'])
  })
})

describe('LearnOrchestrator.runBasicDiscovery (answers when the sweep has ENDED)', () => {
  const threeModules = (): LearnProjectState => ({
    graph: graphWith([moduleNode('src/a', 1), moduleNode('src/b', 1), moduleNode('src/c', 1)]),
    learning: undefined,
    investigations: undefined,
  })

  it('resolves done with the tally once every selected module has run', async () => {
    let call = 0
    const h = makeHarness({
      projectState: threeModules(),
      passResult: () => Promise.resolve(call++ === 1 ? { ok: false, reason: 'boom' } : { ok: true }),
    })
    const outcome = await h.orchestrator.runBasicDiscovery('/repo')
    expect(outcome).toEqual({ kind: 'done', learned: 2, failed: 1 })
    expect(h.passCalls).toHaveLength(3)
  })

  it('an AUTOMATIC sweep is quiet — no started or finished toast — while a person\'s run still announces (live: 47 toasts, 2026-10-06)', async () => {
    const quiet = makeHarness({ projectState: threeModules(), passResult: () => Promise.resolve({ ok: true }) })
    await expect(quiet.orchestrator.runBasicDiscovery('/repo', { announce: false })).resolves.toEqual({ kind: 'done', learned: 3, failed: 0 })
    expect(quiet.passCalls).toHaveLength(3)
    expect(quiet.notifications.map((n) => n.title)).toEqual([])

    const asked = makeHarness({ projectState: threeModules(), passResult: () => Promise.resolve({ ok: true }) })
    await asked.orchestrator.runBasicDiscovery('/repo')
    expect(asked.notifications.map((n) => n.title)).toEqual(['Basic discovery started', 'Basic discovery finished'])
    // UI text never names a config key or a file path (forbidden-pattern #12).
    for (const n of asked.notifications) expect(`${n.title} ${n.body}`).not.toMatch(/learn_ignore|flowconfig|flow\//)
  })

  it('does not resolve while a module is still running', async () => {
    const h = makeHarness({ projectState: { ...threeModules(), graph: graphWith([moduleNode('src/a', 1)]) } })
    let settled = false
    const run = h.orchestrator.runBasicDiscovery('/repo').then((outcome) => {
      settled = true
      return outcome
    })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(settled).toBe(false)
    h.resolvePass({ ok: true })
    await expect(run).resolves.toEqual({ kind: 'done', learned: 1, failed: 0 })
  })

  it('a second caller joins the run in flight instead of starting another', async () => {
    const h = makeHarness({ projectState: { ...threeModules(), graph: graphWith([moduleNode('src/a', 1)]) } })
    const first = h.orchestrator.runBasicDiscovery('/repo')
    const second = h.orchestrator.runBasicDiscovery('/repo')
    await flush()
    expect(h.passCalls).toHaveLength(1)
    h.resolvePass({ ok: true })
    await expect(first).resolves.toEqual({ kind: 'done', learned: 1, failed: 0 })
    await expect(second).resolves.toEqual({ kind: 'done', learned: 1, failed: 0 })
  })

  it('is failed when nothing could be learned', async () => {
    const h = makeHarness({
      projectState: { ...threeModules(), graph: graphWith([moduleNode('src/a', 1), moduleNode('src/b', 1)]) },
      passResult: { ok: false, reason: 'boom' },
    })
    const outcome = await h.orchestrator.runBasicDiscovery('/repo')
    expect(outcome.kind).toBe('failed')
  })

  it('is done at once when there is nothing to learn, and not-ready on an unready root', async () => {
    const empty = makeHarness({ passResult: { ok: true } })
    await expect(empty.orchestrator.runBasicDiscovery('/repo')).resolves.toEqual({ kind: 'done', learned: 0, failed: 0 })
    const unready = makeHarness({ projectState: threeModules(), passResult: { ok: true } })
    unready.setReady(false)
    await expect(unready.orchestrator.runBasicDiscovery('/repo')).resolves.toEqual({ kind: 'not-ready' })
  })

  it('is failed when the project structure cannot be read', async () => {
    const h = makeHarness({ projectReadFails: true })
    await expect(h.orchestrator.runBasicDiscovery('/repo')).resolves.toMatchObject({ kind: 'failed' })
  })

  it('is cancelled when the root is stopped mid-run', async () => {
    const h = makeHarness({ projectState: { ...threeModules(), graph: graphWith([moduleNode('src/a', 1)]) } })
    const run = h.orchestrator.runBasicDiscovery('/repo')
    await flush()
    h.orchestrator.abortRoot('/repo')
    await expect(run).resolves.toEqual({ kind: 'cancelled' })
    h.resolvePass({ ok: false, reason: 'cancelled' })
    await flush()
  })

  it('a run that pauses itself after failures in a row ends as failed, and resume:true lifts the pause', async () => {
    let healthy = false
    const h = makeHarness({
      projectState: {
        ...threeModules(),
        graph: graphWith([moduleNode('src/a', 1), moduleNode('src/b', 1), moduleNode('src/c', 1), moduleNode('src/d', 1)]),
      },
      passResult: () => Promise.resolve(healthy ? { ok: true } : { ok: false, reason: 'boom' }),
    })
    const outcome = await h.orchestrator.runBasicDiscovery('/repo')
    expect(outcome.kind).toBe('failed')
    expect(h.orchestrator.isPaused()).toBe(true)
    healthy = true
    const again = await h.orchestrator.runBasicDiscovery('/repo', { resume: true })
    expect(h.orchestrator.isPaused()).toBe(false)
    expect(again.kind).toBe('done')
  })
})

describe('LearnOrchestrator budget', () => {
  it('drops auto jobs past the budget, leaving a stale entry, with no toast', async () => {
    const h = makeHarness({ budget: 1, passResult: { ok: true } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'auto', deliberate: false })
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'auto', deliberate: false })
    await flush()
    expect(h.passCalls.map((c) => c.modulePath)).toEqual(['src/a']) // src/b dropped
    // src/b left stale; no failure toast for a budget drop.
    expect(h.transitions).toContainEqual({ module: 'src/b', status: 'stale' })
    expect(h.notifications).toHaveLength(0)
  })

  it('always runs deliberate jobs regardless of budget', async () => {
    const h = makeHarness({ budget: 0, passResult: { ok: true } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
  })
})

describe('LearnOrchestrator.abortRoot / dispose', () => {
  it('aborts the in-flight session for the root and drops its queue', async () => {
    const h = makeHarness() // deferred pass — stays in-flight
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    const signal = h.passCalls[0].abortSignal
    h.orchestrator.abortRoot('/repo')
    expect(signal?.aborted).toBe(true)
    // Resolving an aborted pass does not toast/transition to stale.
    h.resolvePass({ ok: false, reason: 'cancelled' })
    await flush()
    expect(h.notifications).toHaveLength(0)
    expect(h.transitions).toEqual([
      { module: 'src/a', status: 'queued' },
      { module: 'src/a', status: 'learning' },
    ])
  })

  it('dispose aborts the active session and refuses further enqueues', async () => {
    const h = makeHarness()
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    const signal = h.passCalls[0].abortSignal
    h.orchestrator.dispose()
    expect(signal?.aborted).toBe(true)
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1) // no new work after dispose
  })
})

describe('LearnOrchestrator.setPaused', () => {
  it('pause lets the active pass finish but starts no new pass; resume drains', async () => {
    const h = makeHarness() // deferred pass — completion is controlled
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    h.orchestrator.setPaused(true)
    expect(h.orchestrator.isPaused()).toBe(true)
    h.resolvePass({ ok: true })
    await flush()
    // The active pass completed and recorded normally…
    expect(h.transitions).toContainEqual({ module: 'src/a', status: 'learned' })
    // …but src/b was NOT taken — it stays queued while paused.
    expect(h.passCalls).toHaveLength(1)
    h.orchestrator.setPaused(false)
    await flush()
    expect(h.orchestrator.isPaused()).toBe(false)
    expect(h.passCalls).toHaveLength(2)
    expect(h.passCalls[1].modulePath).toBe('src/b')
    h.resolvePass({ ok: true })
    await flush()
  })

  it('enqueues while paused are admitted (visible queue) but not run until resume', async () => {
    const h = makeHarness({ passResult: { ok: true } })
    h.orchestrator.setPaused(true)
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.transitions).toEqual([{ module: 'src/a', status: 'queued' }])
    expect(h.passCalls).toHaveLength(0)
    h.orchestrator.setPaused(false)
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.transitions).toContainEqual({ module: 'src/a', status: 'learned' })
  })
})

describe('LearnOrchestrator.cancelRoot', () => {
  it('aborts the active pass, drops the queue, and flips entries stale immediately', async () => {
    const h = makeHarness() // deferred pass — src/a stays in-flight
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    h.orchestrator.enqueueModule('/repo', 'src/b', { reason: 'manual', deliberate: true })
    await flush()
    const signal = h.passCalls[0].abortSignal
    await h.orchestrator.cancelRoot('/repo')
    expect(signal?.aborted).toBe(true)
    // Both the aborted 'learning' entry and the dropped 'queued' entry read
    // stale NOW — not on next startup.
    const byModule = new Map(h.learningEntries.map((e) => [e.module, e.status]))
    expect(byModule.get('src/a')).toBe('stale')
    expect(byModule.get('src/b')).toBe('stale')
    // The aborted pass resolves later without recording or toasting, and no
    // new pass starts (the queue is empty).
    h.resolvePass({ ok: false, reason: 'cancelled' })
    await flush()
    expect(h.notifications).toHaveLength(0)
    expect(h.passCalls).toHaveLength(1)
  })
})

describe('LearnOrchestrator.resetRoot', () => {
  it('aborts in-flight work and wipes the learning-state to empty', async () => {
    const at = '2026-07-15T00:00:00.000Z'
    const h = makeHarness({
      learning: [
        { module: 'src/a', status: 'learned', notedAt: at },
        { module: 'src/b', status: 'stale', notedAt: at },
      ],
    })
    h.orchestrator.enqueueModule('/repo', 'src/c', { reason: 'manual', deliberate: true })
    await flush()
    const signal = h.passCalls[0].abortSignal
    await h.orchestrator.resetRoot('/repo')
    expect(signal?.aborted).toBe(true)
    // Every module reads never-learned again (absent = 'none' in the panel).
    expect(h.learningEntries).toEqual([])
    // The aborted pass resolves later without resurrecting any entry.
    h.resolvePass({ ok: true })
    await flush()
    expect(h.learningEntries).toEqual([])
    expect(h.notifications).toHaveLength(0)
  })
})

describe('reconcileNoteless (learned-without-notes integrity)', () => {
  const now = '2026-07-21T22:00:00.000Z'
  const learned = (module: string): BlueprintLearningEntry => ({
    module,
    status: 'learned',
    notedAt: '2026-07-20T17:10:00.000Z',
  })
  const note = (ref: string) => ({
    anchorRefs: [ref],
    summary: 's',
    provenance: 'learn:module',
    ts: now,
    fingerprint: `fp-${ref}`,
  })

  // THE BUG THIS GUARDS. `investigations` is a display projection capped at
  // INVESTIGATIONS_CAP. On orbit-app (362 notes, cap 100) this pass saw a
  // 100-note slice, concluded "no note" for everything past it, and flipped 24
  // of 25 learned modules to stale — all of which HAD notes. It re-ran on every
  // launch, so everything the user learned went amber again each time they
  // opened the app. Absence from a capped list is not absence.
  it('changes NOTHING when the note list was truncated — absence cannot be proven', () => {
    const { entries, changed } = reconcileNoteless(
      [learned('src'), learned('lib'), learned('app')],
      [note('src')], // the only note that fitted in the projection
      now,
      true, // …but there are more
    )
    expect(changed).toBe(false)
    expect(entries.map((e) => e.status)).toEqual(['learned', 'learned', 'learned'])
  })

  it('still reconciles when the list is COMPLETE — the real lost-notes case survives', () => {
    const { entries, changed } = reconcileNoteless([learned('src'), learned('lib')], [note('src')], now, false)
    expect(changed).toBe(true)
    expect(entries.find((e) => e.module === 'lib')?.status).toBe('stale')
  })

  it('flips learned modules with NO note to stale (the lost-notes state)', () => {
    const { entries, changed } = reconcileNoteless([learned('src'), learned('lib')], [note('src')], now)
    expect(changed).toBe(true)
    expect(entries.find((e) => e.module === 'lib')?.status).toBe('stale')
    expect(entries.find((e) => e.module === 'src')?.status).toBe('learned')
  })

  it('an absent notes store counts as note-less — everything learned flips', () => {
    const { entries, changed } = reconcileNoteless([learned('a'), learned('b')], undefined, now)
    expect(changed).toBe(true)
    expect(entries.every((e) => e.status === 'stale')).toBe(true)
  })

  it('non-learned entries are untouched and a fully-noted store changes nothing', () => {
    const stale: BlueprintLearningEntry = { module: 'x', status: 'stale', notedAt: now }
    const ok = reconcileNoteless([learned('src'), stale], [note('src')], now)
    expect(ok.changed).toBe(false)
    expect(ok.entries.find((e) => e.module === 'x')?.status).toBe('stale')
  })
})

describe('selectAllModulePaths (staleness watcher gets every depth)', () => {
  it('returns every module path at any depth, deduped + sorted', () => {
    const graph = graphWith([
      moduleNode('src', 1),
      moduleNode('src/app', 2),
      moduleNode('src/lib', 2),
      moduleNode('prisma', 1),
    ])
    expect(selectAllModulePaths(graph)).toEqual(['prisma', 'src', 'src/app', 'src/lib'])
  })

  it('null graph yields empty', () => {
    expect(selectAllModulePaths(null)).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// CLAIM-FILE ENUMERATION + THREADING (trust-tiers phase 3)
// ════════════════════════════════════════════════════════════════════════

describe('defaultEnumerateModuleEntries', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learn-enum-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('collects source files and claim docs/images in one walk, repo-relative', async () => {
    const mod = join(root, 'src/feature')
    mkdirSync(join(mod, 'docs'), { recursive: true })
    writeFileSync(join(mod, 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(mod, 'README.md'), '# claims\n')
    writeFileSync(join(mod, 'docs/diagram.png'), 'not-really-a-png')
    writeFileSync(join(mod, 'data.bin'), 'binary')
    const entries = await defaultEnumerateModuleEntries(root, 'src/feature')
    expect(entries.files.map((f) => f.path)).toEqual(['src/feature/index.ts'])
    expect(entries.claimFiles.map((f) => f.path).sort()).toEqual([
      'src/feature/README.md',
      'src/feature/docs/diagram.png',
    ])
    // Sizes are real byte sizes, so the caps downstream mean something.
    expect(entries.claimFiles.every((f) => f.size > 0)).toBe(true)
  })

  it('skips hidden/ignored dirs for claims too and fails soft on a missing module', async () => {
    const mod = join(root, 'src/feature')
    mkdirSync(join(mod, '.hidden'), { recursive: true })
    mkdirSync(join(mod, 'node_modules'), { recursive: true })
    writeFileSync(join(mod, '.hidden/secrets.md'), 'x')
    writeFileSync(join(mod, 'node_modules/pkg.md'), 'x')
    const entries = await defaultEnumerateModuleEntries(root, 'src/feature')
    expect(entries.claimFiles).toEqual([])
    const missing = await defaultEnumerateModuleEntries(root, 'src/nope')
    expect(missing).toEqual({ files: [], claimFiles: [] })
  })
})

describe('LearnOrchestrator claim-file threading', () => {
  it('threads enumerated claim files into the learn pass', async () => {
    const h = makeHarness({
      claimFiles: [{ path: 'src/a/README.md', size: 42 }],
      passResult: { ok: true },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.passCalls[0].claimFiles).toEqual([{ path: 'src/a/README.md', size: 42 }])
  })

  it('legacy enumerateModuleFiles injection yields no claim files (back-compat)', async () => {
    const h = makeHarness({ passResult: { ok: true } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.passCalls[0].claimFiles).toBeUndefined()
  })

  it('logs adjudication warnings to the error sink without failing the learn', async () => {
    const h = makeHarness({
      claimFiles: [{ path: 'src/a/README.md', size: 42 }],
      passResult: {
        ok: true,
        adjudicationWarnings: ['adjudicate failed for src/a/README.md: no tier store'],
      },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.transitions).toContainEqual({ module: 'src/a', status: 'learned' })
    expect(h.notifications).toHaveLength(0) // fail-soft: no failure toast
    expect(h.errors).toEqual([
      {
        message: 'learn adjudication for /repo/src/a',
        error: 'adjudicate failed for src/a/README.md: no tier store',
      },
    ])
  })
})

// ── The board's spinner needs a terminal signal on EVERY branch ──────────────
//
// The blueprint's empty state now runs a basic discovery itself and shows a
// running indicator until the feature-generation step settles. That step used
// to return silently on three of its four exits — a `discover` failure, a
// `confirm` refusal, a thrown error — and toast only when it created
// something. An indicator waiting on a signal that a branch never raises spins
// forever, which is the same class of bug as the dead button it replaced. So:
// every exit signals, and these tests hold that.
describe('generateFeatures signals every exit (learn:featuresDiscovered)', () => {
  const discovered: Array<{ rootPath: string; added: number; reason: string | null }> = []

  function harness(cli: (args: readonly string[]) => { ok: boolean; stdout: string }, ready = true) {
    discovered.length = 0
    return new LearnOrchestrator({
      readProjectState: () =>
        Promise.resolve({ graph: null, learning: undefined, investigations: undefined }),
      isRootReady: () => ready,
      bundledCli: BUNDLED_CLI,
      notify: () => undefined,
      runCli: (_cwd, args) => Promise.resolve(cli(args)),
      onError: () => undefined,
      onFeaturesDiscovered: (event) => discovered.push(event),
    })
  }

  it('reports how many features were written on success', async () => {
    const o = harness((args) =>
      args[2] === 'discover'
        ? { ok: true, stdout: 'features: staged 7 candidate(s)\n' }
        : { ok: true, stdout: 'features: confirmed 7 candidate(s)\n' },
    )
    await o.enqueueBasicDiscovery('/repo')
    expect(discovered).toEqual([{ rootPath: '/repo', added: 7, reason: null }])
  })

  // A REPO THAT NAMES NO CAPABILITY IS NOT A FAILURE. `confirm --all` refuses
  // when nothing is staged, and the board says "the discovery found nothing"
  // rather than showing an error for a project that is simply small.
  it('reports a completed-but-empty discovery as done, not failed', async () => {
    const o = harness((args) =>
      args[2] === 'discover'
        ? { ok: true, stdout: 'features: staged 0 candidate(s)\n' }
        : { ok: false, stdout: 'features refused: no staged candidates — run `blueprint features discover` first\n' },
    )
    await o.enqueueBasicDiscovery('/repo')
    expect(discovered).toEqual([{ rootPath: '/repo', added: 0, reason: null }])
  })

  it('carries the CLI’s own refusal line when discovery genuinely fails', async () => {
    const o = harness(() => ({ ok: false, stdout: 'features refused: no flow/ directory\n' }))
    await o.enqueueBasicDiscovery('/repo')
    expect(discovered).toEqual([
      { rootPath: '/repo', added: 0, reason: 'features refused: no flow/ directory' },
    ])
  })

  it('and any OTHER confirm refusal keeps its reason', async () => {
    const o = harness((args) =>
      args[2] === 'discover'
        ? { ok: true, stdout: 'ok\n' }
        : { ok: false, stdout: 'features refused: --kind must be core|child\n' },
    )
    await o.enqueueBasicDiscovery('/repo')
    expect(discovered[0]?.reason).toBe('features refused: --kind must be core|child')
  })

  // DEFECT B, at the source. This return was completely silent: no toast, no
  // event, no error — so on a freshly added project the gesture did nothing
  // and said nothing about it.
  it('says why nothing happened when the root is not ready', async () => {
    const o = harness(() => ({ ok: true, stdout: '' }), false)
    await o.enqueueBasicDiscovery('/repo')
    expect(discovered).toEqual([
      { rootPath: '/repo', added: 0, reason: 'this project is not ready yet' },
    ])
  })
})

// ── The roster reaches the pass (file-based-brain phase 2) ──────────────────
//
// `renderFeatureRoster` was plumbed into the learn prompts and NOTHING
// populated it, so every pass in production ran with an empty roster and could
// not name the other side of a relationship even in principle. This is the
// wire: the orchestrator asks the CLI for the roster and hands it to the pass.

describe('the learn pass is handed the project roster', () => {
  it('reads it through the injected CLI runner and passes it on', async () => {
    const h = makeHarness({
      passResult: { ok: true },
      cliResult: {
        ok: true,
        stdout: JSON.stringify({
          roster: [{ id: 'feature:skills', slug: 'skills', name: 'Skills', kind: 'core', summary: 'a reusable instruction set' }],
        }),
      },
    })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.cliCalls).toContainEqual(['blueprint', 'features', 'roster', '--json'])
    expect(h.passCalls[0].roster).toEqual([
      { id: 'feature:skills', name: 'Skills', kind: 'core', summary: 'a reusable instruction set' },
    ])
  })

  it('learns the module anyway when the roster read fails', async () => {
    // A pass with no roster writes prose instead of an edge — which is exactly
    // the behaviour that shipped for months. Losing the learning would be worse.
    const h = makeHarness({ passResult: { ok: true }, cliResult: { ok: false, stdout: '' } })
    h.orchestrator.enqueueModule('/repo', 'src/a', { reason: 'manual', deliberate: true })
    await flush()
    expect(h.passCalls).toHaveLength(1)
    expect(h.passCalls[0].roster).toBeUndefined()
  })
})

// Live 2026-10-09: orbit-app's `flow` link dangled at launch; every startup
// trigger (one per root, again per roots-changed, again per ready edge) called
// resumeInterrupted, and each threw an unhandled ENOTDIR — ~15 in the log.
describe('resumeInterrupted on a flow/ that is not there yet', () => {
  function enotdir(): Error {
    return Object.assign(new Error("ENOTDIR: not a directory, mkdir '/repo/flow'"), { code: 'ENOTDIR' })
  }

  function orchestratorWith(mutate: () => Promise<BlueprintLearningEntry[]>, errors: string[]) {
    return new LearnOrchestrator({
      readProjectState: () => Promise.resolve({ graph: null, learning: undefined, investigations: undefined }),
      isRootReady: () => true,
      bundledCli: BUNDLED_CLI,
      notify: () => undefined,
      mutateLearning: mutate,
      onError: (message) => errors.push(message),
      resumeRetryMs: 5,
    })
  }

  it('never rejects, folds a burst of calls into one run plus one re-run, logs ONE line and retries once', async () => {
    let calls = 0
    let failing = true
    const errors: string[] = []
    const o = orchestratorWith(async () => {
      calls += 1
      if (failing) throw enotdir()
      return []
    }, errors)

    const burst = Array.from({ length: 15 }, () => o.resumeInterrupted('/repo'))
    await expect(Promise.all(burst)).resolves.toBeDefined()
    await flush()
    // The first run, and ONE re-run for everything that arrived meanwhile.
    expect(calls).toBe(2)
    // One line, for one scheduled retry — the re-run's failure found it pending.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/could not resume interrupted learning for \/repo yet \(retry 1\/3/)

    failing = false
    await new Promise((resolve) => setTimeout(resolve, 20))
    await flush()
    expect(calls).toBe(3)
    expect(errors).toHaveLength(1)
    o.dispose()
  })

  it('stops retrying after its budget and says so once; a non-transient error is not retried', async () => {
    let calls = 0
    const errors: string[] = []
    const o = orchestratorWith(async () => {
      calls += 1
      throw enotdir()
    }, errors)
    await o.resumeInterrupted('/repo')
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(4) // the first try + three retries, then it waits for the next trigger
    expect(errors.at(-1)).toMatch(/the next trigger tries again/)
    expect(errors).toHaveLength(4)
    o.dispose()

    const other: string[] = []
    let otherCalls = 0
    const p = orchestratorWith(async () => {
      otherCalls += 1
      throw new Error('boom')
    }, other)
    await p.resumeInterrupted('/repo')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(otherCalls).toBe(1)
    expect(other).toHaveLength(1)
    p.dispose()
  })
})
