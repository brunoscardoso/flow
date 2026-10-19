// Flow board tools — the names and gates shared across the wiring.
//
// PURE ON PURPOSE. This module is imported by the permission broker (which only
// needs to know which tool names are board WRITES) and by the tools module and
// the provider. It touches no fs, no store, no SDK — so importing it pulls
// nothing heavy into the permission graph, and the "which tools mean the board"
// fact lives in ONE place rather than being restated at each call site
// (allowed-pattern #14).

/** The in-process MCP server name. Tools are addressed `mcp__flow__<base>`. */
export const FLOW_MCP_SERVER_NAME = 'flow'

/**
 * The tool base names (as `tool()` registers them). The model sees them
 * namespaced by the server — `flowToolName` builds that full name, and every
 * consumer that must match a full name goes through it.
 */
export const BOARD_TOOL_NAMES = {
  createTask: 'create_task',
  listTasks: 'list_tasks',
  getTask: 'get_task',
  updateTask: 'update_task',
  startLoop: 'start_loop',
  stopLoop: 'stop_loop',
} as const

/** The full, namespaced name the SDK reports for one of this server's tools. */
export function flowToolName(base: string): string {
  return `mcp__${FLOW_MCP_SERVER_NAME}__${base}`
}

/**
 * The board WRITES — the tools that create, change, or set the loop running, and
 * so must always ask before they act. Reads (`list`, `get`) are absent by design.
 *
 * Frozen and matched only through `isFlowWriteTool`, so the "these always ask"
 * rule cannot be reimplemented slightly differently somewhere the broker can't
 * see (allowed-pattern #14).
 */
const FLOW_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  flowToolName(BOARD_TOOL_NAMES.createTask),
  flowToolName(BOARD_TOOL_NAMES.updateTask),
  flowToolName(BOARD_TOOL_NAMES.startLoop),
  flowToolName(BOARD_TOOL_NAMES.stopLoop),
])

/** Is this the full name of a board WRITE tool (one that must always ask)? */
export function isFlowWriteTool(toolName: string): boolean {
  return FLOW_WRITE_TOOL_NAMES.has(toolName)
}

/**
 * The sentence the confirmation card shows for a board write — so the person sees
 * what will happen, not the machine tool name (forbidden-pattern #12).
 */
export function flowWriteToolTitle(toolName: string): string {
  switch (toolName) {
    case flowToolName(BOARD_TOOL_NAMES.createTask):
      return 'The agent wants to create a task on the board'
    case flowToolName(BOARD_TOOL_NAMES.updateTask):
      return 'The agent wants to change a task on the board'
    case flowToolName(BOARD_TOOL_NAMES.startLoop):
      return 'The agent wants to start the board loop'
    case flowToolName(BOARD_TOOL_NAMES.stopLoop):
      return 'The agent wants to stop the board loop'
    default:
      return 'The agent wants to change the board'
  }
}

/** The `flow/.flowconfig` key. Internal — never rendered (forbidden-pattern #12). */
export const BOARD_TOOLS_KEY = 'agent_board_tools'

/**
 * Are the board tools enabled, given a project's parsed `.flowconfig`?
 *
 * DEFAULT ON. An absent key means the capability is available — the setting is
 * an escape hatch, not an opt-in. Split from any file reading so the provider
 * (which has the disk) and the tests (which have neither) answer the same way.
 */
export function boardToolsEnabledIn(flowconfig: Record<string, string>): boolean {
  const configured = flowconfig[BOARD_TOOLS_KEY]
  if (configured !== undefined) return configured.trim() === 'true'
  return true
}
