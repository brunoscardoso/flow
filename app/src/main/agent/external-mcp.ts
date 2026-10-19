// external-mcp — load the USER's OWN MCP servers into a Flow session.
//
// Flow builds every Claude session's Options from scratch and injects only its
// in-process `flow` board server (board-tools-provider.ts). A server the user
// registered — a project `.mcp.json`, or `claude mcp add` which writes
// ~/.claude.json — therefore never reaches the session. Two structural reasons
// make the SDK's OWN filesystem discovery unreliable here, so we cannot just
// lean on `settingSources`:
//
//   • the session's cwd is the thread's WORKTREE, not the project root
//     (sessionRootFor), so a project `.mcp.json` is present only when committed;
//   • an account-bound project relocates CLAUDE_CONFIG_DIR and strips inherited
//     auth (account-env.ts, #107), so a user-scope ~/.claude.json is outside the
//     dir that session actually reads.
//
// So we read the same files Claude Code writes and merge their `mcpServers`
// into `options.mcpServers` PROGRAMMATICALLY — keyed by the registered PROJECT
// (thread.projectRoot), never the worktree. The servers' tool calls still go
// through the session's canUseTool permission gate exactly like every other
// tool, so this widens what the agent CAN reach, never what it may do unprompted.
//
// Fail-soft, like runtime-credentials / shared-config: any missing, unreadable,
// or malformed file is skipped and NEVER thrown — a broken MCP config must never
// fail a session, it just means "no external servers from that scope".
//
// SCOPES, lowest precedence first (a later scope wins a name collision, matching
// Claude Code's own local > project > user ordering):
//
//   user     ~/.claude.json            → top-level `mcpServers`
//   project  <projectRoot>/.mcp.json   → `mcpServers`
//   local    ~/.claude.json            → `projects[<projectRoot>].mcpServers`
//
// The reserved `flow` name is dropped so a user's server can never shadow the
// board tools (the board merge runs after this and would win regardless).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

import { FLOW_MCP_SERVER_NAME } from './board-tools/board-tools-shared'

/** Injectable fs/home for tests; defaults read the real filesystem. */
export interface ExternalMcpDeps {
  readFileFn?: (path: string) => string
  homedirFn?: () => string
}

/** Parse a JSON file to an object, or null on any failure (missing / unreadable
 *  / not-JSON / not-an-object). Never throws. */
function readJsonObject(
  path: string,
  read: (p: string) => string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(read(path))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Is this a passthrough MCP server config the SDK accepts from JSON?
 *
 * The `.mcp.json` / ~/.claude.json entries use exactly the SDK's stdio / http /
 * sse variants: a stdio server has a `command`, a remote one a `url`. The `sdk`
 * variant carries a live instance and cannot come from a file, so it is never
 * admitted here. Anything else (no command, no url, unknown type) is malformed
 * and skipped rather than trusted.
 */
export function isExternalMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== 'object' || value === null) return false
  const config = value as Record<string, unknown>
  const type = config['type']
  if (type === undefined || type === 'stdio') {
    return typeof config['command'] === 'string' && config['command'].length > 0
  }
  if (type === 'http' || type === 'sse') {
    return typeof config['url'] === 'string' && config['url'].length > 0
  }
  return false
}

/** Fold one scope's `mcpServers` map into `into`, dropping the reserved `flow`
 *  name and any malformed entry. A non-object `servers` is a no-op. */
function collectServers(servers: unknown, into: Record<string, McpServerConfig>): void {
  if (typeof servers !== 'object' || servers === null) return
  for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
    if (name === FLOW_MCP_SERVER_NAME) continue
    if (isExternalMcpServer(config)) into[name] = config
  }
}

/**
 * Every user-configured MCP server that applies to `projectRoot`, merged across
 * the three file scopes (user < project < local, later wins). Empty when nothing
 * is configured or every file is missing — the common case, and byte-identical
 * to before this existed. Never throws.
 */
export function loadExternalMcpServers(
  projectRoot: string,
  deps: ExternalMcpDeps = {},
): Record<string, McpServerConfig> {
  const read = deps.readFileFn ?? ((path: string) => readFileSync(path, 'utf8'))
  const home = deps.homedirFn?.() ?? homedir()
  const merged: Record<string, McpServerConfig> = {}

  // Read ~/.claude.json once — it holds BOTH the user-scope map and the
  // per-project (local) map, and it can be large.
  const userConfig = readJsonObject(join(home, '.claude.json'), read)

  // user scope — applies to every project
  if (userConfig) collectServers(userConfig['mcpServers'], merged)

  // project scope — the repo's own `.mcp.json`, read off the REGISTERED project
  const projectConfig = readJsonObject(join(projectRoot, '.mcp.json'), read)
  if (projectConfig) collectServers(projectConfig['mcpServers'], merged)

  // local scope — this project's private servers inside ~/.claude.json; highest
  // precedence, so a local override of a project/user server wins.
  const projects = userConfig?.['projects']
  if (typeof projects === 'object' && projects !== null) {
    const entry = (projects as Record<string, unknown>)[projectRoot]
    if (typeof entry === 'object' && entry !== null) {
      collectServers((entry as Record<string, unknown>)['mcpServers'], merged)
    }
  }

  return merged
}
