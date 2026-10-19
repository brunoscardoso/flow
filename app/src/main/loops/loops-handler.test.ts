import { EventEmitter } from 'events'

import {
  approveLoopItem,
  fileLoopItem,
  parseFileJson,
  claimLoopItem,
  DEFAULT_PAUSE_REASON,
  directivePauseArgs,
  directiveQueueArgs,
  setDirectivePaused,
  setDirectiveQueue,
  parseListJson,
  parseStatusJson,
  parseStatusResult,
  readLoopQueue,
  readLoops,
  readLoopsActivity,
  registerLoopsChannels,
  LoopStatusCache,
  directiveSnapshotToLoops,
  runsReportOf,
  setLoopPaused,
  unclaimLoopItem,
  closeLoopItem,
  parseCloseJson,
} from './loops-handler'
import { LoopDirectiveCache, type LoopDirectiveSnapshot } from './directive-reader'
import { RunsInFlightCache } from './background-agent'
import type { BundledCli } from '../blueprint/derive-runner'

/**
 * The channel registry, captured instead of Electron's. `registerLoopsChannels`
 * lazily `require`s electron precisely so this file can run under plain Node.
 */
const mockHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => unknown): void => {
      mockHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      mockHandlers.delete(channel)
    },
  },
}))

const cli: BundledCli = { execPath: '/bin/electron', cliPath: '/app/cli.mjs' }

/** A spawn stub that emits the given transcript then closes with `code`. */
function fakeSpawn(
  out: { stdout?: string; stderr?: string; code?: number | null } = {},
): { spawnFn: any; args: string[][] } {
  const args: string[][] = []
  const spawnFn = (_exec: string, argv: string[]) => {
    args.push(argv)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    setImmediate(() => {
      if (out.stdout !== undefined) child.stdout.emit('data', out.stdout)
      if (out.stderr !== undefined) child.stderr.emit('data', out.stderr)
      child.emit('close', out.code ?? 0)
    })
    return child
  }
  return { spawnFn, args }
}

const statusJson = JSON.stringify({
  status: 'ok',
  loops: [
    {
      loop: 'find',
      engine: 'claude',
      mission: 'hunt for real defects',
      pause: null,
      lock: { owner: 'beat-1', acquiredAt: 'T0', expiresAt: 'T1' },
      lastOutcome: 'success',
      lastRunAt: '2026-08-12T08:00:00.000Z',
      queue: {
        open: 3,
        closed: 9,
        claimed: 1,
        awaitingApproval: 2,
        parked: 0,
        claimable: 1,
        maxOpenIssues: 8,
        capReached: false,
      },
    },
    {
      loop: 'improve',
      pause: { scope: 'loop', reason: 'needs approval', since: '2026-08-12T07:00:00.000Z' },
      lock: null,
      queue: null,
      queueError: 'gh: could not resolve host',
    },
  ],
  globalPause: null,
  digest: {
    entries: 12,
    beats: 8,
    success: 6,
    failure: 2,
    filed: 6,
    closed: 4,
    breakerTrips: 1,
    pauses: 1,
    resumes: 1,
    approvals: 2,
    loops: [],
    since: '2026-08-12T00:00:00.000Z',
    until: '2026-08-12T08:00:00.000Z',
  },
  generatedAt: '2026-08-12T08:05:00.000Z',
})

describe('readLoops', () => {
  it('runs `loop status` and narrows the report', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: statusJson })
    const { snapshot } = await readLoops(cli, '/repo', { spawnFn })

    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'status'])
    expect(snapshot.available).toBe(true)
    expect(snapshot.loops).toHaveLength(2)
    expect(snapshot.loops[0].mission).toBe('hunt for real defects')
    expect(snapshot.loops[0].queue?.awaitingApproval).toBe(2)
    expect(snapshot.loops[0].locks[0]?.owner).toBe('beat-1')
    expect(snapshot.digest?.filed).toBe(6)
    expect(snapshot.generatedAt).toBe('2026-08-12T08:05:00.000Z')
  })

  it('keeps a per-loop failure as a ROW, not as a missing loop', async () => {
    // The CLI is deliberately fail-soft per loop: an unreadable directive or an
    // unreachable `gh` must still produce that loop's row. Dropping it here
    // would make the panel silently shorter than the project's loop list — the
    // one presentation of a broken loop that looks exactly like a healthy one.
    const { spawnFn } = fakeSpawn({ stdout: statusJson })
    const { snapshot } = await readLoops(cli, '/repo', { spawnFn })
    const improve = snapshot.loops[1]
    expect(improve.loop).toBe('improve')
    expect(improve.queueError).toBe('gh: could not resolve host')
    // NULL, not a zeroed count object: "nobody could read the queue" and "the
    // queue is empty" are different facts and must not render the same.
    expect(improve.queue).toBeNull()
  })

  it('is unavailable, with a reason, on every failure path', async () => {
    expect((await readLoops(null, '/r')).snapshot.reason).toBe('bundled CLI unavailable')
    expect(
      (await readLoops(cli, '/r', { spawnFn: fakeSpawn({ stdout: '' }).spawnFn })).snapshot.reason,
    ).toBe('no output')
    expect(
      (await readLoops(cli, '/r', { spawnFn: fakeSpawn({ stdout: '{nope' }).spawnFn })).snapshot.reason,
    ).toBe('unparseable loop status output')
    expect(
      (await readLoops(cli, '/r', { spawnFn: fakeSpawn({ stdout: 'loop refused: no flow dir\n' }).spawnFn }))
        .snapshot.reason,
    ).toBe('loop refused: no flow dir')
    // …and every one of those paths reports the stuck claims as UNKNOWN rather
    // than as none: a status read that did not happen answered no question.
    expect((await readLoops(null, '/r')).stuck.known).toBe(false)
  })

  it('reads a non-zero exit off the COMBINED transcript', async () => {
    // This CLI's logger routes error() through console.log — a stderr-only read
    // reports an empty reason for a refusal the user can plainly see.
    const { spawnFn } = fakeSpawn({ stdout: 'loop refused: unknown verb\n', code: 1 })
    expect((await readLoops(cli, '/r', { spawnFn })).snapshot.reason).toBe('loop refused: unknown verb')
  })

  it('never throws when the spawn itself fails', async () => {
    const spawnFn = () => {
      throw new Error('ENOENT')
    }
    const { snapshot } = await readLoops(cli, '/r', { spawnFn: spawnFn as any })
    expect(snapshot.available).toBe(false)
    expect(snapshot.reason).toBe('ENOENT')
    expect(snapshot.loops).toEqual([])
  })
})

describe('parseStatusJson', () => {
  it('narrows a row the CLI no longer decorates — no breaker, and still a row', () => {
    // `loop status --json` stopped emitting `breaker` when the supervision layer
    // went (loops-native-runtime, Phase 6). The narrowing used to default the
    // block; nothing app-side carries it now, and the row must still arrive.
    const snapshot = parseStatusJson(
      JSON.stringify({ loops: [{ loop: 'fix', pause: null, queue: null }], digest: null }),
    )
    expect(snapshot.loops).toHaveLength(1)
    expect(snapshot.loops[0].loop).toBe('fix')
    expect(Object.keys(snapshot.loops[0])).not.toContain('breaker')
  })

  it('carries the CLI\'s topic through the narrowing, and absent stays absent', () => {
    // The panel renders this field; nothing app-side re-derives it. If the
    // narrowing dropped it, the panel would silently lose the one word that
    // says where the loop is working.
    const snapshot = parseStatusJson(
      JSON.stringify({
        loops: [
          { loop: 'find', topic: 'codemap', pause: null, queue: null },
          { loop: 'fix', engine: 'consumer', pause: null, queue: null },
        ],
        digest: null,
      }),
    )
    expect(snapshot.loops[0].topic).toBe('codemap')
    expect(snapshot.loops[1]).not.toHaveProperty('topic')
  })

  it('drops an entry with no loop name', () => {
    const snapshot = parseStatusJson(JSON.stringify({ loops: [{ mission: 'nameless' }] }))
    expect(snapshot.loops).toEqual([])
  })

  it('carries `directivePaused: false` through — absent means UNREADABLE', () => {
    // THREE STATES, AND THE NARROWING USED TO CARRY TWO. The CLI emits this
    // field for every row whose directive parsed (`directivePaused:
    // directive.paused`) and omits it only for one it could not read at all.
    // Narrowing `=== true` collapsed "running" into "absent", and the settings
    // row reads absent as "Not readable" — so every healthy loop in the project
    // was labelled unreadable beside a switch offering to turn it off.
    const snapshot = parseStatusJson(
      JSON.stringify({
        loops: [
          { loop: 'find', directivePaused: false, pause: null, queue: null },
          { loop: 'fix', directivePaused: true, pause: null, queue: null },
          { loop: 'gap', directiveError: 'unreadable', pause: null, queue: null },
        ],
      }),
    )
    expect(snapshot.loops[0].directivePaused).toBe(false)
    expect(snapshot.loops[1].directivePaused).toBe(true)
    expect(snapshot.loops[2]).not.toHaveProperty('directivePaused')
  })
})

