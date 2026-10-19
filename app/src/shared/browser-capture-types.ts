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
