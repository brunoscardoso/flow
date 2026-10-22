// flow-tools handler tests — the pure tool logic against fakes: each tool
// delegates to the right bound operation, and a bad id / empty patch / thrown
// store error becomes a legible non-throwing result. No SDK, no zod-at-runtime.

import type { TaskRecord } from '../../store/task-store'
import type { BoardLoopStatus } from '../../tasks/board-loop'
import {
  boardToolHandlers,
  START_SUBTASK_DESCRIPTION,
  subtaskToolHandlers,
  type FlowBoardToolsDeps,
} from './flow-tools'

function fakeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    projectRoot: '/proj',
    title: 'A card',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'thread-1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: false,
    agentBlockedFrom: null,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  }
}

const STATUS: BoardLoopStatus = { running: true, taskId: null, stoppedReason: null }

/** A deps set that records calls; each op is overridable per test. */
function fakeDeps(over: Partial<FlowBoardToolsDeps> = {}): {
  deps: FlowBoardToolsDeps
  calls: { createTask: unknown[]; updateTask: unknown[]; startLoop: number; stopLoop: number }
} {
  const calls = { createTask: [] as unknown[], updateTask: [] as unknown[], startLoop: 0, stopLoop: 0 }
  const deps: FlowBoardToolsDeps = {
    createTask: (input) => {
      calls.createTask.push(input)
      return fakeTask({ title: input.title })
    },
    listTasks: () => [fakeTask({ id: 't-todo', lane: 'todo' }), fakeTask({ id: 't-done', lane: 'done' })],
    getTask: (id) => (id === 'task-1' ? fakeTask() : null),
    updateTask: (id, patch) => {
      calls.updateTask.push({ id, patch })
      return fakeTask({ id, ...patch })
    },
    startLoop: async () => {
      calls.startLoop += 1
      return STATUS
    },
    stopLoop: () => {
      calls.stopLoop += 1
      return { ...STATUS, running: false }
    },
    ...over,
  }
  return { deps, calls }
}

/** Parse a tool result's JSON payload. */
function body(result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }): {
  payload: any
  isError: boolean
} {
  return { payload: JSON.parse(result.content[0].text), isError: result.isError === true }
}

describe('boardToolHandlers', () => {
  it('create_task delegates to createTask and returns the new card', async () => {
    const { deps, calls } = fakeDeps()
    const { payload, isError } = body(
      await boardToolHandlers(deps).createTask({ title: 'Fix login', description: 'the bug' }),
    )
    expect(isError).toBe(false)
    expect(calls.createTask).toEqual([{ title: 'Fix login', description: 'the bug' }])
    expect(payload).toMatchObject({ ok: true, task: { title: 'Fix login', lane: 'todo' } })
  })

  it('list_tasks filters by lane', async () => {
    const { deps } = fakeDeps()
    const all = body(await boardToolHandlers(deps).listTasks({})).payload
    expect(all.tasks).toHaveLength(2)
    const done = body(await boardToolHandlers(deps).listTasks({ lane: 'done' })).payload
    expect(done.tasks).toEqual([expect.objectContaining({ id: 't-done', lane: 'done' })])
  })

  it('get_task returns a legible not-found for an unknown id', async () => {
    const { deps } = fakeDeps()
    const { payload, isError } = body(await boardToolHandlers(deps).getTask({ id: 'nope' }))
    expect(isError).toBe(true)
    expect(payload).toEqual({ ok: false, error: 'No card with id nope' })
  })

  it('update_task builds a patch and delegates to updateTask', async () => {
    const { deps, calls } = fakeDeps()
    const { payload } = body(
      await boardToolHandlers(deps).updateTask({ id: 'task-1', lane: 'doing', autoFix: true }),
    )
    expect(calls.updateTask).toEqual([{ id: 'task-1', patch: { lane: 'doing', autoFix: true } }])
    expect(payload).toMatchObject({ ok: true, task: { lane: 'doing', autoFix: true } })
  })

  it('update_task refuses an empty patch and a missing card, without calling updateTask', async () => {
    const { deps, calls } = fakeDeps()
    const empty = body(await boardToolHandlers(deps).updateTask({ id: 'task-1' }))
    expect(empty.isError).toBe(true)
    const missing = body(await boardToolHandlers(deps).updateTask({ id: 'ghost', lane: 'done' }))
    expect(missing.isError).toBe(true)
    expect(missing.payload.error).toContain('ghost')
    expect(calls.updateTask).toEqual([])
  })

  it('start_loop and stop_loop delegate to the board loop', async () => {
    const { deps, calls } = fakeDeps()
    const start = body(await boardToolHandlers(deps).startLoop())
    expect(calls.startLoop).toBe(1)
    expect(start.payload).toMatchObject({ ok: true, loop: { running: true } })
    const stop = body(await boardToolHandlers(deps).stopLoop())
    expect(calls.stopLoop).toBe(1)
    expect(stop.payload).toMatchObject({ ok: true, loop: { running: false } })
  })

  it('is fail-soft: a thrown store error becomes a legible result, never a throw', async () => {
    const { deps } = fakeDeps({
      createTask: () => {
        throw new Error('database is locked')
      },
    })
    const { payload, isError } = body(await boardToolHandlers(deps).createTask({ title: 'x' }))
    expect(isError).toBe(true)
    expect(payload).toEqual({ ok: false, error: 'database is locked' })
  })
})

