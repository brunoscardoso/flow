// The claim round trip (loops-on-the-board, Task 8.3): a card dragged into
// Doing, and what is left on the board after the work is closed.
//
// ONE PATH, END TO END, ACROSS THE THREE MODULES THAT OWN IT:
//
//   loops:claim (the channel, spawning the CLI)
//     → claimOutcome / runRecordFacts (what the answer means for the card)
//       → createTaskFromQueueItem (the run record, in the real DB)
//         → buildBoardModel (where the card is now)
//
// Each of those has its own unit suite; none of them proves that a claim lands
// as a card in Doing, because the JOIN between them is a string — the external
// key the record is stored under and the key the board rebuilds from the queue's
// location and the item's id. A test that asserted that string on each side
// separately would let the two sides drift while both stayed green, which is
// exactly why `task-service.test.ts` already imports the board's own key builder
// rather than a literal. This file joins them for real, against a real store.
//
// THE CLI TRANSCRIPTS ARE VERBATIM, captured on 2026-08-14 from the built binary
// against a throwaway ledger-backed fixture:
//
//   loop file --loop find --title "…"        → the item
//   loop claim --loop find --id 1            → CLAIM_STDOUT
//   loop list                                → LIST_AFTER_CLAIM
//   loop close --loop find --id 1 --reason done --evidence '{"commands":[…]}'
//   loop list --state all                    → LIST_ALL_AFTER_CLOSE
//   loop list                                → LIST_OPEN_AFTER_CLOSE
//
// THE EVIDENCE IS NOT ON THE ITEM, and the assertions below say so out loud.
// `loop close` gates on it and the queue's own log records it verbatim, but
// `list()` reports only the close's REASON — there is no evidence field on
// `LoopQueueItem` for a card to draw. The gate itself is proved against the real
// binary in src/cli/commands/loop-e2e.test.ts; what a board can show about a
// closed item is what this file pins down.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { TaskStore, type TaskRecord } from '../store/task-store'
import { ThreadStore } from '../store/thread-store'
import { registerLoopsChannels } from '../loops/loops-handler'
import type { BundledCli } from '../blueprint/derive-runner'
import type { RootsProvider } from '../flow/flow-observer'
import type {
  IpcRequest,
  LoopClaimResult,
  LoopQueueSnapshot,
  TaskSummary,
} from '../../shared/ipc-contract'
import { buildBoardModel, type BoardCard } from '../../renderer/tasks/board-model'
import { claimOutcome, queueItemFor, runRecordFacts } from '../../renderer/tasks/board-actions'
import { createTaskFromQueueItem } from './task-service'

/** The channel registry, captured instead of Electron's (as loops-handler.test.ts). */
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

/**
 * The project root — a REAL directory, assigned per test.
 *
 * It has to exist: the channel spawns the CLI with the root as its `cwd`, so a
 * made-up path fails the spawn itself and every read comes back unavailable
 * before any of this file's subject matter is reached.
 */
let ROOT = ''
const NOW = Date.parse('2026-08-14T18:00:00.000Z')

// ── the captured transcripts ─────────────────────────────────────────────

const CLAIM_STDOUT = `{"status":"claimed","loop":"find","owner":"run-20260814T173726952Z-9586","item":{"id":"1","loop":"find","title":"the codemap points at a deleted file","body":"because it is broken\\n\\n<!-- loop: find -->\\n<!-- loop-fp: b495983a8f69fb300f03485c6b0f6e6c88d9648d -->\\n<!-- loop-claim: run-20260814T173726952Z-9586 @ 2026-08-14T17:37:26.953Z -->\\n","fingerprint":"b495983a8f69fb300f03485c6b0f6e6c88d9648d","state":"open","labels":["codemap"],"approved":true,"createdAt":"2026-08-14T17:37:00.009Z","claimedBy":"run-20260814T173726952Z-9586","claimedAt":"2026-08-14T17:37:26.953Z"}}`

const LIST_BEFORE_CLAIM = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[{"id":"1","loop":"find","title":"the codemap points at a deleted file","body":"because it is broken\\n\\n<!-- loop: find -->\\n<!-- loop-fp: b495983a8f69fb300f03485c6b0f6e6c88d9648d -->\\n","fingerprint":"b495983a8f69fb300f03485c6b0f6e6c88d9648d","state":"open","labels":["codemap"],"approved":true,"createdAt":"2026-08-14T17:37:00.009Z"}],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:00.058Z"}`

