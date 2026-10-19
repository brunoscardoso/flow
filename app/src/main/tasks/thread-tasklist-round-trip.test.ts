// The thread tasklist, end to end (thread-tasklist, Phase 6 Task 6.1).
//
// ONE PATH, ACROSS EVERY LAYER THAT OWNS A PIECE OF IT:
//
//   StreamBridge (persists the tool call, announces it)
//     → makeTodoMirror (the production hook, routing BOTH protocols)
//       → todo-reconcile / agent-task-reconcile (what the payload means)
//         → TaskStore + ThreadStore (the real database, the real columns)
//           → buildBoardModel (where the card is, and whose it is)
//             → cardShare + `loops:file` (the ONE route to a shared list)
//
// Every one of those has its own suite, and none of them proves the trip. The
// joins between them are strings and column semantics — the external key the
// mirror files under and the prefix the board reads a chip off, the provenance
// column and the deletion rule it was given — and a suite that asserts each side
// separately lets the two drift while both stay green.
//
// WHY THE BOARD IS THE END OF THE TRIP AND NOT THE STORE. `todo-mirror.test.ts`
// asserts the churn rule against `listTasks(root, { includeArchived: true })`,
// which is the right read for a mirror asking what it has already filed and the
// WRONG read for "is this still on the board" — a mirror that quietly archived
// every dropped todo passes that assertion with the work gone from the user's
// screen. (Confirmed by mutation: archiving in the `keep` branch leaves all 75
// of that file's tests green.) The board reads `listTasks(root)`, so the
// assertions here go through `buildBoardModel` and can see the difference.
//
// TWO PROTOCOLS, BOTH DRIVEN THROUGH THE BRIDGE. The whole-list write is read at
// the moment it is recorded; the id-addressed create/update are read when they
// settle, because their identity is in the answer. Both trips are made here from
// a real SDK message, so the moment each one listens at is exercised rather than
// assumed.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { TaskStore, type TaskRecord } from '../store/task-store'
import { ThreadStore } from '../store/thread-store'
import { StreamBridge } from '../agent/stream-bridge'
import { registerLoopsChannels } from '../loops/loops-handler'
import type { BundledCli } from '../blueprint/derive-runner'
import type { RootsProvider } from '../flow/flow-observer'
import type {
  LoopFileResult,
  LoopQueueSnapshot,
  TaskSummary,
} from '../../shared/ipc-contract'
import {
  buildBoardModel,
  originForTask,
  type BoardCard,
  type BoardModel,
} from '../../renderer/tasks/board-model'
import { cardShare, shareOutcome } from '../../renderer/tasks/board-actions'
import { planBoardRender } from '../../renderer/tasks/board-render'
import { makeTodoMirror } from './todo-mirror'

/** The channel registry, captured instead of Electron's (as queue-round-trip.test.ts). */
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

const NOW = Date.parse('2026-08-15T12:00:00.000Z')
const TODO_WRITE = 'TodoWrite'
const TASK_CREATE = 'TaskCreate'
const TASK_UPDATE = 'TaskUpdate'

/** A real project root, assigned per test — the CLI stub is spawned with it as cwd. */
let ROOT = ''

/**
 * One `loop list` answer with an EMPTY list, captured from the same run as
 * queue-round-trip.test.ts's transcripts.
 *
 * Empty on purpose: this file's queue is here to give the share control a list to
 * name, not to draw cards. An item would put a second card on every board below
 * and prove nothing about a conversation's tasks.
 */
const LIST_EMPTY = `{"status":"ok","state":"open","loops":[{"loop":"find","items":[],"queueKind":"ledger","queueLocation":"flow/loops/queue.jsonl"}],"generatedAt":"2026-08-14T17:37:00.058Z"}`

/** `loop file`'s own report for a first filing. */
const FILE_FILED = `{"status":"filed","loop":"find","id":"7"}`

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

/** One whole-list payload, in the shape the SDK declares for that tool. */
function todoPayload(todos: Array<{ content: string; status: string }>): Record<string, unknown> {
  return { todos: todos.map((t) => ({ ...t, activeForm: `${t.content}ing` })) }
}

