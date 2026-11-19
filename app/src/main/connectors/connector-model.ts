// connector-model — the pure half of the connector service (plan_connectors,
// note 1). Turns what the runtime reports (`McpServerStatus`) and what Claude's
// own files say (the scoped external-mcp read) into the one `ConnectorEntry`
// shape the renderer draws. DOM-free and fs-free, so it tests without either.
//
// SECRETS NEVER ENTER AN ENTRY (NFR-6). Every field is copied by name from a
// known-safe place: a config's `url` is reduced to its host, a stdio command is
// never copied at all, and `env` / `headers` are never read. Spreading a status
// or a config into an entry is the bug this file exists to make impossible.

import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'

import type {
  ConnectorEntry,
  ConnectorIconHint,
  ConnectorScope,
  ConnectorSource,
  ConnectorStatus,
  ConnectorTool,
  ConnectorTransport,
} from '../../shared/connectors'
import type { ExternalMcpScope, ScopedExternalMcpServer } from '../agent/external-mcp'

/** The in-process server Flow itself registers — never a connector. */
const FLOW_SERVER_NAME = 'flow'
/** A server that declares more icons than this is trimmed; nobody draws twenty. */
const MAX_ICON_HINTS = 8
/** A tool description longer than this is cut; it is a tooltip, not a manual. */
const MAX_DESCRIPTION_CHARS = 400

/** What the per-chat and per-account layers add on top of status and config. */
export interface ConnectorOverlay {
  /** Names this chat turned off; undefined = no chat was asked about. */
  offInThread?: readonly string[]
  /** The ask-first tools for one connector name. */
  askFirst: (name: string) => string[]
}

/** The file scope of external-mcp as the writer's target scope. */
export function scopeOfFile(scope: ExternalMcpScope): ConnectorScope {
  switch (scope) {
    case 'user':
      return 'account'
    case 'local':
      return 'project-local'
    case 'project':
      return 'project-shared'
  }
}

/**
 * Where a status entry's definition came from. The runtime names it in
 * `source`; a server Flow handed the session programmatically reads `dynamic`,
 * so the file it came from (the scoped read) answers instead. Anything else
 * the runtime may grow (managed, enterprise, agent) is shown with the account.
 */