describe('setLoopPaused', () => {
  it('pauses one loop with a reason', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    const result = await setLoopPaused(cli, '/r', { loop: 'fix', paused: true, reason: 'stop' }, { spawnFn })
    expect(result).toEqual({ ok: true, reason: null })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'pause', '--loop', 'fix', '--reason', 'stop'])
  })

  it('always sends a reason — the CLI refuses a reasonless pause', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: 'fix', paused: true }, { spawnFn })
    expect(args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'pause',
      '--loop',
      'fix',
      '--reason',
      DEFAULT_PAUSE_REASON,
    ])
  })

  it('treats an empty loop as the GLOBAL pause, exactly as the CLI does', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: '', paused: true, reason: 'all stop' }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'pause', '--reason', 'all stop'])
  })

  it('resumes without inventing a reason', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: 'fix', paused: false }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'resume', '--loop', 'fix'])
  })

  it('reports a refusal instead of throwing', async () => {
    const { spawnFn } = fakeSpawn({ stdout: 'loop refused: unknown loop \'nope\'\n', code: 1 })
    expect(await setLoopPaused(cli, '/r', { loop: 'nope', paused: false }, { spawnFn })).toEqual({
      ok: false,
      reason: "loop refused: unknown loop 'nope'",
    })
    expect(await setLoopPaused(null, '/r', { loop: 'fix', paused: false })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
    })
  })
})

describe('setDirectivePaused — the loop\'s committed switch, not its stopwatch', () => {
  it('spawns ONE verb, from ONE function — the rename seam', async () => {
    // The CLI's verb name was still being settled when this landed, so the
    // whole of it lives in `directivePauseArgs`. This test is what makes a
    // rename a one-line change with a red test pointing at it, rather than a
    // silent refusal a user reads as a broken button — and it did exactly that:
    // the guess was `loop directive --paused true|false`, the CLI shipped the
    // verb PAIR, and this assertion was the only thing that failed.
    expect(directivePauseArgs('fix', true)).toEqual(['loop', 'disable', '--loop', 'fix'])
    expect(directivePauseArgs('fix', false)).toEqual(['loop', 'enable', '--loop', 'fix'])

    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    const result = await setDirectivePaused(cli, '/r', { loop: 'fix', paused: false }, { spawnFn })
    expect(result).toEqual({ ok: true, reason: null })
    expect(args[0]).toEqual(['/app/cli.mjs', ...directivePauseArgs('fix', false)])
  })

  it('never writes the directive itself — a refusal is reported, not routed around', async () => {
    const { spawnFn } = fakeSpawn({ stdout: "loop refused: unknown verb 'directive'\n", code: 1 })
    expect(await setDirectivePaused(cli, '/r', { loop: 'fix', paused: true }, { spawnFn })).toEqual({
      ok: false,
      reason: "loop refused: unknown verb 'directive'",
    })
    expect(await setDirectivePaused(null, '/r', { loop: 'fix', paused: true })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
    })
  })

  it('refuses a nameless loop locally — there is no project-wide directive', async () => {
    // Unlike the runtime pause, an empty scope is not "everything" here: it is
    // a caller bug, and spawning it would ask the CLI about nothing.
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    expect(await setDirectivePaused(cli, '/r', { loop: '  ', paused: true }, { spawnFn })).toEqual({
      ok: false,
      reason: 'this needs a loop to switch',
    })
    expect(args).toEqual([])
  })
})

describe("setDirectiveQueue — where a loop reads its work", () => {
  it('spawns ONE verb, from ONE function — the rename seam', async () => {
    // Same seam as the switch above, and for the same reason: the verb's whole
    // spelling lives in `directiveQueueArgs`, so a CLI rename is a one-line
    // change with a red test pointing at it rather than a button that silently
    // refuses.
    expect(directiveQueueArgs('fix', 'github', 'acme/widgets')).toEqual([
      'loop',
      'point',
      '--loop',
      'fix',
      '--queue',
      'github',
      '--repo',
      'acme/widgets',
    ])

    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    const result = await setDirectiveQueue(
      cli,
      '/r',
      { loop: 'fix', queue: 'github', repo: 'acme/widgets' },
      { spawnFn },
    )
    expect(result).toEqual({ ok: true, reason: null })
    expect(args[0]).toEqual(['/app/cli.mjs', ...directiveQueueArgs('fix', 'github', 'acme/widgets')])
  })

  it('never sends a ledger location — a path is not something this app asks for', async () => {
    // The verb accepts `--path`; this channel does not offer one. A file path in
    // a settings box is exactly the internals-leak the whole surface exists to
    // remove, and the CLI reads an unmentioned path as "leave what is there".
    expect(directiveQueueArgs('fix', 'ledger', 'acme/widgets')).toEqual([
      'loop',
      'point',
      '--loop',
      'fix',
      '--queue',
      'ledger',
    ])
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setDirectiveQueue(cli, '/r', { loop: 'fix', queue: 'ledger' }, { spawnFn })
    expect(args[0]?.join(' ')).not.toContain('--path')
  })

  it('refuses a github list with no repository, before anything is spawned', async () => {
    // The renderer already said this in a sentence; saying it again here is the
    // rule stated where the request actually leaves the app.
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    expect(
      await setDirectiveQueue(cli, '/r', { loop: 'fix', queue: 'github', repo: '  ' }, { spawnFn }),
    ).toEqual({ ok: false, reason: 'a GitHub list needs the name of a repository' })
    expect(args).toEqual([])
  })

  it('refuses a nameless loop and an unknown list locally', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    expect(await setDirectiveQueue(cli, '/r', { loop: ' ', queue: 'ledger' }, { spawnFn })).toEqual({
      ok: false,
      reason: 'this needs a loop to point',
    })
    expect(
      await setDirectiveQueue(cli, '/r', { loop: 'fix', queue: 'jira' as 'ledger' }, { spawnFn }),
    ).toEqual({ ok: false, reason: 'that is not a list this build knows' })
    expect(args).toEqual([])
  })

  it('reports a refusal rather than routing around it', async () => {
    const { spawnFn } = fakeSpawn({
      stdout: "loop refused: queue 'github' requires 'repo: owner/name'\n",
      code: 1,
    })
    expect(
      await setDirectiveQueue(cli, '/r', { loop: 'fix', queue: 'github', repo: 'acme/widgets' }, { spawnFn }),
    ).toEqual({ ok: false, reason: "loop refused: queue 'github' requires 'repo: owner/name'" })
    expect(await setDirectiveQueue(null, '/r', { loop: 'fix', queue: 'ledger' })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
    })
  })
})

describe('approveLoopItem', () => {
  it('runs `loop approve` with the loop and the item id', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    expect(await approveLoopItem(cli, '/r', { loop: 'improve', id: '42' }, { spawnFn })).toEqual({
      ok: true,
      reason: null,
    })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'approve', '--loop', 'improve', '--id', '42'])
  })

  it('refuses locally when either half is missing — no spawn at all', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    expect(await approveLoopItem(cli, '/r', { loop: '', id: '42' }, { spawnFn })).toEqual({
      ok: false,
      reason: 'approve needs a loop and an item id',
    })
    expect(await approveLoopItem(cli, '/r', { loop: 'fix', id: ' ' }, { spawnFn })).toEqual({
      ok: false,
      reason: 'approve needs a loop and an item id',
    })
    expect(args).toEqual([])
  })
})

describe('run slots come through whichever shape the CLI on PATH emits', () => {
  it('reads the `locks` array a current CLI emits', () => {
    const parsed = parseStatusJson(
      JSON.stringify({
        status: 'ok',
        loops: [
          {
            loop: 'fix',
            pause: null,
            queue: null,
            locks: [
              { owner: 'run-b', slot: 2, acquiredAt: '2026-08-14T02:00:00.000Z', expiresAt: '2026-08-14T02:30:00.000Z' },
              { owner: 'run-a', slot: 1, acquiredAt: '2026-08-14T01:59:00.000Z', expiresAt: '2026-08-14T02:29:00.000Z' },
            ],
          },
        ],
        generatedAt: '2026-08-14T02:05:00.000Z',
      }),
    )
    // lowest slot first, whatever order the CLI listed them in
    expect(parsed.loops[0].locks.map((lock) => lock.slot)).toEqual([1, 2])
  })

  it('still reads the single `lock` an older CLI emits', () => {
    // The app ships bundled against one version but runs against whatever
    // `planflow-ai` resolves to. A reader that knew only the new shape would
    // report a busy loop as idle on any machine a step behind.
    const parsed = parseStatusJson(
      JSON.stringify({
        status: 'ok',
        loops: [
          {
            loop: 'fix',
            pause: null,
            queue: null,
            lock: { owner: 'run-old', acquiredAt: '2026-08-14T02:00:00.000Z', expiresAt: '2026-08-14T02:30:00.000Z' },
          },
        ],
        generatedAt: '2026-08-14T02:05:00.000Z',
      }),
    )
    expect(parsed.loops[0].locks).toHaveLength(1)
    expect(parsed.loops[0].locks[0]).toMatchObject({ owner: 'run-old', slot: 1 })
  })
})

