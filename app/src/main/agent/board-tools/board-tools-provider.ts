// The gate and the wiring: decide whether a session gets the board tools, and if
// so build them bound to that session's project.
//
// TWO GATES, BOTH POSITIVE. The tools exist for a session only when the project's
// setting is on AND the thread is a plain user chat. A board-loop-driven thread —
// one an existing task owns, or a loop run — gets nothing, so an autonomous run
// can never hand itself `start_loop`: the re-entrancy is closed by SCOPE, not by
// a runtime flag (FR-7).
//
// PROJECT-BOUND. Every operation is bound to `projectRoot` here — the registered
// project, never a worktree (tasks are keyed by the project) — so no tool takes a
// project and a tool argument can never reach another project's board (NFR-2). A
// card id from another project reads as "not found", the same fail-soft a missing
// id gets.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TaskStore } from '../../store/task-store'
import type { ThreadStore } from '../../store/thread-store'
import type { BoardLoop } from '../../tasks/board-loop'
import {
  applyTaskUpdate,
  createManualTask,
  type ApplyTaskUpdateDeps,
  type BriefGenerator,
} from '../../tasks/task-service'
import { parseFlowconfigText } from '../../flow/flow-observer'
import { boardToolsEnabledIn } from './board-tools-shared'
import type { FlowBoardToolsDeps } from './flow-tools'

/**
 * The board operations a session gets, bound to its project, or null when it
 * gets none. The AgentManager builds the one `flow` server from this AND the
 * subtask tool, which every Claude thread session gets whatever this says.
 */
export type BoardToolsProvider = (input: {
  threadId: string
  projectRoot: string
}) => Promise<FlowBoardToolsDeps | null>

export interface BoardToolsProviderDeps {
  taskStore: TaskStore
  threadStore: ThreadStore
  boardLoop: BoardLoop
  /** For applyTaskUpdate's brief-on-activation reaction. */
  briefGenerator: BriefGenerator
  /** For applyTaskUpdate's close-remote-on-done reaction. */
  closeRemote: ApplyTaskUpdateDeps['closeRemote']
}

/**
 * A plain user chat: no task owns this thread, and it is not a loop run. Excludes
 * every board-loop-driven thread (they are task threads) and every task-detail
 * chat — the FR-7 gate. Both checks are positive; either one failing means this is
 * not a chat the board tools belong on.
 */
export function isUserChatThread(
  threadId: string,
  deps: { taskStore: TaskStore; threadStore: ThreadStore },
): boolean {
  if (deps.taskStore.getTaskByThreadId(threadId) !== null) return false
  const thread = deps.threadStore.getThread(threadId)
  return thread !== null && thread.originLoop === null
}

/**
 * Read the board-tools setting from a project's `flow/.flowconfig`. Default ON —
 * an absent file or key means the capability is available.
 */
export function boardToolsEnabled(projectRoot: string): boolean {
  try {
    const text = readFileSync(join(projectRoot, 'flow', '.flowconfig'), 'utf-8')
    return boardToolsEnabledIn(parseFlowconfigText(text))
  } catch {
    return true
  }
}

/**
 * The board operations bound to one project — the closure every tool calls. Split
 * out so the binding and the project-scoping (a cross-project id reads as
 * not-found) test directly, paired with `boardToolHandlers`, without the SDK.
 */
export function buildBoardToolsDeps(
  deps: BoardToolsProviderDeps,
  projectRoot: string,
): FlowBoardToolsDeps {
  // A card must belong to THIS project — a cross-project id reads as not-found.
  const scopedTask = (id: string) => {
    const task = deps.taskStore.getTask(id)
    return task && task.projectRoot === projectRoot ? task : null
  }
  return {
    createTask: (input) =>
      createManualTask(deps, {
        projectRoot,
        title: input.title,
        description: input.description,
      }),
    listTasks: () => deps.taskStore.listTasks(projectRoot),
    getTask: scopedTask,
    updateTask: (id, patch) => {
      if (scopedTask(id) === null) throw new Error(`No card with id ${id}`)
      return applyTaskUpdate(
        {
          taskStore: deps.taskStore,
          threadStore: deps.threadStore,
          briefGenerator: deps.briefGenerator,
          closeRemote: deps.closeRemote,
        },
        id,
        patch,
      )
    },
    startLoop: () => deps.boardLoop.start(projectRoot),
    stopLoop: () => deps.boardLoop.stop(projectRoot),
  }
}

/**
 * Build the provider the AgentManager calls per session. Returns the board
 * operations when both gates pass, else null. Every board operation is bound to
 * the session's project here.
 */
export function makeBoardToolsProvider(deps: BoardToolsProviderDeps): BoardToolsProvider {
  return async ({ threadId, projectRoot }) => {
    if (!boardToolsEnabled(projectRoot)) return null
    if (!isUserChatThread(threadId, deps)) return null
    return buildBoardToolsDeps(deps, projectRoot)
  }
}
