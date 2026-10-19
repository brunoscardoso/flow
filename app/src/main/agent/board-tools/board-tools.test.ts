// board-tools wiring tests, against REAL stores and a real database.
//
// The availability gate, the setting, project scoping, and the promise that an
// intentional create and a mirrored todo stay two independent records are all
// facts about the store, so a fake store would be testing nothing.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../../store/db'
import { ThreadStore } from '../../store/thread-store'
import { TaskStore } from '../../store/task-store'
import {
  createManualTask,
  createTaskFromAgentTodo,
  type BriefGenerator,
} from '../../tasks/task-service'
import type { BoardLoop } from '../../tasks/board-loop'
import { boardToolHandlers } from './flow-tools'
import {
  boardToolsEnabled,
  buildBoardToolsDeps,
  isUserChatThread,
  type BoardToolsProviderDeps,
} from './board-tools-provider'

const PROJECT = '/proj-a'
const OTHER = '/proj-b'

const briefGenerator: BriefGenerator = async () => null
const noopLoop = {
  start: async () => ({ running: true, taskId: null, stoppedReason: null }),
  stop: () => ({ running: false, taskId: null, stoppedReason: null }),
  status: () => ({ running: false, taskId: null, stoppedReason: null }),
} as unknown as BoardLoop

function body(result: { content: Array<{ type: 'text'; text: string }> }): any {
  return JSON.parse(result.content[0].text)
}

describe('board-tools wiring', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore
  let deps: BoardToolsProviderDeps

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'board-tools-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)
    deps = {
      taskStore,
      threadStore,
      boardLoop: noopLoop,
      briefGenerator,
      closeRemote: { isEnabled: () => false, closeIssue: async () => ({ ok: true }) as any, notify: () => {} },
    }
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('isUserChatThread', () => {
    it('admits a plain chat thread nobody owns', () => {
      const thread = threadStore.createThread({ projectRoot: PROJECT, title: 'chat' })
      expect(isUserChatThread(thread.id, { taskStore, threadStore })).toBe(true)
    })

    it('denies a task-owned thread (every board-loop-driven thread is one)', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: PROJECT, title: 'card' })
      expect(task.threadId).not.toBeNull()
      expect(isUserChatThread(task.threadId as string, { taskStore, threadStore })).toBe(false)
    })

    it('denies a loop-run thread', () => {
      const thread = threadStore.createThread({ projectRoot: PROJECT, title: 'loop run' })
      threadStore.markAsLoopRun(thread.id, 'board')
      expect(isUserChatThread(thread.id, { taskStore, threadStore })).toBe(false)
    })
  })

  describe('boardToolsEnabled', () => {
    function writeConfig(contents: string): string {
      const root = mkdtempSync(join(tmpdir(), 'proj-'))
      mkdirSync(join(root, 'flow'), { recursive: true })
      writeFileSync(join(root, 'flow', '.flowconfig'), contents, 'utf-8')
      return root
    }

    it('defaults ON when there is no config', () => {
      expect(boardToolsEnabled(join(tempDir, 'no-such-project'))).toBe(true)
    })

    it('defaults ON when the key is absent', () => {
      expect(boardToolsEnabled(writeConfig('autopilot: true\n'))).toBe(true)
    })

    it('is OFF only when the key says false', () => {
      expect(boardToolsEnabled(writeConfig('agent_board_tools: false\n'))).toBe(false)
      expect(boardToolsEnabled(writeConfig('agent_board_tools: true\n'))).toBe(true)
    })
  })

  describe('project scoping (bound deps)', () => {
    it('lists only this project’s cards and treats a cross-project id as not-found', async () => {
      createManualTask({ taskStore, threadStore }, { projectRoot: PROJECT, title: 'mine' })
      const other = createManualTask({ taskStore, threadStore }, { projectRoot: OTHER, title: 'theirs' })

      const handlers = boardToolHandlers(buildBoardToolsDeps(deps, PROJECT))
      const listed = body(await handlers.listTasks({}))
      expect(listed.tasks.map((t: any) => t.title)).toEqual(['mine'])

      const cross = body(await handlers.getTask({ id: other.id }))
      expect(cross).toEqual({ ok: false, error: `No card with id ${other.id}` })
    })
  })

  describe('no duplicate cards (FR-10)', () => {
    it('an intentional create and a mirrored todo stay two independent records', () => {
      const origin = threadStore.createThread({ projectRoot: PROJECT, title: 'chat' })
      const manual = createManualTask({ taskStore, threadStore }, { projectRoot: PROJECT, title: 'Run the tests' })
      const { task: mirrored, created } = createTaskFromAgentTodo(
        { taskStore, threadStore },
        { projectRoot: PROJECT, originThreadId: origin.id, key: 'run the tests', title: 'Run the tests' },
      )
      expect(created).toBe(true)
      expect(mirrored.id).not.toBe(manual.id)
      // The manual card owns a thread and has no origin; the mirror carries an
      // origin and owns no thread — different key spaces, no collision.
      expect(manual.threadId).not.toBeNull()
      expect(manual.originThreadId).toBeNull()
      expect(mirrored.originThreadId).toBe(origin.id)
      expect(taskStore.listTasks(PROJECT)).toHaveLength(2)
    })
  })
})