// ── the queue itself (loops-on-the-board, Phase 4) ────────────────────────

/** A `loop list` report with one healthy loop and one unreachable one. */
const listJson = JSON.stringify({
  status: 'ok',
  state: 'open',
  loops: [
    {
      loop: 'fix',
      queueKind: 'github',
      queueLocation: 'acme/widgets',
      items: [
        {
          id: '1533',
          loop: 'fix',
          title: 'code map refactor',
          body: 'the map is broken\n<!-- loop: fix -->\n',
          fingerprint: '',
          state: 'open',
          labels: ['loop-fix'],
          approved: true,
          createdAt: '2026-08-12T13:08:39Z',
          url: 'https://github.com/acme/widgets/issues/1533',
          // A field this narrowing has never heard of — dropped, not carried.
          reactions: { '+1': 3 },
        },
        {
          id: '1540',
          loop: 'fix',
          title: 'gated finding',
          body: '',
          fingerprint: 'abc123',
          state: 'open',
          labels: ['loop-fix', 'loop-needs-approval'],
          approved: false,
          claimedBy: 'run-7',
          claimedAt: '2026-08-13T09:00:00.000Z',
          assignees: ['someone'],
          plan: 'state-md-handoff',
          primaryFile: 'src/cli/loop/next.ts',
          createdAt: '2026-08-13T08:00:00.000Z',
        },
      ],
    },
    {
      loop: 'find',
      queueKind: 'github',
      queueLocation: 'acme/widgets',
      items: null,
      queueError: 'gh: could not resolve host',
    },
  ],
  generatedAt: '2026-08-14T09:00:00.000Z',
})

describe('readLoopQueue', () => {
  it('runs `loop list` and narrows the items', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: listJson })
    const snapshot = await readLoopQueue(cli, '/repo', {}, { spawnFn })

    // No `--loop` and no `--state`: an unqualified board read is the whole
    // project, on the slice the CLI itself defines as the default.
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'list'])
    expect(snapshot.available).toBe(true)
    expect(snapshot.state).toBe('open')
    expect(snapshot.generatedAt).toBe('2026-08-14T09:00:00.000Z')
    expect(snapshot.loops).toHaveLength(2)

    const fix = snapshot.loops[0]
    expect(fix.queueKind).toBe('github')
    expect(fix.queueLocation).toBe('acme/widgets')
    expect(fix.items).toHaveLength(2)
    expect(fix.items?.[0]).toMatchObject({ id: '1533', title: 'code map refactor', approved: true })
    // Unknown fields are dropped rather than guessed at.
    expect(fix.items?.[0]).not.toHaveProperty('reactions')
    expect(fix.items?.[1]).toMatchObject({
      id: '1540',
      approved: false,
      claimedBy: 'run-7',
      plan: 'state-md-handoff',
      primaryFile: 'src/cli/loop/next.ts',
      assignees: ['someone'],
    })
  })

  it('sends `--loop` and `--state` only when the caller named them', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: listJson })
    await readLoopQueue(cli, '/repo', { loop: 'fix', state: 'all' }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'list', '--loop', 'fix', '--state', 'all'])
  })

  it('keeps an UNREADABLE queue null — never an empty backlog', async () => {
    // The single most important assertion in this channel. `[]` says the loop
    // has nothing to do; a loop whose `gh` call failed has said nothing at all,
    // and rendering the second as the first draws an empty Todo over work that
    // is still there.
    const { spawnFn } = fakeSpawn({ stdout: listJson })
    const snapshot = await readLoopQueue(cli, '/repo', {}, { spawnFn })
    const find = snapshot.loops[1]
    expect(find.loop).toBe('find')
    expect(find.items).toBeNull()
    expect(find.queueError).toBe('gh: could not resolve host')
    // ...and the loop beside it is untouched: one unreachable backend must not
    // blank out the rest of the project.
    expect(snapshot.loops[0].items).toHaveLength(2)
  })

  it('tells an empty queue apart from an unreadable one', async () => {
    const snapshot = parseListJson(
      JSON.stringify({ status: 'ok', state: 'open', loops: [{ loop: 'fix', items: [] }] }),
    )
    expect(snapshot.loops[0].items).toEqual([])
    expect(snapshot.loops[0]).not.toHaveProperty('queueError')
  })

  it('drops an item with no id, and a group with no loop name', () => {
    const snapshot = parseListJson(
      JSON.stringify({
        loops: [{ loop: 'fix', items: [{ title: 'nameless' }, { id: '9', title: 'real' }] }, { items: [] }],
      }),
    )
    expect(snapshot.loops).toHaveLength(1)
    expect(snapshot.loops[0].items?.map((item) => item.id)).toEqual(['9'])
  })

  it('reads a missing `approved` as GATED, and a missing state as open', () => {
    // Both defaults point the same way: toward a human looking at it. An item
    // whose gate could not be read must not present itself as ready to work.
    const snapshot = parseListJson(JSON.stringify({ loops: [{ loop: 'fix', items: [{ id: '3' }] }] }))
    expect(snapshot.loops[0].items?.[0]).toMatchObject({ approved: false, state: 'open' })
  })

  it('echoes the CLI\'s state rather than assuming the default', () => {
    expect(parseListJson(JSON.stringify({ state: 'closed', loops: [] })).state).toBe('closed')
    // An unrecognised (or absent) slice is null — this reader does not know
    // what the CLI's default is, and inventing one is how the two drift.
    expect(parseListJson(JSON.stringify({ state: 'sideways', loops: [] })).state).toBeNull()
    expect(parseListJson(JSON.stringify({ loops: [] })).state).toBeNull()
  })

  it('is unavailable, with a reason, on every failure path', async () => {
    expect((await readLoopQueue(null, '/r')).reason).toBe('bundled CLI unavailable')
    expect((await readLoopQueue(null, '/r')).loops).toEqual([])
    expect(
      (await readLoopQueue(cli, '/r', {}, { spawnFn: fakeSpawn({ stdout: '' }).spawnFn })).reason,
    ).toBe('no output')
    expect(
      (await readLoopQueue(cli, '/r', {}, { spawnFn: fakeSpawn({ stdout: '{nope' }).spawnFn })).reason,
    ).toBe('unparseable loop list output')
    // A refusing CLI: the reason is read off the COMBINED transcript, because
    // this CLI's logger routes error() through console.log.
    const refusing = fakeSpawn({ stdout: "loop refused: unknown loop 'nope'\n", code: 1 })
    expect((await readLoopQueue(cli, '/r', {}, { spawnFn: refusing.spawnFn })).reason).toBe(
      "loop refused: unknown loop 'nope'",
    )
  })

  it('reports the refusal the CLI actually prints, paint and all', async () => {
    // OBSERVED, NOT IMAGINED: `loop list --state sideways` against the bundled
    // CLI emits `\x1b[31m  x\x1b[0m loop refused: …`. The logger colours
    // unconditionally — a pipe is not a TTY and it does not check — so the raw
    // line carried into a panel notice would render as escape codes and a
    // stray `x`. The message survives; the terminal's paint does not.
    const painted = fakeSpawn({
      stdout: '\u001b[31m  x\u001b[0m loop refused: malformed --state \'sideways\'\n',
      code: 1,
    })
    expect((await readLoopQueue(cli, '/r', {}, { spawnFn: painted.spawnFn })).reason).toBe(
      "loop refused: malformed --state 'sideways'",
    )
  })

  it('never throws when the spawn itself fails', async () => {
    const spawnFn = () => {
      throw new Error('ENOENT')
    }
    const snapshot = await readLoopQueue(cli, '/r', {}, { spawnFn: spawnFn as any })
    expect(snapshot).toMatchObject({ available: false, reason: 'ENOENT', loops: [], state: null })
  })
})

