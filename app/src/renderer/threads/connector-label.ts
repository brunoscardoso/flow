/**
 * Connector calls in plain words (plan_connectors, Phase 4, note 7).
 *
 * ONE label rule for every place a connector call shows — the tool card, the
 * work row's used-connector marks and the permission card — so the raw tool
 * name never reaches the screen (allowed-pattern #14). Pure and DOM-free: the
 * app's renderer jest runs CJS under a node environment.
 *
 * The forms a connector tool name arrives in:
 *
 *   - Claude: `mcp__<server>__<tool>`. The server part is the configured name
 *     with every character outside letters, digits, `_` and `-` replaced by
 *     `_` — a Claude.ai "claude.ai Linear" arrives as `claude_ai_Linear`, a
 *     plugin server "plugin:vercel:vercel" as `plugin_vercel_vercel`.
 *   - Codex: `codex-events.ts` names an `mcp_tool_call` item in the SAME form,
 *     so there is one form to read, not two.
 *   - Copilot: the CLI names an MCP tool `<server>-<tool>` (its built-in
 *     GitHub server's tools read `github-mcp-server-get_issue`). The stored
 *     name is never rewritten; it is read here. Copilot's own tools (`bash`,
 *     `view`, `str_replace_editor`, `report_intent`…) carry no `-`, and no
 *     Claude or Codex tool does either, so a hyphenated name is the signal.
 *
 * Flow's own board tools (`mcp__flow__*`, `flow-*`) are not connectors and
 * keep their existing rendering.
 */

/** A connector call, read out of its tool name. */
export interface ConnectorCall {
  /** The server part as it appears in the tool name (sanitized). */
  serverName: string
  /** The name a person reads: "Linear", "Vercel". */
  connectorName: string
  /** The tool in plain words: "Search issues". */
  action: string
}

export interface ConnectorLabelOptions {
  /**
   * Display names from the connector list, keyed by the configured name
   * (`claude.ai Linear`) or the tool-name form (`claude_ai_Linear`) — both are
   * matched. Overrides the name derived from the tool name.
   */
  displayNames?: ReadonlyMap<string, string>
}

/** Flow's own MCP server — its tools are the board's, not a connector's. */
const FLOW_SERVER = 'flow'
const CLAUDE_PREFIX = 'mcp__'
const CLAUDE_AI_PREFIX = 'claude_ai_'
const PLUGIN_PREFIX = 'plugin_'

