// The `flow` board tools — an in-process MCP server the chat agent can act on the
// tasks board with. Six tools, each a thin delegate to the board's existing code
// path (create_task → createManualTask, update_task → applyTaskUpdate, the loop
// tools → BoardLoop): there is ONE set of board rules, reached two ways
// (allowed-pattern #14).
//
// MODULE FORMAT: `createSdkMcpServer`/`tool` are runtime exports of the ESM-only
// @anthropic-ai/claude-agent-sdk while the main process bundles to CJS, so they
// are loaded through a runtime dynamic import() (kept out of TypeScript's CJS
// down-compilation via `new Function`) — the same mechanism agent-manager uses
// for `query`. Typing the result as `typeof import(...)` keeps `tool()`'s generic
// inference, so each handler's `args` stay fully typed.
//
// PROJECT-BOUND, NOT PROJECT-ARGUMENT. The provider binds every operation to the
// session's own project before handing them here, so no tool takes a projectRoot
// and a tool argument can never point the agent at another project (NFR-2).
//
// FAIL-SOFT: a bad id, an unknown lane, or a store error becomes a legible result
// the model can relay (`{ ok: false, error }`, `isError: true`), never a thrown
// turn (NFR-3).

import { z } from 'zod'

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { TaskLane, TaskRecord, UpdateTaskInput } from '../../store/task-store'

/**
 * A tool result carrying text — a structural subset of the SDK's (unexported)
 * CallToolResult, which is all these tools return. Assignable to what `tool()`
 * expects, so handlers stay fully typed without naming the SDK-private type.
 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
import type { BoardLoopStatus } from '../../tasks/board-loop'
import type { SubtaskStartResult } from '../subtask-registry'
import { BOARD_TOOL_NAMES, FLOW_MCP_SERVER_NAME, SUBTASK_TOOL_NAME } from './board-tools-shared'

/** Every lane a card can be moved to — the runtime half of the TaskLane union. */
const LANES: readonly TaskLane[] = ['todo', 'doing', 'blocked', 'review', 'done']

/**
 * The board operations the tools call, each already bound to the session's own
 * project by the provider. Injected so the tools test against fakes with no store,
 * no Electron, and no SDK.
 */
export interface FlowBoardToolsDeps {
  /** Create a real manual card (+ its 1:1 thread) — wraps createManualTask. */
  createTask(input: { title: string; description?: string }): TaskRecord
  /** This project's active cards — wraps taskStore.listTasks. */
  listTasks(): TaskRecord[]
  /** One card by id, or null — wraps taskStore.getTask. */
  getTask(id: string): TaskRecord | null
  /** Apply a patch through the one update path — wraps applyTaskUpdate. */
  updateTask(id: string, patch: UpdateTaskInput): TaskRecord
  /** Start the whole-board loop — wraps BoardLoop.start. */
  startLoop(): Promise<BoardLoopStatus>
  /** Stop the whole-board loop — wraps BoardLoop.stop. */
  stopLoop(): BoardLoopStatus
}

/**
 * The subtask registry, bound to ONE thread by the AgentManager (which owns the
 * session) — so no tool argument can reach another conversation's tickets.
 * `fromPrompt` is the model's short quote of the person's message the work came
 * from; the binding resolves it to a message id (a model cannot know ids).
 */
export interface SubtaskToolDeps {
  start(input: { title: string; task: string; fromPrompt?: string; retryOf?: string }): SubtaskStartResult
}

/** The `start_subtask` description: the delegation protocol, for the model. */
export const START_SUBTASK_DESCRIPTION =
  'Get a ticket for a background subtask. Use it only for work that is independent of your current task. ' +
  'Then call the Agent tool with run_in_background: true and name set to the ticket. ' +
  'One ticket for one Agent call. If the answer is "queued", do not call Agent yet: wait until you are told the ticket may start. ' +
  'Give a subtask only files your current work does not touch. ' +
  'To change what a running subtask does, send it a message with SendMessage, to = its ticket.'