describe('claimLoopItem', () => {
  const claimed = JSON.stringify({
    status: 'claimed',
    loop: 'fix',
    owner: 'run-42',
    item: { id: '1533', loop: 'fix', title: 'code map refactor', state: 'open', approved: true },
  })

  it('runs `loop claim` with the loop and the item id', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: claimed })
    const result = await claimLoopItem(cli, '/r', { loop: 'fix', id: '1533' }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'claim', '--loop', 'fix', '--id', '1533'])
    expect(result).toMatchObject({ status: 'claimed', loop: 'fix', owner: 'run-42' })
    expect(result.item?.id).toBe('1533')
  })

  it('leaves the owner to the CLI unless one was named', async () => {
    // This function still never invents an identity — it forwards one or sends
    // none. What review finding H1 changed is who calls it: the `loops:claim`
    // channel now always names the installation's durable owner, because the
    // CLI's per-invocation `run-<ts>-<pid>` made a retry unmatchable.
    const bare = fakeSpawn({ stdout: claimed })
    await claimLoopItem(cli, '/r', { loop: 'fix' }, { spawnFn: bare.spawnFn })
    expect(bare.args[0]).toEqual(['/app/cli.mjs', 'loop', 'claim', '--loop', 'fix'])

    const named = fakeSpawn({ stdout: claimed })
    await claimLoopItem(cli, '/r', { loop: 'fix', id: '7', owner: 'devuser' }, { spawnFn: named.spawnFn })
    expect(named.args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'claim',
      '--loop',
      'fix',
      '--id',
      '7',
      '--owner',
      'devuser',
    ])
  })

  it('keeps `empty` and `lost` as their own outcomes, not as failures', async () => {
    // A quiet queue and a rival run getting there first are the system working.
    // Collapsing either into "failed" would report success as breakage.
    const empty = fakeSpawn({
      stdout: JSON.stringify({ status: 'empty', loop: 'fix', owner: 'run-1', reason: 'nothing claimable' }),
    })
    expect(await claimLoopItem(cli, '/r', { loop: 'fix' }, { spawnFn: empty.spawnFn })).toEqual({
      status: 'empty',
      loop: 'fix',
      owner: 'run-1',
      reason: 'nothing claimable',
      item: null,
    })

    const lost = fakeSpawn({
      stdout: JSON.stringify({
        status: 'lost',
        loop: 'fix',
        owner: 'run-1',
        reason: 'claimed by @someone-else',
        item: { id: '1540', state: 'open' },
      }),
    })
    const result = await claimLoopItem(cli, '/r', { loop: 'fix', id: '1540' }, { spawnFn: lost.spawnFn })
    // VERBATIM: the board shows who actually holds it, not "claim failed".
    expect(result).toMatchObject({ status: 'lost', reason: 'claimed by @someone-else' })
    expect(result.item?.id).toBe('1540')
  })

  it('reports a refusal instead of throwing', async () => {
    const refusing = fakeSpawn({ stdout: 'loop refused: budget spent for today\n', code: 1 })
    expect(await claimLoopItem(cli, '/r', { loop: 'fix' }, { spawnFn: refusing.spawnFn })).toEqual({
      status: 'refused',
      loop: 'fix',
      owner: null,
      reason: 'loop refused: budget spent for today',
      item: null,
    })
  })

  it('refuses an unrecognised status rather than reading it as a claim', async () => {
    const odd = fakeSpawn({ stdout: JSON.stringify({ status: 'maybe', loop: 'fix' }) })
    const result = await claimLoopItem(cli, '/r', { loop: 'fix' }, { spawnFn: odd.spawnFn })
    expect(result.status).toBe('refused')
    expect(result.reason).toBe("unexpected loop claim status 'maybe'")
  })

  it('refuses locally with no loop, and with no CLI — no spawn at all', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: claimed })
    expect(await claimLoopItem(cli, '/r', { loop: '  ' }, { spawnFn })).toMatchObject({
      status: 'refused',
      reason: 'claim needs a loop',
    })
    expect(await claimLoopItem(null, '/r', { loop: 'fix' })).toMatchObject({
      status: 'refused',
      reason: 'bundled CLI unavailable',
    })
    expect(args).toEqual([])
  })

  it('never throws when the spawn itself fails', async () => {
    const spawnFn = () => {
      throw new Error('ENOENT')
    }
    const result = await claimLoopItem(cli, '/r', { loop: 'fix' }, { spawnFn: spawnFn as any })
    expect(result).toMatchObject({ status: 'refused', reason: 'ENOENT' })
  })
})

// ── the claim's other half (review finding H1) ───────────────────────────
//
// Until this existed, an item claimed from the board could only be released by
// running `planflow-ai loop unclaim` in a terminal the app never mentions — so a
// claim that landed while its local record did not left the item held with no
// in-app recovery, and the board reported it as somebody else's.

// ── the dismissal (a person settles an item they do not want done) ────────
//
// The board's cards could be dragged and nothing else: a finding a loop had
// just written could not be opened, and disagreeing with one meant a terminal.
// `loop close --reason wontfix` is the queue's own answer, and it is NOT a
// delete — the written reason is permanent, searchable memory the producers
// read back so the idea is never filed again.

describe('closeLoopItem', () => {
  const closed = JSON.stringify({
    status: 'closed',
    loop: 'find',
    reason: 'wontfix',
    item: { id: '3', loop: 'find', title: 'tenant alias drift', state: 'closed', approved: true },
    remaining: 2,
  })

  it('runs `loop close` with the reason, the sentence and the owner', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: closed })
    const result = await closeLoopItem(
      cli,
      '/r',
      { loop: 'find', id: '3', reason: 'wontfix', detail: 'covered by the tenancy rewrite', owner: 'flow-ide-abc' },
      { spawnFn },
    )
    expect(args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'close',
      '--loop',
      'find',
      '--id',
      '3',
      '--reason',
      'wontfix',
      '--detail',
      'covered by the tenancy rewrite',
      '--owner',
      'flow-ide-abc',
    ])
    expect(result).toEqual({ ok: true, reason: null, status: 'closed', note: null })
  })

  it('refuses an unexplained dismissal WITHOUT spawning anything', async () => {
    // The store keeps the reason forever and the CLI refuses without one, so a
    // caller that forgot it is a bug in the app rather than a queue outcome.
    const { spawnFn, args } = fakeSpawn({ stdout: closed })
    const result = await closeLoopItem(
      cli,
      '/r',
      { loop: 'find', id: '3', reason: 'wontfix', detail: '   ' },
      { spawnFn },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('written reason')
    expect(args).toEqual([])
  })

  it('carries `handled` through as itself, with the CLI’s own note', async () => {
    // A PERSON'S ISSUE IS NEVER CLOSED BY A LOOP: the claim comes off, a local
    // record is written, and the issue stays open for the pull request. Folding
    // this into `closed` would report somebody's live report as resolved.
    const { spawnFn } = fakeSpawn({
      stdout: JSON.stringify({
        status: 'handled',
        loop: 'fix',
        reason: 'wontfix',
        note: 'issue left open — it is not ours to close',
        item: { id: '9', loop: 'fix', title: 'x', state: 'open', approved: true },
        remaining: 0,
      }),
    })
    const result = await closeLoopItem(
      cli,
      '/r',
      { loop: 'fix', id: '9', reason: 'wontfix', detail: 'not a bug' },
      { spawnFn },
    )
    expect(result).toEqual({
      ok: true,
      reason: null,
      status: 'handled',
      note: 'issue left open — it is not ours to close',
    })
  })

  it('reads a refusal off the combined transcript, verbatim', async () => {
    const { spawnFn } = fakeSpawn({
      stdout: "loop refused: item 3 is claimed by 'run-2' — 'flow-ide' cannot close it\n",
      code: 1,
    })
    const result = await closeLoopItem(
      cli,
      '/r',
      { loop: 'find', id: '3', reason: 'wontfix', detail: 'no' },
      { spawnFn },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cannot close it')
    expect(result.status).toBeNull()
  })

  it('treats an unrecognised status as a refusal', () => {
    // Same rule the release beside it states: taking an unknown word for
    // success is how a board reports an item settled that is still on the list.
    expect(parseCloseJson('{"status":"sideways"}').ok).toBe(false)
    expect(parseCloseJson('').reason).toBe('no output')
    expect(parseCloseJson('{nope').reason).toBe('unparseable loop close output')
  })

  it('says so when there is no bundled CLI to run', async () => {
    const result = await closeLoopItem(null, '/r', {
      loop: 'find',
      id: '3',
      reason: 'wontfix',
      detail: 'no',
    })
    expect(result).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
      status: null,
      note: null,
    })
  })
})

