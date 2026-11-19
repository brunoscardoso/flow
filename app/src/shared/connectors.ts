// Connectors (plan_connectors) — the shapes that cross IPC.
//
// A connector is an MCP server that gives the agent tools from another service.
// The connector service in main (main/connectors/) is the one owner of the
// list, its status and every write; the renderer only reads these entries and
// sends intents. Nothing here carries a secret: no env values, no headers, no
// tokens (NFR-6) — an entry is built field by field from status and config,
// never by spreading either.

/** Where a connector's definition came from. */
export type ConnectorSource = 'account' | 'project' | 'claudeai' | 'plugin'

/** How Flow reaches it: a web address, a program on this computer, or Claude.ai. */
export type ConnectorTransport = 'web' | 'program' | 'claudeai'

/**
 * One status per connector. `off` = this chat turned it off; `disabled` = the
 * runtime reports it switched off (a Claude.ai connector not enabled, say).
 */
export type ConnectorStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'off'

/** Which of Claude's own files an entry was read from, and where add/remove write. */
export type ConnectorScope = 'account' | 'project-local' | 'project-shared'

export interface ConnectorTool {
  name: string
  description?: string
  readOnly?: boolean
  destructive?: boolean
}

/** An icon the server itself declared (MCP `serverInfo.icons`). */
export interface ConnectorIconHint {
  src: string
  mimeType?: string
  theme?: string
}

export interface ConnectorEntry {
  /** The name as configured — the key every intent sends back. */
  name: string
  displayName: string
  source: ConnectorSource
  transport: ConnectorTransport
  status: ConnectorStatus
  tools: ConnectorTool[]
  /** What is wrong, as a sentence a person can read. */
  error?: string
  websiteUrl?: string
  /** The host of the connector's web address, when it has one. */
  host?: string
  iconHints: ConnectorIconHint[]
  /** Flow may remove it (it came from one of Claude's files Flow writes). */
  removable: boolean
  /** The file it came from, when Flow can write it — what Remove sends back. */
  scope?: ConnectorScope
  /** This chat turned it off. Present only when a chat was asked about. */
  offInThread?: boolean
  /** Tool names marked to always ask first, for this account. */
  askFirst: string[]
}

/** What `connectors:list` answers. `error` = the status could not be read; entries then come from the files alone. */
export interface ConnectorListAnswer {
  entries: ConnectorEntry[]
  error?: string
}

/** What a write intent answers: done, or why nothing was changed. */
export type ConnectorWriteAnswer = { ok: true } | { ok: false; reason: string }

/**
 * A connector config a person adds. Only the two shapes a person can type:
 * a web address, or a program with its arguments. Env and headers are not
 * taken from the renderer in this version.
 */
export type ConnectorAddConfig =
  | { type: 'http' | 'sse'; url: string }
  | { type: 'stdio'; command: string; args?: string[] }

/** Which theme an icon is asked for — a server may declare one icon per theme. */
export type ConnectorIconTheme = 'light' | 'dark'

/** What `connectors:icon` answers: a `data:` image, or null (the renderer draws the initial). */
export interface ConnectorIconAnswer {
  dataUri: string | null
}

/**
 * What `connectors:signIn` answers.
 *  - `waiting`: the browser is open; Flow watches for the sign-in to finish and
 *    broadcasts `connectors:changed` (with `signIn`) when it does or gives up.
 *  - `connected`: nothing to do — it was already signed in, and is reconnected.
 *  - `finish-in-browser`: the person finishes on Claude.ai; reconnect when back.
 */
export type ConnectorSignInAnswer =
  | { ok: true; state: 'waiting' | 'connected' | 'finish-in-browser' }
  | { ok: false; reason: string }

/** How a watched sign-in ended — carried on `connectors:changed`. */
export type ConnectorSignInOutcome = 'connected' | 'timed-out' | 'cancelled' | 'failed'

/** What `connectors:changed` carries. `signIn` = a watched sign-in ended, and how. */
export interface ConnectorChangeEvent {
  projectRoot?: string
  threadId?: string
  signIn?: { name: string; outcome: ConnectorSignInOutcome }
}

// ── Suggestions ("Suggested for <project>" in Settings → Connectors) ────────

/** Why a connector is suggested, strongest first: the repository host, use in other chats, a name in the files. */
export type ConnectorSuggestionReasonKind = 'repo' | 'used' | 'files'

/** One connector that is not set up yet and this project looks like it uses. */
export interface ConnectorSuggestion {
  name: string
  displayName: string
  reasonKind: ConnectorSuggestionReasonKind
  /** One plain sentence saying why. */
  reason: string
}

/** What `connectors:suggest` answers, strongest first. Dismissed ones are already left out. */
export interface ConnectorSuggestAnswer {
  suggestions: ConnectorSuggestion[]
}

/**
 * The key a "Not now" is kept under: the connector and the kind of reason.
 * A suggestion returns only when a NEW kind of reason appears for it.
 */
export function suggestionFingerprint(suggestion: Pick<ConnectorSuggestion, 'name' | 'reasonKind'>): string {
  return `${suggestion.name}|${suggestion.reasonKind}`
}
