/**
 * SubtaskRegistry against a real ThreadStore on a temp database (v40's table):
 * the cap, attempt numbering, linking, settling, overlaps and the Stop answer.
 * Runs under Electron-as-Node (node scripts/run-jest.mjs) for better-sqlite3.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore, type ThreadChangeEvent } from '../store/thread-store'
import { SUBTASK_RUNNING_CAP, SubtaskRegistry, makeTicket } from './subtask-registry'

describe('SubtaskRegistry', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let events: ThreadChangeEvent[]
  let registry: SubtaskRegistry
  let threadId: string
  let clock: number

  const tick = (): string => new Date(Date.UTC(2026, 9, 22, 12, 0, clock++)).toISOString()

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subtask-registry-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    events = []
    clock = 0
    registry = new SubtaskRegistry(store, (event) => events.push(event), { now: tick })
    threadId = store.createThread({ projectRoot: '/repo', title: 'main' }).id
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const startOk = (title: string, extra: { retryOf?: string; thread?: string } = {}) => {
    const result = registry.start({
      threadId: extra.thread ?? threadId,
      fromMessageId: 'm-1',
      title,
      task: `do ${title}`,
      ...(extra.retryOf === undefined ? {} : { retryOf: extra.retryOf }),
    })
    if (!result.ok) throw new Error(result.reason)
    return result
  }

  /** start → link → task_started: a subtask with a runtime task behind it. */
  const running = (title: string) => {
    const started = startOk(title)
    expect(registry.link({ threadId, ticket: started.ticket, toolCallId: `tu-${title}` }).ok).toBe(true)
    registry.onTaskStarted({ threadId, toolUseId: `tu-${title}`, taskId: `task-${title}` })
    return started.ticket
  }

  it('mints short, model-friendly tickets', () => {
    expect(makeTicket()).toMatch(/^st-[0-9a-z]{6}$/)
  })

  describe('start and the cap', () => {
    it('gives the first three a slot and queues the fourth behind them', () => {
      const first = [startOk('a'), startOk('b'), startOk('c')]
      expect(first.map((r) => r.state)).toEqual(['running', 'running', 'running'])
      expect(SUBTASK_RUNNING_CAP).toBe(3)

      const fourth = startOk('d')
      expect(fourth.state).toBe('queued')
      expect(fourth.queuedBehind).toEqual(first.map((r) => r.ticket))
      expect(store.getSubtask(fourth.ticket)?.startedAt).toBeNull()
    })

    it('stores the row, survives a reload, and emits one created event carrying it', () => {
      const result = startOk('a')
      expect(events).toEqual([
        { entity: 'subtask', action: 'created', threadId, subtask: result.record },
      ])
      const reread = new ThreadStore(db).listSubtasks(threadId)
      expect(reread).toEqual([result.record])
      expect(reread[0]).toMatchObject({ title: 'a', task: 'do a', attempt: 1, retryOf: null, fromMessageId: 'm-1' })
    })

    it('caps per thread: another thread is not held back', () => {
      startOk('a'); startOk('b'); startOk('c')
      const other = store.createThread({ projectRoot: '/repo', title: 'other' }).id
      expect(startOk('x', { thread: other }).state).toBe('running')
    })

    it('refuses an empty title or task', () => {
      expect(registry.start({ threadId, fromMessageId: null, title: ' ', task: 'x' }).ok).toBe(false)
      expect(registry.start({ threadId, fromMessageId: null, title: 'x', task: '' }).ok).toBe(false)
      expect(store.listSubtasks(threadId)).toEqual([])
    })
  })

  describe('retry_of', () => {
    it('numbers the attempt from the retried ticket', () => {
      const ticket = running('a')
      registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'failed', error: 'boom' })
      const retry = startOk('a', { retryOf: ticket })
      expect(retry.attempt).toBe(2)
      expect(retry.record.retryOf).toBe(ticket)
      const third = registry.start({ threadId, fromMessageId: null, title: 'a', task: 't', retryOf: retry.ticket })
      // The second attempt is still running, so it cannot be retried yet.
      expect(third).toEqual({ ok: false, reason: expect.stringContaining('has not ended') })
    })

    it('refuses an unknown retry_of, and one from another thread, writing nothing', () => {
      const result = registry.start({ threadId, fromMessageId: null, title: 'a', task: 't', retryOf: 'st-nope00' })
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('st-nope00') })
      const other = store.createThread({ projectRoot: '/repo', title: 'other' }).id
      const foreign = startOk('f', { thread: other })
      expect(
        registry.start({ threadId, fromMessageId: null, title: 'a', task: 't', retryOf: foreign.ticket }).ok,
      ).toBe(false)
      expect(store.listSubtasks(threadId)).toEqual([])
    })
  })

  describe('link', () => {
    it('links a running ticket to its Agent call', () => {
      const started = startOk('a')
      const linked = registry.link({ threadId, ticket: started.ticket, toolCallId: 'tu-1' })
      expect(linked.ok && linked.record.toolCallId).toBe('tu-1')
      // The same call again is idempotent; another call on the same ticket is refused.
      expect(registry.link({ threadId, ticket: started.ticket, toolCallId: 'tu-1' }).ok).toBe(true)
      expect(registry.link({ threadId, ticket: started.ticket, toolCallId: 'tu-2' }).ok).toBe(false)
    })

    it('refuses an unknown ticket with a reason the agent can act on', () => {
      startOk('a')
      const result = registry.link({ threadId, ticket: 'st-zzzzzz', toolCallId: 'tu-1' })
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('start_subtask') })
    })

    it('refuses a queued ticket while every slot is taken, and promotes it once one frees', () => {
      running('a'); running('b'); running('c')
      const queued = startOk('d')
      const refused = registry.link({ threadId, ticket: queued.ticket, toolCallId: 'tu-d' })
      expect(refused).toEqual({ ok: false, reason: expect.stringContaining('Wait') })
      expect(store.getSubtask(queued.ticket)?.state).toBe('queued')

      const settled = registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'completed' })
      expect(settled.next?.ticket).toBe(queued.ticket)

      const linked = registry.link({ threadId, ticket: queued.ticket, toolCallId: 'tu-d' })
      expect(linked.ok && linked.record.state).toBe('running')
      expect(store.getSubtask(queued.ticket)?.startedAt).not.toBeNull()
    })

    it('refuses an ended ticket', () => {
      const ticket = running('a')
      registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'stopped' })
      expect(registry.link({ threadId, ticket, toolCallId: 'tu-again' }).ok).toBe(false)
    })
  })

  describe('task events', () => {
    it('stores the task id on the linked row, and ignores a call with no ticket', () => {
      const ticket = running('a')
      expect(store.getSubtask(ticket)?.sdkTaskId).toBe('task-a')
      expect(registry.onTaskStarted({ threadId, toolUseId: 'tu-skill', taskId: 'task-skill' })).toBeNull()
    })

    it('settles done / failed / stopped with an end time and the error', () => {
      const a = running('a'); const b = running('b'); const c = running('c')
      registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'completed' })
      registry.onTaskSettled({ threadId, taskId: 'task-b', status: 'failed', error: 'tests failed' })
      registry.onTaskSettled({ threadId, taskId: 'task-c', status: 'stopped' })
      expect(store.getSubtask(a)).toMatchObject({ state: 'done', error: null })
      expect(store.getSubtask(b)).toMatchObject({ state: 'failed', error: 'tests failed' })
      expect(store.getSubtask(c)?.state).toBe('stopped')
      expect(store.getSubtask(a)?.endedAt).not.toBeNull()
    })

    it('names no next ticket when nothing is queued, and ignores a skill task', () => {
      running('a')
      expect(registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'completed' }).next).toBeNull()
      expect(registry.onTaskSettled({ threadId, taskId: 'task-skill', status: 'completed' })).toEqual({
        record: null,
        next: null,
      })
    })
  })

  describe('files written and overlaps', () => {
    it('records a subtask write, and marks no overlap when nobody else wrote the file', () => {
      const ticket = running('a')
      registry.recordWrite({ threadId, agentId: 'task-a', filePath: '/repo/a.ts' })
      registry.recordWrite({ threadId, agentId: 'task-a', filePath: '/repo/a.ts' })
      expect(store.getSubtask(ticket)).toMatchObject({ filesWritten: ['/repo/a.ts'], overlapFiles: [] })
    })

    it('marks an overlap when the main agent and a subtask write the same file — either order', () => {
      registry.beginRequest(threadId)
      const a = running('a')
      registry.recordWrite({ threadId, agentId: null, filePath: '/repo/shared.ts' })
      registry.recordWrite({ threadId, agentId: 'task-a', filePath: '/repo/shared.ts' })
      expect(store.getSubtask(a)?.overlapFiles).toEqual(['/repo/shared.ts'])

      const b = running('b')
      registry.recordWrite({ threadId, agentId: 'task-b', filePath: '/repo/later.ts' })
      expect(store.getSubtask(b)?.overlapFiles).toEqual([])
      registry.recordWrite({ threadId, agentId: null, filePath: '/repo/later.ts' })
      expect(store.getSubtask(b)?.overlapFiles).toEqual(['/repo/later.ts'])
    })

    it('marks both rows when two subtasks write the same file', () => {
      const a = running('a'); const b = running('b')
      registry.recordWrite({ threadId, agentId: 'task-a', filePath: '/repo/x.ts' })
      registry.recordWrite({ threadId, agentId: 'task-b', filePath: '/repo/x.ts' })
      expect(store.getSubtask(a)?.overlapFiles).toEqual(['/repo/x.ts'])
      expect(store.getSubtask(b)?.overlapFiles).toEqual(['/repo/x.ts'])
    })

    it('forgets the main agent\'s writes at the next request', () => {
      registry.beginRequest(threadId)
      registry.recordWrite({ threadId, agentId: null, filePath: '/repo/old.ts' })
      clock += 10
      registry.beginRequest(threadId)
      const a = running('a')
      registry.recordWrite({ threadId, agentId: 'task-a', filePath: '/repo/old.ts' })
      expect(store.getSubtask(a)).toMatchObject({ filesWritten: ['/repo/old.ts'], overlapFiles: [] })
    })

    it('ignores a skill sub-agent\'s write', () => {
      running('a')
      expect(registry.recordWrite({ threadId, agentId: 'task-skill', filePath: '/repo/x.ts' })).toEqual([])
    })
  })

  describe('stop', () => {
    it('answers the task id to stop for a running subtask, and writes nothing', () => {
      const ticket = running('a')
      const before = events.length
      expect(registry.stop({ threadId, ticket })).toEqual({ ok: true, taskId: 'task-a' })
      expect(events.length).toBe(before)
      expect(store.getSubtask(ticket)?.state).toBe('running')
    })

    it('refuses no ticket, a ticket of another thread, an unstarted one and an ended one', () => {
      const ticket = running('a')
      expect(registry.stop({ threadId, ticket }).ok).toBe(true)

      expect(registry.stop({ threadId, ticket: 'st-zzzzzz' }).ok).toBe(false)
      expect(registry.stop({ threadId: 'other', ticket }).ok).toBe(false)
      const unstarted = startOk('b')
      expect(registry.stop({ threadId, ticket: unstarted.ticket })).toEqual({
        ok: false,
        reason: expect.stringContaining('not started'),
      })
      registry.onTaskSettled({ threadId, taskId: 'task-a', status: 'completed' })
      expect(registry.stop({ threadId, ticket }).ok).toBe(false)
    })
  })

  it('every write emits exactly one subtask event with the row as stored', () => {
    const ticket = running('a')
    // start (created) + link + task_started (updated)
    expect(events.map((e) => [e.entity, e.action])).toEqual([
      ['subtask', 'created'],
      ['subtask', 'updated'],
      ['subtask', 'updated'],
    ])
    expect(events[2]?.subtask).toEqual(store.getSubtask(ticket))
  })

  it('ends rows a restart stranded as failed, with a sentence', () => {
    const ticket = running('a')
    const queuedA = startOk('b'); startOk('c'); const queued = startOk('d')
    expect(store.getSubtask(queued.ticket)?.state).toBe('queued')
    expect(registry.reconcileInterrupted()).toBe(4)
    for (const t of [ticket, queuedA.ticket, queued.ticket]) {
      expect(store.getSubtask(t)).toMatchObject({ state: 'failed', error: 'Flow closed before this subtask ended.' })
    }
  })

  it('a deleted thread takes its subtasks with it', () => {
    const ticket = startOk('a').ticket
    expect(store.getSubtask(ticket)).not.toBeNull()
    store.deleteThread(threadId)
    expect(store.getSubtask(ticket)).toBeNull()
  })
})