describe('unclaimLoopItem', () => {
  const released = JSON.stringify({
    status: 'unclaimed',
    loop: 'fix',
    id: '1533',
    wasClaimed: true,
    tookOverAbandoned: false,
    item: { id: '1533', loop: 'fix', title: 'code map refactor', state: 'open', approved: true },
  })

  it('runs `loop unclaim` with the loop, the id and the owner', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: released })
    const result = await unclaimLoopItem(
      cli,
      '/r',
      { loop: 'fix', id: '1533', owner: 'flow-ide-abc123abc123' },
      { spawnFn },
    )
    expect(args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'unclaim',
      '--loop',
      'fix',
      '--id',
      '1533',
      '--owner',
      'flow-ide-abc123abc123',
    ])
    expect(result).toEqual({ ok: true, reason: null, wasClaimed: true })
  })

  it('omits `--owner` when nothing named one, leaving the CLI its own reading', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: released })
    await unclaimLoopItem(cli, '/r', { loop: 'fix', id: '1533' }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'unclaim', '--loop', 'fix', '--id', '1533'])
  })

  it('carries `wasClaimed: false` through — releasing what nobody held is success', async () => {
    const { spawnFn } = fakeSpawn({
      stdout: JSON.stringify({ status: 'unclaimed', loop: 'fix', id: '9', wasClaimed: false }),
    })
    expect(await unclaimLoopItem(cli, '/r', { loop: 'fix', id: '9' }, { spawnFn })).toEqual({
      ok: true,
      reason: null,
      wasClaimed: false,
    })
  })

  it('reports the CLI refusal verbatim rather than throwing', async () => {
    // The ownership check is the BACKEND'S — this channel cannot be talked into
    // releasing a stranger's claim, and the sentence that says so is the CLI's.
    const { spawnFn } = fakeSpawn({
      stdout: "loop refused: item 1533 is held by '@someone-else' on the queue\n",
      code: 1,
    })
    expect(await unclaimLoopItem(cli, '/r', { loop: 'fix', id: '1533' }, { spawnFn })).toEqual({
      ok: false,
      reason: "loop refused: item 1533 is held by '@someone-else' on the queue",
      wasClaimed: false,
    })
  })

  it('refuses an unrecognised status rather than reading it as a release', async () => {
    const { spawnFn } = fakeSpawn({ stdout: JSON.stringify({ status: 'maybe' }) })
    expect(await unclaimLoopItem(cli, '/r', { loop: 'fix', id: '1' }, { spawnFn })).toEqual({
      ok: false,
      reason: "unexpected loop unclaim status 'maybe'",
      wasClaimed: false,
    })
  })

  it('refuses locally with no loop or no id, and with no CLI — no spawn at all', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: released })
    expect(await unclaimLoopItem(cli, '/r', { loop: '  ', id: '1' }, { spawnFn })).toEqual({
      ok: false,
      reason: 'unclaim needs a loop and an item id',
      wasClaimed: false,
    })
    expect(await unclaimLoopItem(cli, '/r', { loop: 'fix', id: ' ' }, { spawnFn })).toMatchObject({
      reason: 'unclaim needs a loop and an item id',
    })
    expect(await unclaimLoopItem(null, '/r', { loop: 'fix', id: '1' })).toMatchObject({
      ok: false,
      reason: 'bundled CLI unavailable',
    })
    expect(args).toEqual([])
  })

  it('never throws when the spawn itself fails', async () => {
    const spawnFn = () => {
      throw new Error('ENOENT')
    }
    expect(
      await unclaimLoopItem(cli, '/r', { loop: 'fix', id: '1' }, { spawnFn: spawnFn as any }),
    ).toMatchObject({ ok: false, reason: 'ENOENT' })
  })
})

describe('registerLoopsChannels', () => {
  const roots = (paths: string[]) => ({
    getRoots: () => paths.map((rootPath) => ({ rootPath })),
    onRootsChanged: () => () => undefined,
  })

  /**
   * The two caches, with their WORLD REMOVED.
   *
   * NOTHING IN THIS SUITE MAY TOUCH THE MACHINE. The directive cache watches
   * files and the runs cache spawns Claude Code; a test that let either reach
   * the real thing would watch directories that do not exist (and hang the
   * runner on their handles) and start a process against whatever is installed.
   * Both take injectable readers precisely so this file can say what they
   * answered.
   */
  const caches = (
    snapshot: LoopDirectiveSnapshot = { available: true, reason: null, loops: [], readAt: 0 },
  ) => ({
    directives: new LoopDirectiveCache({
      watchFn: () => null,
      readFn: () => Promise.resolve(snapshot),
    }),
    runsCache: new RunsInFlightCache({
      readFn: () => Promise.resolve({ known: false as const, reason: 'nobody looked', readAt: 0 }),
    }),
  })

  const call = <T>(channel: string, request: unknown): Promise<T> => {
    const handler = mockHandlers.get(channel)
    if (handler === undefined) throw new Error(`channel ${channel} was never registered`)
    return Promise.resolve(handler(null, request) as T)
  }

  afterEach(() => {
    mockHandlers.clear()
  })

  it('validates rootId on the READS and the WRITES alike', async () => {
    // Every channel spawns a CLI whose cwd is the rootId. An unvalidated write
    // would be an arbitrary directory the renderer got to name, which is why
    // this rule has no exception for "a write can only follow a read".
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: cli, ...caches() })

    expect(await call<any>('loops:queue', { rootId: '/elsewhere' })).toEqual({
      available: false,
      reason: 'unknown root',
      state: null,
      loops: [],
      generatedAt: null,
    })
    expect(await call<any>('loops:claim', { rootId: '/elsewhere', loop: 'fix', id: '1' })).toEqual({
      status: 'refused',
      loop: 'fix',
      owner: null,
      reason: 'unknown root',
      item: null,
    })
    expect(await call<any>('loops:read', { rootId: '/elsewhere' })).toMatchObject({
      available: false,
      reason: 'unknown root',
    })
    // The activity read is validated the same way, and its refusal keeps the
    // unknown-is-not-empty rule: nobody could say what is running, so no claim
    // may be reported as stuck.
    expect(await call<any>('loops:activity', { rootId: '/elsewhere', visible: true })).toMatchObject({
      runs: { known: false },
      stuck: { known: false },
    })
    expect(await call<any>('loops:setPaused', { rootId: '/elsewhere', loop: 'fix', paused: true })).toEqual({
      ok: false,
      reason: 'unknown root',
    })
    expect(await call<any>('loops:approve', { rootId: '/elsewhere', loop: 'fix', id: '1' })).toEqual({
      ok: false,
      reason: 'unknown root',
    })
    // The directive write is validated like every other: it becomes a spawned
    // CLI's cwd, and the fact that it rewrites a committed file makes it the
    // last place to trust a rootId the renderer named.
    expect(
      await call<any>('loops:setDirectivePaused', { rootId: '/elsewhere', loop: 'fix', paused: true }),
    ).toEqual({ ok: false, reason: 'unknown root' })
    expect(
      await call<any>('loops:setDirectiveQueue', { rootId: '/elsewhere', loop: 'fix', queue: 'ledger' }),
    ).toEqual({ ok: false, reason: 'unknown root' })

    dispose()
  })

  it('reports unavailable on the directive write when the bundled CLI is missing', async () => {
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })
    expect(
      await call<any>('loops:setDirectivePaused', { rootId: '/known', loop: 'fix', paused: true }),
    ).toEqual({ ok: false, reason: 'bundled CLI unavailable' })
    dispose()
  })

  it('reports unavailable on EVERY channel when the bundled CLI is missing', async () => {
    // An older bundle, or a dev run with no CLI resolved: the board must render
    // a one-line notice, never throw.
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })

    expect(await call<any>('loops:queue', { rootId: '/known' })).toMatchObject({
      available: false,
      reason: 'bundled CLI unavailable',
      loops: [],
    })
    expect(await call<any>('loops:claim', { rootId: '/known', loop: 'fix' })).toMatchObject({
      status: 'refused',
      reason: 'bundled CLI unavailable',
    })
    // …EXCEPT the directive read, which never had a CLI to miss. It is a
    // readdir over `loops/`, so a project with no bundled CLI still gets every
    // loop it has — the whole point of moving this off the subprocess.
    expect(await call<any>('loops:read', { rootId: '/known' })).toMatchObject({
      available: true,
      reason: null,
      loops: [],
    })
    // The ACTIVITY read is the one that needs the CLI, and it says so on the
    // status half while still reporting the runs and the stuck claims as
    // unknown rather than as none.
    expect(await call<any>('loops:activity', { rootId: '/known', visible: true })).toMatchObject({
      status: { available: false, reason: 'bundled CLI unavailable' },
      runs: { known: false },
      stuck: { known: false },
    })
    expect(await call<any>('loops:setPaused', { rootId: '/known', loop: 'fix', paused: false })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
    })
    expect(await call<any>('loops:approve', { rootId: '/known', loop: 'fix', id: '1' })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
    })

    dispose()
  })

  it('unregisters every channel it registered', () => {
    const dispose = registerLoopsChannels({ roots: roots(['/known']), ...caches() })
    expect([...mockHandlers.keys()].sort()).toEqual([
      'loops:activity',
      'loops:approve',
      'loops:claim',
      'loops:close',
      'loops:describe',
      'loops:file',
      'loops:finishHunt',
      'loops:forget',
      'loops:owner',
      'loops:queue',
      'loops:read',
      'loops:setDirectiveDescription',
      'loops:setDirectivePaused',
      'loops:setDirectiveQueue',
      'loops:setPaused',
      'loops:unclaim',
    ])
    dispose()
    expect(mockHandlers.size).toBe(0)
  })

  // ── the durable owner and the release (review finding H1) ───────────────

  it('validates rootId on the RELEASE too — it spawns a CLI like every other write', async () => {
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: cli, ...caches() })
    expect(
      await call<any>('loops:unclaim', { rootId: '/elsewhere', loop: 'fix', id: '1' }),
    ).toEqual({ ok: false, reason: 'unknown root', wasClaimed: false })
    dispose()
  })

  it('reports unavailable on the release when the bundled CLI is missing', async () => {
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })
    expect(await call<any>('loops:unclaim', { rootId: '/known', loop: 'fix', id: '1' })).toEqual({
      ok: false,
      reason: 'bundled CLI unavailable',
      wasClaimed: false,
    })
    dispose()
  })

  it('answers `loops:owner` with the word the caller persisted', async () => {
    const dispose = registerLoopsChannels({
      roots: roots(['/known']),
      bundledCli: cli,
      ownerId: () => 'flow-ide-3f2a9c1b7e04',
      ...caches(),
    })
    // No rootId: it names the installation, not a project.
    expect(await call<any>('loops:owner', {})).toEqual({ owner: 'flow-ide-3f2a9c1b7e04' })
    dispose()
  })

  it('resolves the installation owner on both writes, and only for a known root', async () => {
    // THE FINDING ITSELF (H1): a claim sent with no owner lets the CLI mint a
    // fresh `run-<ts>-<pid>` per invocation, so a retry is refused by the claim
    // this very window just made. The channel must reach for the durable one.
    // (That the resolved word lands in argv is asserted against `claimLoopItem`
    // and `unclaimLoopItem` themselves, which take an injectable spawn.)
    const ownerId = jest.fn(() => 'flow-ide-abc123abc123')
    const dispose = registerLoopsChannels({
      roots: roots(['/known']),
      bundledCli: null,
      ownerId,
      ...caches(),
    })

    await call<any>('loops:claim', { rootId: '/known', loop: 'fix', id: '1' })
    expect(ownerId).toHaveBeenCalledTimes(1)
    await call<any>('loops:unclaim', { rootId: '/known', loop: 'fix', id: '1' })
    expect(ownerId).toHaveBeenCalledTimes(2)

    // An unknown root refuses BEFORE anything else happens — the identity is
    // not even reached, let alone a spawn.
    await call<any>('loops:claim', { rootId: '/elsewhere', loop: 'fix', id: '1' })
    await call<any>('loops:unclaim', { rootId: '/elsewhere', loop: 'fix', id: '1' })
    expect(ownerId).toHaveBeenCalledTimes(2)

    dispose()
  })

  it('reports an empty owner rather than inventing one when nothing persisted it', async () => {
    // A harness with no settings store. Empty is the honest answer, and the
    // renderer reads it as "unknown" — no Release control, a held card treated
    // as somebody else's — which is exactly the pre-H1 behaviour.
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })
    expect(await call<any>('loops:owner', {})).toEqual({ owner: '' })
    dispose()
  })
})

