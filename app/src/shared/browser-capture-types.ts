/**
 * Embedded-browser capture types — the shapes the `<webview>` browser tab
 * tags into the chat composer (element → React source, console logs, network
 * requests). Shared across the main ↔ renderer boundary via `ipc-contract.ts`.
 *
 * DOM-FREE BY CONTRACT. This module is compiled by BOTH tsconfig.node.json
 * (`types: ["node"]`, no DOM lib) AND tsconfig.web.json. It must therefore name
 * no DOM type — no `Element`, `Response`, `Headers`, `HeadersInit`. Everything
 * is a plain structural type (string, number, Record<string, string>, string[])
 * so both compilers accept it unchanged.
 */
import type { DraftElementFacts } from './draft-pick'

/** The three things a person can tag out of the embedded browser. */
export type BrowserCaptureKind = 'element' | 'console' | 'network'

/** A tagged DOM element, resolved back to its React source when a source map
 *  is available. `selector`/`domSummary` are the fallback identity when it is
 *  not (see `capabilities.sourceMapping`). */
export interface BrowserElementPayload {
  /** Component display path (e.g. `App > Sidebar > NavItem`) — the chip label. */
  componentPath: string
  /** Resolved source file for the element, when source mapping succeeded. */
  sourceFile?: string
  /** 1-based line within `sourceFile`, when known. */
  sourceLine?: number
  /** A CSS selector that locates the element in the live DOM. */
  selector: string
  /** A short human summary of the element (tag, key attrs, trimmed text). */
  domSummary: string
  /** Serialized React props, stringified per value to stay DOM-free. */
  props?: Record<string, string>
  /**
   * Present only for an element of a UI draft screen (it or an ancestor carries
   * a stamped `data-flow-id`): the id and screen the agent and in-place edits
   * address it by, never the selector. Ordinary pages never carry it.
   */
  draft?: BrowserDraftElement
}

/** A draft element: what the pick read, plus where it lives (filled by the host). */
export interface BrowserDraftElement extends DraftElementFacts {
  /** The screen's slug (its file is `<screen>.html`). */
  screen: string
  /** The canvas's slug — filled by the host from the page address. */
  canvas?: string
  /** The screen's title from the layout — filled by the host. */
  screenTitle?: string
  /** The screen file, relative to the project — filled by the host. */
  file?: string
}

/** A captured console entry. */
export interface BrowserConsolePayload {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  /** The formatted message text. */
  text: string
  /** Stack trace when the entry carried one (typically `error`). */
  stack?: string
  /** Capture time, epoch milliseconds. */
  ts: number
}

/** A captured network request/response pair. */
export interface BrowserNetworkPayload {
  /** HTTP method, uppercased (GET, POST, …). */
  method: string
  url: string
  /** HTTP status code (0 when the request never completed). */
  status: number
  /** Wall-clock duration in milliseconds. */
  timingMs: number
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  /** Request body, when present and not withheld/redacted. */
  requestBody?: string
  /** Response body, when present and not withheld/redacted. */
  responseBody?: string
  /** Capture time, epoch milliseconds. */
  ts: number
  // ── Everything below came with the Network panel (2026-11-20). All optional:
  //    captures recorded before it, and requests that never got a response,
  //    simply lack them, and every reader treats absent as "not known".
  /** What the browser loaded it as: Document, Script, Fetch, XHR, Image… */
  resourceType?: string
  /** The response's MIME type, as the browser read it. */
  mimeType?: string
  /** Bytes that crossed the network, headers included (0 from a cache). */
  transferBytes?: number
  /** Bytes of the response body once decoded. */
  resourceBytes?: number
  /** Where the response came from when it was not the network. */
  servedFrom?: 'disk cache' | 'memory cache' | 'service worker' | 'prefetch cache'
  /** Why the request failed, as the browser said it (net::ERR_…). */
  failure?: string
  /** The page or the browser cancelled the request. */
  canceled?: boolean
  /** How long each step took, in milliseconds. */
  phases?: BrowserNetworkPhases
  /** What sent the request. */
  initiator?: BrowserNetworkInitiator
  /** The server's address, `ip:port`. */
  remoteAddress?: string
  /** http/1.1, h2, h3… */
  protocol?: string
  /** For a hop that redirected: where it went next. */
  redirectedTo?: string
}

/** A request's time, split the way the browser measured it. Each is ms; a step
 *  that did not happen (a reused connection has no DNS) is absent. */
export interface BrowserNetworkPhases {
  queued?: number
  dns?: number
  connect?: number
  tls?: number
  send?: number
  wait?: number
  download?: number
}

/** One frame of the script that sent a request. `line` and `column` are 1-based. */
export interface BrowserStackFrame {
  functionName: string
  url: string
  line: number
  column: number
  /** True on the first frame after an async boundary (shown as "(async)"). */
  async?: boolean
}

/** What started a request: the parser (a tag in the page), a script, a
 *  preflight, or something else. */
export interface BrowserNetworkInitiator {
  type: string
  url?: string
  line?: number
  column?: number
  stack?: BrowserStackFrame[]
}

/** When the page on screen reached its milestones, epoch ms (null = not yet). */
export interface BrowserPageTimings {
  domContentLoaded: number | null
  load: number | null
  /** Requests from the start of this page load that capture did not see —
   *  sent before it was listening in the page's process. A reload sees them. */
  missedRequests?: number
}

/** Fields every capture carries, whatever its kind. */
interface BrowserCaptureBase {
  /** Stable identity for this capture — the dedupe key and the chip key. */
  id: string
  /** Stable source anchor the chip resolves to (a component/source path). */
  componentPath: string
  /** True when sensitive values (headers/bodies) were redacted before the
   *  payload crossed IPC (allowed-pattern #18 — bound at the boundary). */
  redacted: boolean
  /** True when a large payload was withheld at the boundary and must be
   *  fetched on demand — never render "withheld" as "empty". */
  withheld?: boolean
  /** True on a list read that left the bodies behind on purpose: the bodies
   *  exist and are read one request at a time. Not the same as `withheld`. */
  bodiesOmitted?: boolean
}

export interface BrowserElementCapture extends BrowserCaptureBase {
  kind: 'element'
  payload: BrowserElementPayload
}

export interface BrowserConsoleCapture extends BrowserCaptureBase {
  kind: 'console'
  payload: BrowserConsolePayload
}

export interface BrowserNetworkCapture extends BrowserCaptureBase {
  kind: 'network'
  payload: BrowserNetworkPayload
}

/** A tagged capture the renderer turns into a composer chip. */
export type BrowserCapture =
  | BrowserElementCapture
  | BrowserConsoleCapture
  | BrowserNetworkCapture

/**
 * Which slice of a capture buffer to tag or read.
 *
 * - `last-n` — the most-recent `n` entries of a kind.
 * - `since-nav` — everything captured since the last navigation.
 * - `single` — one entry by its stable `id`.
 */
export type TagWindow =
  | { mode: 'last-n'; n: number }
  | { mode: 'since-nav' }
  | { mode: 'single'; id: string }

/** Per-kind buffer sizes, carried on `browser:bufferUpdated` so a badge can
 *  render all three counts from one event. */
export type BrowserBufferCounts = Record<BrowserCaptureKind, number>

/** What the browser can do in the current page — probed once per navigation.
 *  `sourceMapping` gates element→React-source resolution; `cdp` gates the
 *  richer console/network capture path. */
export interface BrowserCapabilities {
  sourceMapping: boolean
  cdp: boolean
}
