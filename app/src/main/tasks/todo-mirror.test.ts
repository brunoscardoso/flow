// todo-mirror tests — an assistant's todo list becoming cards on the board,
// against REAL stores and a real database.
//
// Real stores on purpose. The pure decisions already have their own suite next
// to the model that makes them; what is untested until here is everything
// between a decision and a row: that the dedup actually holds across a rewrite,
// that provenance lands in the column that outlives the chat, and that the
// board write cannot reach out and fail somebody's turn. None of those can be
// demonstrated against a fake store, because in every one of them the store IS
// the thing under test.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { TaskStore, TASK_STORE_CHANGE_EVENT } from '../store/task-store'
import { StreamBridge } from '../agent/stream-bridge'
import {
  agentTaskCallKind,
  isMirroredToolName,
  makeTodoMirror,
  mirrorAgentTaskSafely,
  mirrorAgentTaskToolCall,
  mirrorTodosSafely,
  mirrorTodoToolCall,
} from './todo-mirror'

const ROOT = '/tmp/mirror-proj'
const TOOL = 'TodoWrite'
const CREATE = 'TaskCreate'
const UPDATE = 'TaskUpdate'

/** One todo-list payload, in the shape the SDK declares for this tool. */
function payload(todos: Array<{ content: string; status: string }>): string {
  return JSON.stringify({
    // `activeForm` is carried because the real tool carries it — a payload
    // trimmed to only the fields the reader wants would not prove the reader
    // tolerates the ones it doesn't.
    todos: todos.map((t) => ({ ...t, activeForm: `${t.content}ing` })),
  })
}

