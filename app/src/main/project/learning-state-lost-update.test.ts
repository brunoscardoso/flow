// The learning-state store against a SECOND writer — the app's real call sites,
// a real temp store, a real lock file.
//
// `learning-state.test.ts` proves the store's own primitives hold the lock.
// This proves the CALLERS use them, which is a different claim and the one that
// was false: four call sites did a bare `readLearning…` / `writeLearning…`
// pair, so the read that decided a full rewrite sat outside every critical
// section. Nothing errored — the slower writer simply rewrote the file without
// whatever the other one had put there.
//
// The other writer here stands in for the one the app cannot see: a
// `planflow-ai` verb, or a second orchestrator. It is scripted rather than
// raced, so these fail on unfixed code every time instead of most of the time:
// it takes the lock, READS while the call site is in flight, waits long enough
// that an unlocked call site would have finished its whole read-modify-write,
// and only then rewrites from the view it read. Under a lock the call site is
// still waiting at that point and gets the newer file; without one it already
// wrote, and this rewrite erases it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BlueprintLearningEntry, FlowNotification } from '../../shared/ipc-contract'
import { LearnTriggers, type FilesChangedBatch, type StaleCheckReport } from '../learn/learn-triggers'
import { LearnOrchestrator, type LearnOrchestratorDeps } from './learn-orchestrator'
import {
  readLearningState,
  withLearningStateLock,
  writeLearningState,
} from './learning-state'

const ROOT = '/repo'

/** Long enough that an UNLOCKED call site completes its read-modify-write. */
const OVERLAP_MS = 120

let structureDir: string

beforeEach(() => {
  structureDir = mkdtempSync(join(tmpdir(), 'learning-state-race-'))
})

/** Every orchestrator a test made — disposed before its folder is removed. */
const created: LearnOrchestrator[] = []

