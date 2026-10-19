// learn-triggers — pure decision core + the always-on staleness class driven
// with injected timers/clock (no fs, no spawn, no Electron).

import type { BlueprintLearningEntry, BlueprintLearningStatus } from '../../shared/ipc-contract'
import {
  enqueueJob,
  initialQueueState,
  takeNext,
  type LearnJob,
} from '../project/learn-orchestrator'
import { makeLearningStateFake } from '../project/learning-state-fake'
import {
  LearnTriggers,
  collectTouchedModules,
  isCommentOnlyDiff,
  isMeaningfulDiff,
  isPreviouslyLearned,
  mapFileToModule,
  parseNumstatTotal,
  parseStaleCheckJson,
  reportIsStale,
  shouldAutoRelearn,
  staleEntry,
  type FilesChangedBatch,
  type ModuleStaleContext,
  type StaleCheckReport,
  type TimerHandle,
} from './learn-triggers'

// ── Pure: file → module mapping ─────────────────────────────────────────────

describe('mapFileToModule', () => {
  const modules = ['app/src', 'src', 'scripts']

  it('maps a file to its containing depth-1 module', () => {
    expect(mapFileToModule('src/foo/bar.ts', modules)).toBe('src')
    expect(mapFileToModule('app/src/main/x.ts', modules)).toBe('app/src')
    expect(mapFileToModule('scripts/build.mjs', modules)).toBe('scripts')
  })

  it('maps a file equal to the module directory itself', () => {
    expect(mapFileToModule('src', modules)).toBe('src')
  })

  it('prefers the LONGEST (most specific) matching module when nested', () => {
    // app/src is longer than src → the deeper spine root wins.
    expect(mapFileToModule('app/src/main/x.ts', ['src', 'app/src'])).toBe('app/src')
  })

  it('returns undefined for a file outside every module', () => {
    expect(mapFileToModule('README.md', modules)).toBeUndefined()
    expect(mapFileToModule('other/x.ts', modules)).toBeUndefined()
  })

  it('does not treat a sibling prefix as containment', () => {
    // "src-gen/x" must NOT map to "src".
    expect(mapFileToModule('src-gen/x.ts', ['src'])).toBeUndefined()
  })

  it('tolerates a trailing slash on the module path', () => {
    expect(mapFileToModule('src/x.ts', ['src/'])).toBe('src')
  })

  it('normalizes windows separators', () => {
    expect(mapFileToModule('src\\foo\\bar.ts', ['src'])).toBe('src')
  })
})

describe('collectTouchedModules', () => {
  const root = '/repo'
  const modules = ['app/src', 'src']

  const batch = (paths: string[]): FilesChangedBatch => ({
    rootPath: root,
    changes: paths.map((path) => ({ path })),
  })

  it('filters to source files and maps them to distinct modules, sorted', () => {
    const result = collectTouchedModules(
      batch([
        '/repo/src/a.ts',
        '/repo/src/b.ts', // same module → deduped
        '/repo/app/src/c.tsx',
        '/repo/README.md', // not a source file → dropped
        '/repo/notes.txt', // not a source file → dropped
      ]),
      modules,
    )
    expect(result).toEqual(['app/src', 'src'])
  })

  it('includes deleted source files (a deletion can drift a note)', () => {
    expect(collectTouchedModules(batch(['/repo/src/gone.ts']), modules)).toEqual(['src'])
  })

  it('drops files outside the module spine', () => {
    expect(collectTouchedModules(batch(['/repo/other/x.ts']), modules)).toEqual([])
  })

  it('drops paths outside the root', () => {
    expect(collectTouchedModules(batch(['/elsewhere/src/x.ts']), modules)).toEqual([])
  })

  it('returns empty for an empty batch', () => {
    expect(collectTouchedModules(batch([]), modules)).toEqual([])
  })
})

// ── Pure: stale-report interpretation ───────────────────────────────────────

const emptyReport: StaleCheckReport = { checked: 3, fresh: 3, stale: [] }
const staleReport: StaleCheckReport = {
  checked: 2,
  fresh: 1,
  stale: [{ fingerprint: 'fp1', anchors: [], changedFiles: ['src/a.ts'], missingFiles: [] }],
}

