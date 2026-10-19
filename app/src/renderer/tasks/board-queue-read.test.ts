// The board's queue read, end to end through the REAL narrowing
// (loops-on-the-board, Tasks 8.2 and 8.4).
//
// WHY THIS FILE EXISTS NEXT TO board-model.test.ts. That suite builds a
// `LoopQueueSnapshot` by hand and proves what the model does with it; this one
// starts from the bytes `planflow-ai loop list` really prints and walks them
// through the same two steps the running app does — `parseListJson` (or
// `readLoopQueue`, spawn and all) and then `buildBoardModel`. A hand-built
// snapshot cannot catch a narrowing that turns a null into an empty array,
// because the test would have written the null itself.
//
// EVERY PAYLOAD BELOW IS VERBATIM CLI OUTPUT, captured on 2026-08-14 by running
// the built binary against throwaway fixture projects:
//
//   node dist/cli/index.js loop list --target <fixture>              (ledger)
//   PATH=<no gh> node dist/cli/index.js loop list --target <fixture>  (github)
//   node dist/cli/index.js loop list --state sideways --target <fx>   (refusal)
//
// including the ANSI the logger paints unconditionally on a pipe.
//
// THE FILE-ABSENCE HALF OF TASK 8.4 IS NOT HERE, and deliberately: proving that
// a read creates no queue file requires the real binary touching a real disk,
// and that assertion lives in src/cli/commands/loop-e2e.test.ts ("reading writes
// nothing — not a queue file, not a byte" / "a project with NO loop directives
// lists nothing and creates nothing"), where the built CLI is already a declared
// precondition. Repeating it here with a stubbed spawn would assert that a
// function which never ran wrote nothing.

import { EventEmitter } from 'events'
import type { spawn } from 'child_process'

import { parseListJson, readLoopQueue } from '../../main/loops/loops-handler'
import type { BundledCli } from '../../main/blueprint/derive-runner'
import type { TaskSummary } from '../../shared/ipc-contract'
import { buildBoardModel } from './board-model'

const NOW = Date.parse('2026-08-14T18:00:00.000Z')

const cli: BundledCli = { execPath: '/bin/electron', cliPath: '/app/cli.mjs' }

/**
 * A spawn stub that emits one captured transcript and closes with `code`, or —
 * with `silent` — a child that never answers at all, which is what a hung `gh`
 * looks like to the reader waiting on it.
 */
function fakeSpawn(
  out: { stdout?: string; stderr?: string; code?: number | null; silent?: boolean } = {},
): { spawnFn: typeof spawn; args: string[][] } {
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
    if (out.silent !== true) {
      setImmediate(() => {
        if (out.stdout !== undefined) child.stdout.emit('data', out.stdout)
        if (out.stderr !== undefined) child.stderr.emit('data', out.stderr)
        child.emit('close', out.code ?? 0)
      })
    }
    return child
  }
  return { spawnFn: spawnFn as unknown as typeof spawn, args }
}

// ── the captured payloads ────────────────────────────────────────────────

/** A ledger queue with one filed item — the ordinary, readable case. */
const LEDGER_OK = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[{"id":"1","loop":"find","title":"the codemap points at a deleted file","body":"because it is broken\\n\\n<!-- loop: find -->\\n<!-- loop-fp: b495983a8f69fb300f03485c6b0f6e6c88d9648d -->\\n","fingerprint":"b495983a8f69fb300f03485c6b0f6e6c88d9648d","state":"open","labels":["codemap"],"approved":true,"createdAt":"2026-08-14T17:37:00.009Z"}],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:00.058Z"}`

/**
 * The SAME queue with nothing on it. Byte-for-byte the readable case above with
 * `items: []` — the pair that makes "an empty list" and "a broken read"
 * comparable rather than merely described.
 */
const LEDGER_EMPTY = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:36:59.953Z"}`

/** A GitHub queue nobody could reach — `gh` is not installed on this machine. */
const GITHUB_UNREADABLE = `{"status":"ok","state":"open","loops":[{"loop":"gh","items":null,"queueKind":"github","queueLocation":"acme/widgets","queueError":"gh issue list failed for acme/widgets: the gh CLI is not installed or not on PATH"}],"generatedAt":"2026-08-14T17:37:18.406Z"}`

/** A project that never adopted a loop: no directives, so no queues. */
const NO_DIRECTIVES = `{"status":"ok","state":"open","loops":[],"generatedAt":"2026-08-14T17:37:10.642Z"}`

/**
 * The escape the logger paints with, spelled out rather than pasted: a raw ESC
 * byte in a source file is invisible to every reader of it.
 */
const ESC = '\u001b'