export function sourceOf(statusSource: string | undefined, fileScope: ExternalMcpScope | undefined): ConnectorSource {
  if (statusSource === 'claudeai') return 'claudeai'
  if (statusSource === 'plugin') return 'plugin'
  if (statusSource === 'project') return 'project'
  if (statusSource === 'user' || statusSource === 'local') return 'account'
  if (fileScope === 'project') return 'project'
  return 'account'
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** How a config is reached. A config with neither a type nor a url is a program. */
export function transportOf(config: unknown, source: ConnectorSource): ConnectorTransport {
  const record = recordOf(config)
  const type = record?.['type']
  if (type === 'claudeai-proxy') return 'claudeai'
  if (type === 'http' || type === 'sse') return 'web'
  if (type === 'stdio') return 'program'
  if (record !== null && typeof record['command'] === 'string') return 'program'
  if (record !== null && typeof record['url'] === 'string') return 'web'
  return source === 'claudeai' ? 'claudeai' : 'program'
}

/** The host of a web config's address — the only part of a url an entry keeps. */
export function hostOf(config: unknown): string | undefined {
  const record = recordOf(config)
  if (record === null) return undefined
  const type = record['type']
  if (type !== 'http' && type !== 'sse') return undefined
  const url = stringOf(record['url'])
  if (url === undefined) return undefined
  try {
    const host = new URL(url).hostname
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

/** Title-case a server name: `linear-server` → "Linear Server". */
export function titleCase(name: string): string {
  const words = name
    .split(/[\s_\-.:]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return words.length === 0 ? name : words.join(' ')
}

/**
 * The name a person reads. The server's own title wins; then a Claude.ai
 * connector loses its "claude.ai " prefix, a plugin server is named by its last
 * part (`plugin:vercel:vercel` → "Vercel"), and anything else is title-cased.
 */
export function displayNameOf(name: string, source: ConnectorSource, serverTitle: string | undefined): string {
  if (serverTitle !== undefined) return serverTitle.trim()
  if (source === 'claudeai' || /^claude\.ai\s+/i.test(name)) {
    const stripped = name.replace(/^claude\.ai\s+/i, '').trim()
    if (stripped !== '') return stripped
  }
  if (name.startsWith('plugin:')) {
    const parts = name.split(':').filter((part) => part !== '')
    const last = parts[parts.length - 1]
    if (last !== undefined && last !== 'plugin') return titleCase(last)
  }
  return titleCase(name)
}

/** Only an http(s) or data: image may be offered as an icon. */
function isIconSource(src: string): boolean {
  return /^https?:\/\//i.test(src) || /^data:image\//i.test(src)
}

/**
 * The icons a server declared. `serverInfo` at runtime carries MCP's `icons`
 * array although the SDK's types declare only name and version, so this is
 * read defensively: anything that is not a usable image source is dropped.
 */
export function iconHintsOf(serverInfo: unknown): ConnectorIconHint[] {
  const icons = recordOf(serverInfo)?.['icons']
  if (!Array.isArray(icons)) return []
  const hints: ConnectorIconHint[] = []
  for (const icon of icons) {
    const record = recordOf(icon)
    const src = stringOf(record?.['src'])
    if (record === null || src === undefined || !isIconSource(src)) continue
    const mimeType = stringOf(record['mimeType'])
    const theme = stringOf(record['theme'])
    hints.push({ src, ...(mimeType !== undefined ? { mimeType } : {}), ...(theme !== undefined ? { theme } : {}) })
    if (hints.length >= MAX_ICON_HINTS) break
  }
  return hints
}

function websiteUrlOf(serverInfo: unknown): string | undefined {
  const url = stringOf(recordOf(serverInfo)?.['websiteUrl'])
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}

function toolsOf(tools: McpServerStatus['tools']): ConnectorTool[] {
  if (!Array.isArray(tools)) return []
  const out: ConnectorTool[] = []
  for (const tool of tools) {
    const name = stringOf(tool?.name)
    if (name === undefined) continue
    const description = stringOf(tool.description)
    out.push({
      name,
      ...(description !== undefined ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
      ...(tool.annotations?.readOnly === true ? { readOnly: true } : {}),
      ...(tool.annotations?.destructive === true ? { destructive: true } : {}),
    })
  }
  return out
}

/**
 * A sentence for a status that needs one. The runtime's own error text is not
 * shown: it can name a program, a path or a flag (forbidden-pattern #12). The
 * service logs it for whoever is debugging.
 */
export function errorSentenceOf(status: ConnectorStatus, source: ConnectorSource): string | undefined {
  switch (status) {
    case 'failed':
      return 'This connector could not start.'
    case 'needs-auth':
      return source === 'claudeai'
        ? 'This connector needs you to sign in on Claude.ai.'
        : 'This connector needs you to sign in.'
    default:
      return undefined
  }
}

/**
 * The runtime error a server gets when it is still "pending" after the settle
 * window: it never answered. The model turns it into its own sentence; the
 * runtime's own error text is never shown (forbidden-pattern #12).
 */
export const NOT_ANSWERING = 'flow:not-answering'

/** A connector that never finished starting — a host this computer may not reach. */
export const NOT_ANSWERING_SENTENCE =
  'This connector is not answering. Its address may not be reachable from this computer. Retry to try again.'

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['connected', 'needs-auth', 'failed', 'pending', 'disabled'])

function statusOf(raw: unknown): ConnectorStatus {
  return typeof raw === 'string' && KNOWN_STATUSES.has(raw) ? (raw as ConnectorStatus) : 'pending'
}

function withOverlay(
  entry: Omit<ConnectorEntry, 'askFirst' | 'offInThread'>,
  overlay: ConnectorOverlay,
): ConnectorEntry {
  const off = overlay.offInThread
  const isOff = off !== undefined && off.includes(entry.name)
  return {
    ...entry,
    ...(off !== undefined ? { offInThread: isOff } : {}),
    // A chat that turned it off sees it as off, whatever the runtime says.
    status: isOff ? 'off' : entry.status,
    ...(isOff ? { error: undefined } : {}),
    askFirst: overlay.askFirst(entry.name),
  }
}

/** Drop `error: undefined` keys so an entry serialises the same however it was built. */
function clean(entry: ConnectorEntry): ConnectorEntry {
  if (entry.error === undefined) {
    const { error: _error, ...rest } = entry
    return rest
  }
  return entry
}

/**
 * One entry from a runtime status, or null for a server that is not a
 * connector (Flow's own `flow` server, an in-process `sdk` server).
 */
export function entryFromStatus(
  status: McpServerStatus,
  files: Readonly<Record<string, ScopedExternalMcpServer>>,
  overlay: ConnectorOverlay,
): ConnectorEntry | null {
  const name = stringOf(status.name)
  if (name === undefined || name === FLOW_SERVER_NAME || status.source === 'sdk') return null
  const file = files[name]
  const config: unknown = status.config ?? file?.config
  if (recordOf(config)?.['type'] === 'sdk') return null
  const source = sourceOf(status.source, file?.scope)
  const serverInfo: unknown = status.serverInfo
  const runtimeStatus = statusOf(status.status)
  // Only an entry Flow can find in one of Claude's files may be removed from
  // here — a Claude.ai or plugin connector is managed where it came from.
  const scope = file !== undefined && (source === 'account' || source === 'project') ? scopeOfFile(file.scope) : undefined
  const host = hostOf(config)
  const websiteUrl = websiteUrlOf(serverInfo)
  const error =
    runtimeStatus === 'failed' && status.error === NOT_ANSWERING
      ? NOT_ANSWERING_SENTENCE
      : errorSentenceOf(runtimeStatus, source)
  return clean(
    withOverlay(
      {
        name,
        displayName: displayNameOf(name, source, stringOf(recordOf(serverInfo)?.['title'])),
        source,
        transport: transportOf(config, source),
        status: runtimeStatus,
        tools: toolsOf(status.tools),
        ...(error !== undefined ? { error } : {}),
        ...(websiteUrl !== undefined ? { websiteUrl } : {}),
        ...(host !== undefined ? { host } : {}),
        iconHints: iconHintsOf(serverInfo),
        removable: scope !== undefined,
        ...(scope !== undefined ? { scope } : {}),
      },
      overlay,
    ),
  )
}

/**
 * An entry from Claude's files alone, for when the status could not be read.
 * Its status is `pending` — Flow does not know whether it would connect.
 */
export function entryFromFile(name: string, file: ScopedExternalMcpServer, overlay: ConnectorOverlay): ConnectorEntry {
  const source: ConnectorSource = file.scope === 'project' ? 'project' : 'account'
  const host = hostOf(file.config)
  const scope = scopeOfFile(file.scope)
  return clean(
    withOverlay(
      {
        name,
        displayName: displayNameOf(name, source, undefined),
        source,
        transport: transportOf(file.config, source),
        status: 'pending',
        tools: [],
        ...(host !== undefined ? { host } : {}),
        iconHints: [],
        removable: true,
        scope,
      },
      overlay,
    ),
  )
}

const SOURCE_ORDER: Record<ConnectorSource, number> = { account: 0, project: 1, claudeai: 2, plugin: 3 }

/** Stable order: by source group, then by the name a person reads. */
export function sortEntries(entries: ConnectorEntry[]): ConnectorEntry[] {
  return [...entries].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      a.displayName.localeCompare(b.displayName) ||
      a.name.localeCompare(b.name),
  )
}

/**
 * The whole list: every status entry, then any configured connector the
 * runtime did not report (so a file entry is never silently missing).
 */
export function buildConnectorList(
  statuses: readonly McpServerStatus[] | null,
  files: Readonly<Record<string, ScopedExternalMcpServer>>,
  overlay: ConnectorOverlay,
): ConnectorEntry[] {
  const entries: ConnectorEntry[] = []
  const seen = new Set<string>()
  for (const status of statuses ?? []) {
    const entry = entryFromStatus(status, files, overlay)
    if (entry === null || seen.has(entry.name)) continue
    seen.add(entry.name)
    entries.push(entry)
  }
  for (const [name, file] of Object.entries(files)) {
    if (seen.has(name)) continue
    entries.push(entryFromFile(name, file, overlay))
  }
  return sortEntries(entries)
}
