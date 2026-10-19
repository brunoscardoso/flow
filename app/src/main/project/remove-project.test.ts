// removeProject cascade — against real stores (real DB), fake removeRoot.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { TaskStore } from '../store/task-store'
import { removeProject } from './remove-project'

const ROOT_A = '/proj/a'
const ROOT_B = '/proj/b'

describe('removeProject', () => {
  let tempDir: string
  let db: FlowDatabase
  let threadStore: ThreadStore
  let taskStore: TaskStore
  let removedRoots: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-remove-project-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    threadStore = new ThreadStore(db)
    taskStore = new TaskStore(db)
    removedRoots = []
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const deps = () => ({
    threadStore,
    taskStore,
    removeRoot: (path: string) => removedRoots.push(path),
  })

  it('deletes the project’s threads (including archived) and drops the root', () => {
    const t1 = threadStore.createThread({ projectRoot: ROOT_A, title: 'a1' })
    const t2 = threadStore.createThread({ projectRoot: ROOT_A, title: 'a2' })
    threadStore.updateThread(t2.id, { archived: true })
    const other = threadStore.createThread({ projectRoot: ROOT_B, title: 'b1' })

    removeProject(deps(), ROOT_A)

    expect(threadStore.getThread(t1.id)).toBeNull()
    expect(threadStore.getThread(t2.id)).toBeNull() // archived too
    expect(threadStore.getThread(other.id)).not.toBeNull() // other project untouched
    expect(removedRoots).toEqual([ROOT_A])
  })

  it('deletes the project’s tasks along with their threads', () => {
    const thread = threadStore.createThread({ projectRoot: ROOT_A, title: 'task thread' })
    const task = taskStore.createTask({ projectRoot: ROOT_A, title: 'T', threadId: thread.id })

    removeProject(deps(), ROOT_A)

    expect(taskStore.getTask(task.id)).toBeNull()
    expect(threadStore.getThread(thread.id)).toBeNull()
  })

  it('is a clean no-op (still drops the root) for a project with nothing in it', () => {
    removeProject(deps(), ROOT_A)
    expect(removedRoots).toEqual([ROOT_A])
  })

  it('prunes the removed project from OTHER threads’ additional roots (#261)', () => {
    // Thread primaried in B keeps A as an additional root; removing A must strip
    // A from B-thread's scope, not just delete A-owned threads.
    const bThread = threadStore.createThread({ projectRoot: ROOT_B, title: 'multi' })
    threadStore.setThreadRoots(bThread.id, [ROOT_A])
    expect(threadStore.getThreadRoots(bThread.id)).toEqual([ROOT_A])

    removeProject(deps(), ROOT_A)

    // The B-thread survives (primaried elsewhere) but no longer scopes A.
    expect(threadStore.getThread(bThread.id)).not.toBeNull()
    expect(threadStore.getThreadRoots(bThread.id)).toEqual([])
  })

  // #1484: the cascade reached tasks → threads → thread_roots → the root, and
  // stopped short of the one thing holding an OS process. The removed project's
  // shells kept running for the life of the app — invisible with another project
  // open, a ghost tab for a nonexistent project without one.
  it('closes the project’s terminals, before the root they are scoped by goes', () => {
    const order: string[] = []
    removeProject(
      {
        ...deps(),
        removeRoot: (path: string) => order.push(`removeRoot:${path}`),
        disposeTerminals: (path: string) => order.push(`disposeTerminals:${path}`),
      },
      ROOT_A,
    )
    expect(order).toEqual([`disposeTerminals:${ROOT_A}`, `removeRoot:${ROOT_A}`])
  })

  it('still removes the project when no terminal teardown is wired', () => {
    expect(() => removeProject(deps(), ROOT_A)).not.toThrow()
    expect(removedRoots).toEqual([ROOT_A])
  })

  it('leaves other projects’ tasks intact', () => {
    const tA = threadStore.createThread({ projectRoot: ROOT_A, title: 'a' })
    taskStore.createTask({ projectRoot: ROOT_A, title: 'A', threadId: tA.id })
    const tB = threadStore.createThread({ projectRoot: ROOT_B, title: 'b' })
    const taskB = taskStore.createTask({ projectRoot: ROOT_B, title: 'B', threadId: tB.id })

    removeProject(deps(), ROOT_A)

    expect(taskStore.getTask(taskB.id)).not.toBeNull()
    expect(threadStore.getThread(tB.id)).not.toBeNull()
  })
})