describe('start_subtask', () => {
  const record = {} as never
  const read = (result: { content: Array<{ text: string }> }): string => result.content[0].text

  it('a running ticket: tells the model to call Agent now, named by the ticket', async () => {
    const start = jest.fn().mockReturnValue({ ok: true, ticket: 'st-abc123', state: 'running', attempt: 1, record })
    const result = await subtaskToolHandlers({ start }).startSubtask({
      title: 'Docs',
      task: 'Update the README',
      from_prompt: 'update the readme',
    })
    expect(start).toHaveBeenCalledWith({ title: 'Docs', task: 'Update the README', fromPrompt: 'update the readme' })
    expect(result.isError).toBeUndefined()
    expect(read(result)).toContain('st-abc123')
    expect(read(result)).toContain('run_in_background: true')
    expect(read(result)).toContain('name: st-abc123')
  })

  it('a queued ticket: says wait, and not to call Agent now', async () => {
    const start = jest.fn().mockReturnValue({
      ok: true,
      ticket: 'st-qqqqqq',
      state: 'queued',
      attempt: 1,
      queuedBehind: ['st-1', 'st-2', 'st-3'],
      record,
    })
    const result = await subtaskToolHandlers({ start }).startSubtask({ title: 'T', task: 'X', retry_of: 'st-old000' })
    expect(start).toHaveBeenCalledWith({ title: 'T', task: 'X', retryOf: 'st-old000' })
    expect(read(result)).toContain('queued')
    expect(read(result)).toContain('Wait')
    expect(read(result)).toContain('Do not call Agent')
  })

  it('a refusal: relays the registry reason as an error result', async () => {
    const start = jest.fn().mockReturnValue({ ok: false, reason: 'A subtask needs a title.' })
    const result = await subtaskToolHandlers({ start }).startSubtask({ title: ' ', task: 'X' })
    expect(result.isError).toBe(true)
    expect(read(result)).toBe('Refused: A subtask needs a title.')
  })

  it('the description carries the protocol', () => {
    expect(START_SUBTASK_DESCRIPTION).toContain('independent of your current task')
    expect(START_SUBTASK_DESCRIPTION).toContain('run_in_background: true')
    expect(START_SUBTASK_DESCRIPTION).toContain('name set to the ticket')
    expect(START_SUBTASK_DESCRIPTION).toContain('"queued"')
    expect(START_SUBTASK_DESCRIPTION).toContain('SendMessage')
  })
})