describe('reportIsStale', () => {
  it('is false for null and for a fresh report', () => {
    expect(reportIsStale(null)).toBe(false)
    expect(reportIsStale(emptyReport)).toBe(false)
  })
  it('is true when at least one note drifted', () => {
    expect(reportIsStale(staleReport)).toBe(true)
  })
})

describe('staleEntry', () => {
  it('builds a stale learning-state entry with an ISO timestamp', () => {
    const now = new Date('2026-07-15T12:00:00.000Z')
    expect(staleEntry('src', now)).toEqual({
      module: 'src',
      status: 'stale',
      notedAt: '2026-07-15T12:00:00.000Z',
    })
  })
})

describe('parseStaleCheckJson', () => {
  it('parses a well-formed report', () => {
    const raw = JSON.stringify(staleReport)
    expect(parseStaleCheckJson(raw)).toEqual(staleReport)
  })

  it('returns null for non-JSON', () => {
    expect(parseStaleCheckJson('not json')).toBeNull()
    expect(parseStaleCheckJson('')).toBeNull()
  })

  it('returns null when stale is not an array', () => {
    expect(parseStaleCheckJson(JSON.stringify({ checked: 1, fresh: 1 }))).toBeNull()
    expect(parseStaleCheckJson(JSON.stringify([1, 2, 3]))).toBeNull()
  })

  it('coerces missing fields defensively', () => {
    const parsed = parseStaleCheckJson(JSON.stringify({ stale: [{ fingerprint: 'x' }] }))
    expect(parsed).toEqual({
      checked: 1,
      fresh: 0,
      stale: [{ fingerprint: 'x', anchors: [], changedFiles: [], missingFiles: [] }],
    })
  })

  it('skips non-object stale entries', () => {
    const parsed = parseStaleCheckJson(JSON.stringify({ stale: [null, 'nope', { fingerprint: 'y' }] }))
    expect(parsed?.stale).toHaveLength(1)
  })
})

// ── Pure: meaningful-diff heuristic (task 2) ────────────────────────────────

describe('parseNumstatTotal', () => {
  it('sums added + deleted across files', () => {
    expect(parseNumstatTotal('10\t5\tsrc/a.ts\n3\t2\tsrc/b.ts')).toBe(20)
  })
  it('treats binary (- -) as zero and skips malformed lines', () => {
    expect(parseNumstatTotal('-\t-\tbin.png\n\ngarbage\n4\t1\tx.ts')).toBe(5)
  })
  it('is zero for empty output', () => {
    expect(parseNumstatTotal('')).toBe(0)
  })
})

describe('isCommentOnlyDiff', () => {
  it('is true when every changed line is a comment or blank', () => {
    const diff = ['+++ b/x.ts', '--- a/x.ts', '+// added comment', '-# removed', '+   ', '+ * jsdoc'].join('\n')
    expect(isCommentOnlyDiff(diff)).toBe(true)
  })
  it('is false when any changed line is code', () => {
    const diff = ['+// a comment', '+const x = 1'].join('\n')
    expect(isCommentOnlyDiff(diff)).toBe(false)
  })
  it('ignores the +++/--- file headers', () => {
    const diff = ['+++ b/x.ts', '--- a/x.ts'].join('\n')
    // No real content lines → treated as comment-only (nothing meaningful).
    expect(isCommentOnlyDiff(diff)).toBe(true)
  })
})

describe('isMeaningfulDiff', () => {
  const bigCode = Array.from({ length: 20 }, (_, i) => `+const v${i} = ${i}`).join('\n')

  it('is true for a large non-comment change', () => {
    expect(isMeaningfulDiff('20\t0\tx.ts', bigCode)).toBe(true)
  })
  it('is false below the line threshold even if code', () => {
    expect(isMeaningfulDiff('5\t0\tx.ts', '+const x = 1')).toBe(false)
  })
  it('is false for a large but comment-only change', () => {
    const bigComments = Array.from({ length: 20 }, (_, i) => `+// note ${i}`).join('\n')
    expect(isMeaningfulDiff('20\t0\tx.ts', bigComments)).toBe(false)
  })
})