const LIST_AFTER_CLAIM = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[{"id":"1","loop":"find","title":"the codemap points at a deleted file","body":"because it is broken\\n\\n<!-- loop: find -->\\n<!-- loop-fp: b495983a8f69fb300f03485c6b0f6e6c88d9648d -->\\n<!-- loop-claim: run-20260814T173726952Z-9586 @ 2026-08-14T17:37:26.953Z -->\\n","fingerprint":"b495983a8f69fb300f03485c6b0f6e6c88d9648d","state":"open","labels":["codemap"],"approved":true,"createdAt":"2026-08-14T17:37:00.009Z","claimedBy":"run-20260814T173726952Z-9586","claimedAt":"2026-08-14T17:37:26.953Z"}],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:27.009Z"}`

const LIST_ALL_AFTER_CLOSE = `{"status":"ok","state":"all","loops":[{"loop":"find","items":[{"id":"1","loop":"find","title":"the codemap points at a deleted file","body":"because it is broken\\n\\n<!-- loop: find -->\\n<!-- loop-fp: b495983a8f69fb300f03485c6b0f6e6c88d9648d -->\\n<!-- loop-claim: run-20260814T173726952Z-9586 @ 2026-08-14T17:37:26.953Z -->\\n","fingerprint":"b495983a8f69fb300f03485c6b0f6e6c88d9648d","state":"closed","labels":["codemap"],"approved":true,"createdAt":"2026-08-14T17:37:00.009Z","claimedBy":"run-20260814T173726952Z-9586","claimedAt":"2026-08-14T17:37:26.953Z","closedAt":"2026-08-14T17:37:27.061Z","closeReason":"done"}],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:27.115Z"}`

const LIST_OPEN_AFTER_CLOSE = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:27.160Z"}`

/**
 * The queue's own log line for that close, verbatim.
 *
 * Here to make the point the assertions cannot make against the item: the
 * evidence WAS recorded, in the store the CLI writes — it just never travels to
 * a board through `loop list`.
 */
const CLOSED_LOG_LINE = `{"id":"1","event":"closed","loop":"find","reason":"done","detail":"fixed the pointer","evidence":{"commands":[{"command":"npm run test","exitCode":0}],"summary":"suite green"},"ts":"2026-08-14T17:37:27.061Z","provenance":"cli:loop close"}`

// ── harness ──────────────────────────────────────────────────────────────

/**
 * A stand-in for the bundled CLI, spawned for real.
 *
 * WHY A REAL SCRIPT AND NOT A SPAWN STUB. `registerLoopsChannels` takes no
 * injectable spawn — the channel calls `claimLoopItem` with the bundled CLI and
 * nothing else — so a stub can only be reached by going AROUND the channel,
 * which is precisely the seam this file exists to cross. A tiny executable at
 * the end of a real `spawn` puts the process boundary back: the argv asserted
 * below is the argv the channel really built, read off the file the child wrote.
 *
 * It answers with whatever `STUB_STDOUT` currently holds, so one script serves
 * every step of the trip.
 */
const STUB_CLI = `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(readFileSync(process.env.STUB_STDOUT, 'utf-8'))
`

const roots = { getRoots: () => [{ rootPath: ROOT }] } as unknown as RootsProvider

