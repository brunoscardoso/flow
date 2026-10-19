import type {
  BlueprintGraph,
  BlueprintLearningEntry,
  BlueprintLearningStatus,
  BlueprintNode,
} from '../../shared/ipc-contract'
import {
  allModuleIds,
  computeLearnProgress,
  formatElapsed,
  formatLearnLogLine,
  formatLearnPercent,
  learnStateLabel,
  unlearnedModules,
  filledSegments,
  lensCoverage,
  PROGRESS_SEGMENTS,
  understoodFraction,
  understoodBySlug,
  learnCountsLabel,
} from './learn-progress-model'

function mod(id: string, depth: number): BlueprintNode {
  return { id, kind: 'module', label: id, sourceFile: id, meta: { depth } }
}
function graph(nodes: BlueprintNode[]): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-17T00:00:00Z',
    coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
    nodes,
    edges: [],
  }
}
function entry(module: string, status: BlueprintLearningStatus, notedAt = '2026-07-17T00:00:00Z'): BlueprintLearningEntry {
  return { module, status, notedAt }
}

describe('allModuleIds', () => {
  it('returns every module node id at ANY depth', () => {
    const g = graph([mod('module:src', 1), mod('module:src/inner', 2), mod('module:src/inner/deep', 3)])
    expect(allModuleIds(g).sort()).toEqual(['module:src', 'module:src/inner', 'module:src/inner/deep'])
  })
  it('is empty for a null graph', () => {
    expect(allModuleIds(null)).toEqual([])
  })
})

describe('computeLearnProgress', () => {
  // 4 module nodes across depths (a,b,c depth-1 + c/deep depth-2).
  const g = graph([mod('module:a', 1), mod('module:b', 1), mod('module:c', 1), mod('module:c/deep', 2)])

  it('percent = learned / ALL modules (any depth), not just depth-1', () => {
    const p = computeLearnProgress(g, [entry('module:a', 'learned'), entry('module:b', 'learning')])
    expect(p.total).toBe(4) // a, b, c, c/deep — the whole learnable universe
    expect(p.learned).toBe(1)
    expect(p.learning).toBe(1)
    expect(p.percent).toBe(25) // round(1/4 * 100)
    expect(p.active).toBe(true)
  })

  // The reported bug (#learn-progress): the orchestrator writes BARE module paths
  // (`src`, `src/lib`) but graph node ids are PREFIXED (`module:src`), so the two
  // never matched — the panel showed rows LEARNED yet the header read "0/1, 0%".
  it('matches BARE learning entries against PREFIXED graph module ids (0% bug)', () => {
    const nested = graph([mod('module:src', 1), mod('module:src/lib', 2), mod('module:src/api', 2)])
    const p = computeLearnProgress(nested, [entry('src', 'learned'), entry('src/lib', 'learned')])
    expect(p.total).toBe(3)
    expect(p.learned).toBe(2) // src + src/lib recognized despite the module: prefix gap
    // `percent` is the RAW ratio now (the bar wants it unrounded); the label
    // decides precision — see formatLearnPercent.
    expect(p.percent).toBeCloseTo(66.67, 1) // 2/3 — NOT 0
    expect(p.percentLabel).toBe('67%')
    // No phantom duplicate: `src` appears once (not as both `module:src` NONE and `src` LEARNED).
    expect(p.rows.filter((r) => r.module === 'src')).toHaveLength(1)
    expect(p.rows.some((r) => r.module === 'module:src')).toBe(false)
  })

  it('counts a learned module MISSING from a limited graph (union denominator)', () => {
    // "Structure limited — building code graph…": the graph may lack a module the
    // user already learned. The union keeps it in both numerator and denominator.
    const limited = graph([mod('module:a', 1)])
    const p = computeLearnProgress(limited, [entry('a', 'learned'), entry('orphan/mod', 'learned')])
    expect(p.total).toBe(2)
    expect(p.learned).toBe(2)
    expect(p.percent).toBe(100)
  })

  it('is 0% with no learning entries; every module row is none', () => {
    const p = computeLearnProgress(g, [])
    expect(p.percent).toBe(0)
    expect(p.active).toBe(false)
    expect(p.total).toBe(4)
    expect(p.rows.map((r) => r.status)).toEqual(['none', 'none', 'none', 'none'])
  })

  it('is 100% only when EVERY module (all depths) is learned', () => {
    const p = computeLearnProgress(g, [
      entry('a', 'learned'),
      entry('b', 'learned'),
      entry('c', 'learned'),
      entry('c/deep', 'learned'),
    ])
    expect(p.percent).toBe(100)
    expect(p.active).toBe(false)
  })

  it('orders rows active-first (learning, queued, stale, learned, none)', () => {
    const p = computeLearnProgress(g, [
      entry('a', 'learned'),
      entry('b', 'learning'),
      entry('c', 'queued'),
    ])
    expect(p.rows.map((r) => `${r.status}:${r.module}`)).toEqual([
      'learning:b',
      'queued:c',
      'learned:a',
      'none:c/deep',
    ])
  })

  it('handles a null graph as empty', () => {
    const p = computeLearnProgress(null, [])
    expect(p).toMatchObject({ total: 0, learned: 0, percent: 0, active: false, rows: [] })
  })
})