// ── the hunts a producer reports (loops-on-the-board, Phase 7, Task 7.1) ──

describe('instructions come through as the store holds them', () => {
  const row = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      status: 'ok',
      loops: [
        {
          loop: 'find',
          pause: null,
          queue: null,
          ...extra,
        },
      ],
      generatedAt: '2026-08-14T02:05:00.000Z',
    })

  it('carries text, filed, cap, quietRuns, status and since verbatim', () => {
    const parsed = parseStatusJson(
      row({
        instructions: [
          {
            text: 'find UI gaps',
            filed: 7,
            cap: 20,
            quietRuns: 1,
            status: 'active',
            since: '2026-08-11T09:00:00.000Z',
          },
        ],
      }),
    )
    expect(parsed.loops[0].instructions).toEqual([
      {
        text: 'find UI gaps',
        filed: 7,
        cap: 20,
        quietRuns: 1,
        status: 'active',
        since: '2026-08-11T09:00:00.000Z',
      },
    ])
  })

  it('leaves the field ABSENT when the CLI omitted it — absent is "not measured"', () => {
    // The CLI omits `instructions` on a row whose store could not be read (the
    // reason arrives on `instructionsError`), and an empty array here would read
    // as "measured, nothing being hunted".
    const parsed = parseStatusJson(row({ instructionsError: 'malformed instructions.json' }))
    expect(parsed.loops[0].instructions).toBeUndefined()
    expect(parsed.loops[0].instructionsError).toBe('malformed instructions.json')
  })

  it('keeps an EMPTY array empty — a consumer genuinely has none', () => {
    expect(parseStatusJson(row({ instructions: [] })).loops[0].instructions).toEqual([])
  })

  it('drops an entry with no text or an unknown status, rather than guessing one', () => {
    const parsed = parseStatusJson(
      row({
        instructions: [
          { filed: 1, cap: 2, quietRuns: 0, status: 'active', since: '' },
          { text: 'sideways', filed: 1, cap: 2, quietRuns: 0, status: 'paused', since: '' },
          { text: 'kept', filed: 1, cap: 2, quietRuns: 0, status: 'dry', since: '' },
        ],
      }),
    )
    expect(parsed.loops[0].instructions?.map((entry) => entry.text)).toEqual(['kept'])
  })
})

// ── a hunt's resume rides the resume verb (Phase 7, Task 7.5) ─────────────

describe('setLoopPaused carries a hunt on the RESUME only', () => {
  it('sends --focus and --cap on a per-loop resume', async () => {
    // `loop resume --loop <n> --focus <text>` is the CLI's own "I looked, carry
    // on": it stops the instruction and starts it again. One verb, one channel.
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(
      cli,
      '/r',
      { loop: 'find', paused: false, focus: 'find UI gaps', cap: 20 },
      { spawnFn },
    )
    expect(args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'resume',
      '--loop',
      'find',
      '--focus',
      'find UI gaps',
      '--cap',
      '20',
    ])
  })

  it('drops the focus on a PAUSE — `loop pause` takes none', async () => {
    // A flag the verb ignores is the kind of silently-dropped argument that
    // makes a caller believe a write happened.
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: 'find', paused: true, focus: 'find UI gaps' }, { spawnFn })
    expect(args[0]).not.toContain('--focus')
  })

  it('drops the focus on a GLOBAL resume — that scope would restart a hunt sideways', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: '', paused: false, focus: 'find UI gaps' }, { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'resume'])
  })

  it('drops a cap the CLI would refuse rather than turning a resume into a refusal', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{}' })
    await setLoopPaused(cli, '/r', { loop: 'find', paused: false, focus: 'x', cap: 0 }, { spawnFn })
    expect(args[0]).not.toContain('--cap')
    expect(args[0]).toContain('--focus')
  })
})

// ── Filing to the shared list (thread-tasklist, Phase 5, Task 5.2) ────────
//
// THE ONE ASSERTION UNDERNEATH ALL OF THESE: the app does not write a queue.
// Every fact a filed item carries — its fingerprint, its labels, its topic, the
// cap it is subject to, whether it starts behind the approval gate — is decided
// by the CLI from the loop's own directive, so what is checked here is that this
// side hands over a title and a loop and adds nothing of its own to the argv.

describe('fileLoopItem — the only writer of the shared list is the CLI', () => {
  it('spawns exactly one `loop file`, carrying the title and the loop and no more', async () => {
    const { spawnFn, args } = fakeSpawn({
      stdout: `${JSON.stringify({ status: 'filed', loop: 'fix', item: { id: '2001' } })}\n`,
    })
    const result = await fileLoopItem(
      cli,
      '/repo',
      { loop: 'fix', title: 'run the tests' },
      { spawnFn },
    )
    expect(result).toEqual({ ok: true, reason: null, status: 'filed' })
    expect(args).toHaveLength(1)
    expect(args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'file',
      '--loop',
      'fix',
      '--title',
      'run the tests',
    ])
    // No labels, no topic, no approval flag: all of those are the directive's.
    expect(args[0]?.join(' ')).not.toContain('--labels')
    expect(args[0]?.join(' ')).not.toContain('--needs-approval')
  })

  it('passes a body only when there is one', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"status":"filed"}\n' })
    await fileLoopItem(cli, '/repo', { loop: 'fix', title: 't', body: '  ' }, { spawnFn })
    expect(args[0]).not.toContain('--body')
    const second = fakeSpawn({ stdout: '{"status":"filed"}\n' })
    await fileLoopItem(cli, '/repo', { loop: 'fix', title: 't', body: 'why' }, { spawnFn: second.spawnFn })
    expect(second.args[0]).toEqual([
      '/app/cli.mjs',
      'loop',
      'file',
      '--loop',
      'fix',
      '--title',
      't',
      '--body',
      'why',
    ])
  })

  it('reports a duplicate as the success it is, not as a failure', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '{"status":"duplicate","loop":"fix","item":{"id":"7"}}\n' })
    expect(await fileLoopItem(cli, '/repo', { loop: 'fix', title: 't' }, { spawnFn })).toEqual({
      ok: true,
      reason: null,
      status: 'duplicate',
    })
  })

  it("relays the CLI's own refusal line, read off the combined transcript", async () => {
    // The CLI's logger routes `error()` through console.log, so a refusal
    // arrives on STDOUT with a coloured bullet in front of it.
    const { spawnFn } = fakeSpawn({
      stdout: "[31m  x[0m loop refused: no directive for loop 'fix'\n",
      code: 1,
    })
    expect(await fileLoopItem(cli, '/repo', { loop: 'fix', title: 't' }, { spawnFn })).toEqual({
      ok: false,
      reason: "loop refused: no directive for loop 'fix'",
      status: null,
    })
  })

  it('refuses without spawning when it has nothing to file', async () => {
    const { spawnFn, args } = fakeSpawn({})
    expect((await fileLoopItem(cli, '/repo', { loop: ' ', title: 't' }, { spawnFn })).ok).toBe(false)
    expect((await fileLoopItem(cli, '/repo', { loop: 'fix', title: ' ' }, { spawnFn })).ok).toBe(false)
    expect((await fileLoopItem(null, '/repo', { loop: 'fix', title: 't' }, { spawnFn })).ok).toBe(false)
    expect(args).toHaveLength(0)
  })

  it('keeps a clean exit a success even when its report will not parse', () => {
    // The exit code is the authority on whether the write landed; the JSON is
    // the authority on WHICH success it was, and only that half can be lost.
    expect(parseFileJson('not json at all')).toEqual({ ok: true, reason: null, status: null })
    expect(parseFileJson('{"status":"something-new"}')).toEqual({ ok: true, reason: null, status: null })
    expect(parseFileJson('')).toEqual({ ok: true, reason: null, status: null })
  })
})