/** The pure `start_subtask` logic — short plain words the model acts on. */
export interface SubtaskToolHandlers {
  startSubtask(args: { title: string; task: string; from_prompt?: string; retry_of?: string }): Promise<ToolResult>
}

export function subtaskToolHandlers(deps: SubtaskToolDeps): SubtaskToolHandlers {
  return {
    startSubtask: async (args) => {
      try {
        const result = deps.start({
          title: args.title,
          task: args.task,
          ...(args.from_prompt !== undefined ? { fromPrompt: args.from_prompt } : {}),
          ...(args.retry_of !== undefined ? { retryOf: args.retry_of } : {}),
        })
        if (!result.ok) return text(`Refused: ${result.reason}`, true)
        if (result.state === 'queued') {
          return text(
            `Ticket ${result.ticket} is queued: all subtask slots are in use. Wait — you will be told when ${result.ticket} may start. Do not call Agent for it now.`,
          )
        }
        return text(
          `Ticket ${result.ticket}. Call the Agent tool now with run_in_background: true and name: ${result.ticket}.`,
        )
      } catch (error) {
        return text(`Refused: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}

/** A plain-text result (the subtask tool speaks sentences, not JSON). */
function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) }
}

/** ESM SDK members loaded at runtime; typed off the real module for inference. */
type SdkMcpApi = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'createSdkMcpServer' | 'tool'>

const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk'

/** Runtime import() that TypeScript's CJS output cannot rewrite to require. */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

async function loadSdkMcpApi(): Promise<SdkMcpApi> {
  return (await dynamicImport(SDK_MODULE_SPECIFIER)) as SdkMcpApi
}

/** A card as the model sees it — the board's own fields, nothing internal. */
function taskView(task: TaskRecord): {
  id: string
  title: string
  lane: TaskLane
  autoFix: boolean
  source: TaskRecord['source']
  archived: boolean
} {
  return {
    id: task.id,
    title: task.title,
    lane: task.lane,
    autoFix: task.autoFix,
    source: task.source,
    archived: task.archivedAt !== null,
  }
}

/** A success result carrying a JSON payload the model can read. */
function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** A legible, non-throwing failure the model can relay. */
function fail(error: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }], isError: true }
}

/** Wrap a handler so any thrown store error becomes a fail-soft result. */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The pure tool logic — one async handler per tool, each returning a text result.
 * SEPARATED FROM THE SDK WIRING so the delegation and the fail-soft behaviour test
 * against fakes with no SDK and no zod-at-runtime; `createFlowBoardTools` only adds
 * the schemas and the transport around these.
 */
export interface BoardToolHandlers {
  createTask(args: { title: string; description?: string }): Promise<ToolResult>
  listTasks(args: { lane?: TaskLane }): Promise<ToolResult>
  getTask(args: { id: string }): Promise<ToolResult>
  updateTask(args: {
    id: string
    lane?: TaskLane
    autoFix?: boolean
    archived?: boolean
  }): Promise<ToolResult>
  startLoop(): Promise<ToolResult>
  stopLoop(): Promise<ToolResult>
}

export function boardToolHandlers(deps: FlowBoardToolsDeps): BoardToolHandlers {
  return {
    createTask: (args) =>
      guarded(async () => {
        const task = deps.createTask({ title: args.title, description: args.description })
        return ok({ ok: true, task: taskView(task) })
      }),
    listTasks: (args) =>
      guarded(async () => {
        const tasks = deps
          .listTasks()
          .filter((t) => args.lane === undefined || t.lane === args.lane)
        return ok({ ok: true, tasks: tasks.map(taskView) })
      }),
    getTask: (args) =>
      guarded(async () => {
        const task = deps.getTask(args.id)
        if (task === null) return fail(`No card with id ${args.id}`)
        return ok({
          ok: true,
          task: { ...taskView(task), description: task.description, brief: task.brief },
        })
      }),
    updateTask: (args) =>
      guarded(async () => {
        if (args.lane !== undefined && !LANES.includes(args.lane)) {
          return fail(`Unknown lane "${args.lane}"`)
        }
        const patch: UpdateTaskInput = {}
        if (args.lane !== undefined) patch.lane = args.lane
        if (args.autoFix !== undefined) patch.autoFix = args.autoFix
        if (args.archived !== undefined) patch.archived = args.archived
        if (Object.keys(patch).length === 0) {
          return fail('Nothing to update — pass a lane, autoFix, or archived.')
        }
        if (deps.getTask(args.id) === null) return fail(`No card with id ${args.id}`)
        const task = deps.updateTask(args.id, patch)
        return ok({ ok: true, task: taskView(task) })
      }),
    startLoop: () =>
      guarded(async () => {
        const status = await deps.startLoop()
        return ok({ ok: true, loop: status })
      }),
    stopLoop: () =>
      guarded(async () => {
        const status = deps.stopLoop()
        return ok({ ok: true, loop: status })
      }),
  }
}

/** The lane enum both the schema and the tests share. */
const LANE_ENUM = ['todo', 'doing', 'blocked', 'review', 'done'] as const

/**
 * Build the `flow` MCP server for one session. Async because the SDK's tool
 * factories are loaded at runtime (see MODULE FORMAT above). Adds the zod schemas
 * and transport around the pure handlers above.
 *
 * TWO HALVES, ONE SERVER. `board` is null when the board gates said no (the
 * setting is off, or this is not a plain user chat); `subtasks` is present on
 * every Claude thread session. The server key `flow` is reserved, so both
 * halves share it rather than one shadowing the other.
 */
export async function createFlowBoardTools(
  board: FlowBoardToolsDeps | null,
  subtasks: SubtaskToolDeps | null = null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await loadSdkMcpApi()

  const subtaskTools =
    subtasks === null
      ? []
      : [
          tool(
            SUBTASK_TOOL_NAME,
            START_SUBTASK_DESCRIPTION,
            {
              title: z.string().min(1).describe('A few words naming the work.'),
              task: z.string().min(1).describe('The full instructions the background agent gets.'),
              from_prompt: z
                .string()
                .optional()
                .describe('A few words quoted from the person’s message this work comes from.'),
              retry_of: z.string().optional().describe('The ticket of an ended subtask this one tries again.'),
            },
            (args) => subtaskToolHandlers(subtasks).startSubtask(args),
          ),
        ]
  if (board === null) {
    return createSdkMcpServer({ name: FLOW_MCP_SERVER_NAME, version: '1.0.0', tools: subtaskTools })
  }
  const h = boardToolHandlers(board)

  const tools = [
    ...subtaskTools,
    tool(
      BOARD_TOOL_NAMES.createTask,
      'Create a task card on this project’s Flow board (with its own chat thread). Returns the new card.',
      { title: z.string().min(1), description: z.string().optional() },
      (args) => h.createTask(args),
    ),
    tool(
      BOARD_TOOL_NAMES.listTasks,
      'List this project’s active Flow board cards, optionally filtered to one lane.',
      { lane: z.enum(LANE_ENUM).optional() },
      (args) => h.listTasks(args),
    ),
    tool(
      BOARD_TOOL_NAMES.getTask,
      'Get one Flow board card by id, including its description and brief.',
      { id: z.string().min(1) },
      (args) => h.getTask(args),
    ),
    tool(
      BOARD_TOOL_NAMES.updateTask,
      'Update a Flow board card: move it to a lane, offer it to the loop (autofix), or archive it.',
      {
        id: z.string().min(1),
        lane: z.enum(LANE_ENUM).optional(),
        autoFix: z.boolean().optional(),
        archived: z.boolean().optional(),
      },
      (args) => h.updateTask(args),
    ),
    tool(
      BOARD_TOOL_NAMES.startLoop,
      'Start this project’s board loop — it works every card marked for autofix, one at a time.',
      {},
      () => h.startLoop(),
    ),
    tool(BOARD_TOOL_NAMES.stopLoop, 'Stop this project’s board loop.', {}, () => h.stopLoop()),
  ]

  return createSdkMcpServer({ name: FLOW_MCP_SERVER_NAME, version: '1.0.0', tools })
}
