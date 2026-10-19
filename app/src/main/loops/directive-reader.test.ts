// The directive reader — the read path that replaces a CLI subprocess.
//
// Three things are worth testing here and they are not the same thing:
//   1. the PARSER agrees with `src/cli/loop/directive-parser.ts`, wording and
//      validation order included, because a directive that reads one way in the
//      IDE and another way in a headless run is the failure this mirror invites;
//   2. an unreadable directive is a NAMED NOTICE, never a loop that vanished;
//   3. the cache serves a window the injected clock controls, and a file change
//      cuts that window short.
//
// The watcher is injected in every cache test. This project's own notes record
// chokidar being unreliable on macOS temp directories, so a test that waited on
// a real fsevent would be testing the OS, not this file.

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_LEDGER_PATH,
  LoopDirectiveCache,
  directiveHomes,
  extractSection,
  oneLine,
  parseLoopDirective,
  readLoopDirectives,
  type LoopDirectiveSnapshot,
  type LoopDirectiveWatcher,
} from './directive-reader'

/** A minimal directive that parses — every optional key left out on purpose. */
const MINIMAL = ['---', 'loop: find', 'engine: producer', 'mission: hunt', 'queue: ledger', '---', ''].join(
  '\n',
)

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'directive-reader-'))
}

async function writeDirective(root: string, home: string, name: string, body: string): Promise<void> {
  const dir = join(root, home)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.md`), body, 'utf-8')
}

describe('parseLoopDirective', () => {
  it('reads every field of a full directive', () => {
    const content = [
      '---',
      'loop: find',
      'engine: producer',
      'paused: true   # 2026-08-14: the comment is stripped, the value is not',
      'mission: Put work in the list',
      'scope: [src/, app/src/]',
      'slice: rotate',
      'queue: github',
      'repo: dev/plan-flow',
      'label: qa-heartbeat',
      'topic: backlog',
      'max_open_issues: 20',
      'max_run_minutes: 45',
      'max_concurrent_runs: 2',
      'needs_approval: true',
      '---',
      '',
      '## Direction',
      '',
      'Hunt within the scope.',
      '',
      '## Rules',
      '',
      'Reproduce before filing.',
      '',
    ].join('\n')

    expect(parseLoopDirective(content, 'find.md')).toEqual({
      loop: 'find',
      engine: 'producer',
      paused: true,
      mission: 'Put work in the list',
      scope: ['src/', 'app/src/'],
      slice: 'rotate',
      queue: 'github',
      repo: 'dev/plan-flow',
      label: 'qa-heartbeat',
      topic: 'backlog',
      maxOpenIssues: 20,
      maxRunMinutes: 45,
      maxConcurrentRuns: 2,
      needsApproval: true,
      direction: 'Hunt within the scope.',
      rules: 'Reproduce before filing.',
    })
  })

  it('applies the documented defaults when optional keys are absent', () => {
    // The mission is the one field with no default; everything else has one,
    // and a default that drifts from the CLI's is a loop the IDE describes
    // differently from the way it runs.
    expect(parseLoopDirective(MINIMAL, 'find.md')).toEqual({
      loop: 'find',
      engine: 'producer',
      paused: false,
      mission: 'hunt',
      scope: [],
      slice: 'changed',
      queue: 'ledger',
      path: DEFAULT_LEDGER_PATH,
      maxOpenIssues: 8,
      maxRunMinutes: 25,
      maxConcurrentRuns: 1,
      needsApproval: false,
      direction: '',
      rules: '',
    })
  })

  it('accepts the pre-rename max_beat_minutes spelling', () => {
    // A directive is committed and shared: another machine's checkout can carry
    // the old key long after this one is updated.
    const content = MINIMAL.replace('queue: ledger', 'queue: ledger\nmax_beat_minutes: 90')
    expect(parseLoopDirective(content, 'find.md').maxRunMinutes).toBe(90)
  })

  it.each([
    ['an unknown key', 'branch: perf/10x', "unknown frontmatter key 'branch'"],
    ['a duplicate key', 'mission: something else', "duplicate frontmatter key 'mission'"],
    ['a malformed cap', 'max_open_issues: 0', "malformed max_open_issues '0'"],
    ['a fractional cap', 'max_open_issues: 2.5', "malformed max_open_issues '2.5'"],
    ['a non-boolean pause', 'paused: yes', "malformed paused 'yes'"],
    ['an unknown slice', 'slice: sideways', "unknown slice 'sideways'"],
    ['a repo on a ledger queue', 'repo: owner/name', "'repo' applies to queue 'github' only"],
    ['a value over the concurrency limit', 'max_concurrent_runs: 50', 'max_concurrent_runs 50 is above the limit of 25'],
    ['a reserved topic', 'topic: not-now', "reserved topic 'not-now'"],
    ['a topic with a space', 'topic: the backlog', "malformed topic 'the backlog'"],
  ])('refuses a directive with %s', (_label, extraLine, expected) => {
    const content = MINIMAL.replace('queue: ledger', `queue: ledger\n${extraLine}`)
    expect(() => parseLoopDirective(content, 'find.md')).toThrow(`find.md: ${expected}`)
  })

  it('refuses a github queue with no repo, and a path on one', () => {
    const github = MINIMAL.replace('queue: ledger', 'queue: github')
    expect(() => parseLoopDirective(github, 'f.md')).toThrow(
      "f.md: queue 'github' requires 'repo: owner/name'",
    )
    const withPath = MINIMAL.replace(
      'queue: ledger',
      'queue: github\nrepo: owner/name\npath: flow/x.jsonl',
    )
    expect(() => parseLoopDirective(withPath, 'f.md')).toThrow(
      "f.md: 'path' applies to queue 'ledger' only",
    )
  })

  it('refuses a missing mission and a missing frontmatter fence', () => {
    const noMission = MINIMAL.replace('mission: hunt\n', '')
    expect(() => parseLoopDirective(noMission, 'f.md')).toThrow("f.md: missing 'mission'")
    expect(() => parseLoopDirective('# just prose\n', 'f.md')).toThrow('f.md: missing frontmatter')
  })

  it('refuses the unknown KEY before the unknown value, as the CLI does', () => {
    // Order is a contract, not an accident: this repo's own perf.md has BOTH an
    // unknown key (`branch`) and an unknown queue kind (`local`), and the CLI
    // reports the key. A reader that validated values first would give a
    // different reason for the same file.
    const both = MINIMAL.replace('queue: ledger', 'queue: local\nbranch: perf/10x')
    expect(() => parseLoopDirective(both, 'perf.md')).toThrow(
      "perf.md: unknown frontmatter key 'branch'",
    )
  })
})

describe('extractSection', () => {
  it('takes one section and stops at the next heading', () => {
    const body = ['## Direction', '', 'aim here', '', '## Rules', '', 'not this', ''].join('\n')
    expect(extractSection(body, 'Direction')).toBe('aim here')
    expect(extractSection(body, 'Nothing')).toBe('')
  })
})

describe('oneLine', () => {
  it('collapses and elides at the CLI’s own length', () => {
    expect(oneLine('  a\n  b  ')).toBe('a b')
    const long = 'x'.repeat(300)
    const elided = oneLine(long)
    expect(elided).toHaveLength(200)
    expect(elided.endsWith('…')).toBe(true)
  })
})

describe('readLoopDirectives', () => {
  let root: string

  beforeEach(async () => {
    root = await makeProject()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a whole loops/ directory, ordered by name', async () => {
    await writeDirective(root, 'loops', 'zeta', MINIMAL.replace('loop: find', 'loop: zeta'))
    await writeDirective(root, 'loops', 'alpha', MINIMAL.replace('loop: find', 'loop: alpha'))
    await writeFile(join(root, 'loops', 'README.txt'), 'not a directive', 'utf-8')

    const snapshot = await readLoopDirectives(root, { now: () => 111 })

    expect(snapshot.available).toBe(true)
    expect(snapshot.reason).toBeNull()
    expect(snapshot.readAt).toBe(111)
    expect(snapshot.loops.map((entry) => entry.loop)).toEqual(['alpha', 'zeta'])
    expect(snapshot.loops[0].directive?.mission).toBe('hunt')
    expect(snapshot.loops[0].queueLocation).toBe(DEFAULT_LEDGER_PATH)
  })

  it('reports a github loop’s queue location as its repo', async () => {
    await writeDirective(
      root,
      'loops',
      'find',
      MINIMAL.replace('queue: ledger', 'queue: github\nrepo: owner/name'),
    )
    const [entry] = (await readLoopDirectives(root)).loops
    expect(entry.queueLocation).toBe('owner/name')
  })

  it('keeps a malformed directive as a NAMED NOTICE, never a dropped loop', async () => {
    await writeDirective(root, 'loops', 'good', MINIMAL.replace('loop: find', 'loop: good'))
    await writeDirective(root, 'loops', 'broken', ['---', 'loop: broken', 'branch: x', '---', ''].join('\n'))

    const snapshot = await readLoopDirectives(root)

    // BOTH loops are present. A loop that disappears from the panel because its
    // file has a typo is the app disagreeing with the disk in silence.
    expect(snapshot.loops.map((entry) => entry.loop)).toEqual(['broken', 'good'])
    const broken = snapshot.loops[0]
    expect(broken.directive).toBeNull()
    expect(broken.queueLocation).toBeNull()
    expect(broken.directiveError).toContain("unknown frontmatter key 'branch'")
    expect(broken.directiveError).toContain(join(root, 'loops', 'broken.md'))
    expect(snapshot.loops[1].directiveError).toBeNull()
  })

  it('notices a directive whose loop name does not match its filename', async () => {
    await writeDirective(root, 'loops', 'fix', MINIMAL)
    const [entry] = (await readLoopDirectives(root)).loops
    expect(entry.loop).toBe('fix')
    expect(entry.directive).toBeNull()
    expect(entry.directiveError).toContain("loop 'find' does not match its filename 'fix.md'")
  })

  it('lets the tracked home win over the legacy flow/loops one', async () => {
    await writeDirective(root, 'loops', 'find', MINIMAL.replace('mission: hunt', 'mission: tracked'))
    await writeDirective(
      root,
      join('flow', 'loops'),
      'find',
      MINIMAL.replace('mission: hunt', 'mission: legacy'),
    )

    const snapshot = await readLoopDirectives(root)

    // ONE loop, not two: a name in both homes is one loop resolved from the
    // committed copy, and a stale local file may never shadow it.
    expect(snapshot.loops).toHaveLength(1)
    expect(snapshot.loops[0].directive?.mission).toBe('tracked')
    expect(snapshot.loops[0].source).toBe(join(root, 'loops', 'find.md'))
  })

  it('still finds a directive that only lives in the legacy home', async () => {
    await writeDirective(root, join('flow', 'loops'), 'find', MINIMAL)
    const snapshot = await readLoopDirectives(root)
    expect(snapshot.loops[0].source).toBe(join(root, 'flow', 'loops', 'find.md'))
  })

  it('treats a project with no loops directory as empty, not unavailable', async () => {
    // Absence is not failure. A project that has never made a loop must not
    // render the notice a broken one gets.
    const snapshot = await readLoopDirectives(root)
    expect(snapshot).toMatchObject({ available: true, reason: null, loops: [] })
  })

  it('names a home it could not list, and still reports the other one’s loops', async () => {
    await writeDirective(root, 'loops', 'find', MINIMAL)
    const legacy = join(root, 'flow', 'loops')
    await mkdir(legacy, { recursive: true })
    await chmod(legacy, 0o000)
    try {
      if (await isReadable(legacy)) return // running as root — nothing to prove
      const snapshot = await readLoopDirectives(root)
      // The loops that COULD be read are reported, and the failure is named
      // rather than silently shortening the list.
      expect(snapshot.available).toBe(true)
      expect(snapshot.loops.map((entry) => entry.loop)).toEqual(['find'])
      expect(snapshot.reason).toContain(legacy)
      expect(snapshot.reason).toContain('unreadable')
    } finally {
      await chmod(legacy, 0o755)
    }
  })

  it('is unavailable when no home could be listed at all', async () => {
    const tracked = join(root, 'loops')
    await mkdir(tracked, { recursive: true })
    await chmod(tracked, 0o000)
    try {
      if (await isReadable(tracked)) return
      const snapshot = await readLoopDirectives(root)
      expect(snapshot.available).toBe(false)
      expect(snapshot.reason).toContain(tracked)
      expect(snapshot.loops).toEqual([])
    } finally {
      await chmod(tracked, 0o755)
    }
  })
})

async function isReadable(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

describe('LoopDirectiveCache', () => {
  /** A clock the test moves by hand — no sleeping, per allowed pattern #20. */
  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let value = 1_000
    return {
      now: () => value,
      advance: (ms) => {
        value += ms
      },
    }
  }

  function snapshotAt(readAt: number, loop: string): LoopDirectiveSnapshot {
    return {
      available: true,
      reason: null,
      readAt,
      loops: [{ loop, source: `${loop}.md`, directive: null, directiveError: 'stub', queueLocation: null }],
    }
  }

  it('serves the cached snapshot inside the window and re-reads outside it', async () => {
    const clock = fakeClock()
    let reads = 0
    const cache = new LoopDirectiveCache({
      now: clock.now,
      ttlMs: 5_000,
      watchFn: () => null,
      readFn: () => {
        reads += 1
        return Promise.resolve(snapshotAt(clock.now(), `read-${String(reads)}`))
      },
    })

    await cache.read('/repo')
    clock.advance(4_999)
    const cached = await cache.read('/repo')
    expect(reads).toBe(1)
    expect(cached.loops[0].loop).toBe('read-1')

    clock.advance(2)
    const refreshed = await cache.read('/repo')
    expect(reads).toBe(2)
    expect(refreshed.loops[0].loop).toBe('read-2')
  })

  it('re-reads inside the window once the watcher says the files changed', async () => {
    const clock = fakeClock()
    let reads = 0
    let fire = (): void => {}
    const cache = new LoopDirectiveCache({
      now: clock.now,
      ttlMs: 60_000,
      watchFn: (_dirs, onChange) => {
        fire = onChange
        return { close: () => {} }
      },
      readFn: () => {
        reads += 1
        return Promise.resolve(snapshotAt(clock.now(), `read-${String(reads)}`))
      },
    })

    await cache.read('/repo')
    await cache.read('/repo')
    expect(reads).toBe(1)

    fire()
    const afterChange = await cache.read('/repo')
    expect(reads).toBe(2)
    expect(afterChange.loops[0].loop).toBe('read-2')
  })

  it('watches both directive homes, and only once a root is actually asked about', async () => {
    const watched: string[][] = []
    const cache = new LoopDirectiveCache({
      watchFn: (dirs) => {
        watched.push([...dirs])
        return { close: () => {} }
      },
      readFn: () => Promise.resolve(snapshotAt(0, 'x')),
    })

    expect(watched).toEqual([])
    await cache.read('/repo')
    await cache.read('/repo')
    expect(watched).toEqual([directiveHomes('/repo')])
  })

  it('does not lose a change that lands while a read is in flight', async () => {
    const clock = fakeClock()
    let reads = 0
    let fire = (): void => {}
    let release = (): void => {}
    const cache = new LoopDirectiveCache({
      now: clock.now,
      ttlMs: 60_000,
      watchFn: (_dirs, onChange) => {
        fire = onChange
        return { close: () => {} }
      },
      readFn: () => {
        reads += 1
        return new Promise<LoopDirectiveSnapshot>((resolve) => {
          release = () => {
            resolve(snapshotAt(clock.now(), `read-${String(reads)}`))
          }
        })
      },
    })

    const pending = cache.read('/repo')
    fire() // the file changed while the sweep was still walking the directory
    release()
    await pending

    // The in-flight snapshot is already out of date, so the next caller must go
    // back to disk rather than be handed it. Not awaited before the assertion:
    // the point is that a second sweep STARTED, and `release` now belongs to it.
    const second = cache.read('/repo')
    expect(reads).toBe(2)
    release()
    await second
  })

  it('folds concurrent reads of one root into a single sweep', async () => {
    let reads = 0
    let release = (): void => {}
    const cache = new LoopDirectiveCache({
      watchFn: () => null,
      readFn: () => {
        reads += 1
        return new Promise<LoopDirectiveSnapshot>((resolve) => {
          release = () => {
            resolve(snapshotAt(0, 'shared'))
          }
        })
      },
    })

    const all = Promise.all([cache.read('/repo'), cache.read('/repo'), cache.read('/repo')])
    release()
    const results = await all

    expect(reads).toBe(1)
    expect(results.map((snapshot) => snapshot.loops[0].loop)).toEqual(['shared', 'shared', 'shared'])
  })

  it('closes a root’s watcher when the project leaves', async () => {
    let closed = 0
    const watcher: LoopDirectiveWatcher = {
      close: () => {
        closed += 1
      },
    }
    const cache = new LoopDirectiveCache({
      watchFn: () => watcher,
      readFn: () => Promise.resolve(snapshotAt(0, 'x')),
    })

    await cache.read('/repo')
    cache.forget('/repo')
    expect(closed).toBe(1)

    await cache.read('/other')
    cache.dispose()
    expect(closed).toBe(2)
  })

  it('reads real directives end to end through the cache', async () => {
    const root = await makeProject()
    try {
      await writeDirective(root, 'loops', 'find', MINIMAL)
      const cache = new LoopDirectiveCache({ watchFn: () => null })
      const snapshot = await cache.read(root)
      expect(snapshot.loops[0].directive?.mission).toBe('hunt')
      cache.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('parity with the CLI, on this repo’s own loops/', () => {
  // WHAT THE CLI SAYS TODAY, recorded rather than re-derived.
  //
  // Refreshed 2026-09-22 after `237e2024 chore(loops): point both loops at this
  // project's own list` moved both directives from a GitHub queue to the local
  // ledger. Re-captured from the CLI rather than hand-edited, and parity HELD —
  // the app reader and the CLI agreed on every field, which is what this test
  // is for. A stale table is the config having changed; a DIFF between the two
  // readers is the bug it exists to catch, and those look different.
  //
  // Originally captured 2026-08-24 from `node dist/cli/index.js loop status` at the repo
  // root — the exact command `loops:read` spawns — and reduced to the fields a
  // directive alone decides. Re-run that command to refresh this table if the
  // directives change; a diff here is the mirror drifting from the parser it
  // mirrors, which is the whole reason this test exists.
  //
  // THE BROKEN DIRECTIVE MOVED OUT OF THIS TABLE. It used to carry a third row:
  // `perf`, whose frontmatter had both an unknown key (`branch`) and an unknown
  // queue kind (`local`), and which pinned the refusal wording, the key order
  // inside it and the 200-character elision. That file was retired on
  // 2026-08-26 — it had never once parsed, so it drove nothing — and this table
  // went red with it.
  //
  // Restoring the row would mean keeping a broken directive in the repo purely
  // so a test could read it. The refusal SHAPE is worth pinning and the repo
  // happening to contain a bad file is not, so that assertion now writes its
  // own directive in a temp root (below) and this table stays what it says it
  // is: what the CLI reports for the loops this project actually runs.
  const CLI_ROWS = [
    {
      loop: 'find',
      engine: 'producer',
      topic: 'backlog',
      mission: 'Put work in the list — whatever the instruction points at, reproduced before it is filed',
      slice: 'rotate',
      queueKind: 'ledger',
      directivePaused: false,
      queueLocation: 'flow/loops/queue.jsonl',
    },
    {
      loop: 'fix',
      engine: 'consumer',
      topic: 'backlog',
      mission:
        'Take work out of the list — drain it, task by task, each one fixed end to end and closed with evidence',
      slice: 'changed',
      queueKind: 'ledger',
      directivePaused: false,
      queueLocation: 'flow/loops/queue.jsonl',
    },
  ]

  it('reports the same fields the CLI does, loop by loop', async () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..')
    const snapshot = await readLoopDirectives(repoRoot)

    expect(snapshot.available).toBe(true)
    const rows = snapshot.loops.map((entry) => {
      if (entry.directive === null) {
        return {
          loop: entry.loop,
          // The CLI prints an absolute path; the table stores the repo-relative
          // tail so the expectation is the same on every machine.
          directiveError: (entry.directiveError ?? '').replace(`${repoRoot}/`, ''),
        }
      }
      const directive = entry.directive
      return {
        loop: entry.loop,
        engine: directive.engine,
        topic: directive.topic,
        mission: directive.mission,
        slice: directive.slice,
        queueKind: directive.queue,
        directivePaused: directive.paused,
        queueLocation: entry.queueLocation,
      }
    })

    expect(rows).toEqual(CLI_ROWS)
  })

  /**
   * The refusal a bad directive produces, pinned on a directive this test owns.
   *
   * Previously this rode on `loops/perf.md` being broken in the repo — real
   * coverage, resting on a file whose whole problem was that it should not
   * exist. Written here, the same three things are pinned (the wording, the
   * order the parser lists its keys in, and the elision) and nothing has to
   * stay broken for them to hold.
   */
  it('elides a long refusal the way the CLI does', async () => {
    const root = await makeProject()
    try {
      await writeDirective(
        root,
        'loops',
        'perf',
        ['---', 'loop: perf', 'engine: consumer', 'mission: speed', 'queue: local', 'branch: perf/10x', '---', ''].join(
          '\n',
        ),
      )
      const snapshot = await readLoopDirectives(root)
      const entry = snapshot.loops.find((row) => row.loop === 'perf')
      expect(entry?.directive).toBeNull()
      const notice = entry?.directiveError ?? ''

      // The refusal names the offending key and then the ones it would have
      // taken, in the parser's own order — a reader has to be able to see what
      // they should have written.
      expect(notice.replace(`${root}/`, '')).toContain(
        "loops/perf.md: unknown frontmatter key 'branch' — expected one of loop, engine, paused, mission, scope, slice, queue, repo, pa",
      )
      // AND IT IS ELIDED AT THE FULL STRING, PATH INCLUDED. Which is why this
      // asserts the cap rather than a literal tail: the budget is spent on the
      // absolute path first, so how much of the key list survives depends on
      // where the project happens to live. The old expectation was pinned to
      // this repo's own path length and would have passed nowhere else.
      expect(notice.length).toBe(200)
      expect(notice.endsWith('…')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