describe('an assistant’s task list becomes cards on the board, and outlives the conversation', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore
  let threadId: string
  let bridge: StreamBridge
  /** Board writes the mirror deferred — run explicitly so nothing waits on a timer. */
  let deferred: Array<() => void>
  let dispose: (() => void) | null
  let stubLog: string
  let stubStdout: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-tasklist-e2e-'))
    ROOT = tempDir
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)
    threadId = threadStore.createThread({ projectRoot: ROOT, title: 'Board filter work' }).id

    deferred = []
    // THE PRODUCTION WIRING, verbatim: main/index.ts passes
    // `makeTodoMirror({ taskStore, threadStore })` as the bridge's tool-call
    // observer through AgentManager. Only the scheduler is substituted, and only
    // so the deferral is drained on demand instead of on a real event-loop turn.
    const mirrorHook = makeTodoMirror({ taskStore, threadStore }, (run) => deferred.push(run))
    bridge = new StreamBridge(threadId, threadStore, {
      onSessionId: () => {},
      emit: () => {},
      onToolCallRecorded: (observation) => mirrorHook({ threadId, ...observation }),
    })

    const cliPath = join(tempDir, 'stub-cli.mjs')
    writeFileSync(cliPath, STUB_CLI, 'utf-8')
    stubLog = join(tempDir, 'argv.jsonl')
    stubStdout = join(tempDir, 'stdout.txt')
    writeFileSync(stubLog, '', 'utf-8')
    writeFileSync(stubStdout, LIST_EMPTY, 'utf-8')
    process.env.STUB_LOG = stubLog
    process.env.STUB_STDOUT = stubStdout
    const cli: BundledCli = { execPath: process.execPath, cliPath }
    dispose = registerLoopsChannels({ roots, bundledCli: cli })
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    mockHandlers.clear()
    delete process.env.STUB_LOG
    delete process.env.STUB_STDOUT
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── driving the real bridge ────────────────────────────────────────────

  /** Feed one tool use through the bridge, exactly as an SDK assistant message. */
  function toolUse(id: string, name: string, input: Record<string, unknown>): void {
    bridge.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] },
    } as never)
  }

  /** Feed the answer for one tool use, as the synthetic user message it arrives in. */
  function toolResult(id: string, content: string): void {
    bridge.handleMessage({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
    } as never)
  }

  /** Run whatever the mirror deferred, and report how many passes it scheduled. */
  function drain(): number {
    const count = deferred.length
    deferred.splice(0).forEach((run) => run())
    return count
  }

  /** One whole-list write, all the way through the bridge. */
  function writeTodos(todos: Array<{ content: string; status: string }>, id = `tu-${nextId()}`): void {
    toolUse(id, TODO_WRITE, todoPayload(todos))
    drain()
  }

  /** One id-addressed creation, question and answer, through the bridge. */
  function createTask(taskId: string, subject: string, description = 'why it matters'): void {
    const id = `tu-${nextId()}`
    toolUse(id, TASK_CREATE, { subject, description })
    toolResult(id, `Task #${taskId} created successfully: ${subject}`)
    drain()
  }

  /** One id-addressed change, question and answer, through the bridge. */
  function updateTask(patch: { taskId: string; subject?: string; status?: string }): void {
    const id = `tu-${nextId()}`
    toolUse(id, TASK_UPDATE, patch)
    toolResult(id, `Updated task #${patch.taskId}`)
    drain()
  }

  let counter = 0
  const nextId = (): number => (counter += 1)

  // ── the board, built from what the store actually holds ────────────────

  /**
   * The board a person is looking at.
   *
   * `listTasks(ROOT)` — WITHOUT `includeArchived`, because that is the read the
   * IPC layer makes for the board. A card the mirror archived is off this board,
   * which is the whole reason the assertions below are made here.
   */
  function board(options: { threadFilter?: { threadId: string; label: string | null } } = {}): BoardModel {
    return buildBoardModel({
      queue: { available: true, reason: null, state: 'open', loops: [], generatedAt: new Date(NOW).toISOString() },
      loops: null,
      tasks: taskStore.listTasks(ROOT).map(summaryOf),
      now: NOW,
      ...(options.threadFilter === undefined ? {} : { threadFilter: options.threadFilter }),
    })
  }

  /** Every card the board draws, in every lane. */
  function drawn(model: BoardModel): BoardCard[] {
    return [...model.lanes.todo, ...model.lanes.doing, ...model.lanes.blocked, ...model.lanes.done]
  }

  /** The titles the board draws, sorted so assertions read as a set. */
  function titles(model: BoardModel = board()): string[] {
    return drawn(model).map((card) => card.title).sort()
  }

  /** The record behind a drawn card, by title. */
  function recordFor(title: string): TaskRecord {
    const found = taskStore.listTasks(ROOT, { includeArchived: true }).find((t) => t.title === title)
    expect(found).toBeDefined()
    return found as TaskRecord
  }

  // ── the whole-list protocol ────────────────────────────────────────────

  describe('the whole-list write', () => {
    it('turns a recorded tool call into cards attributed to the conversation', () => {
      writeTodos([
        { content: 'Write the parser', status: 'pending' },
        { content: 'Wire the mirror', status: 'in_progress' },
        { content: 'Ship it', status: 'completed' },
      ])

      const model = board()
      expect(titles(model)).toEqual(['Ship it', 'Wire the mirror', 'Write the parser'])
      // NOTHING REACHES AMBER. It is reserved for the approval gate, and no
      // state an assistant can send maps to it.
      expect(model.lanes.blocked).toEqual([])

      // ATTRIBUTION, ON THE CARD AND IN THE COLUMN. The chip is read off the
      // pair of fields the mirror wrote together — the producing thread and a
      // key belonging to it — so this asserts the join between the store's
      // columns and the board's reader, not just one side of it.
      for (const card of drawn(model)) expect(card.origin).toBe('assistant')
      for (const record of taskStore.listTasks(ROOT)) {
        expect(record.originThreadId).toBe(threadId)
        // Provenance is NOT ownership: these cards own no conversation yet, so
        // clicking one cannot reopen the thread that merely listed it.
        expect(record.threadId).toBeNull()
      }
    })

    it('draws a FIRST list in the lanes its states name', () => {
      // THE DEFECT THIS PHASE PINNED, NOW FIXED (#1707). The whole-list mirror's
      // `add` branch used to hand `createTaskFromAgentTodo` a key and a title
      // and no lane, so every card landed in Todo and only a LATER payload moved
      // it — and a first payload that is also the last (an already-completed
      // todo, a denied earlier write) had nothing to heal it. The add path now
      // applies `decision.lane` when it differs, exactly as the agent-task path
      // beside it always has; the asymmetry that made this a finding is gone.
      writeTodos([
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'in_progress' },
        { content: 'C', status: 'completed' },
      ])
      expect(board().lanes.todo.map((c) => c.title)).toEqual(['A'])
      expect(board().lanes.doing.map((c) => c.title)).toEqual(['B'])
      expect(board().lanes.done.map((c) => c.title)).toEqual(['C'])

      // The very next payload — the same list, which is what really happens —
      // settles them.
      writeTodos([
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'in_progress' },
        { content: 'C', status: 'completed' },
      ])
      const settled = board()
      expect(settled.lanes.todo.map((c) => c.title)).toEqual(['A'])
      expect(settled.lanes.doing.map((c) => c.title)).toEqual(['B'])
      expect(settled.lanes.done.map((c) => c.title)).toEqual(['C'])
    })

    it('narrows to the conversation that produced it, and hides another’s unstarted work', () => {
      writeTodos([{ content: 'Write the parser', status: 'pending' }])
      const other = threadStore.createThread({ projectRoot: ROOT, title: 'Elsewhere' }).id
      const otherBridge = new StreamBridge(other, threadStore, {
        onSessionId: () => {},
        emit: () => {},
        onToolCallRecorded: (observation) =>
          makeTodoMirror({ taskStore, threadStore }, (run) => run())({ threadId: other, ...observation }),
      })
      otherBridge.handleMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-x',
          content: [
            {
              type: 'tool_use',
              id: 'tu-other',
              name: TODO_WRITE,
              input: todoPayload([{ content: 'Somebody else’s job', status: 'pending' }]),
            },
          ],
        },
      } as never)

      expect(titles()).toEqual(['Somebody else’s job', 'Write the parser'])
      const narrowed = board({ threadFilter: { threadId, label: 'Board filter work' } })
      expect(titles(narrowed)).toEqual(['Write the parser'])
      expect(narrowed.threadFilter).toMatchObject({ matched: 1, hidden: 1 })
      // The bar a person actually reads, from the same model.
      expect(planBoardRender(narrowed).threadFilter?.text).toBe(
        'In this conversation: Board filter work',
      )
    })

    it('KEEPS work a rewritten list stopped naming — on the board, not merely in the table', () => {
      writeTodos([
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'pending' },
        { content: 'C', status: 'pending' },
      ])
      const before = board().lanes.todo.map((card) => card.taskId)
      expect(before).toHaveLength(3)

      writeTodos([
        { content: 'A', status: 'pending' },
        { content: 'D', status: 'pending' },
      ])

      // THE ASSERTION THE WHOLE FEATURE RESTS ON, made against the read the
      // board makes. Nobody said B and C were done, so nothing may take them off
      // the screen — not by deleting them and not by putting them away.
      expect(titles()).toEqual(['A', 'B', 'C', 'D'])
      for (const title of ['B', 'C']) {
        expect(recordFor(title).archivedAt).toBeNull()
      }
      // And A is the SAME card, reconciled rather than re-filed.
      expect(board().lanes.todo.map((card) => card.taskId)).toEqual(
        expect.arrayContaining([before[0]]),
      )
      expect(board().lanes.todo).toHaveLength(4)
    })

    it('survives the deletion of the conversation that produced it (FR-10)', () => {
      const list = [
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'in_progress' },
      ]
      // Twice, because a first list lands entirely in Todo (see above) and the
      // point here is that work IN FLIGHT outlives the conversation too.
      writeTodos(list)
      writeTodos(list)
      threadStore.deleteThread(threadId)

      const model = board()
      expect(titles(model)).toEqual(['A', 'B'])
      expect(model.lanes.doing.map((c) => c.title)).toEqual(['B'])
      // The POINTER goes — `ON DELETE SET NULL`, so nothing dangles at a
      // conversation that no longer exists — and the record stays.
      for (const record of taskStore.listTasks(ROOT)) expect(record.originThreadId).toBeNull()
      // With the origin gone there is nothing left on the card that says a
      // mirror wrote it, so the chip falls back to what the board has always
      // said about a local record. Documented in `isMirroredTask`; asserted here
      // because it is the visible half of the deletion rule.
      for (const card of drawn(model)) expect(card.origin).toBe('you')
      // A filter for a DIFFERENT conversation cannot hide them either: a card
      // naming no producer is never somebody else's.
      const narrowed = board({ threadFilter: { threadId: 'th-someone-else', label: 'Other' } })
      expect(titles(narrowed)).toEqual(['A', 'B'])
      expect(narrowed.threadFilter?.hidden).toBe(0)
    })
  })

  // ── the id-addressed protocol (the one live traffic actually uses) ─────

  describe('the id-addressed create and change', () => {
    it('turns a settled tool call into a card attributed to the conversation', () => {
      createTask('1', 'Write the parser', 'Read the payload defensively.')

      const model = board()
      expect(model.lanes.todo.map((c) => [c.title, c.origin])).toEqual([
        ['Write the parser', 'assistant'],
      ])
      const record = recordFor('Write the parser')
      expect(record.originThreadId).toBe(threadId)
      // This protocol sends a subject AND an account of the work, so the card
      // keeps the second one — the whole-list write has nothing to put here.
      expect(record.description).toBe('Read the payload defensively.')
    })

    it('reads nothing until the answer arrives — the identity is in the reply', () => {
      toolUse('tu-pending', TASK_CREATE, { subject: 'Write the parser', description: 'x' })
      expect(drain()).toBe(0)
      expect(titles()).toEqual([])

      toolResult('tu-pending', 'Task #1 created successfully: Write the parser')
      expect(drain()).toBe(1)
      expect(titles()).toEqual(['Write the parser'])
    })

    it('moves the card a later change names, and only that one', () => {
      createTask('1', 'Write the parser')
      createTask('2', 'Wire the mirror')
      updateTask({ taskId: '2', status: 'in_progress' })

      const model = board()
      expect(model.lanes.doing.map((c) => c.title)).toEqual(['Wire the mirror'])
      expect(model.lanes.todo.map((c) => c.title)).toEqual(['Write the parser'])
    })

    it('takes a card off the board only when the assistant states a deletion', () => {
      createTask('1', 'Write the parser')
      createTask('2', 'Wire the mirror')
      updateTask({ taskId: '1', status: 'deleted' })

      // OFF THE BOARD, NOT OUT OF THE DATABASE. The row survives, so a later
      // call naming that id finds the record instead of filing a second one.
      expect(titles()).toEqual(['Wire the mirror'])
      expect(recordFor('Write the parser').archivedAt).not.toBeNull()
      // And a task the assistant simply STOPPED naming is untouched: there is no
      // whole-list sweep in this protocol, so silence removes nothing.
      updateTask({ taskId: '2', status: 'in_progress' })
      expect(titles()).toEqual(['Wire the mirror'])
    })

    it('survives the deletion of the conversation that produced it (FR-10)', () => {
      createTask('1', 'Write the parser')
      threadStore.deleteThread(threadId)

      expect(titles()).toEqual(['Write the parser'])
      expect(recordFor('Write the parser').originThreadId).toBeNull()
      expect(board().lanes.todo[0]?.origin).toBe('you')
    })
  })

  // ── the two mirrors, on one board ──────────────────────────────────────
  //
  // The store-level proof that their key namespaces cannot collide is in
  // `todo-mirror.test.ts` ("the two mirrors"), including the case where a todo's
  // wording is spelled exactly like the other protocol's key. What is added here
  // is the only thing that suite cannot show: what a person ends up looking at.

  describe('both protocols in one conversation', () => {
    it('draws two cards for one wording, and each one moves alone', () => {
      writeTodos([{ content: 'Run the tests', status: 'pending' }])
      createTask('1', 'Run the tests')

      const model = board()
      expect(model.lanes.todo).toHaveLength(2)
      for (const card of model.lanes.todo) expect(card.origin).toBe('assistant')

      // The whole-list write completes its card; the id-addressed one is not
      // dragged along with it.
      writeTodos([{ content: 'Run the tests', status: 'completed' }])
      const after = board()
      expect(after.lanes.done).toHaveLength(1)
      expect(after.lanes.todo).toHaveLength(1)

      // …and vice versa.
      updateTask({ taskId: '1', status: 'in_progress' })
      const last = board()
      expect(last.lanes.doing).toHaveLength(1)
      expect(last.lanes.done).toHaveLength(1)
      expect(last.lanes.todo).toEqual([])
    })

    it('never mirrors one tool call twice — one protocol, one moment', () => {
      // The bridge announces every tool call at BOTH moments. A mirror reading
      // its protocol at both would re-file a card somebody deleted in between.
      toolUse('tu-1', TODO_WRITE, todoPayload([{ content: 'A', status: 'pending' }]))
      expect(drain()).toBe(1)
      toolResult('tu-1', 'todos updated')
      expect(drain()).toBe(0)

      const id = 'tu-2'
      toolUse(id, TASK_CREATE, { subject: 'B', description: 'x' })
      expect(drain()).toBe(0)
      toolResult(id, 'Task #1 created successfully: B')
      expect(drain()).toBe(1)

      expect(titles()).toEqual(['A', 'B'])
    })
  })

  // ── what a person's own edit survives ──────────────────────────────────
  //
  // The mirror writes to cards a person can also touch, so every edit they can
  // make is a question about who wins. Three of the four answers are settled and
  // proved at the store level in `todo-mirror.test.ts` (amber stands, an archive
  // stands, nothing bumps the sort order). The fourth was never asked, and the
  // answer below is the current one rather than an endorsed one — see the note
  // this phase reports.

  describe('a card a person moved or renamed', () => {
    it('keeps a person’s archive — the card stays off the board', () => {
      writeTodos([{ content: 'A', status: 'pending' }])
      taskStore.updateTask(recordFor('A').id, { archived: true })

      writeTodos([{ content: 'A', status: 'pending' }])
      // Not re-filed and not un-archived: work somebody deliberately put away
      // stays away, and no second copy appears beside it.
      expect(titles()).toEqual([])
      expect(taskStore.listTasks(ROOT, { includeArchived: true })).toHaveLength(1)
    })

    it('is pulled back to the lane the assistant still reports — the current answer', () => {
      // THE NARROW ANSWER, STATED RATHER THAN IMPLIED. Blocked is protected
      // (`updatePatchFor` refuses to move a parked card) because amber is a
      // person waiting on something the assistant cannot see. Doing is NOT: a
      // person who drags a mirrored card into Doing while the assistant's list
      // still calls it pending has that move undone by the next payload, and the
      // same is true of a rename. This test exists so the behaviour is visible
      // and so a deliberate change to it is a red test rather than a surprise.
      writeTodos([{ content: 'A', status: 'pending' }])
      const cardId = recordFor('A').id
      taskStore.updateTask(cardId, { lane: 'doing', title: 'A, in my words' })
      expect(board().lanes.doing.map((c) => c.title)).toEqual(['A, in my words'])

      writeTodos([{ content: 'A', status: 'pending' }])
      const after = taskStore.getTask(cardId)
      expect(after?.lane).toBe('todo')
      expect(after?.title).toBe('A')
      // The rename did not fork the card: the mirror matched on the key it filed
      // under, not on the wording the person changed.
      expect(taskStore.listTasks(ROOT)).toHaveLength(1)
    })
  })

  // ── backward compatibility (Task 6.4) ──────────────────────────────────

  describe('a project with no conversations and no assistant tasks', () => {
    it('renders exactly today’s board, and no provenance value is required', () => {
      // Created WITHOUT the field — the shape every row written before this
      // feature has, and the shape every hand-typed card still has.
      const manual = taskStore.createTask({ projectRoot: ROOT, title: 'Typed by hand' })
      const imported = taskStore.createTask({
        projectRoot: ROOT,
        title: 'PRJ-1: imported',
        source: 'jira',
        externalKey: 'PRJ-1',
        externalUrl: 'https://example.invalid/PRJ-1',
      })
      expect(manual.originThreadId).toBeNull()
      expect(imported.originThreadId).toBeNull()

      const model = board()
      expect(model.threadFilter).toBeNull()
      expect(planBoardRender(model).threadFilter).toBeNull()
      // SORTED, because the order between these two is not a fact. Both records
      // are written in the same millisecond, so they share a timestamp and the
      // board's tie-break between them is a coin flip — asserting the drawn
      // order made this test fail about one run in six while claiming the chips
      // were wrong. What the case is actually about is that a record with no
      // provenance keeps the chip it always had.
      const drawn = model.lanes.todo.map((card) => [card.title, card.origin]).sort()
      expect(drawn).toEqual([
        ['PRJ-1: imported', 'jira'],
        ['Typed by hand', 'you'],
      ])
      // NO CHIP MOVED. `originForTask` is asked for every card the board draws,
      // and a record with no provenance answers exactly what it answered before
      // the column existed.
      for (const record of taskStore.listTasks(ROOT)) {
        expect(originForTask(summaryOf(record))).not.toBe('assistant')
      }
    })

    it('is untouched by a filter for a conversation it knows nothing about', () => {
      taskStore.createTask({ projectRoot: ROOT, title: 'Typed by hand' })
      const started = taskStore.createTask({ projectRoot: ROOT, title: 'Also mine' })
      taskStore.updateTask(started.id, { lane: 'doing' })
      const narrowed = board({ threadFilter: { threadId, label: 'Board filter work' } })
      // Null provenance is "we do not know", never "somebody else's" — reading it
      // the other way would empty an existing project's board the moment any
      // conversation was opened.
      expect(titles(narrowed)).toEqual(['Also mine', 'Typed by hand'])
      expect(narrowed.threadFilter).toMatchObject({ matched: 0, hidden: 0 })
    })
  })

  // ── the one route to the shared list ───────────────────────────────────

  describe('nothing reaches the shared list by itself', () => {
    /** Every argv the channels really handed the CLI, in order. */
    function argvCalls(): string[][] {
      if (!existsSync(stubLog)) return []
      return readFileSync(stubLog, 'utf-8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[])
    }

    async function channel<T>(name: string, request: unknown): Promise<T> {
      const handler = mockHandlers.get(name)
      expect(handler).toBeDefined()
      return (await handler!(null, request)) as T
    }

    it('mirrors a whole conversation without writing anything to a queue', async () => {
      writeTodos([
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'in_progress' },
      ])
      createTask('1', 'C')
      updateTask({ taskId: '1', status: 'completed' })

      // Four cards on the board, and NOT ONE invocation of the CLI that owns the
      // shared list. A conversation never files work as a side effect.
      expect(titles()).toEqual(['A', 'B', 'C'])
      expect(argvCalls()).toEqual([])
      const snapshot = await channel<LoopQueueSnapshot>('loops:queue', { rootId: ROOT })
      expect(snapshot.loops[0]?.items).toEqual([])
      expect(argvCalls()).toEqual([['loop', 'list']])
    })

    it('goes on the list only when the share control is pressed, carrying two facts', async () => {
      writeTodos([{ content: 'Write the parser', status: 'pending' }])
      const snapshot = await channel<LoopQueueSnapshot>('loops:queue', { rootId: ROOT })
      const model = buildBoardModel({
        queue: snapshot,
        loops: null,
        tasks: taskStore.listTasks(ROOT).map(summaryOf),
        now: NOW,
      })
      const card = model.lanes.todo.find((c) => c.taskId !== null)!
      const record = recordFor('Write the parser')
      const share = cardShare(card, summaryOf(record), model.groups)
      expect(share).toMatchObject({ loop: 'find', actionable: true, blockedReason: null })

      writeFileSync(stubStdout, FILE_FILED, 'utf-8')
      const result = await channel<LoopFileResult>('loops:file', {
        rootId: ROOT,
        loop: share!.loop,
        title: card.title,
      })
      expect(result).toMatchObject({ ok: true, status: 'filed' })

      // THE APP SUPPLIES A LIST AND A TITLE AND DECIDES NOTHING ELSE — no
      // labels, no topic, no fingerprint, no approval flag. Those belong to the
      // directive and the backend, and a board that sent its own would file
      // items a producer's own reads then treated differently.
      expect(argvCalls()).toEqual([
        ['loop', 'list'],
        ['loop', 'file', '--loop', 'find', '--title', 'Write the parser'],
      ])

      // And the local copy comes off the board once the work is on the list, so
      // one piece of work is not drawn twice.
      const outcome = shareOutcome(card.title, share!.listLabel, result)
      expect(outcome).toMatchObject({ onTheList: true, archive: true })
      taskStore.updateTask(record.id, { archived: true })
      expect(titles()).toEqual([])
    })

    it('is not offered on work in flight, nor on a card no assistant listed', async () => {
      const typed = taskStore.createTask({ projectRoot: ROOT, title: 'Typed by hand' })
      // Twice — a first list lands in Todo whatever it reported, and this test
      // needs the card actually in Doing.
      writeTodos([{ content: 'Write the parser', status: 'in_progress' }])
      writeTodos([{ content: 'Write the parser', status: 'in_progress' }])
      const snapshot = await channel<LoopQueueSnapshot>('loops:queue', { rootId: ROOT })
      const model = buildBoardModel({
        queue: snapshot,
        loops: null,
        tasks: taskStore.listTasks(ROOT).map(summaryOf),
        now: NOW,
      })

      // Sharing archives the local card, so offering it on a card in Doing would
      // let a press empty a lane somebody is working in.
      const doing = model.lanes.doing[0]!
      expect(cardShare(doing, summaryOf(recordFor('Write the parser')), model.groups)).toBeNull()
      // And a hand-typed card is already the user's own — there is no
      // conversation to promote it out of.
      const mine = model.lanes.todo.find((c) => c.taskId === typed.id)!
      expect(cardShare(mine, summaryOf(typed), model.groups)).toBeNull()
    })
  })
})