describe('loops:file — the channel', () => {
  it('refuses a root this app does not manage, without spawning anything', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"status":"filed"}\n' })
    const dispose = registerLoopsChannels({
      roots: { getRoots: () => [{ rootPath: '/repo' }] } as any,
      bundledCli: cli,
      directives: new LoopDirectiveCache({
        watchFn: () => null,
        readFn: () => Promise.resolve({ available: true, reason: null, loops: [], readAt: 0 }),
      }),
      runsCache: new RunsInFlightCache({
        readFn: () => Promise.resolve({ known: false as const, reason: 'nobody looked', readAt: 0 }),
      }),
    })
    const handler = mockHandlers.get('loops:file')
    expect(handler).toBeDefined()
    expect(await handler?.(null, { rootId: '/elsewhere', loop: 'fix', title: 't' })).toEqual({
      ok: false,
      reason: 'unknown root',
      status: null,
    })
    expect(args).toHaveLength(0)
    dispose()
    void spawnFn
  })
})

// ── The fast half, and the slow half that knows what is running ──────────

describe('directiveSnapshotToLoops', () => {
  const entry = (over: Partial<any> = {}) => ({
    loop: 'find',
    source: '/repo/loops/find.md',
    directiveError: null,
    queueLocation: 'acme/widgets',
    directive: {
      loop: 'find',
      engine: 'producer' as const,
      paused: false,
      mission: 'put work in the list',
      scope: [],
      slice: 'rotate' as const,
      queue: 'github' as const,
      repo: 'acme/widgets',
      topic: 'backlog',
      maxOpenIssues: 20,
      maxRunMinutes: 25,
      maxConcurrentRuns: 1,
      needsApproval: false,
      direction: '',
      rules: '',
    },
    ...over,
  })

  it('carries every fact the file holds, and invents none of the rest', () => {
    const snapshot = directiveSnapshotToLoops({
      available: true,
      reason: null,
      loops: [entry()],
      readAt: Date.parse('2026-08-24T10:00:00.000Z'),
    })
    expect(snapshot.available).toBe(true)
    const row = snapshot.loops[0]
    expect(row).toMatchObject({
      loop: 'find',
      engine: 'producer',
      topic: 'backlog',
      mission: 'put work in the list',
      slice: 'rotate',
      queueKind: 'github',
      queueLocation: 'acme/widgets',
      directivePaused: false,
    })
    // NOT MEASURED, NOT ZERO. A directive says what a loop IS; it cannot say
    // what the loop is doing, and a zeroed count here would be the panel
    // reporting an empty queue it never read.
    expect(row.queue).toBeNull()
    expect(row.locks).toEqual([])
    expect(row.pause).toBeNull()
    expect(snapshot.globalPause).toBeNull()
  })

  it('keeps an unreadable directive as a ROW carrying its refusal', () => {
    const snapshot = directiveSnapshotToLoops({
      available: true,
      reason: null,
      loops: [
        entry({
          loop: 'perf',
          directive: null,
          queueLocation: null,
          directiveError: "/repo/loops/perf.md: unknown frontmatter key 'quee'",
        }),
      ],
      readAt: 0,
    })
    expect(snapshot.loops).toHaveLength(1)
    expect(snapshot.loops[0].loop).toBe('perf')
    expect(snapshot.loops[0].directiveError).toContain('unknown frontmatter key')
  })

  it('is a NOTICE, not an empty list, when nothing could be listed at all', () => {
    const snapshot = directiveSnapshotToLoops({
      available: false,
      reason: '/repo/loops: unreadable (EACCES)',
      loops: [],
      readAt: 0,
    })
    expect(snapshot.available).toBe(false)
    expect(snapshot.reason).toContain('EACCES')
  })
})

describe('runs, and the stuck claims they make answerable', () => {
  it('hands `loop status` the RAW agents list, not a narrowing of it', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"loops":[],"runs":{"known":true}}' })
    const raw = '[{"kind":"background","sessionId":"s-1"}]'
    await readLoops(cli, '/repo', { spawnFn, liveRuns: raw })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'status', '--live-runs', raw])
  })

  it('sends no snapshot at all when nobody could say what is running', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"loops":[]}' })
    await readLoops(cli, '/repo', { spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'status'])
  })

  it('reads `runs.known` BEFORE the claims — absent is unknown, never none', () => {
    // The whole safety property in one assertion pair. A report that could not
    // tell a live run from a dead one must not render as "nothing is stuck".
    const cannotTell = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null}],"runs":{"known":false,"reason":"nothing said which runs are alive"}}',
    )
    expect(cannotTell.stuck.known).toBe(false)
    expect(cannotTell.stuck).toMatchObject({ reason: 'nothing said which runs are alive' })

    const asked = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null,"stuckClaims":[' +
        '{"id":"1701","loop":"fix","owner":"run-x~s-9","sessionId":"s-9","claimedAt":"2026-08-24T09:00:00.000Z"}]}],' +
        '"runs":{"known":true}}',
    )
    expect(asked.stuck).toEqual({
      known: true,
      claims: [
        {
          id: '1701',
          loop: 'fix',
          owner: 'run-x~s-9',
          sessionId: 's-9',
          claimedAt: '2026-08-24T09:00:00.000Z',
        },
      ],
    })
  })

  it('treats an older CLI that says nothing about runs as unknown', () => {
    const older = parseStatusResult('{"loops":[],"generatedAt":"2026-08-24T10:00:00.000Z"}')
    expect(older.snapshot.available).toBe(true)
    expect(older.stuck.known).toBe(false)
  })

  it('drops a stuck claim that names no item or no session', () => {
    const result = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null,"stuckClaims":[' +
        '{"loop":"fix","sessionId":"s-9"},{"id":"7","loop":"fix"},{"id":"8","loop":"fix","sessionId":"s-2"}]}],' +
        '"runs":{"known":true}}',
    )
    expect(result.stuck).toMatchObject({ known: true })
    expect(result.stuck.known && result.stuck.claims.map((claim) => claim.id)).toEqual(['8'])
  })

  it('narrows the runs report, and never turns unknown into an empty list', () => {
    expect(runsReportOf({ known: false, reason: 'no claude on PATH', readAt: 0 })).toEqual({
      known: false,
      reason: 'no claude on PATH',
    })
    expect(
      runsReportOf({
        known: true,
        raw: '[]',
        readAt: 0,
        runs: [
          { sessionId: 's-1', id: 'a1', name: 'loop fix', cwd: '/repo', startedAt: 5, state: 'blocked' },
        ],
      }),
    ).toEqual({
      known: true,
      runs: [
        { sessionId: 's-1', id: 'a1', name: 'loop fix', cwd: '/repo', startedAt: 5, state: 'blocked' },
      ],
    })
  })
})