afterEach(async () => {
  // A resume folds late calls into a re-run and retries a missing folder on a
  // timer; disposing first means nothing writes into the folder while it is
  // being removed (the full suite saw ENOTEMPTY from exactly that race).
  for (const learn of created.splice(0)) learn.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  rmSync(structureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function entry(
  module: string,
  status: BlueprintLearningEntry['status'],
  notedAt = '2026-01-01T00:00:00.000Z',
): BlueprintLearningEntry {
  return { module, status, notedAt }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `callSite` while a second writer holds the lock and rewrites the store
 * from a view it read BEFORE the call site could have written. Resolves once
 * both are done.
 *
 * `settle` is how the caller waits for a fire-and-forget call site (the queue
 * transitions are not awaitable from outside); it runs after the lock is
 * released.
 */
async function withCompetingWriter(options: {
  callSite: () => void | Promise<void>
  otherEntry: BlueprintLearningEntry
  settle?: () => Promise<void>
}): Promise<BlueprintLearningEntry[]> {
  let open = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })

  // The call site must be started from the TEST's async context, never from
  // inside the holder's callback. The lock is re-entrant per async context —
  // anything begun inside a holder inherits its held set and walks straight in,
  // which is correct for a nested write and useless as a second writer.
  const holder = withLearningStateLock(structureDir, async () => {
    const before = (await readLearningState(structureDir)) ?? []
    await gate
    await writeLearningState(structureDir, [...before, options.otherEntry])
  })
  await delay(20) // the holder has the lock and has read

  const inFlight = Promise.resolve(options.callSite()).then(() => undefined)
  await delay(OVERLAP_MS) // an UNLOCKED call site finishes its whole write here
  open()

  await holder
  await inFlight
  await options.settle?.()
  return (await readLearningState(structureDir)) ?? []
}

/** An orchestrator wired to the REAL store — no learning-state fake. */
function orchestrator(overrides: Partial<LearnOrchestratorDeps> = {}): LearnOrchestrator {
  const deps: LearnOrchestratorDeps = {
    readProjectState: () =>
      Promise.resolve({ graph: null, learning: undefined, investigations: [] }),
    isRootReady: () => true,
    bundledCli: { execPath: '/electron', cliPath: '/planflow-ai.mjs' },
    notify: (_notification: FlowNotification) => undefined,
    structureDirFor: () => structureDir,
    enumerateModuleFiles: () => Promise.resolve([{ path: 'src/a/index.ts', size: 10 }]),
    // Never resolves: the pass must not run to completion and write more
    // transitions while the assertions are being made.
    runPass: () => new Promise(() => undefined),
    runCli: () => Promise.resolve({ ok: true, stdout: '{"notes":[]}' }),
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    onError: () => undefined,
    ...overrides,
  }
  const learn = new LearnOrchestrator(deps)
  created.push(learn)
  return learn
}

/** Wait for `module` to appear in the store, or give up (so a failure reads as
 *  a missing entry rather than a hung suite). */
async function waitForModule(module: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const entries = (await readLearningState(structureDir)) ?? []
    if (entries.some((candidate) => candidate.module === module)) return
    await delay(25)
  }
}

describe('a second writer cannot erase what a call site wrote', () => {
  it('reconcileInterrupted keeps the other writer’s entry, and its own', async () => {
    await writeLearningState(structureDir, [entry('src/a', 'learning')])
    const learn = orchestrator()

    const final = await withCompetingWriter({
      callSite: () => learn.reconcileInterrupted(ROOT),
      // 'stale' is a terminal status: reconcile leaves it alone, so the only
      // thing that can remove it from the file is a rewrite that never saw it.
      otherEntry: entry('src/other', 'stale', '2026-06-02T00:00:00.000Z'),
    })

    const byModule = new Map(final.map((record) => [record.module, record.status]))
    // Unfixed: the reconcile read, flipped and wrote before the other writer's
    // rewrite landed on top of it — so src/a is back to 'learning'.
    expect(byModule.get('src/a')).toBe('stale')
    expect(byModule.get('src/other')).toBe('stale')
  })

  it('resumeInterrupted keeps the other writer’s entry, and its own', async () => {
    await writeLearningState(structureDir, [entry('src/a', 'learning')])
    const learn = orchestrator()

    const final = await withCompetingWriter({
      callSite: () => learn.resumeInterrupted(ROOT),
      otherEntry: entry('src/other', 'stale', '2026-06-02T00:00:00.000Z'),
      settle: () => waitForModule('src/other'),
    })

    const byModule = new Map(final.map((record) => [record.module, record.status]))
    expect(byModule.get('src/a')).toBe('queued') // 'learning' → resumable 'queued'
    expect(byModule.get('src/other')).toBe('stale')
  })

  it('a queue transition keeps the other writer’s entry, and its own', async () => {
    await writeLearningState(structureDir, [entry('src/seed', 'learned')])
    // A SECOND instance, because the per-store write chain only serializes one
    // object's own transitions — the writer it cannot see is the whole point.
    const learn = orchestrator()

    const final = await withCompetingWriter({
      callSite: () => {
        learn.enqueueModule(ROOT, 'src/queued', { reason: 'manual', deliberate: true })
      },
      otherEntry: entry('src/other', 'stale', '2026-06-02T00:00:00.000Z'),
      settle: () => waitForModule('src/queued'),
    })

    const modules = new Set(final.map((record) => record.module))
    expect(modules.has('src/queued')).toBe(true)
    expect(modules.has('src/other')).toBe(true)
    expect(modules.has('src/seed')).toBe(true)
  })

  it('a stale-check flip keeps the other writer’s entry, and its own', async () => {
    await writeLearningState(structureDir, [entry('src/seed', 'learned')])
    const report: StaleCheckReport = {
      checked: 1,
      fresh: 0,
      stale: [{ fingerprint: 'fp1', anchors: [], changedFiles: ['src/a.ts'], missingFiles: [] }],
    }
    let fire: (() => void) | undefined
    let emit: ((batch: FilesChangedBatch) => void) | undefined

    const triggers = new LearnTriggers({
      onFilesChanged: (listener) => {
        emit = listener
        return () => {
          emit = undefined
        }
      },
      readModules: () => Promise.resolve(['src']),
      isRootReady: () => true,
      runStaleCheck: () => Promise.resolve(report),
      structureDirFor: () => structureDir,
      setTimer: (fn: () => void) => {
        fire = fn
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      onError: () => undefined,
    })
    triggers.start()
    emit?.({ rootPath: ROOT, changes: [{ path: `${ROOT}/src/a.ts` }] })
    await delay(10)

    const final = await withCompetingWriter({
      callSite: () => fire?.(),
      otherEntry: entry('src/other', 'queued', '2026-06-02T00:00:00.000Z'),
      settle: () => waitForModule('src'),
    })

    const modules = new Set(final.map((record) => record.module))
    expect(modules.has('src')).toBe(true) // the stale flip survived
    expect(modules.has('src/other')).toBe(true)
    expect(modules.has('src/seed')).toBe(true)
  })
})