/** The tool-name form of a configured connector name (mirrors the runtime). */
export function toolNameForm(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** Title-case a server name: `linear-server` → "Linear Server". */
function titleCase(name: string): string {
  const words = name
    .split(/[\s_\-.:]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return words.length === 0 ? name : words.join(' ')
}

/**
 * The name a person reads, from the server part alone. Mirrors the connector
 * list's own rule (`displayNameOf` in main) on the sanitized form: a Claude.ai
 * connector loses its prefix, a plugin server is named by its last part,
 * anything else is title-cased.
 */
export function connectorNameFromServer(serverName: string): string {
  if (serverName.startsWith(CLAUDE_AI_PREFIX)) {
    const rest = serverName.slice(CLAUDE_AI_PREFIX.length).replace(/_+/g, ' ').trim()
    if (rest !== '') return rest
  }
  if (serverName.startsWith(PLUGIN_PREFIX)) {
    const parts = serverName.slice(PLUGIN_PREFIX.length).split('_').filter((part) => part !== '')
    const last = parts[parts.length - 1]
    if (last !== undefined) return titleCase(last)
  }
  return titleCase(serverName)
}

/** An acronym stays as written: `URL`, `PRs`, `ID`. */
function isAcronym(word: string): boolean {
  return /^[A-Z][A-Z0-9]+s?$/.test(word) && /[A-Z].*[A-Z0-9]/.test(word)
}

/**
 * A tool name in plain words: `search_issues` → "Search issues",
 * `getIssue` → "Get issue", `list-pull-requests` → "List pull requests",
 * `get_PR_URL` → "Get PR URL", `getURLForId` → "Get URL for id".
 */
export function readableAction(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z](?!s(?:[^a-z]|$))[a-z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .filter((word) => word !== '')
  if (words.length === 0) return tool
  // A name shouted whole (`SEARCH_ISSUES`) is not a row of acronyms.
  const shouted = words.length > 1 && words.every(isAcronym)
  return words
    .map((word, index) => {
      if (!shouted && isAcronym(word)) return word
      const lower = word.toLowerCase()
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

function displayNameFor(serverName: string, options: ConnectorLabelOptions | undefined): string {
  const names = options?.displayNames
  if (names !== undefined) {
    const direct = names.get(serverName)
    if (direct !== undefined && direct.trim() !== '') return direct.trim()
    for (const [key, value] of names) {
      if (toolNameForm(key) === serverName && value.trim() !== '') return value.trim()
    }
  }
  return connectorNameFromServer(serverName)
}

/** The known server names, in tool-name form, longest first. */
function knownServers(options: ConnectorLabelOptions | undefined): string[] {
  const names = options?.displayNames
  if (names === undefined) return []
  return [...new Set([...names.keys()].map(toolNameForm))].sort((a, b) => b.length - a.length)
}

/** `mcp__<server>__<tool>` → its two parts. A known server wins a split. */
function splitClaudeForm(toolName: string, options: ConnectorLabelOptions | undefined): { server: string; tool: string } | null {
  const rest = toolName.slice(CLAUDE_PREFIX.length)
  for (const server of knownServers(options)) {
    if (rest.startsWith(server + '__') && rest.length > server.length + 2) {
      return { server, tool: rest.slice(server.length + 2) }
    }
  }
  const index = rest.indexOf('__')
  if (index <= 0) return null
  const tool = rest.slice(index + 2)
  if (tool === '') return null
  return { server: rest.slice(0, index), tool }
}

/** Copilot's `<server>-<tool>` → its two parts. A known server wins a split;
 *  else the tool is the part after the last `-`. */
function splitCopilotForm(toolName: string, options: ConnectorLabelOptions | undefined): { server: string; tool: string } | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*-[A-Za-z0-9_]+$/.test(toolName)) return null
  for (const server of knownServers(options)) {
    if (toolName.startsWith(server + '-') && toolName.length > server.length + 1) {
      return { server, tool: toolName.slice(server.length + 1) }
    }
  }
  const index = toolName.lastIndexOf('-')
  if (index <= 0) return null
  return { server: toolName.slice(0, index), tool: toolName.slice(index + 1) }
}

/**
 * The connector call a tool name stands for, or null for every tool that is
 * not a connector's — including Flow's own board tools, which keep today's
 * rendering.
 */
export function connectorCall(toolName: string, options?: ConnectorLabelOptions): ConnectorCall | null {
  if (toolName === '') return null
  const parts = toolName.startsWith(CLAUDE_PREFIX)
    ? splitClaudeForm(toolName, options)
    : splitCopilotForm(toolName, options)
  if (parts === null || parts.server === FLOW_SERVER) return null
  return {
    serverName: parts.server,
    connectorName: displayNameFor(parts.server, options),
    action: readableAction(parts.tool),
  }
}

/** A connector used in a request: what the work row's marks draw. */
export interface UsedConnector {
  serverName: string
  connectorName: string
}

/**
 * The distinct connectors a set of calls used, in order of first use. The
 * work row's closed line draws the first three.
 */
export function usedConnectors(
  records: Iterable<{ toolName: string }>,
  options?: ConnectorLabelOptions,
): UsedConnector[] {
  const seen = new Set<string>()
  const out: UsedConnector[] = []
  for (const record of records) {
    const call = connectorCall(record.toolName, options)
    if (call === null || seen.has(call.serverName)) continue
    seen.add(call.serverName)
    out.push({ serverName: call.serverName, connectorName: call.connectorName })
  }
  return out
}

/** How many hue tokens the initial's ground picks from (`--fl-project-hue-0..7`). */
export const CONNECTOR_HUE_COUNT = 8

/** A stable hue slot for a connector name (FNV-1a over its UTF-16 units). */
export function connectorHueSlot(name: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % CONNECTOR_HUE_COUNT
}

/** The letter the fallback icon shows: the first letter or digit, upper-cased. */
export function connectorInitial(displayName: string): string {
  const match = /[\p{L}\p{N}]/u.exec(displayName)
  return match === null ? '?' : match[0].toUpperCase()
}

/** The words a failed connector call shows: the error's own sentence, when the
 *  output carries one (a string, or `{ message }` / `{ error }`). */
export function connectorErrorSentence(outputJson: string | null): string | null {
  if (outputJson === null || outputJson.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(outputJson) as unknown
  } catch {
    parsed = outputJson
  }
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string') return value.trim() === '' ? null : value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      return pick(record['message']) ?? pick(record['error'])
    }
    return null
  }
  const sentence = pick(parsed)
  if (sentence === null) return null
  const flat = sentence.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? flat.slice(0, 159) + String.fromCharCode(8230) : flat
}

/** A finished call's duration in short words — `420 ms`, `1.2 s`, `2 min` —
 *  or null while it runs or when either time is unreadable. */
export function callDuration(startedAt: string, completedAt: string | null): string | null {
  if (completedAt === null) return null
  const ms = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** The permission card's question for a connector tool:
 *  "Allow Linear to search issues?" — an acronym (`PR`) keeps its case. */
export function connectorPermissionTitle(call: Pick<ConnectorCall, 'connectorName' | 'action'>): string {
  const first = call.action.split(' ')[0] ?? ''
  const action = isAcronym(first) ? call.action : call.action.charAt(0).toLowerCase() + call.action.slice(1)
  return `Allow ${call.connectorName} to ${action}?`
}