/** A refusal, with the colour the logger paints even into a pipe. */
const REFUSAL = `${ESC}[31m  x${ESC}[0m loop refused: malformed --state 'sideways' — expected open|closed|all\n`

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'A local task',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: false,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-08-14T15:00:00.000Z',
    updatedAt: '2026-08-14T17:00:00.000Z',
    ...overrides,
  }
}

/** The board, from CLI stdout — the two steps the running app takes, in order. */
function boardFrom(stdout: string, tasks: TaskSummary[] = []) {
  return buildBoardModel({ queue: parseListJson(stdout), loops: null, tasks, now: NOW })
}

// ── Task 8.2: the unreadable rule, from the CLI's own bytes ──────────────
//
// THE USER'S STATED FAILURE MODE: a live read that failed, drawn as an empty
// Todo, so an engineer looks at the board and concludes there is no work. Every
// assertion in this block is about the difference between "nothing to do" and
// "nobody could find out" surviving BOTH steps — the narrowing and the model.

describe('a broken queue read reaches the board as `unreadable`, never as an empty Todo', () => {
  it('carries the CLI reason verbatim, on the group that failed', () => {
    const model = boardFrom(GITHUB_UNREADABLE)

    expect(model.state).toBe('unreadable')
    expect(model.state).not.toBe('ready')
    expect(model.state).not.toBe('no-list-configured')
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0]?.readable).toBe(false)
    // Verbatim: the reason a queue would not open is the finding, and rewording
    // it would put a second opinion between the reader and the tool that failed.
    expect(model.groups[0]?.reason).toBe(
      'gh issue list failed for acme/widgets: the gh CLI is not installed or not on PATH',
    )
    // The location survives the failure — "unreadable" is only actionable with one.
    expect(model.groups[0]?.label).toBe('GitHub · acme/widgets')
    expect(model.groups[0]?.todo).toEqual([])
    expect(model.lanes.todo).toEqual([])
  })

  it('never collapses `items: null` into `items: []` on the way through', () => {
    // The narrowing is where this could go wrong silently: an `items ?? []` in
    // parseQueueGroup would make the two payloads below indistinguishable, and
    // every downstream assertion about state would still pass on the emptier one.
    expect(parseListJson(GITHUB_UNREADABLE).loops[0]?.items).toBeNull()
    expect(parseListJson(LEDGER_EMPTY).loops[0]?.items).toEqual([])

    const broken = boardFrom(GITHUB_UNREADABLE)
    const clear = boardFrom(LEDGER_EMPTY)

    // Both draw zero cards. That is exactly why the STATE has to differ.
    expect(broken.lanes.todo).toEqual([])
    expect(clear.lanes.todo).toEqual([])
    expect(broken.state).toBe('unreadable')
    expect(clear.state).toBe('ready')
    expect(broken.state).not.toBe(clear.state)
    expect(broken.groups[0]?.readable).toBe(false)
    expect(clear.groups[0]?.readable).toBe(true)
    expect(clear.groups[0]?.reason).toBeNull()
  })

  it('reports the whole-board failure when the CLI itself refused', async () => {
    // The other way a read breaks: the process exits non-zero and prints one
    // refusal line — on STDOUT, because this CLI's logger routes error() through
    // console.log (allowed-pattern #15). A stderr-only reader would surface an
    // empty reason here, and an empty reason is how a failure becomes an
    // emptiness.
    const { spawnFn, args } = fakeSpawn({ stdout: REFUSAL, code: 1 })
    const snapshot = await readLoopQueue(cli, '/repo', { state: 'open' }, { spawnFn })

    expect(args[0]).toEqual([cli.cliPath, 'loop', 'list', '--state', 'open'])
    expect(snapshot.available).toBe(false)
    expect(snapshot.loops).toEqual([])
    // The reason is the CLI's own sentence, with only the terminal's paint off.
    expect(snapshot.reason).toBe(
      "loop refused: malformed --state 'sideways' — expected open|closed|all",
    )

    const model = buildBoardModel({ queue: snapshot, loops: null, tasks: [], now: NOW })
    expect(model.state).toBe('unreadable')
    expect(model.reason).toBe(snapshot.reason)
    expect(model.lanes.todo).toEqual([])
  })

  it('keeps the local records on the board while the window is broken', async () => {
    // A read that failed says nothing about the runs this project already has.
    // The failure here is the one with no output at all — a `gh` that hung until
    // the reader gave up on it.
    const { spawnFn } = fakeSpawn({ silent: true })
    const timedOut = await readLoopQueue(cli, '/repo', {}, { spawnFn, timeoutMs: 5 })
    expect(timedOut.available).toBe(false)
    expect(timedOut.reason).toBe('timed out')

    const model = buildBoardModel({
      queue: timedOut,
      loops: null,
      tasks: [task({ id: 'mine' }), task({ id: 'run', lane: 'doing' })],
      now: NOW,
    })
    expect(model.state).toBe('unreadable')
    expect(model.localTodo.map((card) => card.taskId)).toEqual(['mine'])
    expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['run'])
  })

  it('one unreadable queue does not blank out the one that answered', () => {
    // `partial`, not `unreadable`: a whole-board banner over a half-failing read
    // would overstate the damage, and the readable half is still true.
    const merged = JSON.stringify({
      status: 'ok',
      state: 'open',
      loops: [
        ...(JSON.parse(LEDGER_OK) as { loops: unknown[] }).loops,
        ...(JSON.parse(GITHUB_UNREADABLE) as { loops: unknown[] }).loops,
      ],
      generatedAt: '2026-08-14T17:37:18.406Z',
    })

    const model = buildBoardModel({
      queue: parseListJson(merged),
      loops: null,
      tasks: [],
      now: NOW,
    })
    expect(model.state).toBe('partial')
    expect(model.groups.map((group) => group.readable)).toEqual([true, false])
    expect(model.lanes.todo).toHaveLength(1)
    expect(model.lanes.todo[0]?.title).toBe('the codemap points at a deleted file')
  })
})

