// The basic-discovery coordinator: one definition of "this project has its
// basic discovery", the bounded sweep queue, the restart re-check and the
// waiters a held message stands on. Every effect is a fake.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BlueprintLearningEntry } from '../../shared/ipc-contract'
import type { BasicDiscoveryRunOutcome } from '../project/learn-orchestrator'
import {
  BASIC_DISCOVERY_FILE,
  createBasicDiscovery,
  hasBasicDiscovery,
  parseBasicDiscoveryRecords,
  readBasicDiscoveryEvidence,
  recordBasicDiscovery,
  shouldAskBasicDiscovery,
  type BasicDiscoveryDeps,
  type BasicDiscoveryStatus,
} from './basic-discovery'

const LEARNED: BlueprintLearningEntry = { module: 'src/a', status: 'learned', notedAt: '2026-10-01T00:00:00.000Z' }

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('hasBasicDiscovery — the one rule', () => {
  it('is true once a completed sweep was recorded', () => {
    expect(hasBasicDiscovery({ records: [{ completedAt: '2026-10-06T00:00:00.000Z', learned: 3, failed: 0 }], learning: undefined })).toBe(true)
  })

  it('is true for a project learned before the record existed (any learned module)', () => {
    expect(hasBasicDiscovery({ records: [], learning: [LEARNED] })).toBe(true)
  })

  it('is false with no record and nothing learned — queued, learning and stale do not count', () => {
    expect(hasBasicDiscovery({ records: [], learning: undefined })).toBe(false)
    expect(
      hasBasicDiscovery({
        records: [],
        learning: [
          { module: 'src/a', status: 'queued', notedAt: 'x' },
          { module: 'src/b', status: 'learning', notedAt: 'x' },
          { module: 'src/c', status: 'stale', notedAt: 'x' },
        ],
      }),
    ).toBe(false)
  })
})

describe('parseBasicDiscoveryRecords', () => {
  it('keeps valid lines and skips corrupt ones', () => {
    const raw = ['{"completedAt":"2026-10-06T00:00:00.000Z","learned":2,"failed":1}', 'not json', '{"learned":1}', ''].join('\n')
    expect(parseBasicDiscoveryRecords(raw)).toEqual([{ completedAt: '2026-10-06T00:00:00.000Z', learned: 2, failed: 1 }])
    expect(parseBasicDiscoveryRecords(null)).toEqual([])
  })
})

describe('the record on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-bd-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is absent, then appended beside the learning state, then read back', async () => {
    const structure = join(dir, 'flow', 'brain', '.structure')
    expect(await readBasicDiscoveryEvidence(structure)).toEqual({ records: [], learning: undefined })
    await recordBasicDiscovery(structure, { completedAt: '2026-10-06T00:00:00.000Z', learned: 2, failed: 0 })
    const raw = readFileSync(join(structure, BASIC_DISCOVERY_FILE), 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    const evidence = await readBasicDiscoveryEvidence(structure)
    expect(hasBasicDiscovery(evidence)).toBe(true)
  })

  it('reads the learning state for the legacy rule', async () => {
    const structure = join(dir, '.structure')
    mkdirSync(structure, { recursive: true })
    writeFileSync(join(structure, 'learning-state.jsonl'), `${JSON.stringify(LEARNED)}\n`)
    expect(hasBasicDiscovery(await readBasicDiscoveryEvidence(structure))).toBe(true)
  })
})

interface Harness {
  deps: BasicDiscoveryDeps
  runs: string[]
  resumes: boolean[]
  recorded: string[]
  changes: Array<{ root: string; status: BasicDiscoveryStatus }>
  finish(root: string, outcome: BasicDiscoveryRunOutcome): void
  setReady(root: string, ready: boolean): void
  setHas(root: string, has: boolean): void
  setWorkspace(root: string, inside: boolean): void
}

