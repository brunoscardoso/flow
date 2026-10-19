// The projects a person chose for a task (the remote ticket's picker, and a
// card's "Change") — against real stores (real DB), like task-service.test.ts.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { TaskStore } from '../store/task-store'
import {
  chooseTaskProjects,
  createTaskFromQueueItem,
  rememberChosenProjects,
  taskChatHasStarted,
  type TaskProjectsRecord,
} from './task-service'

const APP = '/tmp/ws/orbit-app'
const CORE = '/tmp/ws/orbit-core'
const ARGO = '/tmp/ws/orbit-argo'

function memoryRecord(): TaskProjectsRecord & { extra: Map<string, string[]>; chosen: Set<string> } {
  const extra = new Map<string, string[]>()
  const chosen = new Set<string>()
  return {
    extra,
    chosen,
    setExtra: (taskId, roots) => {
      extra.set(taskId, [...roots])
      return [...roots]
    },
    markChosen: (taskId) => chosen.add(taskId),
  }
}

describe('chosen task projects', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-task-projects-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function addTicket(additionalRoots?: string[]) {
    return createTaskFromQueueItem(
      { taskStore, threadStore },
      {
        projectRoot: APP,
        externalKey: 'ACME-3866',
        url: 'https://acme.atlassian.net/browse/ACME-3866',
        title: 'ACME-3866: Endless loading',
        ...(additionalRoots === undefined ? {} : { additionalRoots }),
      },
    )
  }

  it('a remote ticket added with projects: the first is the task’s project, the rest its chat’s attached roots', () => {
    const { task, created } = addTicket([CORE])
    expect(created).toBe(true)
    expect(task.projectRoot).toBe(APP)
    expect(threadStore.getThread(task.threadId!)?.projectRoot).toBe(APP)
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual([CORE])

    const record = memoryRecord()
    rememberChosenProjects(record, task.id, [CORE])
    expect(record.extra.get(task.id)).toEqual([CORE])
    expect(record.chosen.has(task.id)).toBe(true)
  })

  it('Change with the same first project re-sets only the context projects', () => {
    const { task } = addTicket([CORE])
    const record = memoryRecord()
    const result = chooseTaskProjects({ taskStore, threadStore, projects: record }, { taskId: task.id, roots: [APP, ARGO] })
    expect(result.task.projectRoot).toBe(APP)
    expect(result.task.threadId).toBe(task.threadId)
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual([ARGO])
    expect(record.extra.get(task.id)).toEqual([ARGO])
    expect(record.chosen.has(task.id)).toBe(true)
  })

  it('Change with a different first project moves the task and gives it a fresh chat there', () => {
    const { task } = addTicket([CORE])
    const oldThread = task.threadId!
    const record = memoryRecord()
    const result = chooseTaskProjects({ taskStore, threadStore, projects: record }, { taskId: task.id, roots: [CORE] })
    expect(result.task.projectRoot).toBe(CORE)
    expect(taskStore.getTask(task.id)?.projectRoot).toBe(CORE)
    const newThread = result.task.threadId!
    expect(newThread).not.toBe(oldThread)
    expect(threadStore.getThread(newThread)?.projectRoot).toBe(CORE)
    expect(threadStore.getThread(oldThread)).toBeNull()
    expect(threadStore.getThreadRoots(newThread)).toEqual([])
    expect(record.extra.get(task.id)).toEqual([])
    expect(record.chosen.has(task.id)).toBe(true)
  })

  it('a failed re-link leaves the task in its project, linked to its own chat (one transaction)', () => {
    const { task } = addTicket()
    const oldThread = task.threadId!
    // Positive first: the move would otherwise have gone through.
    expect(task.projectRoot).toBe(APP)
    const linkThread = taskStore.linkThread.bind(taskStore)
    taskStore.linkThread = () => {
      throw new Error('disk full')
    }
    expect(() =>
      chooseTaskProjects({ taskStore, threadStore, projects: memoryRecord() }, { taskId: task.id, roots: [CORE] }),
    ).toThrow(/disk full/)
    taskStore.linkThread = linkThread
    const after = taskStore.getTask(task.id)
    expect(after?.projectRoot).toBe(APP)
    expect(after?.threadId).toBe(oldThread)
    expect(threadStore.getThread(oldThread)).not.toBeNull()
    expect(threadStore.listThreads(CORE, { includeArchived: true })).toEqual([])
  })

  it('a move keeps the old unstarted chat when it already has a checkout of its project', () => {
    const { task } = addTicket()
    const oldThread = task.threadId!
    threadStore.setThreadWorktree(oldThread, { path: '/tmp/ws/orbit-app-threads/worktree/x', branch: null, base: null })
    const result = chooseTaskProjects({ taskStore, threadStore, projects: memoryRecord() }, { taskId: task.id, roots: [CORE] })
    // The move happened…
    expect(result.task.projectRoot).toBe(CORE)
    expect(result.task.threadId).not.toBe(oldThread)
    // …and the thread holding a checkout was not deleted out from under it.
    expect(threadStore.getThread(oldThread)?.worktreePath).toBe('/tmp/ws/orbit-app-threads/worktree/x')
  })

  it('refuses once the chat has started, and when nothing is chosen', () => {
    const { task } = addTicket()
    // Positive first: an untouched chat has not started.
    expect(taskChatHasStarted(threadStore, task.threadId)).toBe(false)
    const record = memoryRecord()
    expect(() => chooseTaskProjects({ taskStore, threadStore, projects: record }, { taskId: task.id, roots: [] })).toThrow(
      /at least one project/,
    )
    threadStore.appendMessage(task.threadId!, 'user', 'go')
    expect(taskChatHasStarted(threadStore, task.threadId)).toBe(true)
    expect(() =>
      chooseTaskProjects({ taskStore, threadStore, projects: record }, { taskId: task.id, roots: [CORE] }),
    ).toThrow(/has started/)
    expect(taskStore.getTask(task.id)?.projectRoot).toBe(APP)
    expect(record.chosen.size).toBe(0)
  })

  it('refuses to move a ticket into a project that already has a task for it', () => {
    const { task } = addTicket()
    createTaskFromQueueItem(
      { taskStore, threadStore },
      { projectRoot: CORE, externalKey: 'ACME-3866', url: 'https://acme.atlassian.net/browse/ACME-3866', title: 'dup' },
    )
    expect(() =>
      chooseTaskProjects({ taskStore, threadStore, projects: memoryRecord() }, { taskId: task.id, roots: [CORE] }),
    ).toThrow(/already has a task/)
    expect(taskStore.getTask(task.id)?.projectRoot).toBe(APP)
  })
})