describe('the expensive half is gated on whether anyone is looking (review finding H1)', () => {
  /** A runs cache with no world behind it — the status read is what is on trial. */
  const noRuns = () =>
    new RunsInFlightCache({
      readFn: () => Promise.resolve({ known: false as const, reason: 'nobody looked', readAt: 0 }),
    })

  it('spawns NOTHING for a caller that says nobody is looking', async () => {
    // THE DEFECT THIS WHOLE CHANGE EXISTS TO REMOVE, still running on its own
    // interval: `visible` reached the runs cache and stopped, so `loop status`
    // — a fresh CLI runtime boot plus a `gh` round trip per github loop — ran
    // unconditionally. The tasks board polls this every fifteen seconds with
    // `visible: false` because it draws no runs.
    const { spawnFn, args } = fakeSpawn({ stdout: '{"loops":[],"runs":{"known":true}}' })
    const activity = await readLoopsActivity(cli, '/repo', noRuns(), { visible: false, spawnFn })
    expect(args).toEqual([])
    // …and it says so rather than reporting a healthy project it never read.
    expect(activity.status.available).toBe(false)
    expect(activity.stuck.known).toBe(false)
    expect(activity.runs.known).toBe(false)
  })

  it('serves an off-screen caller the last answer a visible one looked up', async () => {
    const statusCache = new LoopStatusCache()
    const first = fakeSpawn({
      stdout:
        '{"loops":[{"loop":"fix","pause":null,"queue":null,"stuckClaims":[],"abandonedClaims":[]}],"runs":{"known":true}}',
    })
    await readLoopsActivity(cli, '/repo', noRuns(), {
      visible: true,
      spawnFn: first.spawnFn,
      statusCache,
    })
    expect(first.args).toHaveLength(1)

    const second = fakeSpawn({ stdout: '{"loops":[],"runs":{"known":true}}' })
    const activity = await readLoopsActivity(cli, '/repo', noRuns(), {
      visible: false,
      spawnFn: second.spawnFn,
      statusCache,
    })
    expect(second.args).toEqual([])
    expect(activity.status.loops.map((row) => row.loop)).toEqual(['fix'])
    expect(activity.stuck).toEqual({ known: true, claims: [] })
  })

  it('falls back to what a file can say when nobody has looked yet', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"loops":[],"runs":{"known":true}}' })
    const activity = await readLoopsActivity(cli, '/repo', noRuns(), {
      visible: false,
      spawnFn,
      lastResortStatus: () =>
        Promise.resolve(
          directiveSnapshotToLoops({
            available: true,
            reason: null,
            readAt: 0,
            loops: [
              {
                loop: 'find',
                directive: {
                  engine: 'producer',
                  mission: 'look',
                  slice: 'one',
                  queue: 'github',
                  paused: false,
                } as any,
                directiveError: null,
                queueLocation: null,
              } as any,
            ],
          }),
        ),
    })
    expect(args).toEqual([])
    expect(activity.status.loops.map((row) => row.loop)).toEqual(['find'])
    // The counts a file cannot hold stay ABSENT rather than being invented.
    expect(activity.status.loops[0]?.queue).toBeNull()
    expect(activity.stuck.known).toBe(false)
  })

  it('still reads the CLI for a caller that IS looking', async () => {
    const { spawnFn, args } = fakeSpawn({ stdout: '{"loops":[],"runs":{"known":true}}' })
    await readLoopsActivity(cli, '/repo', noRuns(), { visible: true, spawnFn })
    expect(args[0]).toEqual(['/app/cli.mjs', 'loop', 'status'])
  })
})

describe('loops:activity — the in-flight dedupe (review finding H3)', () => {
  const roots = (paths: string[]) => ({
    getRoots: () => paths.map((rootPath) => ({ rootPath })),
    onRootsChanged: () => () => undefined,
  })

  const caches = () => ({
    directives: new LoopDirectiveCache({
      watchFn: () => null,
      readFn: () =>
        Promise.resolve({ available: true, reason: null, loops: [], readAt: 0 } as LoopDirectiveSnapshot),
    }),
    runsCache: new RunsInFlightCache({
      readFn: () => Promise.resolve({ known: false as const, reason: 'nobody looked', readAt: 0 }),
    }),
  })

  const call = <T>(channel: string, request: unknown): Promise<T> => {
    const handler = mockHandlers.get(channel)
    if (handler === undefined) throw new Error(`channel ${channel} was never registered`)
    return Promise.resolve(handler(null, request) as T)
  }

  afterEach(() => {
    mockHandlers.clear()
  })

  it('does not hand a visible caller the cheap answer an invisible one asked for', async () => {
    // Keyed on the root alone, the board's `visible: false` request — which by
    // design spends nothing — was served to the Loops screen that asked, at the
    // same moment on startup, a strictly larger question. The screen that WAS
    // open then rendered "Flow can't tell", having started nothing, and with
    // its fifteen-second poll deleted nothing re-asked.
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })
    const cheap = call<any>('loops:activity', { rootId: '/known', visible: false })
    const rich = call<any>('loops:activity', { rootId: '/known', visible: true })

    // The one that may spend gets the answer it paid for…
    expect(await rich).toMatchObject({
      status: { available: false, reason: 'bundled CLI unavailable' },
    })
    // …and the one that may not gets what a file could say, not the CLI's.
    expect(await cheap).toMatchObject({ status: { available: true } })
    dispose()
  })

  it('still folds a cheap caller into a read that is already paying', async () => {
    // The asymmetry only points one way: every read answers at least the cheap
    // caller's question, so joining upward costs nothing and saves a process.
    const dispose = registerLoopsChannels({ roots: roots(['/known']), bundledCli: null, ...caches() })
    const rich = call<any>('loops:activity', { rootId: '/known', visible: true })
    const cheap = call<any>('loops:activity', { rootId: '/known', visible: false })
    expect(await cheap).toEqual(await rich)
    dispose()
  })
})

describe('an unreadable list is not a clean bill of health (review finding C3)', () => {
  it('refuses to read a queue that could not be read as “nothing is stuck”', () => {
    // The CLI's own docblock, directly above the field: ABSENT means nobody
    // could tell, "the queue was unreadable, or no snapshot of the live runs
    // was supplied", and "it must never be read as 'nothing is stuck'". Only
    // the second cause was honoured, so a `gh` outage on one github loop
    // arrived as `known: true, claims: []` and the panel said nothing at all.
    const result = parseStatusResult(
      '{"loops":[{"loop":"find","pause":null,"queue":null,"queueError":"gh: could not resolve host"}],' +
        '"runs":{"known":true}}',
    )
    expect(result.stuck.known).toBe(false)
    expect(result.stuck).toMatchObject({ reason: expect.stringContaining('find') })
  })

  it('reports what it DID find beside the gap, rather than choosing one', () => {
    const result = parseStatusResult(
      '{"loops":[' +
        '{"loop":"fix","pause":null,"queue":null,"stuckClaims":[' +
        '{"id":"1701","loop":"fix","owner":"run-a~s-9","sessionId":"s-9"}]},' +
        '{"loop":"find","pause":null,"queue":null,"queueError":"gh: could not resolve host"}' +
        '],"runs":{"known":true}}',
    )
    expect(result.stuck.known).toBe(false)
    expect(!result.stuck.known && result.stuck.claims?.map((claim) => claim.id)).toEqual(['1701'])
    expect(result.stuck).toMatchObject({ reason: expect.stringContaining('find') })
  })

  it('keeps `known: true` when every list really was read', () => {
    const result = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null,"stuckClaims":[]},' +
        '{"loop":"find","pause":null,"queue":null,"stuckClaims":[]}],"runs":{"known":true}}',
    )
    expect(result.stuck).toEqual({ known: true, claims: [] })
  })
})

describe('abandonedClaims — the dead-run signal that still fires', () => {
  it('carries the CLI’s TTL check onto the row', () => {
    // `stuckClaims` cannot fire in production (nothing records a session), and
    // this — which the CLI has emitted all along — was not in the contract and
    // was never parsed, so the IDE had NO dead-run signal whatsoever.
    const result = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null,"abandonedClaims":[' +
        '{"id":"1701","owner":"run-a","claimedAt":"2026-08-24T09:00:00.000Z","ageMs":7200000}]}],' +
        '"runs":{"known":false,"reason":"nothing said which runs are alive"}}',
    )
    expect(result.snapshot.loops[0]?.abandonedClaims).toEqual([
      { id: '1701', owner: 'run-a', claimedAt: '2026-08-24T09:00:00.000Z', ageMs: 7200000 },
    ])
    // …and it is a SEPARATE fact: the stuck report is still unknown, because
    // nothing said which runs are alive.
    expect(result.stuck.known).toBe(false)
  })

  it('keeps absent absent — a row nobody could read reports no claim', () => {
    const result = parseStatusResult(
      '{"loops":[{"loop":"find","pause":null,"queue":null,"queueError":"gh offline"}],"runs":{"known":true}}',
    )
    expect(result.snapshot.loops[0]?.abandonedClaims).toBeUndefined()
  })

  it('drops an entry that names no item or carries no age', () => {
    const result = parseStatusResult(
      '{"loops":[{"loop":"fix","pause":null,"queue":null,"abandonedClaims":[' +
        '{"owner":"run-a","claimedAt":"2026-08-24T09:00:00.000Z","ageMs":1},' +
        '{"id":"7","owner":"run-b","claimedAt":"2026-08-24T09:00:00.000Z"},' +
        '{"id":"8","owner":"run-c","claimedAt":"2026-08-24T09:00:00.000Z","ageMs":9}]}],' +
        '"runs":{"known":true}}',
    )
    expect(result.snapshot.loops[0]?.abandonedClaims?.map((claim) => claim.id)).toEqual(['8'])
  })
})