describe('computeLearnProgress — learning ignore list (#learn-ignore)', () => {
  // src + lib are real; __mocks__ hits the built-in defaults; vendor only via extras.
  const g = graph([
    mod('module:src', 1),
    mod('module:lib', 1),
    mod('module:__mocks__', 1),
    mod('module:vendor', 1),
  ])

  it('excludes default-ignored modules from numerator AND denominator', () => {
    const p = computeLearnProgress(g, [entry('src', 'learned'), entry('__mocks__', 'learned')])
    expect(p.total).toBe(3) // src, lib, vendor — __mocks__ out of the universe
    expect(p.learned).toBe(1) // the ignored learned entry does not count
    expect(p.percent).toBeCloseTo(33.33, 1)
    expect(p.percentLabel).toBe('33%')
  })

  it('excludes extra-pattern modules when extras are passed', () => {
    const p = computeLearnProgress(g, [entry('src', 'learned')], ['vendor'])
    expect(p.total).toBe(2) // src, lib
    expect(p.learned).toBe(1)
    expect(p.percent).toBe(50)
  })

  // #1450 narrowed this: it used to assert that EVERY ignored module with no
  // entry loses its row, which is right for a built-in ignore and was the bug
  // for a user-added one — the row the user clicked Ignore on simply vanished.
  // Who ignored it now decides; see the #1450 block below for the other half.
  it('drops BUILT-IN ignored modules with no entry entirely (no row)', () => {
    const p = computeLearnProgress(g, [], ['vendor'])
    expect(p.rows.some((r) => r.module === '__mocks__')).toBe(false)
  })

  it('renders an ignored row (not stale/learned noise) for a PRIOR entry, sorted last', () => {
    const p = computeLearnProgress(
      g,
      [entry('__mocks__', 'learned'), entry('vendor', 'stale')],
      ['vendor'],
    )
    const byModule = new Map(p.rows.map((r) => [r.module, r.status]))
    expect(byModule.get('__mocks__')).toBe('ignored')
    expect(byModule.get('vendor')).toBe('ignored')
    expect(p.rows.slice(-2).map((r) => r.status)).toEqual(['ignored', 'ignored'])
    expect(p.stale).toBe(0) // the ignored stale entry is not counted
  })

  it('keeps an in-flight status visible for a deliberate manual Learn of an ignored module', () => {
    const p = computeLearnProgress(g, [entry('__mocks__', 'learning')])
    const row = p.rows.find((r) => r.module === '__mocks__')
    expect(row?.status).toBe('learning') // the override stays visible…
    expect(p.learning).toBe(0) // …but still counts toward nothing
    expect(p.active).toBe(true)
  })

  it('never enqueues ignored modules from Learn all', () => {
    const p = computeLearnProgress(g, [entry('vendor', 'stale')], ['vendor'])
    expect(unlearnedModules(p).sort()).toEqual(['lib', 'src']) // no __mocks__, no vendor
  })

  it('excludes dot-dir modules (.cursor, .github) by default — counts AND Learn all', () => {
    const dotted = graph([
      mod('module:src', 1),
      mod('module:.cursor', 1),
      mod('module:.github', 1),
    ])
    const p = computeLearnProgress(dotted, [entry('.cursor', 'learned')])
    expect(p.total).toBe(1) // src only — dot-dirs out of the universe
    expect(p.learned).toBe(0) // the dot-dir learned entry does not count
    expect(unlearnedModules(p)).toEqual(['src'])
    const byModule = new Map(p.rows.map((r) => [r.module, r.status]))
    expect(byModule.get('.cursor')).toBe('ignored') // prior entry → IGNORED pill
    expect(p.rows.some((r) => r.module === '.github')).toBe(false) // no entry → invisible
  })
})