function harness(options: { automatic?: boolean; maxConcurrent?: number } = {}): Harness {
  const pending = new Map<string, (outcome: BasicDiscoveryRunOutcome) => void>()
  const ready = new Map<string, boolean>()
  const has = new Map<string, boolean>()
  const outside = new Set<string>()
  const runs: string[] = []
  const resumes: boolean[] = []
  const recorded: string[] = []
  const changes: Array<{ root: string; status: BasicDiscoveryStatus }> = []
  const deps: BasicDiscoveryDeps = {
    hasRecord: (root) => Promise.resolve(has.get(root) === true),
    record: (root) => {
      recorded.push(root)
      has.set(root, true)
      return Promise.resolve()
    },
    run: (root, runOptions) => {
      runs.push(root)
      resumes.push(runOptions.resume === true)
      return new Promise((resolve) => pending.set(root, resolve))
    },
    isReady: (root) => ready.get(root) !== false,
    inWorkspace: (root) => Promise.resolve(!outside.has(root)),
    automatic: () => options.automatic !== false,
    onChange: (root, status) => changes.push({ root, status }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    log: () => undefined,
  }
  return {
    deps,
    runs,
    resumes,
    recorded,
    changes,
    finish(root, outcome) {
      const resolve = pending.get(root)
      if (resolve === undefined) throw new Error(`no run in flight for ${root}`)
      pending.delete(root)
      resolve(outcome)
    },
    setReady: (root, value) => ready.set(root, value),
    setHas: (root, value) => has.set(root, value),
    setWorkspace: (root, inside) => (inside ? outside.delete(root) : outside.add(root)),
  }
}

describe('the sweep queue', () => {
  it('runs ONE sweep at a time by default, in order', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b', '/c'])
    await flush()
    expect(h.runs).toEqual(['/a'])
    expect(bd.status('/b')).toBe('queued')
    h.finish('/a', { kind: 'done', learned: 2, failed: 0 })
    await flush()
    expect(h.runs).toEqual(['/a', '/b'])
    expect(bd.status('/a')).toBe('done')
    expect(h.recorded).toEqual(['/a'])
  })

  it('honours a larger bound when given one', async () => {
    const h = harness({ maxConcurrent: 2 })
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b', '/c'])
    await flush()
    expect(h.runs).toEqual(['/a', '/b'])
  })

  it('skips projects that already have basic discovery and projects outside every Workspace', async () => {
    const h = harness()
    h.setHas('/a', true)
    h.setWorkspace('/b', false)
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b', '/c'])
    await flush()
    expect(h.runs).toEqual(['/c'])
    expect(bd.status('/a')).toBe('done')
    expect(bd.status('/b')).toBe('not-required')
  })

  it('does nothing at all when the automatic layer is off', async () => {
    const h = harness({ automatic: false })
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a'])
    const answer = await bd.require(['/a'], { priority: true })
    await flush()
    expect(h.runs).toEqual([])
    expect(answer.learning).toEqual([])
    expect(bd.isDeferred('/a')).toBe(false)
  })

  it('a reconcile on the next launch re-queues a project whose sweep never finished (restart re-check)', async () => {
    const first = harness()
    const before = createBasicDiscovery(first.deps)
    await before.reconcile(['/a'])
    await flush()
    expect(first.runs).toEqual(['/a'])
    // The app quits mid-sweep: nothing was recorded, so a new process asks again.
    const second = harness()
    const after = createBasicDiscovery(second.deps)
    await after.reconcile(['/a'])
    await flush()
    expect(second.runs).toEqual(['/a'])
  })

  it('parks a project that is not ready and runs it once it is', async () => {
    const h = harness()
    h.setReady('/a', false)
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b'])
    await flush()
    expect(h.runs).toEqual(['/b'])
    expect(bd.status('/a')).toBe('queued')
    h.setReady('/a', true)
    bd.rootReady('/a')
    h.finish('/b', { kind: 'done', learned: 1, failed: 0 })
    await flush()
    expect(h.runs).toEqual(['/b', '/a'])
  })

  it('a priority request jumps the queue', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b', '/c'])
    await bd.require(['/c'], { priority: true })
    h.finish('/a', { kind: 'done', learned: 1, failed: 0 })
    await flush()
    expect(h.runs).toEqual(['/a', '/c'])
  })

  it('joins a sweep already queued instead of starting a second one', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.require(['/a'])
    await bd.require(['/a'])
    await bd.reconcile(['/a'])
    await flush()
    expect(h.runs).toEqual(['/a'])
  })
})