describe('todo-mirror', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore
  let threadId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-todo-mirror-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)
    threadId = threadStore.createThread({ projectRoot: ROOT, title: 'Chat' }).id
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const deps = () => ({ taskStore, threadStore })
  const mirror = (inputJson: string | null, toolName = TOOL) =>
    mirrorTodoToolCall(deps(), { threadId, toolName, inputJson })
  /** The project's cards, oldest first, so assertions can read positionally. */
  const cards = () =>
    taskStore.listTasks(ROOT, { includeArchived: true }).slice().reverse()

  // ── Which tools (Task 3.1) ────────────────────────────────────────────

  describe('the mirrored tool names', () => {
    it('recognizes the todo-list write', () => {
      expect(isMirroredToolName(TOOL)).toBe(true)
    })

    it('ignores every other tool name, including near misses', () => {
      // The near misses matter more than the obvious ones: a fuzzy match would
      // hand an incremental task tool's payload to a whole-list parser.
      for (const name of ['Bash', 'Read', 'TaskCreate', 'TaskUpdate', 'todowrite', 'TodoRead']) {
        expect(isMirroredToolName(name)).toBe(false)
      }
    })

    it('an unknown tool name produces nothing at all — no cards, no reason', () => {
      const result = mirror(payload([{ content: 'A', status: 'pending' }]), 'TaskCreate')
      expect(result).toEqual({
        added: 0,
        updated: 0,
        kept: 0,
        reason: null,
        rewordSuspected: false,
      })
      // SILENTLY is the specification: a skipped tool leaves no reason behind,
      // because a reason is something a reader is meant to act on.
      expect(cards()).toHaveLength(0)
    })
  })

  // ── A turn with todos produces attributed cards (Task 3.5) ────────────

  describe('a turn with todos', () => {
    it('produces one card per todo, attributed to the thread', () => {
      const result = mirror(
        payload([
          { content: 'Write the parser', status: 'pending' },
          { content: 'Wire the mirror', status: 'in_progress' },
          { content: 'Ship it', status: 'completed' },
        ]),
      )
      expect(result.added).toBe(3)

      const made = cards()
      // Sorted, because the board's own ordering is by activity and tie-breaks
      // on an opaque id — asserting the payload's order here would be asserting
      // something the store never promised.
      expect(made.map((t) => t.title).sort()).toEqual([
        'Ship it',
        'Wire the mirror',
        'Write the parser',
      ])
      // Provenance on every card, and it is the ORIGIN field — not the one that
      // means "the conversation this task owns".
      expect(made.every((t) => t.originThreadId === threadId)).toBe(true)
      expect(made.every((t) => t.threadId === null)).toBe(true)
    })

    it('puts each todo in the lane its state means, and never in Blocked', () => {
      mirror(
        payload([
          { content: 'A', status: 'pending' },
          { content: 'B', status: 'in_progress' },
          { content: 'C', status: 'completed' },
        ]),
      )
      // Lanes are set by the update pass, not at insert — a created task starts
      // in `todo` — so a fresh list must be mirrored twice to settle. That is
      // the real sequence too: the assistant resends the list as it works.
      mirror(
        payload([
          { content: 'A', status: 'pending' },
          { content: 'B', status: 'in_progress' },
          { content: 'C', status: 'completed' },
        ]),
      )
      const byTitle = new Map(cards().map((t) => [t.title, t.lane]))
      expect(byTitle.get('A')).toBe('todo')
      expect(byTitle.get('B')).toBe('doing')
      expect(byTitle.get('C')).toBe('done')
      expect([...byTitle.values()]).not.toContain('blocked')
    })

    it('a first-seen non-pending todo lands in its lane without a resend (#1707)', () => {
      // The terminal-write case: the FIRST payload naming a key already
      // carries a non-pending status (an earlier write was denied or
      // unreadable, or the todo was added already-completed) and no later
      // payload repeats it. Nothing heals this card afterwards, so the add
      // path itself must honor the decision's lane — as the agent-task add
      // path always has.
      mirror(
        payload([
          { content: 'B', status: 'in_progress' },
          { content: 'C', status: 'completed' },
        ]),
      )
      const byTitle = new Map(cards().map((t) => [t.title, t.lane]))
      expect(byTitle.get('B')).toBe('doing')
      expect(byTitle.get('C')).toBe('done')
    })

    it('mirrors nothing to the shared queue — these are local records only', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      const [card] = cards()
      // No external link of any kind. A card carrying a queue location or a URL
      // is a card something downstream could mistake for filed work.
      expect(card.externalUrl).toBeNull()
      expect(card.source).toBe('manual')
    })
  })

  // ── A second turn reconciles rather than duplicating (Task 3.5) ───────

  describe('a second turn', () => {
    it('updates the cards it already made instead of adding more', () => {
      mirror(payload([{ content: 'Write the parser', status: 'pending' }]))
      const first = cards()
      expect(first).toHaveLength(1)

      const result = mirror(payload([{ content: 'Write the parser', status: 'completed' }]))
      expect(result.added).toBe(0)
      expect(result.updated).toBe(1)

      const after = cards()
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe(first[0].id)
      expect(after[0].lane).toBe('done')
    })

    it('re-sending an identical list changes nothing at all', () => {
      const list = payload([
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'pending' },
      ])
      mirror(list)
      mirror(list)
      const settled = cards().map((t) => t.updatedAt)
      const result = mirror(list)
      expect(result.added).toBe(0)
      expect(result.updated).toBe(0)
      expect(cards()).toHaveLength(2)
      expect(cards().map((t) => t.updatedAt)).toEqual(settled)
    })

    it('KEEPS a card the new list stopped naming — the churn rule, end to end', () => {
      mirror(
        payload([
          { content: 'A', status: 'pending' },
          { content: 'B', status: 'pending' },
          { content: 'C', status: 'pending' },
        ]),
      )
      const result = mirror(
        payload([
          { content: 'A', status: 'pending' },
          { content: 'D', status: 'pending' },
        ]),
      )
      expect(result.added).toBe(1)
      expect(result.kept).toBe(2)

      // THE ASSERTION THE WHOLE FEATURE RESTS ON. B and C are still on the
      // board. Nobody said they were done, so nothing may remove them.
      expect(cards().map((t) => t.title).sort()).toEqual(['A', 'B', 'C', 'D'])
    })

    it('does not re-add a mirrored card that was archived', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      const [card] = cards()
      taskStore.updateTask(card.id, { archived: true })

      mirror(payload([{ content: 'A', status: 'pending' }]))
      // One card, still archived. An archived card the assistant still lists is
      // work somebody deliberately put away — a second copy would undo that.
      expect(cards()).toHaveLength(1)
      expect(cards()[0].archivedAt).not.toBeNull()
    })

    it('does not bump activity, so the board never re-sorts under the user (#1192)', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      const before = cards()[0].updatedAt
      mirror(payload([{ content: 'A', status: 'completed' }]))
      expect(cards()[0].lane).toBe('done')
      expect(cards()[0].updatedAt).toBe(before)
    })

    it('leaves a card a person parked in Blocked in Blocked, but still rewords it', () => {
      mirror(payload([{ content: 'Deploy   the   thing', status: 'pending' }]))
      const [card] = cards()
      taskStore.updateTask(card.id, { lane: 'blocked' })

      // SAME identity (normalization collapses the spacing), so this is an
      // update and not a second card — which is what puts the blocked card on
      // the path that decides whether an assistant may move it.
      mirror(payload([{ content: 'Deploy the thing', status: 'completed' }]))

      const after = taskStore.getTask(card.id)
      // The assistant does not know a human is waiting on something, so amber
      // stands — but its wording is still the assistant's to update.
      expect(after?.lane).toBe('blocked')
      expect(after?.title).toBe('Deploy the thing')
      expect(cards()).toHaveLength(1)
    })

    it('a parked card with unchanged wording takes no write and no board event (#1706)', () => {
      // The resend case: TodoWrite resends the whole list several times per
      // turn, wording unchanged, status still pending. The lane change is
      // refused (amber is a person's answer) and the title is the card's own,
      // so there is NOTHING to write — an identical-content UPDATE would still
      // fire a board-change event per resend, indefinitely, for every parked
      // card.
      mirror(payload([{ content: 'Deploy the thing', status: 'pending' }]))
      const [card] = cards()
      taskStore.updateTask(card.id, { lane: 'blocked' })

      const events: unknown[] = []
      taskStore.on(TASK_STORE_CHANGE_EVENT, (e: unknown) => events.push(e))
      const result = mirror(payload([{ content: 'Deploy the thing', status: 'pending' }]))

      // `updated` counts real writes, and there was none.
      expect(result.updated).toBe(0)
      expect(events).toHaveLength(0)
      const after = taskStore.getTask(card.id)
      expect(after?.lane).toBe('blocked')
      expect(after?.title).toBe('Deploy the thing')
    })
  })

  // ── Scoping ───────────────────────────────────────────────────────────

  describe('scoping', () => {
    it('does not touch another thread\'s cards, even on identical wording', () => {
      const other = threadStore.createThread({ projectRoot: ROOT, title: 'Other' }).id
      mirror(payload([{ content: 'Run the tests', status: 'pending' }]))
      mirrorTodoToolCall(deps(), {
        threadId: other,
        toolName: TOOL,
        inputJson: payload([{ content: 'Run the tests', status: 'in_progress' }]),
      })

      // Two conversations each with their own "run the tests" is two pieces of
      // work, not one card whose lane flips as whichever reported last.
      const made = cards()
      expect(made).toHaveLength(2)
      expect(new Set(made.map((t) => t.originThreadId))).toEqual(new Set([threadId, other]))
    })

    it('never claims a card the mirror did not create', () => {
      const manual = taskStore.createTask({ projectRoot: ROOT, title: 'A', originThreadId: threadId })
      mirror(payload([{ content: 'A', status: 'completed' }]))
      // Same wording, same origin thread — but no mirror key, so it is
      // somebody's own card. It is left alone and the todo gets its own.
      expect(taskStore.getTask(manual.id)?.lane).toBe('todo')
      expect(cards()).toHaveLength(2)
    })

    it('does nothing when the thread is gone, without failing', () => {
      threadStore.deleteThread(threadId)
      expect(mirror(payload([{ content: 'A', status: 'pending' }])).added).toBe(0)
      expect(cards()).toHaveLength(0)
    })

    it('a mirrored card outlives the thread that produced it (FR-10)', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      threadStore.deleteThread(threadId)
      const survivors = taskStore.listTasks(ROOT)
      expect(survivors).toHaveLength(1)
      // The pointer goes rather than dangling; the record itself stays.
      expect(survivors[0].originThreadId).toBeNull()
    })
  })

  // ── A malformed payload produces nothing (Task 3.5) ───────────────────

  describe('a malformed payload', () => {
    it.each([
      ['not JSON at all', '{oops'],
      ['JSON that is not an object', '[1,2,3]'],
      ['an object carrying no list', '{"note":"hello"}'],
      ['an entry that is not a task', '{"todos":[42]}'],
      ['an entry with no wording', '{"todos":[{"status":"pending"}]}'],
      ['a state this board has no column for', '{"todos":[{"content":"A","status":"cancelled"}]}'],
      ['nothing at all', null],
    ])('produces no cards and a reason: %s', (_label, input) => {
      const result = mirror(input)
      expect(result.added).toBe(0)
      expect(result.reason).not.toBeNull()
      expect(cards()).toHaveLength(0)
    })

    it('leaves existing cards untouched and reports no keeps', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      const result = mirror('{oops')
      // NOT reported as kept. A keep means "a list the assistant sent left this
      // card out", and no list was read here — the card survives regardless.
      expect(result.kept).toBe(0)
      expect(result.reason).not.toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('an empty list is read successfully and is not a malformed payload', () => {
      mirror(payload([{ content: 'A', status: 'pending' }]))
      const result = mirror('{"todos":[]}')
      // "My list is clear" and "I sent something unreadable" are different
      // answers: one keeps the card knowingly, the other knows nothing.
      expect(result.reason).toBeNull()
      expect(result.kept).toBe(1)
      expect(cards()).toHaveLength(1)
    })
  })

  // ── A mirror failure never fails the turn (Task 3.4 / 3.5) ────────────

  describe('a mirror failure', () => {
    /** A store whose every read throws, standing in for a locked database. */
    const brokenTaskStore = () =>
      ({
        listTasks: () => {
          throw new Error('database is locked')
        },
      }) as unknown as TaskStore

    it('is logged and dropped rather than thrown', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const result = mirrorTodosSafely(
        { taskStore: brokenTaskStore(), threadStore },
        { threadId, toolName: TOOL, inputJson: payload([{ content: 'A', status: 'pending' }]) },
      )
      expect(result.added).toBe(0)
      // Dropped for the user, NOT silent for a developer.
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('never reaches the turn through the hook', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const hook = makeTodoMirror({ taskStore: brokenTaskStore(), threadStore }, (run) => {
        run()
      })
      expect(() =>
        hook({
          threadId,
          phase: 'recorded',
          toolName: TOOL,
          inputJson: payload([{ content: 'A', status: 'pending' }]),
        }),
      ).not.toThrow()
      spy.mockRestore()
    })

    it('never reaches the turn through the bridge, which records regardless', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const events: string[] = []
      const bridge = new StreamBridge(threadId, threadStore, {
        onSessionId: () => {},
        emit: (event) => events.push(event.kind),
        // The worst-behaved observer there is: one that throws synchronously.
        onToolCallRecorded: () => {
          throw new Error('observer exploded')
        },
      })

      expect(() =>
        bridge.handleMessage({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            model: 'claude-x',
            content: [{ type: 'tool_use', id: 'tu-1', name: TOOL, input: { todos: [] } }],
          },
        } as never),
      ).not.toThrow()

      // The tool call was still persisted and still announced — an observer
      // cannot be the reason a turn's record goes missing.
      expect(threadStore.listToolCalls(threadId)).toHaveLength(1)
      expect(events).toContain('tool-start')
      // And no error event was emitted to the renderer: the turn is fine.
      expect(events).not.toContain('error')
      spy.mockRestore()
    })
  })

  // ── The hook (Task 3.2 / 3.4) ─────────────────────────────────────────

  describe('the hook', () => {
    it('defers the board write off the calling stack', () => {
      const scheduled: Array<() => void> = []
      const hook = makeTodoMirror(deps(), (run) => scheduled.push(run))
      hook({
        threadId,
        phase: 'recorded',
        toolName: TOOL,
        inputJson: payload([{ content: 'A', status: 'pending' }]),
      })

      // Nothing has been written yet — the turn was not made to wait for it.
      expect(cards()).toHaveLength(0)
      expect(scheduled).toHaveLength(1)
      scheduled[0]()
      expect(cards()).toHaveLength(1)
    })

    it('does not even schedule work for a tool it does not mirror', () => {
      const scheduled: Array<() => void> = []
      const hook = makeTodoMirror(deps(), (run) => scheduled.push(run))
      hook({ threadId, phase: 'recorded', toolName: 'Bash', inputJson: '{"command":"ls"}' })
      // The overwhelmingly common case costs one lookup and schedules nothing.
      expect(scheduled).toHaveLength(0)
    })

    it('carries a real tool call from the bridge through to a card', () => {
      const scheduled: Array<() => void> = []
      const mirrorHook = makeTodoMirror(deps(), (run) => scheduled.push(run))
      const bridge = new StreamBridge(threadId, threadStore, {
        onSessionId: () => {},
        emit: () => {},
        onToolCallRecorded: (observation) => mirrorHook({ threadId, ...observation }),
      })

      bridge.handleMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-x',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: TOOL,
              input: { todos: [{ content: 'Write the parser', status: 'pending', activeForm: 'x' }] },
            },
          ],
        },
      } as never)

      scheduled.forEach((run) => run())
      // END TO END through the path that actually runs in production: the
      // payload was read off the record the bridge persisted, not off a
      // hand-built string.
      expect(cards().map((t) => t.title)).toEqual(['Write the parser'])
      expect(cards()[0].originThreadId).toBe(threadId)
    })
  })

  // ── The id-addressed protocol (Phase 3b) ──────────────────────────────
  //
  // THE PAYLOADS ARE REAL. Every fixture below is shaped exactly like recorded
  // traffic from a live profile: a creation answered with a SENTENCE carrying the
  // id after a hash (not the structured object the SDK declares), and changes
  // addressed to small integers that restart at 1 in every conversation.

  describe('the id-addressed protocol', () => {
    /** One creation call, as the harness records it. */
    const createCall = (id: string, subject: string, description?: string) => ({
      threadId,
      toolName: CREATE,
      inputJson: JSON.stringify({
        subject,
        ...(description === undefined ? {} : { description }),
        activeForm: `${subject}ing`,
      }),
      outputJson: JSON.stringify(`Task #${id} created successfully: ${subject}`),
    })
    /** One change call, as the harness records it. */
    const updateCall = (fields: Record<string, unknown>) => ({
      threadId,
      toolName: UPDATE,
      inputJson: JSON.stringify(fields),
      outputJson: JSON.stringify(`Updated task #${String(fields.taskId)} status`),
    })

    const create = (id: string, subject: string, description?: string) =>
      mirrorAgentTaskToolCall(deps(), createCall(id, subject, description))
    const update = (fields: Record<string, unknown>) =>
      mirrorAgentTaskToolCall(deps(), updateCall(fields))

    describe('which tools', () => {
      it('recognizes the creation and the change, and nothing else', () => {
        expect(agentTaskCallKind(CREATE)).toBe('create')
        expect(agentTaskCallKind(UPDATE)).toBe('update')
        // The reads change nothing, so mirroring them would be a no-op at best
        // and a second, weaker source of truth at worst.
        for (const name of ['TaskGet', 'TaskList', 'TodoWrite', 'taskcreate', 'Bash']) {
          expect(agentTaskCallKind(name)).toBeNull()
        }
      })

      it('an unknown tool name produces nothing at all — no cards, no reason', () => {
        const result = mirrorAgentTaskToolCall(deps(), {
          threadId,
          toolName: 'Bash',
          inputJson: '{"command":"ls"}',
          outputJson: '"ok"',
        })
        expect(result).toEqual({ added: 0, updated: 0, removed: 0, ignored: 0, reason: null })
        expect(cards()).toHaveLength(0)
      })
    })

    describe('a creation followed by a change', () => {
      it('files a card under the id it was given, attributed to the thread', () => {
        const result = create('1', 'Assess local env health', 'Confirm the app renders.')
        expect(result.added).toBe(1)

        const [card] = cards()
        expect(card.title).toBe('Assess local env health')
        // The assistant's own account of the work — genuinely different text
        // from the subject, unlike a todo whose line IS its title.
        expect(card.description).toBe('Confirm the app renders.')
        expect(card.originThreadId).toBe(threadId)
        expect(card.threadId).toBeNull()
      })

      it('moves the card the change named, and only that one', () => {
        create('1', 'First')
        create('2', 'Second')
        create('3', 'Third')

        const result = update({ taskId: '2', status: 'in_progress' })
        expect(result.updated).toBe(1)

        const byTitle = new Map(cards().map((t) => [t.title, t.lane]))
        expect(byTitle.get('Second')).toBe('doing')
        // A call names ONE task. The other two are untouched — this protocol's
        // silence about them is not a statement about them.
        expect(byTitle.get('First')).toBe('todo')
        expect(byTitle.get('Third')).toBe('todo')
      })

      it('a completed task lands in Done', () => {
        create('1', 'Ship it')
        update({ taskId: '1', status: 'completed' })
        expect(cards()).toHaveLength(1)
        expect(cards()[0].lane).toBe('done')
      })

      it('never puts a card in Blocked, whatever the assistant says', () => {
        create('1', 'A')
        create('2', 'B')
        create('3', 'C')
        update({ taskId: '1', status: 'pending' })
        update({ taskId: '2', status: 'in_progress' })
        update({ taskId: '3', status: 'completed' })
        expect(cards().map((t) => t.lane)).not.toContain('blocked')
      })

      it('leaves a card a person parked in Blocked in Blocked, but still rewords it', () => {
        create('1', 'Deploy the thing')
        const [card] = cards()
        taskStore.updateTask(card.id, { lane: 'blocked' })

        update({ taskId: '1', subject: 'Deploy the other thing', status: 'completed' })

        const after = taskStore.getTask(card.id)
        // Amber is a person's answer and the assistant does not get to overrule
        // it — but the wording is still the assistant's to update.
        expect(after?.lane).toBe('blocked')
        expect(after?.title).toBe('Deploy the other thing')
      })

      it('writes nothing for a status change to a card parked in Blocked', () => {
        create('1', 'Parked')
        const [card] = cards()
        taskStore.updateTask(card.id, { lane: 'blocked' })
        const before = taskStore.getTask(card.id)?.updatedAt

        const result = update({ taskId: '1', status: 'completed' })
        // The lane is refused and the wording is the card's own, so there is
        // nothing left to apply — the pass reports no update rather than making
        // a write that changes nothing and firing a board refresh for it.
        expect(result.updated).toBe(0)
        expect(taskStore.getTask(card.id)?.updatedAt).toBe(before)
      })

      it('does not bump activity, so the board never re-sorts under the user (#1192)', () => {
        create('1', 'A')
        const before = cards()[0].updatedAt
        update({ taskId: '1', status: 'completed' })
        expect(cards()[0].lane).toBe('done')
        expect(cards()[0].updatedAt).toBe(before)
      })

      it('the same creation replayed does not file a second card', () => {
        create('1', 'A')
        const result = create('1', 'A')
        expect(result.added).toBe(0)
        expect(cards()).toHaveLength(1)
      })

      it('mirrors nothing to the shared queue — these are local records only', () => {
        create('1', 'A')
        const [card] = cards()
        expect(card.externalUrl).toBeNull()
        expect(card.source).toBe('manual')
      })
    })

    // ── THE DELETION RULE, END TO END ───────────────────────────────────

    describe('a card leaves only when somebody says so', () => {
      it('an explicit deletion takes it off the board — archived, never destroyed', () => {
        create('1', 'Abandoned work')
        const [card] = cards()

        const result = update({ taskId: '1', status: 'deleted' })
        expect(result.removed).toBe(1)

        // OFF THE BOARD: the default listing no longer has it.
        expect(taskStore.listTasks(ROOT)).toHaveLength(0)
        // AND STILL THERE: the row survives, because by now it may carry a
        // person's rewording, their lane, or a conversation they attached.
        const archived = taskStore.getTask(card.id)
        expect(archived).not.toBeNull()
        expect(archived?.archivedAt).not.toBeNull()
        expect(archived?.title).toBe('Abandoned work')
      })

      it.each([
        ['a completion', { taskId: '1', status: 'completed' }],
        ['a start', { taskId: '1', status: 'in_progress' }],
        ['a return to pending', { taskId: '1', status: 'pending' }],
        ['a rename', { taskId: '1', subject: 'Something else' }],
        ['a change with no state at all', { taskId: '1' }],
        ['a task the assistant simply stopped naming', { taskId: '2', status: 'completed' }],
      ])('and NOTHING ELSE does: %s', (_label, fields) => {
        // THE ASSERTION THE WHOLE PHASE RESTS ON. Making anything but an
        // explicit deletion archive a card turns this red naming the work.
        create('1', 'Abandoned work')
        create('2', 'Other work')
        const before = taskStore.listTasks(ROOT).map((t) => t.id).sort()
        const result = update(fields)
        expect(result.removed).toBe(0)
        // BOTH RECORDS STILL ON THE BOARD — asserted by identity, so a rename
        // (which is one of these cases) cannot make the check pass or fail for
        // the wrong reason.
        expect(taskStore.listTasks(ROOT).map((t) => t.id).sort()).toEqual(before)
      })

      it('a later change finds the archived card instead of filing a second one', () => {
        create('1', 'Abandoned work')
        update({ taskId: '1', status: 'deleted' })
        update({ taskId: '1', status: 'in_progress' })
        // Archiving keeps the mirror's memory of the id. It also STAYS put
        // away: nothing here un-archives a card somebody (or this mirror) took
        // off the board.
        expect(cards()).toHaveLength(1)
        expect(cards()[0].archivedAt).not.toBeNull()
      })
    })

    // ── A change to an id nobody saw created ────────────────────────────

    describe('a change addressed to a task this board never saw', () => {
      it('is ignored when it carries only a state', () => {
        const result = update({ taskId: '4', status: 'in_progress' })
        // Normal, not an error — the app may have started recording partway
        // through a conversation. A card named after an internal number would
        // be machine scratch on somebody's board.
        expect(result.ignored).toBe(1)
        expect(cards()).toHaveLength(0)
      })

      it('is adopted when it brought its own wording, in the lane it named', () => {
        const result = update({ taskId: '4', subject: 'Rebuild the index', status: 'completed' })
        expect(result.added).toBe(1)
        expect(cards()[0].title).toBe('Rebuild the index')
        expect(cards()[0].lane).toBe('done')
      })

      it('a deletion for one removes nothing', () => {
        create('1', 'Real work')
        const result = update({ taskId: '99', status: 'deleted' })
        expect(result.removed).toBe(0)
        expect(taskStore.listTasks(ROOT)).toHaveLength(1)
      })
    })

    // ── The two mirrors cannot collide ──────────────────────────────────

    describe('the two mirrors', () => {
      it('cannot collide on one card, even on identical wording in one thread', () => {
        mirror(payload([{ content: 'Run the tests', status: 'pending' }]))
        create('1', 'Run the tests')

        // Two cards: one per protocol. The keys are in different namespaces, so
        // neither mirror can be handed the other's record.
        const made = cards()
        expect(made).toHaveLength(2)
        expect(new Set(made.map((t) => t.externalKey))).toHaveProperty('size', 2)

        // And each one moves only its own. The todo mirror completes its card;
        // the task card is untouched.
        mirror(payload([{ content: 'Run the tests', status: 'completed' }]))
        const byKey = new Map(cards().map((t) => [t.externalKey, t.lane]))
        expect([...byKey.values()].sort()).toEqual(['done', 'todo'])
      })

      it('the whole-list mirror never reports the other mirror\'s cards as dropped', () => {
        create('1', 'A task')
        const result = mirror(payload([{ content: 'A todo', status: 'pending' }]))
        // A `keep` means "a list the assistant sent left this card out". The
        // task card was never on that list to begin with — it belongs to a
        // different protocol — so it is not counted, and cannot flip the
        // reword suspicion on.
        expect(result.kept).toBe(0)
        expect(result.rewordSuspected).toBe(false)
      })

      it('a todo whose wording looks like a task key still gets its own card', () => {
        // The namespaces are separated by a marker a todo key cannot contain:
        // todo keys are lowercased on the way in, so no wording anybody can type
        // reaches an uppercase marker.
        mirror(payload([{ content: 'TASK#1', status: 'pending' }]))
        create('1', 'The real task 1')
        expect(cards()).toHaveLength(2)
        expect(cards().map((t) => t.title).sort()).toEqual(['TASK#1', 'The real task 1'])
      })
    })

    // ── Scoping ─────────────────────────────────────────────────────────

    describe('scoping', () => {
      it('does not touch another thread\'s cards, even on the identical id', () => {
        const other = threadStore.createThread({ projectRoot: ROOT, title: 'Other' }).id
        create('1', 'Mine')
        mirrorAgentTaskToolCall(deps(), {
          ...createCall('1', 'Theirs'),
          threadId: other,
        })
        // These ids restart at 1 in every conversation, so two threads each
        // numbering their first task 1 is the ordinary case, not a rare one.
        const made = cards()
        expect(made).toHaveLength(2)
        expect(new Set(made.map((t) => t.originThreadId))).toEqual(new Set([threadId, other]))

        mirrorAgentTaskToolCall(deps(), {
          ...updateCall({ taskId: '1', status: 'deleted' }),
          threadId: other,
        })
        expect(taskStore.listTasks(ROOT).map((t) => t.title)).toEqual(['Mine'])
      })

      it('never claims a card the mirror did not create', () => {
        const manual = taskStore.createTask({
          projectRoot: ROOT,
          title: 'A',
          originThreadId: threadId,
        })
        update({ taskId: '1', subject: 'A', status: 'completed' })
        // Same wording, same origin thread — but no mirror key, so it is
        // somebody's own card.
        expect(taskStore.getTask(manual.id)?.lane).toBe('todo')
        expect(cards()).toHaveLength(2)
      })

      it('does nothing when the thread is gone, without failing', () => {
        threadStore.deleteThread(threadId)
        expect(create('1', 'A').added).toBe(0)
        expect(cards()).toHaveLength(0)
      })
    })

    // ── A malformed payload produces nothing ────────────────────────────

    describe('a malformed payload', () => {
      it.each([
        ['not JSON at all', '{oops', '"Task #1 created successfully: A"'],
        ['JSON that is not an object', '[1,2,3]', '"Task #1 created successfully: A"'],
        ['a creation with no wording', '{"description":"x"}', '"Task #1 created successfully"'],
        ['an answer naming no task', '{"subject":"A"}', '"Created."'],
        ['no answer at all', '{"subject":"A"}', null],
      ])('produces no cards and a reason: %s', (_label, inputJson, outputJson) => {
        const result = mirrorAgentTaskToolCall(deps(), {
          threadId,
          toolName: CREATE,
          inputJson,
          outputJson,
        })
        expect(result.added).toBe(0)
        expect(result.reason).not.toBeNull()
        expect(cards()).toHaveLength(0)
      })

      it('leaves existing cards exactly as they are', () => {
        create('1', 'A')
        const result = mirrorAgentTaskToolCall(deps(), {
          threadId,
          toolName: UPDATE,
          inputJson: '{oops',
          outputJson: null,
        })
        expect(result.reason).not.toBeNull()
        expect(result.removed).toBe(0)
        expect(taskStore.listTasks(ROOT)).toHaveLength(1)
      })

      it('a state this board has no column for changes nothing', () => {
        create('1', 'A')
        const result = update({ taskId: '1', status: 'cancelled' })
        expect(result.reason).not.toBeNull()
        expect(result.removed).toBe(0)
        expect(cards()[0].lane).toBe('todo')
      })
    })

    // ── A mirror failure never fails the turn ───────────────────────────

    it('a mirror failure is logged and dropped rather than thrown', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const broken = {
        listTasks: () => {
          throw new Error('database is locked')
        },
      } as unknown as TaskStore
      const result = mirrorAgentTaskSafely({ taskStore: broken, threadStore }, createCall('1', 'A'))
      expect(result.added).toBe(0)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  // ── The hook routes both protocols (Phase 3b) ─────────────────────────

  describe('the hook, routing two protocols', () => {
    const run = (observations: Parameters<ReturnType<typeof makeTodoMirror>>[0][]) => {
      const scheduled: Array<() => void> = []
      const hook = makeTodoMirror(deps(), (r) => scheduled.push(r))
      observations.forEach((observation) => hook(observation))
      scheduled.forEach((r) => r())
      return scheduled.length
    }

    it('reads the whole-list write at the moment it was recorded', () => {
      const scheduled = run([
        {
          threadId,
          phase: 'recorded',
          toolName: TOOL,
          inputJson: payload([{ content: 'A', status: 'pending' }]),
        },
      ])
      expect(scheduled).toBe(1)
      expect(cards()).toHaveLength(1)
    })

    it('does NOT mirror the whole-list write a second time when it settles', () => {
      const scheduled = run([
        {
          threadId,
          phase: 'completed',
          toolName: TOOL,
          inputJson: payload([{ content: 'A', status: 'pending' }]),
          outputJson: '"done"',
          status: 'success',
        },
      ])
      // Mirroring it twice would re-file a card somebody deleted between the
      // two moments. Each protocol listens at exactly one moment.
      expect(scheduled).toBe(0)
      expect(cards()).toHaveLength(0)
    })

    it('ignores the id-addressed creation at the moment it was recorded', () => {
      const scheduled = run([
        {
          threadId,
          phase: 'recorded',
          toolName: CREATE,
          inputJson: '{"subject":"A","description":"x"}',
        },
      ])
      // THE CENTRAL FACT OF THIS PHASE: at this moment the task has no id yet —
      // the assistant has not been told what it is called — so there is nothing
      // to key a card on.
      expect(scheduled).toBe(0)
      expect(cards()).toHaveLength(0)
    })

    it('mirrors the id-addressed creation when it settles, keyed on the answer', () => {
      run([
        {
          threadId,
          phase: 'completed',
          toolName: CREATE,
          inputJson: '{"subject":"Write the parser","description":"x"}',
          outputJson: '"Task #1 created successfully: Write the parser"',
          status: 'success',
        },
        {
          threadId,
          phase: 'completed',
          toolName: UPDATE,
          inputJson: '{"taskId":"1","status":"completed"}',
          outputJson: '"Updated task #1 status"',
          status: 'success',
        },
      ])
      expect(cards().map((t) => [t.title, t.lane])).toEqual([['Write the parser', 'done']])
    })

    it.each(['error', 'denied', 'interrupted'] as const)(
      'ignores a call that ended %s',
      (status) => {
        const scheduled = run([
          {
            threadId,
            phase: 'completed',
            toolName: CREATE,
            inputJson: '{"subject":"A","description":"x"}',
            outputJson: '"Task #1 created successfully: A"',
            status,
          },
        ])
        // One call is one fact here, so a creation that was refused is a fact
        // that never happened — putting it on the board would show a task the
        // assistant's own list does not have.
        expect(scheduled).toBe(0)
        expect(cards()).toHaveLength(0)
      },
    )

    it('carries a real creation from the bridge, answer and all, through to a card', () => {
      const scheduled: Array<() => void> = []
      const mirrorHook = makeTodoMirror(deps(), (r) => scheduled.push(r))
      const bridge = new StreamBridge(threadId, threadStore, {
        onSessionId: () => {},
        emit: () => {},
        onToolCallRecorded: (observation) => mirrorHook({ threadId, ...observation }),
      })

      bridge.handleMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-x',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: CREATE,
              input: { subject: 'Write the parser', description: 'Read the payload.' },
            },
          ],
        },
      } as never)
      // Nothing yet: the answer has not arrived, so the task has no identity.
      scheduled.forEach((r) => r())
      expect(cards()).toHaveLength(0)

      bridge.handleMessage({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'Task #1 created successfully: Write the parser',
            },
          ],
        },
      } as never)
      scheduled.forEach((r) => r())

      // END TO END through the path that actually runs in production, including
      // the moment that did not exist before this phase.
      expect(cards().map((t) => t.title)).toEqual(['Write the parser'])
      expect(cards()[0].originThreadId).toBe(threadId)
    })
  })
})