describe('unlearnedModules (Learn all target)', () => {
  const g = graph([mod('module:a', 1), mod('module:b', 1), mod('module:c', 1), mod('module:d', 1)])

  it('returns only none + stale modules (excludes learned and in-flight)', () => {
    const p = computeLearnProgress(g, [
      entry('a', 'learned'), // done — excluded
      entry('b', 'learning'), // in-flight — excluded
      entry('c', 'stale'), // needs re-learn — included
      // d has no entry → 'none' — included
    ])
    expect(unlearnedModules(p).sort()).toEqual(['c', 'd'])
  })

  it('is empty when everything is learned (Learn all → nothing to do)', () => {
    const p = computeLearnProgress(g, [
      entry('a', 'learned'),
      entry('b', 'learned'),
      entry('c', 'learned'),
      entry('d', 'learned'),
    ])
    expect(unlearnedModules(p)).toEqual([])
  })

  it('returns every module when none are learned', () => {
    const p = computeLearnProgress(g, [])
    expect(unlearnedModules(p).sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ── #1450: a user-added ignore must not delete the row that offered it ───────
//
// The old rule was "ignored + no learning entry → no row". Right for built-in
// ignores (scaffolding, tests, dot-dirs — never learned, never worth listing);
// wrong for a user-added one, because Ignore is clicked ON a row and on a fresh
// project every module is `none`. The row vanished — no pill, no toast, no undo,
// the count sliding 0/6 → 0/5 — while the module stayed drawn on the code map
// directly above, and the panel's own Unignore action became unreachable for
// exactly the modules a user is most likely to ignore.
describe('user-added vs built-in ignores (#1450)', () => {
  const g = graph([
    mod('module:src/billing', 1),
    mod('module:src/auth', 1),
    mod('module:src/__tests__', 1),
  ])

  const rowFor = (p: ReturnType<typeof computeLearnProgress>, module: string) =>
    p.rows.find((row) => row.module === module)

  it('keeps a user-ignored module as an `ignored` row, even never-learned', () => {
    const p = computeLearnProgress(g, [], ['src/billing'])
    expect(rowFor(p, 'src/billing')?.status).toBe('ignored')
  })

  it('still hides a built-in ignore that was never learned', () => {
    expect(computeLearnProgress(g, [], []).rows.map((r) => r.module)).not.toContain(
      'src/__tests__',
    )
  })

  it('keeps a built-in ignore visible once it HAS been learned (unchanged)', () => {
    const p = computeLearnProgress(g, [entry('module:src/__tests__', 'learned')], [])
    expect(rowFor(p, 'src/__tests__')?.status).toBe('ignored')
  })

  it('leaves the denominator alone — an ignored module is not remaining work', () => {
    const before = computeLearnProgress(g, [], [])
    const after = computeLearnProgress(g, [], ['src/billing'])
    expect(after.total).toBe(before.total - 1)
  })

  it('shows an in-flight learn as in-flight, not as ignored', () => {
    const p = computeLearnProgress(g, [entry('module:src/billing', 'learning')], ['src/billing'])
    expect(rowFor(p, 'src/billing')?.status).toBe('learning')
  })

  it('matches a prefix pattern, so ignoring a parent keeps its children listed', () => {
    const p = computeLearnProgress(g, [], ['src'])
    expect(rowFor(p, 'src/billing')?.status).toBe('ignored')
    expect(rowFor(p, 'src/auth')?.status).toBe('ignored')
  })
})

describe('learnStateLabel — the answer the panel never gave', () => {
  const idle = { running: false, paused: false, activeModule: null, queued: 0 }

  it('says idle when nothing is running, however the file reads', () => {
    // The reported bug: three rows saying 'queued' kept the panel on
    // "Learning…" for fifteen hours with nothing running at all.
    expect(learnStateLabel(idle, false)).toBe('Idle')
    expect(learnStateLabel({ ...idle, queued: 3 }, false)).toBe('Idle · 3 queued')
  })

  it('names the module while a pass is running', () => {
    expect(learnStateLabel({ ...idle, running: true, activeModule: 'src/app' }, false)).toBe(
      'Learning src/app',
    )
    // …and how much is behind it: "Learning flow/resources" with 356 modules
    // queued read as almost done, and was hours from it.
    expect(
      learnStateLabel({ running: true, paused: false, activeModule: 'src/app', queued: 356 }, false),
    ).toBe('Learning src/app · 356 queued')
    // Running with no module named is still running.
    expect(learnStateLabel({ ...idle, running: true }, false)).toBe('Learning')
  })

  it('says paused, and how much is waiting', () => {
    expect(learnStateLabel({ ...idle, queued: 2 }, true)).toBe('Paused · 2 queued')
    expect(learnStateLabel(idle, true)).toBe('Paused')
  })
})

describe('what Learn all does first', () => {
  it('takes the shallowest modules first — the trunk before the leaves', () => {
    // A real queue ran in row order: flow/resources, then src/app/api/audio,
    // then src/app/api/audit… so an hour in, the map had leaves and no trunk.
    const progress = {
      total: 4,
      learned: 0,
      learning: 0,
      queued: 0,
      stale: 0,
      percent: 0,
      percentLabel: '0%',
      active: false,
      rows: [
        { module: 'src/app/api/audio', status: 'none' as const },
        { module: 'src', status: 'none' as const },
        { module: 'src/app/api', status: 'stale' as const },
        { module: 'src/app', status: 'none' as const },
      ],
    }
    expect(unlearnedModules(progress)).toEqual([
      'src',
      'src/app',
      'src/app/api',
      'src/app/api/audio',
    ])
  })
})

describe('formatLearnPercent — a number that moves when work happens', () => {
  it('shows two decimals when a module is worth less than half a point', () => {
    // The reported case: 360 modules, so one is 0.28% and a dozen finished
    // could leave the panel on "1%" — a number that said nothing was
    // happening while something was.
    expect(formatLearnPercent(4, 360)).toBe('1.11%')
    expect(formatLearnPercent(5, 360)).toBe('1.39%')
    expect(formatLearnPercent(6, 360)).toBe('1.67%')
  })

  it('does not decorate a small project with false precision', () => {
    // Twelve modules: each is 8.3%, and "16.67%" would be noise.
    expect(formatLearnPercent(2, 12)).toBe('17%')
    expect(formatLearnPercent(1, 4)).toBe('25%')
  })

  it('uses one decimal in between', () => {
    expect(formatLearnPercent(7, 60)).toBe('11.7%')
  })

  it('answers 0% for an empty project rather than dividing by nothing', () => {
    expect(formatLearnPercent(0, 0)).toBe('0%')
    expect(formatLearnPercent(3, 0)).toBe('0%')
  })

  it('reaches a clean 100% at the end', () => {
    expect(formatLearnPercent(360, 360)).toBe('100.00%')
    expect(formatLearnPercent(12, 12)).toBe('100%')
  })
})

describe('the activity log, as a person reads it', () => {
  const at = new Date('2026-08-20T10:02:54.000Z').getTime()

  it('prints what happened, not a path column', () => {
    // A log where every line starts with /Users/name/Projects/… is a column of
    // noise with the answer off the right edge.
    const line = formatLearnLogLine({
      at,
      kind: 'read',
      module: 'src',
      detail: '/Users/qa/Projects/app/src/components/skill-builder/hooks/index.ts',
    })
    expect(line).toContain('src — reading')
    expect(line).toContain('hooks/index.ts')
    expect(line).not.toContain('/Users/qa')
  })

  it('names each kind in plain words', () => {
    expect(formatLearnLogLine({ at, kind: 'start', module: 'src' })).toContain('started src')
    expect(formatLearnLogLine({ at, kind: 'learned', module: 'src' })).toContain('learned src')
    expect(
      formatLearnLogLine({ at, kind: 'stopped', module: 'src', detail: 'took too long' }),
    ).toContain('stopped src — took too long')
    expect(
      formatLearnLogLine({ at, kind: 'queued', module: 'src/types', detail: 'stale' }),
    ).toContain('queued src/types (stale)')
  })
})

describe('formatElapsed — how long this one has been going', () => {
  it('reads as a person would say it', () => {
    expect(formatElapsed(6_000)).toBe('6s')
    expect(formatElapsed(372_000)).toBe('6m 12s')
    expect(formatElapsed(60_000)).toBe('1m 0s')
  })

  it('says nothing rather than something wrong', () => {
    expect(formatElapsed(Number.NaN)).toBe('')
    expect(formatElapsed(-5)).toBe('')
  })
})

describe('the headline while a pass runs', () => {
  it('carries the elapsed time and the queue', () => {
    // The reported state: six minutes on one module, with no way on screen to
    // tell that from six seconds.
    const started = Date.now() - 372_000
    const label = learnStateLabel(
      { running: true, paused: false, activeModule: 'src', queued: 8, startedAt: started },
      false,
    )
    expect(label).toMatch(/^Learning src · 6m \d+s · 8 queued$/)
  })
})

describe('learnStateLabel — whose pass is this (2026-08-27)', () => {
  const running = (activeRoot: string | null, startedAt: number) => ({
    running: true,
    paused: false,
    activeModule: 'orbit_core/web/api/v1',
    activeRoot,
    queued: 4,
    startedAt,
  })

  it('narrates the module when the pass belongs to the project on screen', () => {
    const label = learnStateLabel(running('/repo/a', Date.now() - 171_000), false, '/repo/a')
    expect(label).toContain('Learning orbit_core/web/api/v1')
    expect(label).toContain('4 queued')
  })

  it('does NOT narrate another project’s pass as this one’s', () => {
    // The defect: the panel read "Learning orbit_core/web/api/v1 · 2m 51s"
    // while Stop and Reset did nothing, because they only reach the root the
    // board is viewing and the pass belonged to a different one. The screen
    // described one project and its buttons were aimed at another.
    const label = learnStateLabel(running('/work/orbit-core', Date.now() - 171_000), false, '/repo/a')
    expect(label).not.toContain('orbit_core/web/api/v1')
    expect(label).toContain('Another project is learning')
    // It NAMES the project, so the reader can go to it rather than wondering.
    expect(label).toContain('orbit-core')
    // The elapsed time is still true and still useful.
    expect(label).toContain('2m 51s')
  })

  it('keeps the old label when there is nothing to compare', () => {
    // No viewedRoot, or an answer from before `activeRoot` existed: there is no
    // comparison to make, so claiming "another project" would be the guess.
    expect(learnStateLabel(running('/work/x', Date.now()), false)).toContain('Learning orbit_core')
    expect(learnStateLabel(running(null, Date.now()), false, '/repo/a')).toContain(
      'Learning orbit_core',
    )
  })

  it('is unchanged when the pass is this project’s own, root known on both sides', () => {
    const same = learnStateLabel(running('/repo/a', Date.now()), false, '/repo/a')
    expect(same).not.toContain('Another project')
  })
})

describe('learnStateLabel — the node pipeline is learning too (2026-08-27)', () => {
  const idle = { running: false, paused: false, activeModule: null, activeRoot: null, queued: 0, startedAt: null }

  it('reports a feature pass instead of claiming idle', () => {
    // Reported live: "i started the learning of the node, but this is not
    // reflecting on the learning, this is not connected?" — a panel titled
    // Learning read "Idle · 0/362" while an understand pass ran, because only
    // the orchestrator's module queue reaches `learn:status`.
    const label = learnStateLabel(idle, false, '/repo/a', { featureName: 'Connectors' })
    expect(label).toBe('Understanding Connectors')
    expect(label).not.toContain('Idle')
  })

  it('still says how much module work is waiting behind it', () => {
    const label = learnStateLabel({ ...idle, queued: 4 }, false, '/repo/a', { featureName: 'Connectors' })
    expect(label).toContain('Understanding Connectors')
    expect(label).toContain('4 queued')
  })

  it('yields to a running module pass — the counter beside it is about that one', () => {
    const live = { ...idle, running: true, activeModule: 'src/api', activeRoot: '/repo/a', startedAt: Date.now() }
    expect(learnStateLabel(live, false, '/repo/a', { featureName: 'Connectors' })).toContain('Learning src/api')
  })

  it('is unchanged when no feature pass is running', () => {
    expect(learnStateLabel(idle, false, '/repo/a', null)).toBe('Idle')
    expect(learnStateLabel(idle, false, '/repo/a')).toBe('Idle')
  })
})

describe('filledSegments — a collar that only shows a real fraction (2026-08-27)', () => {
  // The tick count is a constant, not a literal: these read in TENTHS by
  // passing 10 explicitly, and the default is exercised on its own below.
  // Hardcoding it is how they went red when the collar went from ten arcs to
  // sixty ticks — the function was right and the tests had a number in them.
  it('maps a fraction onto segments', () => {
    expect(filledSegments(0, 10, 10)).toBe(0)
    expect(filledSegments(3, 10, 10)).toBe(3)
    expect(filledSegments(10, 10, 10)).toBe(10)
  })

  it('fills the default collar proportionally', () => {
    expect(filledSegments(0, 100)).toBe(0)
    expect(filledSegments(50, 100)).toBe(PROGRESS_SEGMENTS / 2)
    expect(filledSegments(100, 100)).toBe(PROGRESS_SEGMENTS)
  })

  it('never reads full while work remains', () => {
    // A full collar beside a running pass is the same lie as a percentage
    // stuck at 99 — the last tick lands when the last part does.
    expect(filledSegments(39, 40, 10)).toBe(9)
    expect(filledSegments(99, 100)).toBe(PROGRESS_SEGMENTS - 1)
  })

  it('never reads empty once something has landed', () => {
    // 1 of 40 is less than half a segment; rounding it away shows a reader who
    // has waited minutes exactly what they started with.
    expect(filledSegments(1, 40, 10)).toBe(1)
    expect(filledSegments(1, 1000)).toBe(1)
  })

  it('says NOTHING rather than guessing when there is no fraction', () => {
    // The caller shows the indeterminate collar for these — a pass whose parts
    // are not named yet knows no total, and a made-up total is the one number
    // a reader would actually act on.
    expect(filledSegments(0, 0)).toBeNull()
    expect(filledSegments(5, -1)).toBeNull()
    expect(filledSegments(Number.NaN, 10)).toBeNull()
    expect(filledSegments(1, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('clamps a count that overshoots its total', () => {
    expect(filledSegments(12, 10, 10)).toBe(10)
    expect(filledSegments(-3, 10, 10)).toBe(0)
  })
})

describe('understoodFraction', () => {
  const nodes = [
    { kind: 'core' as const, understanding: 'learned' as const },
    { kind: 'core' as const, understanding: 'learned' as const },
    { kind: 'core' as const, understanding: 'none' as const },
    { kind: 'core' as const, understanding: 'stale' as const },
    { kind: 'child' as const, understanding: 'learned' as const },
    { kind: 'part' as const, understanding: 'learned' as const, partOf: 'chats' },
    { kind: 'part' as const, understanding: 'none' as const, partOf: 'chats' },
    { kind: 'part' as const, understanding: 'learned' as const, partOf: 'connectors' },
  ]

  it('counts the features on the ring, not the changes parented to them', () => {
    // A `child` is a PLAN that touched a feature, carried in the graph for its
    // parent link and drawn on no ring. Counting it would put work in the
    // denominator that no ring ever shows.
    expect(understoodFraction(nodes, 'features')).toEqual({ done: 2, total: 4 })
  })

  it('counts only the parts of the feature asked about', () => {
    expect(understoodFraction(nodes, { partsOf: 'chats' })).toEqual({ done: 1, total: 2 })
    expect(understoodFraction(nodes, { partsOf: 'connectors' })).toEqual({ done: 1, total: 1 })
  })

  it('does not count stale as done', () => {
    // It was learned once and the code moved underneath it. Counting it would
    // report a project as finished at the moment it started drifting.
    const stale = [{ kind: 'core' as const, understanding: 'stale' as const }]
    expect(understoodFraction(stale, 'features')).toEqual({ done: 0, total: 1 })
  })

  it('returns null rather than 0/0 when there is nothing to count', () => {
    // 0/0 is not 0% — it is no question. A collar given null marches instead of
    // reporting a figure nothing computed.
    expect(understoodFraction([], 'features')).toBeNull()
    expect(understoodFraction(null, 'features')).toBeNull()
    expect(understoodFraction(nodes, { partsOf: 'nobody' })).toBeNull()
  })
})

describe('lensCoverage', () => {
  const cover = [
    entry('src/lib', 'learned'),
    entry('src/ui', 'stale'),
    entry('src/api', 'learning'),
  ]

  it('counts DISTINCT modules, not files', () => {
    // Three files in one module is one piece of ground, learned once.
    const cov = lensCoverage(['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts'], cover)
    expect(cov).toEqual({ share: 1, learned: 1, total: 1 })
  })

  it('counts only learned ground — stale and in-flight are not coverage', () => {
    const cov = lensCoverage(['src/lib/a.ts', 'src/ui/b.ts', 'src/api/c.ts'], cover)
    expect(cov.total).toBe(3)
    expect(cov.learned).toBe(1)
    expect(cov.share).toBeCloseTo(1 / 3)
  })

  it('reports a learned count that agrees with the share it drew', () => {
    // The line's width and the sentence beside it come from ONE numerator —
    // `learned` is read back off the share rather than counted a second time.
    const cov = lensCoverage(
      ['src/lib/a.ts', 'src/ui/b.ts', 'src/api/c.ts', 'src/gone/d.ts'],
      cover,
    )
    expect(cov.learned).toBe(Math.round(cov.share * cov.total))
  })

  it('takes ignored modules off BOTH sides of the fraction', () => {
    // A `__tests__` directory is a built-in ignore: counting it in the
    // denominator alone would draw a line that can never reach full on a
    // feature whose every real module is learned.
    const cov = lensCoverage(['src/lib/a.ts', 'src/__tests__/a.test.ts'], cover)
    expect(cov).toEqual({ share: 1, learned: 1, total: 1 })
  })

  it('honours the extra ignores it was given', () => {
    const cov = lensCoverage(['src/lib/a.ts', 'src/ui/b.ts'], cover, ['src/ui'])
    expect(cov).toEqual({ share: 1, learned: 1, total: 1 })
  })

  it('answers 0/0 for ground nothing countable stands on', () => {
    // A repo-root file belongs to no module, and 0/0 must never draw as full.
    expect(lensCoverage([])).toEqual({ share: 0, learned: 0, total: 0 })
    expect(lensCoverage(['README.md'])).toEqual({ share: 0, learned: 0, total: 0 })
  })

  it('accepts anchors as well as bare paths', () => {
    // `moduleOfPath` is the ONE join: `file:` / `module:` refs and bare paths
    // all resolve through it, so an anchor list and a file list agree.
    expect(lensCoverage(['file:src/lib/a.ts'], cover)).toEqual({
      share: 1,
      learned: 1,
      total: 1,
    })
    expect(lensCoverage(['module:src/lib'], cover)).toEqual({ share: 1, learned: 1, total: 1 })
  })
})

describe('learnCountsLabel', () => {
  const modules = { percentLabel: '0.00%', learned: 0, total: 362 }

  it('names the population, so 0/362 cannot read as the whole project', () => {
    // The report: a board with seven features learned, under a panel saying
    // "0.00% · 0/362 learned". Every word was true and the sentence was not.
    expect(learnCountsLabel(modules, { done: 7, total: 29 })).toBe(
      '7/29 features learned · 0/362 modules',
    )
  })

  it('leads with features, and drops the module percentage from the front', () => {
    // A bare "0.00%" at the head of the line is the part that reads as a
    // verdict on everything, so it goes when there is a truer figure to lead.
    expect(learnCountsLabel(modules, { done: 7, total: 29 })).not.toContain('0.00%')
  })

  it('keeps the old sentence when there are no features to count', () => {
    expect(learnCountsLabel(modules, null)).toBe('0.00% · 0/362 modules learned')
  })

  it('does not merge the two populations into one total', () => {
    // A feature is not one of the 362 modules. Adding it would trade a silence
    // for a wrong count.
    const label = learnCountsLabel(
      { percentLabel: '2.00%', learned: 7, total: 362 },
      { done: 7, total: 29 },
    )
    expect(label).toContain('7/362 modules')
    expect(label).toContain('7/29 features')
    expect(label).not.toContain('391')
  })
})

describe('understoodBySlug', () => {
  it('groups parts by their owner in one pass, with stale not done', () => {
    const map = understoodBySlug([
      { kind: 'core', understanding: 'learned' },
      { kind: 'part', understanding: 'learned', partOf: 'chats' },
      { kind: 'part', understanding: 'stale', partOf: 'chats' },
      { kind: 'part', understanding: 'learned', partOf: 'playbooks' },
    ])
    expect(map.get('chats')).toEqual({ done: 1, total: 2 })
    expect(map.get('playbooks')).toEqual({ done: 1, total: 1 })
  })

  it('agrees with understoodFraction, because it IS understoodFraction', () => {
    // The board asks per-cell and per-graph on the same paint now. Two
    // spellings of "how much of this is understood" is the drift the one-code-
    // path rule exists to stop.
    const nodes = [
      { kind: 'core' as const, understanding: 'none' as const },
      { kind: 'part' as const, understanding: 'learned' as const, partOf: 'chats' },
      { kind: 'part' as const, understanding: 'none' as const, partOf: 'chats' },
    ]
    expect(understoodFraction(nodes, { partsOf: 'chats' })).toEqual(
      understoodBySlug(nodes).get('chats'),
    )
    expect(understoodFraction(nodes, { partsOf: 'nobody' })).toBeNull()
    expect(understoodBySlug(nodes).has('nobody')).toBe(false)
  })

  it('is empty for a graph that has not loaded, and skips an unowned part', () => {
    expect(understoodBySlug(null).size).toBe(0)
    expect(understoodBySlug(undefined).size).toBe(0)
    expect(understoodBySlug([{ kind: 'part', understanding: 'learned' }]).size).toBe(0)
  })
})