describe('shouldAutoRelearn / isPreviouslyLearned', () => {
  it('requires all three gates', () => {
    expect(shouldAutoRelearn({ meaningful: true, previouslyLearned: true, autoEnabled: true })).toBe(true)
    expect(shouldAutoRelearn({ meaningful: false, previouslyLearned: true, autoEnabled: true })).toBe(false)
    expect(shouldAutoRelearn({ meaningful: true, previouslyLearned: false, autoEnabled: true })).toBe(false)
    expect(shouldAutoRelearn({ meaningful: true, previouslyLearned: true, autoEnabled: false })).toBe(false)
  })
  it('counts learned/stale as previously learned, not learning/absent', () => {
    expect(isPreviouslyLearned('learned')).toBe(true)
    expect(isPreviouslyLearned('stale')).toBe(true)
    expect(isPreviouslyLearned('learning')).toBe(false)
    expect(isPreviouslyLearned(undefined)).toBe(false)
  })
})

// ── The class, driven with a fake timer + injected effects ──────────────────

/** A controllable fake timer: setTimer records the callback; fire(handle) runs
 *  it. Mirrors how the project file watcher would fire the idle timeout. */
class FakeTimers {
  private seq = 0
  private readonly callbacks = new Map<number, () => void>()

  readonly setTimer = (fn: () => void): TimerHandle => {
    const id = ++this.seq
    this.callbacks.set(id, fn)
    return id
  }

  readonly clearTimer = (handle: TimerHandle): void => {
    this.callbacks.delete(handle as number)
  }

  /** Number of live (un-fired, un-cleared) timers. */
  get live(): number {
    return this.callbacks.size
  }

  /** Fire the most recently-set live timer (there is one per touched module). */
  fireAll(): void {
    const entries = [...this.callbacks.entries()]
    this.callbacks.clear()
    for (const [, fn] of entries) fn()
  }
}

interface Harness {
  triggers: LearnTriggers
  timers: FakeTimers
  emit: (batch: FilesChangedBatch) => void
  writes: BlueprintLearningEntry[][]
  staleContexts: ModuleStaleContext[]
}