// ── Task 8.4: a project that never adopted a loop ────────────────────────

describe('a project with no loop directives keeps the board it already had', () => {
  it('is `no-list-configured` — an explicit answer, not an emptiness', () => {
    const model = boardFrom(NO_DIRECTIVES)

    expect(model.state).toBe('no-list-configured')
    expect(model.state).not.toBe('unreadable')
    expect(model.groups).toEqual([])
    expect(model.hunts).toEqual({ cards: [], reason: null })
    expect(model.filter).toBeNull()
  })

  it('draws every local record in the lane its record names, with its origin chip', () => {
    const model = boardFrom(NO_DIRECTIVES, [
      task({ id: 'a', lane: 'todo', source: 'manual' }),
      task({
        id: 'b',
        lane: 'doing',
        source: 'github',
        externalKey: 'acme/widgets#7',
        externalUrl: 'https://github.com/acme/widgets/issues/7',
      }),
      task({ id: 'c', lane: 'blocked', source: 'jira', externalKey: 'PF-3' }),
      task({ id: 'd', lane: 'done', source: 'azure', externalKey: 'AB#9' }),
    ])

    expect(model.lanes.todo.map((card) => card.taskId)).toEqual(['a'])
    expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['b'])
    expect(model.lanes.blocked.map((card) => card.taskId)).toEqual(['c'])
    expect(model.lanes.done.map((card) => card.taskId)).toEqual(['d'])
    // The chips are the ONE thing that is new for such a project (FR-2), and
    // every card gets one — an import is never credited to a person.
    expect(
      [...model.lanes.todo, ...model.lanes.doing, ...model.lanes.blocked, ...model.lanes.done].map(
        (card) => card.origin,
      ),
    ).toEqual(['you', 'github', 'jira', 'azure'])
    // Nothing else about a local card changed: no queue, no item, no amber, and
    // no claim about a queue that was never read.
    for (const card of model.lanes.doing) {
      expect(card.queueKey).toBeNull()
      expect(card.itemId).toBeNull()
      expect(card.attention).toBe(false)
      expect(card.missingReason).toBeNull()
      expect(card.heldBy).toBeNull()
    }
  })

  it('says nothing about a record just because no queue mentioned it', () => {
    // The `missingReason` line is only for a record whose queue ANSWERED. With
    // no queues at all, absence proves nothing and the card claims nothing.
    const model = boardFrom(NO_DIRECTIVES, [
      task({ id: 'imported', lane: 'doing', source: 'github', externalKey: 'acme/widgets#7' }),
    ])
    expect(model.lanes.doing[0]?.missingReason).toBeNull()
  })

  it('asks the CLI for a plain read — no loop, no state, nothing to write', async () => {
    // What the app spawns for such a project is the whole-project read, with no
    // filter invented app-side. (That this read creates no queue file is proved
    // against the real binary in src/cli/commands/loop-e2e.test.ts — see the
    // module header.)
    const { spawnFn, args } = fakeSpawn({ stdout: NO_DIRECTIVES })
    const snapshot = await readLoopQueue(cli, '/repo', {}, { spawnFn })

    // One invocation, and it is the whole-project read: no `--loop` filter
    // invented app-side, no `--state`, and no verb that could write anything.
    expect(args).toEqual([[cli.cliPath, 'loop', 'list']])
    expect(snapshot.available).toBe(true)
    expect(snapshot.loops).toEqual([])
    expect(buildBoardModel({ queue: snapshot, loops: null, tasks: [], now: NOW }).state).toBe(
      'no-list-configured',
    )
  })
})