describe('waiting on a sweep', () => {
  it('resolves ok when the sweep is done, and the project stops being deferred', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    const { learning } = await bd.require(['/a'], { priority: true })
    expect(learning).toEqual(['/a'])
    expect(bd.isDeferred('/a')).toBe(true)
    const settled = bd.whenSettled('/a')
    await flush()
    h.finish('/a', { kind: 'done', learned: 3, failed: 1 })
    await expect(settled).resolves.toEqual({ ok: true })
    expect(bd.isDeferred('/a')).toBe(false)
  })

  it('resolves with a reason when the sweep fails; a retry runs it again and resumes', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.require(['/a'], { priority: true })
    const settled = bd.whenSettled('/a')
    await flush()
    h.finish('/a', { kind: 'failed', reason: 'None of the 2 parts Flow tried could be learned.' })
    await expect(settled).resolves.toEqual({ ok: false, reason: 'None of the 2 parts Flow tried could be learned.' })
    expect(bd.status('/a')).toBe('failed')
    expect(bd.isDeferred('/a')).toBe(true)
    // Not retried on its own…
    await bd.reconcile(['/a'])
    await flush()
    expect(h.runs).toEqual(['/a'])
    // …only when someone asks.
    await bd.require(['/a'], { priority: true, retry: true })
    await flush()
    expect(h.runs).toEqual(['/a', '/a'])
    expect(h.resumes).toEqual([false, true])
  })

  it('a stopped sweep is a failure a person can retry, never a silent success', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.require(['/a'])
    const settled = bd.whenSettled('/a')
    await flush()
    h.finish('/a', { kind: 'cancelled' })
    const answer = await settled
    expect(answer.ok).toBe(false)
    expect(h.recorded).toEqual([])
  })

  it('a project that already has its discovery answers at once', async () => {
    const h = harness()
    h.setHas('/a', true)
    const bd = createBasicDiscovery(h.deps)
    const { learning } = await bd.require(['/a'])
    expect(learning).toEqual([])
    await expect(bd.whenSettled('/a')).resolves.toEqual({ ok: true })
  })

  it('announces every status change', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.require(['/a'])
    await flush()
    h.finish('/a', { kind: 'done', learned: 1, failed: 0 })
    await flush()
    expect(h.changes.map((change) => change.status)).toEqual(['queued', 'running', 'done'])
  })

  it('forget drops a queued project and fails its waiters', async () => {
    const h = harness()
    const bd = createBasicDiscovery(h.deps)
    await bd.reconcile(['/a', '/b'])
    const settled = bd.whenSettled('/b')
    bd.forget('/b')
    await expect(settled).resolves.toMatchObject({ ok: false })
    h.finish('/a', { kind: 'done', learned: 1, failed: 0 })
    await flush()
    expect(h.runs).toEqual(['/a'])
  })
})

describe('shouldAskBasicDiscovery — the consent card is gone for Workspace projects', () => {
  const base = { answered: false, askedThisSession: false, automatic: true, inWorkspace: true }

  it('never asks about a Workspace project — it is swept on its own', () => {
    expect(shouldAskBasicDiscovery(base)).toBe(false)
  })

  it('still asks once about a project outside every Workspace, or when nothing sweeps automatically', () => {
    expect(shouldAskBasicDiscovery({ ...base, inWorkspace: false })).toBe(true)
    expect(shouldAskBasicDiscovery({ ...base, automatic: false })).toBe(true)
  })

  it('never asks twice, nor after an answer', () => {
    expect(shouldAskBasicDiscovery({ ...base, inWorkspace: false, answered: true })).toBe(false)
    expect(shouldAskBasicDiscovery({ ...base, inWorkspace: false, askedThisSession: true })).toBe(false)
  })
})