/** TaskStore record → the contract summary the board reads (ipc/index.ts's mapping). */
function summaryOf(record: TaskRecord): TaskSummary {
  return {
    id: record.id,
    projectRoot: record.projectRoot,
    title: record.title,
    source: record.source,
    externalKey: record.externalKey,
    externalUrl: record.externalUrl,
    lane: record.lane,
    suggestDone: record.suggestDone,
    threadId: record.threadId,
    originThreadId: record.originThreadId,
    description: record.description,
    images: null,
    autoFix: false,
    prUrl: record.prUrl,
    brief: record.brief,
    briefStatus: record.briefStatus,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

describe('a claimed item becomes a card in Doing, and its record outlives the item', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore
  let dispose: () => void
  let cli: BundledCli
  let stubLog: string
  let stubStdout: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-queue-roundtrip-'))
    ROOT = tempDir
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)

    const cliPath = join(tempDir, 'stub-cli.mjs')
    writeFileSync(cliPath, STUB_CLI, 'utf-8')
    stubLog = join(tempDir, 'argv.jsonl')
    stubStdout = join(tempDir, 'stdout.txt')
    writeFileSync(stubLog, '', 'utf-8')
    writeFileSync(stubStdout, '', 'utf-8')
    process.env.STUB_LOG = stubLog
    process.env.STUB_STDOUT = stubStdout
    // `execPath` is whatever runner this suite is under — plain Node, or the
    // Electron binary that `scripts/run-jest.mjs` launches. `runCli` sets
    // ELECTRON_RUN_AS_NODE for the child either way, so the stub runs as Node.
    cli = { execPath: process.execPath, cliPath }
    dispose = registerLoopsChannels({ roots, bundledCli: cli })
  })

  afterEach(() => {
    dispose?.()
    mockHandlers.clear()
    delete process.env.STUB_LOG
    delete process.env.STUB_STDOUT
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** What the next CLI invocation will answer with. */
  function answerWith(stdout: string): void {
    writeFileSync(stubStdout, stdout, 'utf-8')
  }

  /** Every argv the channels really handed the CLI, in order. */
  function argvCalls(): string[][] {
    if (!existsSync(stubLog)) return []
    return readFileSync(stubLog, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[])
  }

  /** Invoke a registered channel exactly as the renderer's `invoke` does. */
  async function channel<T>(name: string, request: unknown): Promise<T> {
    const handler = mockHandlers.get(name)
    expect(handler).toBeDefined()
    return (await handler!(null, request)) as T
  }

  /** `loops:queue` — the board's read, through the channel. */
  function readQueue(request: Partial<IpcRequest<'loops:queue'>> = {}): Promise<LoopQueueSnapshot> {
    return channel<LoopQueueSnapshot>('loops:queue', { rootId: ROOT, ...request })
  }

  /** `loops:claim` — the drag, through the channel. */
  function claimThroughChannel(id: string): Promise<LoopClaimResult> {
    return channel<LoopClaimResult>('loops:claim', { rootId: ROOT, loop: 'find', id })
  }

  /** The Todo card for the item, off the board the user was looking at. */
  function todoCard(snapshot: LoopQueueSnapshot): BoardCard {
    const model = buildBoardModel({ queue: snapshot, loops: null, tasks: [], now: NOW })
    const card = model.lanes.todo[0]
    expect(card).toBeDefined()
    return card as BoardCard
  }

  it('claims through the channel, records the run, and draws the card in Doing', async () => {
    // 1. The board the user is looking at: one unclaimed item, in Todo.
    answerWith(LIST_BEFORE_CLAIM)
    const before = await readQueue()
    const card = todoCard(before)
    expect(card.lane).toBe('todo')
    expect(card.taskId).toBeNull()
    // A producer's filing carries a fingerprint — the `loop` chip's tell.
    expect(card.origin).toBe('loop')

    // 2. The claim, through `loops:claim`.
    answerWith(CLAIM_STDOUT)
    const result = await claimThroughChannel(card.itemId as string)
    // The argv the CHANNEL built, read off the file the child process wrote.
    expect(argvCalls()).toEqual([
      ['loop', 'list'],
      ['loop', 'claim', '--loop', 'find', '--id', '1'],
    ])
    expect(result.status).toBe('claimed')
    expect(result.owner).toBe('run-20260814T173726952Z-9586')

    // 3. What that answer means for the card the user dragged.
    const outcome = claimOutcome(card, result)
    expect(outcome).toMatchObject({ claimed: true, lane: 'doing', note: null, notice: null })

    // 4. The run record — materialized from facts the read already produced, and
    //    stored under the key the board rebuilds from the queue's own location.
    const group = buildBoardModel({ queue: before, loops: null, tasks: [], now: NOW }).groups[0]!
    const facts = runRecordFacts(card, group, queueItemFor(before, group, card.itemId as string))
    expect(facts).toMatchObject({
      externalKey: 'flow/loops/queue.jsonl#1',
      itemId: '1',
      queueKind: 'ledger',
      title: 'the codemap points at a deleted file',
    })
    const { task, created } = createTaskFromQueueItem(
      { taskStore, threadStore },
      { projectRoot: ROOT, ...facts! },
    )
    expect(created).toBe(true)
    // THE RECORD EXISTS, in the real store, with its own 1:1 thread.
    expect(taskStore.getTask(task.id)).not.toBeNull()
    expect(threadStore.getThread(task.threadId!)).not.toBeNull()
    expect(task.title).toBe('#1: the codemap points at a deleted file')
    // A ledger item is Flow's own list, not an imported tracker's — one chip
    // (`you`) whether the item or only the record survives.
    expect(task.source).toBe('manual')
    const doing = taskStore.updateTask(task.id, { lane: outcome.lane })

    // 5. The next board read: the item is claimed, the record is Doing, and the
    //    two are ONE card.
    answerWith(LIST_AFTER_CLAIM)
    const model = buildBoardModel({
      queue: await readQueue(),
      loops: null,
      tasks: [summaryOf(doing)],
      now: NOW,
    })
    expect(model.state).toBe('ready')
    expect(model.lanes.todo).toEqual([])
    expect(model.lanes.doing).toHaveLength(1)
    const inDoing = model.lanes.doing[0]!
    expect(inDoing.itemId).toBe('1')
    expect(inDoing.taskId).toBe(task.id)
    expect(inDoing.origin).toBe('loop')
    // OUR claim, so the card does not report it as somebody else's.
    expect(inDoing.heldBy).toBeNull()
    expect(inDoing.attention).toBe(false)
    expect(inDoing.missingReason).toBeNull()
  })

  it('a re-claim of the same item finds the record instead of forking it', async () => {
    answerWith(LIST_BEFORE_CLAIM)
    const before = await readQueue()
    const card = todoCard(before)
    const group = buildBoardModel({ queue: before, loops: null, tasks: [], now: NOW }).groups[0]!
    const facts = runRecordFacts(card, group, queueItemFor(before, group, '1'))!

    const first = createTaskFromQueueItem({ taskStore, threadStore }, { projectRoot: ROOT, ...facts })
    answerWith(CLAIM_STDOUT)
    const result = await claimThroughChannel('1')
    expect(result.status).toBe('claimed')
    const second = createTaskFromQueueItem({ taskStore, threadStore }, { projectRoot: ROOT, ...facts })

    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    // and the board still draws ONE card for it
    answerWith(LIST_AFTER_CLAIM)
    const model = buildBoardModel({
      queue: await readQueue(),
      loops: null,
      tasks: [summaryOf(taskStore.updateTask(first.task.id, { lane: 'doing' }))],
      now: NOW,
    })
    expect(model.lanes.doing).toHaveLength(1)
    expect(model.lanes.todo).toEqual([])
  })

  it('a closed item shows in Done — with the close its record was earned by', async () => {
    answerWith(LIST_BEFORE_CLAIM)
    const before = await readQueue()
    const card = todoCard(before)
    const group = buildBoardModel({ queue: before, loops: null, tasks: [], now: NOW }).groups[0]!
    const { task } = createTaskFromQueueItem(
      { taskStore, threadStore },
      { projectRoot: ROOT, ...runRecordFacts(card, group, queueItemFor(before, group, '1'))! },
    )
    const done = taskStore.updateTask(task.id, { lane: 'done' })

    // The read that still holds the item — `--state all`, the slice a Done
    // column needs, since the default read is the open one.
    answerWith(LIST_ALL_AFTER_CLOSE)
    const closedSnapshot = await readQueue({ state: 'all' })
    expect(argvCalls().pop()).toEqual(['loop', 'list', '--state', 'all'])
    const item = closedSnapshot.loops[0]?.items?.[0]
    expect(item).toMatchObject({ id: '1', state: 'closed', closeReason: 'done' })
    // THE EVIDENCE IS NOT HERE. `loop close` refuses a `done` close without it
    // and the queue's log keeps it verbatim, but the contract carries no field
    // for it — so no card can claim to show it.
    expect((item as unknown as Record<string, unknown>).evidence).toBeUndefined()
    expect(JSON.parse(CLOSED_LOG_LINE)).toMatchObject({
      id: '1',
      event: 'closed',
      reason: 'done',
      evidence: { commands: [{ command: 'npm run test', exitCode: 0 }], summary: 'suite green' },
    })

    const model = buildBoardModel({
      queue: closedSnapshot,
      loops: null,
      tasks: [summaryOf(done)],
      now: NOW,
    })
    expect(model.lanes.done).toHaveLength(1)
    expect(model.lanes.done[0]).toMatchObject({ itemId: '1', taskId: task.id, lane: 'done' })
    expect(model.lanes.todo).toEqual([])
    expect(model.lanes.doing).toEqual([])
  })

  it('keeps the Done card after the item leaves the open list, and says why', async () => {
    // The board's ordinary read is the OPEN slice, so the moment the item closes
    // it is gone from the window — and the record is all that is left. It keeps
    // its lane and carries the line, rather than vanishing mid-flight.
    answerWith(LIST_BEFORE_CLAIM)
    const before = await readQueue()
    const card = todoCard(before)
    const group = buildBoardModel({ queue: before, loops: null, tasks: [], now: NOW }).groups[0]!
    const { task } = createTaskFromQueueItem(
      { taskStore, threadStore },
      { projectRoot: ROOT, ...runRecordFacts(card, group, queueItemFor(before, group, '1'))! },
    )
    const done = taskStore.updateTask(task.id, { lane: 'done' })

    answerWith(LIST_OPEN_AFTER_CLOSE)
    const model = buildBoardModel({
      queue: await readQueue(),
      loops: null,
      tasks: [summaryOf(done)],
      now: NOW,
    })
    expect(model.state).toBe('ready')
    expect(model.lanes.done).toHaveLength(1)
    expect(model.lanes.done[0]).toMatchObject({
      taskId: task.id,
      // No item behind it any more — the record is the whole card now.
      itemId: null,
      origin: 'you',
      missingReason: 'no longer open in flow/loops/queue.jsonl',
    })
  })
})