function makeHarness(options: {
  report: StaleCheckReport | null
  ready?: boolean
  modules?: string[]
  existing?: BlueprintLearningEntry[]
  onModuleStale?: (ctx: ModuleStaleContext) => void
  /** Ignore-list extras returned by the injected readIgnoreExtras dep — a
   *  rejecting function to probe the fail-soft path. Omit → dep not wired. */
  ignoreExtras?: string[] | (() => Promise<string[]>)
}): Harness {
  const timers = new FakeTimers()
  let listener: ((batch: FilesChangedBatch) => void) | null = null
  const writes: BlueprintLearningEntry[][] = []
  const staleContexts: ModuleStaleContext[] = []
  const store = makeLearningStateFake(options.existing)

  const triggers = new LearnTriggers({
    onFilesChanged: (l) => {
      listener = l
      return () => {
        listener = null
      }
    },
    readModules: async () => options.modules ?? ['src'],
    isRootReady: () => options.ready ?? true,
    runStaleCheck: async () => options.report,
    onModuleStale: options.onModuleStale
      ? (ctx) => {
          staleContexts.push(ctx)
          options.onModuleStale?.(ctx)
        }
      : (ctx) => {
          staleContexts.push(ctx)
        },
    structureDirFor: (rootPath) => `${rootPath}/.structure`,
    // Records what the mutation DECIDED (pre-dedup), which is what the old
    // `writeLearning` fake recorded — the assertions below are about the set the
    // caller composed, not the deduped set the store keeps.
    mutateLearning: (dir, mutate) =>
      store.mutate(dir, async (current) => {
        const next = await mutate(current)
        if (next !== null) writes.push([...next])
        return next
      }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    ...(options.ignoreExtras !== undefined
      ? {
          readIgnoreExtras:
            typeof options.ignoreExtras === 'function'
              ? options.ignoreExtras
              : () => Promise.resolve(options.ignoreExtras as string[]),
        }
      : {}),
  })
  triggers.start()

  return {
    triggers,
    timers,
    emit: (batch) => listener?.(batch),
    writes,
    staleContexts,
  }
}

const oneEdit: FilesChangedBatch = {
  rootPath: '/repo',
  changes: [{ path: '/repo/src/a.ts' }],
}

// A batch handler is async (readModules awaits) — let microtasks drain.
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('LearnTriggers class', () => {
  it('arms one idle timer per touched module and flips the dot on drift', async () => {
    const h = makeHarness({ report: staleReport })
    h.emit(oneEdit)
    await flush()
    expect(h.timers.live).toBe(1)
    expect(h.writes).toHaveLength(0) // nothing until idle fires

    h.timers.fireAll()
    await flush()
    expect(h.writes).toHaveLength(1)
    const written = h.writes[0]
    expect(written[written.length - 1]).toEqual({
      module: 'src',
      status: 'stale',
      notedAt: '2026-07-15T00:00:00.000Z',
    })
  })

  it('does NOT write when the report is fresh', async () => {
    const h = makeHarness({ report: emptyReport })
    h.emit(oneEdit)
    await flush()
    h.timers.fireAll()
    await flush()
    expect(h.writes).toHaveLength(0)
    expect(h.staleContexts).toHaveLength(0)
  })

  it('does NOT write when the stale-check could not run (null)', async () => {
    const h = makeHarness({ report: null })
    h.emit(oneEdit)
    await flush()
    h.timers.fireAll()
    await flush()
    expect(h.writes).toHaveLength(0)
  })

  it('resets the timer on a save burst (one check, not many)', async () => {
    const h = makeHarness({ report: staleReport })
    h.emit(oneEdit)
    await flush()
    h.emit(oneEdit) // second save before idle → resets
    await flush()
    // The first timer was cleared, a new one set → still exactly one live.
    expect(h.timers.live).toBe(1)
    h.timers.fireAll()
    await flush()
    expect(h.writes).toHaveLength(1)
  })

  it('skips entirely when the root is not ready', async () => {
    const h = makeHarness({ report: staleReport, ready: false })
    h.emit(oneEdit)
    await flush()
    expect(h.timers.live).toBe(0)
  })

  it('skips when the root has no modules', async () => {
    const h = makeHarness({ report: staleReport, modules: [] })
    h.emit(oneEdit)
    await flush()
    expect(h.timers.live).toBe(0)
  })

  it('never arms a timer for a default-ignored module (#learn-ignore)', async () => {
    const h = makeHarness({ report: staleReport, modules: ['src', '__mocks__'] })
    h.emit({ rootPath: '/repo', changes: [{ path: '/repo/__mocks__/fetch.ts' }] })
    await flush()
    expect(h.timers.live).toBe(0) // no stale-check ever spawns, no amber dot
    // A real module in the same batch still schedules normally.
    h.emit({
      rootPath: '/repo',
      changes: [{ path: '/repo/__mocks__/fetch.ts' }, { path: '/repo/src/a.ts' }],
    })
    await flush()
    expect(h.timers.live).toBe(1)
    h.timers.fireAll()
    await flush()
    expect(h.writes[0]?.[0]?.module).toBe('src')
  })

  it('never arms a timer for a module matched by the learn_ignore extras', async () => {
    const h = makeHarness({
      report: staleReport,
      modules: ['src', 'vendor'],
      ignoreExtras: ['vendor'],
    })
    h.emit({ rootPath: '/repo', changes: [{ path: '/repo/vendor/sdk.ts' }] })
    await flush()
    expect(h.timers.live).toBe(0)
  })

  it('falls back to the built-in defaults when the extras reader fails (fail-soft)', async () => {
    const h = makeHarness({
      report: staleReport,
      modules: ['src', 'e2e'],
      ignoreExtras: () => Promise.reject(new Error('unreadable flowconfig')),
    })
    h.emit({
      rootPath: '/repo',
      changes: [{ path: '/repo/e2e/admin.spec.ts' }, { path: '/repo/src/a.ts' }],
    })
    await flush()
    expect(h.timers.live).toBe(1) // only src — e2e still ignored by defaults
  })

  it('hands the seam the PRIOR status (before the stale write)', async () => {
    const existing: BlueprintLearningEntry[] = [
      { module: 'src', status: 'learned', notedAt: '2026-07-01T00:00:00.000Z' },
    ]
    const h = makeHarness({ report: staleReport, existing })
    h.emit(oneEdit)
    await flush()
    h.timers.fireAll()
    await flush()
    expect(h.staleContexts).toHaveLength(1)
    expect(h.staleContexts[0].priorStatus).toBe('learned')
    expect(h.staleContexts[0].modulePath).toBe('src')
    expect(h.staleContexts[0].report).toEqual(staleReport)
    // The prior 'learned' entry is preserved alongside the new 'stale' one.
    expect(h.writes[0]).toEqual([...existing, staleEntry('src', new Date('2026-07-15T00:00:00.000Z'))])
  })

  it('reports undefined prior status for a never-learned module', async () => {
    const h = makeHarness({ report: staleReport, existing: undefined })
    h.emit(oneEdit)
    await flush()
    h.timers.fireAll()
    await flush()
    expect(h.staleContexts[0].priorStatus).toBeUndefined()
  })

  it('cancels pending timers on dispose', async () => {
    const h = makeHarness({ report: staleReport })
    h.emit(oneEdit)
    await flush()
    expect(h.timers.live).toBe(1)
    h.triggers.dispose()
    expect(h.timers.live).toBe(0)
  })
})

// ── FR6: drift → auto-relearn gate chain (regression lock) ──────────────────
//
// The agent must re-learn on drift FIRST, reusing the EXISTING Progressive
// Learning T3 gates — never a second policy. Virgin (never-learned) modules
// must NOT be auto-learned (they surface to the human elsewhere).
//
// The live gate chain is the `onModuleStale` closure in app/src/main/index.ts
// (the seam this class calls after a stale dot flips). `decideAutoRelearn`
// below MIRRORS that closure's gates and ORDER exactly — it is the executable
// specification of FR6 and must stay in sync with index.ts. Each gate delegates
// to the SAME pure helper the closure uses (no re-implemented policy):
//   1. isModuleInPlay  → pause-during-runs (isModuleInPlayState, tested in
//                        learn-run-triggers.test.ts)
//   2. isPreviouslyLearned(priorStatus) → virgin skip
//   3. learn_auto toggle
//   4. changedFiles present + git diff resolvable
//   5. isMeaningfulDiff (≥15 non-comment lines)
//   6. shouldAutoRelearn → enqueue as an AUTO item (deliberate:false), which
//      subjects it to the session budget (takeNext, tested in
//      learn-orchestrator.test.ts).
type GateOutcome = 'enqueue-auto' | 'skip'

function decideAutoRelearn(input: {
  inPlay: boolean
  priorStatus: BlueprintLearningStatus | undefined
  autoEnabled: boolean
  changedFiles: readonly string[]
  diff: { numstat: string; unified: string } | null
}): GateOutcome {
  if (input.inPlay) return 'skip'
  const previouslyLearned = isPreviouslyLearned(input.priorStatus)
  if (!previouslyLearned) return 'skip'
  if (!input.autoEnabled) return 'skip'
  if (input.changedFiles.length === 0) return 'skip'
  if (input.diff === null) return 'skip'
  const meaningful = isMeaningfulDiff(input.diff.numstat, input.diff.unified)
  return shouldAutoRelearn({ meaningful, previouslyLearned, autoEnabled: input.autoEnabled })
    ? 'enqueue-auto'
    : 'skip'
}

describe('FR6 drift → auto-relearn gate chain', () => {
  // A meaningful (≥15-line, non-comment) working-tree diff for the drifted file.
  const meaningfulDiff = {
    numstat: '20\t0\tsrc/a.ts',
    unified: Array.from({ length: 20 }, (_, i) => `+const v${i} = ${i}`).join('\n'),
  }
  // Baseline: a previously-learned module with a real drift, not in play, toggle
  // on — the ONLY combination that should auto-relearn.
  const baseline = {
    inPlay: false,
    priorStatus: 'learned' as BlueprintLearningStatus | undefined,
    autoEnabled: true,
    changedFiles: ['src/a.ts'],
    diff: meaningfulDiff,
  }

  it('previously-learned + meaningful drift + not-in-play + toggle on → auto-relearn', () => {
    expect(decideAutoRelearn(baseline)).toBe('enqueue-auto')
  })

  it('virgin module (never learned) + drift → NO auto-relearn', () => {
    expect(decideAutoRelearn({ ...baseline, priorStatus: undefined })).toBe('skip')
    // 'learning' (in-flight, never completed) is also virgin for this gate.
    expect(decideAutoRelearn({ ...baseline, priorStatus: 'learning' })).toBe('skip')
  })

  it('module in play (active run holds it) → NO auto-relearn (paused)', () => {
    expect(decideAutoRelearn({ ...baseline, inPlay: true })).toBe('skip')
  })

  it('learn_auto toggle off → NO auto-relearn', () => {
    expect(decideAutoRelearn({ ...baseline, autoEnabled: false })).toBe('skip')
  })

  it('comment-only or sub-threshold (<15-line) diff → NO auto-relearn', () => {
    const commentOnly = {
      numstat: '20\t0\tsrc/a.ts',
      unified: Array.from({ length: 20 }, (_, i) => `+// note ${i}`).join('\n'),
    }
    expect(decideAutoRelearn({ ...baseline, diff: commentOnly })).toBe('skip')
    const tiny = { numstat: '5\t0\tsrc/a.ts', unified: '+const x = 1' }
    expect(decideAutoRelearn({ ...baseline, diff: tiny })).toBe('skip')
  })

  it('no changed files or unresolvable git diff → NO auto-relearn', () => {
    expect(decideAutoRelearn({ ...baseline, changedFiles: [] })).toBe('skip')
    expect(decideAutoRelearn({ ...baseline, diff: null })).toBe('skip')
  })

  it('an auto-relearn enqueue is subject to the session budget (drops when spent)', () => {
    // The closure enqueues drift re-learns as AUTO (deliberate:false). The
    // orchestrator's real budget admission drops an auto job once the budget is
    // spent — so an exhausted budget yields NO run even when every gate passed.
    expect(decideAutoRelearn(baseline)).toBe('enqueue-auto')
    const autoJob: LearnJob = {
      rootPath: '/repo',
      modulePath: 'src',
      reason: 'stale',
      deliberate: false, // ← the flag that subjects it to the budget
    }
    const BUDGET = 5
    const queued = enqueueJob({ ...initialQueueState(), runsThisSession: BUDGET }, autoJob).state
    expect(takeNext(queued, BUDGET).kind).toBe('dropped')
  })
})

describe('stale-checks do not stampede', () => {
  it('runs one at a time however many modules go idle', async () => {
    // Each check spawns a CLI that re-hashes a module's stamped files —
    // measured at ~7 s of CPU for one root — so a save touching several
    // modules used to mean several of those at once, and a main process too
    // starved to answer anything for 27 seconds.
    const timers = new FakeTimers()
    const listeners: Array<(batch: FilesChangedBatch) => void> = []
    let running = 0
    let peak = 0
    const release: Array<() => void> = []

    const triggers = new LearnTriggers({
      onFilesChanged: (l) => {
        listeners.push(l)
        return () => listeners.splice(listeners.indexOf(l), 1)
      },
      readModules: async () => ['one', 'two', 'three'],
      isRootReady: () => true,
      runStaleCheck: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => release.push(resolve))
        running -= 1
        return null
      },
      structureDirFor: (rootPath) => `${rootPath}/.structure`,
      mutateLearning: makeLearningStateFake().mutate,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    })
    triggers.start()
    try {
      listeners[0]?.({
        rootPath: '/repo',
        changes: [
          { path: '/repo/one/a.ts' },
          { path: '/repo/two/b.ts' },
          { path: '/repo/three/c.ts' },
        ],
      })
      await Promise.resolve()
      timers.fireAll()
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve()
      }
      expect(peak).toBeLessThanOrEqual(1)
      // …and the queue keeps moving: releasing one lets the next start.
      release.shift()?.()
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve()
      }
      expect(peak).toBeLessThanOrEqual(1)
    } finally {
      for (const done of release) done()
      triggers.dispose()
    }
  })
})
