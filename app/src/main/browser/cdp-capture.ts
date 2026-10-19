// Console + network capture for the embedded <webview> browser, over the Chrome
// DevTools Protocol carried on the guest `webContents.debugger`.
//
// The controller (Phase 4) owns the guest; the coordinator wires this in by
// calling `attachCdpCapture(guest, buffer, onBufferUpdated)` once per attached
// guest and calling `.detach()` on tab close / guest destroy. Everything here is
// async — `debugger.sendCommand` returns a promise and nothing blocks main
// (allowed-pattern #19).
//
// GRACEFUL DEGRADATION: `debugger.attach` throws when a debugger is already
// attached — the common case being the user opening real DevTools. We catch it,
// mark capture unavailable, and return an inert handle. The browser still works;
// only the rich capture path is off.
//
// CDP payloads are loosely typed (`params: any` on the message event), so we
// narrow to small local interfaces naming only the fields we read — never a
// sprawling `any` (allowed-pattern #11 territory: validate the shape you consume).

import { randomUUID } from 'node:crypto'
import { formatConsoleArgs } from '../../shared/console-format'

import type { WebContents } from 'electron'

import type {
  BrowserBufferCounts,
  BrowserCaptureKind,
  BrowserConsoleCapture,
  BrowserConsolePayload,
  BrowserNetworkCapture,
  BrowserNetworkPayload,
} from '../../shared/browser-capture-types'
import type { RollingBuffer } from './rolling-buffer'

/** Called after each capture lands so the controller can broadcast the new counts. */
export type BufferUpdatedFn = (kind: BrowserCaptureKind, counts: BrowserBufferCounts) => void

/** The lifecycle handle the coordinator holds for one attached guest. */
export interface CdpCaptureHandle {
  /** Detach the debugger and stop all listeners. Idempotent. */
  detach(): void
  /** Whether capture is currently active (false once degraded/detached). */
  available(): boolean
}

/** The CDP protocol version we speak. */
const CDP_PROTOCOL = '1.3'

/** Bound the in-flight network map so a page that never finishes requests (or a
 *  navigation that abandons them) cannot grow it without limit. */
const MAX_PENDING_NETWORK = 512

// ── CDP event shapes (only the fields we read) ─────────────────────────────

interface RemoteObject {
  type: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

interface StackTrace {
  callFrames: CallFrame[]
}

interface ConsoleApiCalled {
  type: string
  args: RemoteObject[]
  /** CDP Runtime.Timestamp — ms since epoch. */
  timestamp: number
  stackTrace?: StackTrace
}

interface LogEntryAdded {
  entry: {
    level: string
    text: string
    /** ms since epoch. */
    timestamp: number
    url?: string
    lineNumber?: number
    stackTrace?: StackTrace
  }
}

interface RequestWillBeSent {
  requestId: string
  request: {
    url: string
    method: string
    headers: Record<string, string>
    postData?: string
  }
  /** Network.MonotonicTime — seconds, monotonic (for durations). */
  timestamp: number
  /** Epoch seconds (for wall-clock capture time). */
  wallTime?: number
}

interface ResponseReceived {
  requestId: string
  response: {
    url: string
    status: number
    headers: Record<string, string>
    mimeType: string
  }
}

interface LoadingFinished {
  requestId: string
  timestamp: number
}

interface LoadingFailed {
  requestId: string
  timestamp: number
  errorText?: string
}

/** A network request accumulating across its CDP event lifecycle. */
interface PendingRequest {
  payload: BrowserNetworkPayload
  startTs: number // monotonic seconds
  order: number // insertion order, for oldest-first pending eviction
}

// ── console mapping ────────────────────────────────────────────────────────

type ConsoleLevel = BrowserConsolePayload['level']

function mapConsoleApiType(type: string): ConsoleLevel {
  switch (type) {
    case 'debug':
      return 'debug'
    case 'info':
      return 'info'
    case 'warning':
      return 'warn'
    case 'error':
    case 'assert':
      return 'error'
    default:
      // 'log', 'dir', 'table', 'trace', 'group', … all surface as plain logs.
      return 'log'
  }
}

function mapLogEntryLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'verbose':
      return 'debug'
    case 'info':
      return 'info'
    case 'warning':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'log'
  }
}

/** Render one console argument to a display string without touching the DOM. */
function renderArg(arg: RemoteObject): string {
  if (arg.value !== undefined) {
    if (typeof arg.value === 'object') {
      try {
        return JSON.stringify(arg.value)
      } catch {
        return arg.description ?? arg.type
      }
    }
    return String(arg.value)
  }
  return arg.unserializableValue ?? arg.description ?? arg.type
}

function formatStack(stack: StackTrace | undefined): string | undefined {
  if (!stack || stack.callFrames.length === 0) return undefined
  return stack.callFrames
    .map((f) => `at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join('\n')
}

function topFrameAnchor(stack: StackTrace | undefined, fallback: string): string {
  const frame = stack?.callFrames[0]
  if (frame?.url) return `${frame.url}:${frame.lineNumber + 1}`
  return fallback
}

// ── network mapping ────────────────────────────────────────────────────────

/** A short, stable anchor for a network capture — method + the URL's path. */
function networkAnchor(method: string, url: string): string {
  let path = url
  const schemeEnd = url.indexOf('://')
  if (schemeEnd >= 0) {
    const afterScheme = url.slice(schemeEnd + 3)
    const slash = afterScheme.indexOf('/')
    path = slash >= 0 ? afterScheme.slice(slash) : '/'
  }
  return `${method} ${path}`
}

/**
 * Attach CDP capture to a guest webContents, feeding console + network events
 * into `buffer` and notifying `onBufferUpdated` after each. Returns a handle the
 * caller detaches on teardown. Never throws — a failed attach degrades quietly.
 */
export function attachCdpCapture(
  guest: WebContents,
  buffer: RollingBuffer,
  onBufferUpdated: BufferUpdatedFn,
): CdpCaptureHandle {
  const dbg = guest.debugger
  let active = false
  let detached = false
  let pendingOrder = 0
  const pending = new Map<string, PendingRequest>()

  const record = (kind: BrowserCaptureKind, capture: BrowserConsoleCapture | BrowserNetworkCapture): void => {
    buffer.push(capture)
    onBufferUpdated(kind, buffer.counts())
  }

  const handleConsoleApi = (params: ConsoleApiCalled): void => {
    // FORMAT DIRECTIVES APPLIED HERE, where the arguments are still separate.
    // Joined first, `%cWarning%c` and its two CSS strings become message text
    // and there is no way back — stripping what looks like CSS would eat real
    // content. See `console-format.ts`.
    const text = formatConsoleArgs(params.args.map(renderArg))
    const stack = formatStack(params.stackTrace)
    const payload: BrowserConsolePayload = {
      level: mapConsoleApiType(params.type),
      text,
      ts: Number.isFinite(params.timestamp) ? Math.round(params.timestamp) : Date.now(),
    }
    if (stack) payload.stack = stack
    const capture: BrowserConsoleCapture = {
      kind: 'console',
      id: `con-${randomUUID()}`,
      componentPath: topFrameAnchor(params.stackTrace, `console.${payload.level}`),
      redacted: false,
      payload,
    }
    record('console', capture)
  }

  const handleLogEntry = (params: LogEntryAdded): void => {
    const entry = params.entry
    const stack = formatStack(entry.stackTrace)
    const payload: BrowserConsolePayload = {
      level: mapLogEntryLevel(entry.level),
      text: entry.text,
      ts: Number.isFinite(entry.timestamp) ? Math.round(entry.timestamp) : Date.now(),
    }
    if (stack) payload.stack = stack
    const anchor = entry.url ? `${entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ''}` : 'log'
    const capture: BrowserConsoleCapture = {
      kind: 'console',
      id: `log-${randomUUID()}`,
      componentPath: anchor,
      redacted: false,
      payload,
    }
    record('console', capture)
  }

  const handleRequestWillBeSent = (params: RequestWillBeSent): void => {
    const payload: BrowserNetworkPayload = {
      method: params.request.method.toUpperCase(),
      url: params.request.url,
      status: 0,
      timingMs: 0,
      requestHeaders: params.request.headers ?? {},
      responseHeaders: {},
      ts: params.wallTime !== undefined ? Math.round(params.wallTime * 1000) : Date.now(),
    }
    if (params.request.postData !== undefined) payload.requestBody = params.request.postData
    pending.set(params.requestId, { payload, startTs: params.timestamp, order: pendingOrder++ })
    evictOldestPending()
  }

  const handleResponseReceived = (params: ResponseReceived): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    req.payload.status = params.response.status
    req.payload.responseHeaders = params.response.headers ?? {}
  }

  const handleLoadingFinished = (params: LoadingFinished): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    pending.delete(params.requestId)
    req.payload.timingMs = Math.max(0, Math.round((params.timestamp - req.startTs) * 1000))
    // Fetch the response body for this retained entry, then commit. The body is
    // only available until shortly after loadingFinished, so we fetch now.
    void fetchBodyThenCommit(params.requestId, req.payload)
  }

  const handleLoadingFailed = (params: LoadingFailed): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    pending.delete(params.requestId)
    req.payload.timingMs = Math.max(0, Math.round((params.timestamp - req.startTs) * 1000))
    commitNetwork(req.payload)
  }

  const fetchBodyThenCommit = async (requestId: string, payload: BrowserNetworkPayload): Promise<void> => {
    try {
      const body = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as {
        body?: string
        base64Encoded?: boolean
      }
      if (typeof body.body === 'string' && body.body.length > 0) {
        payload.responseBody = body.base64Encoded
          ? Buffer.from(body.body, 'base64').toString('utf8')
          : body.body
      }
    } catch {
      // Body already gone or not retrievable — commit without it. The buffer's
      // body cap still applies to whatever we did capture.
    }
    if (!detached) commitNetwork(payload)
  }

  const commitNetwork = (payload: BrowserNetworkPayload): void => {
    const capture: BrowserNetworkCapture = {
      kind: 'network',
      id: `net-${randomUUID()}`,
      componentPath: networkAnchor(payload.method, payload.url),
      redacted: false,
      payload,
    }
    record('network', capture)
  }

  const evictOldestPending = (): void => {
    if (pending.size <= MAX_PENDING_NETWORK) return
    let oldestKey: string | undefined
    let oldestOrder = Infinity
    for (const [key, value] of pending) {
      if (value.order < oldestOrder) {
        oldestOrder = value.order
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) pending.delete(oldestKey)
  }

  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (detached) return
    switch (method) {
      case 'Runtime.consoleAPICalled':
        handleConsoleApi(params as ConsoleApiCalled)
        break
      case 'Log.entryAdded':
        handleLogEntry(params as LogEntryAdded)
        break
      case 'Network.requestWillBeSent':
        handleRequestWillBeSent(params as RequestWillBeSent)
        break
      case 'Network.responseReceived':
        handleResponseReceived(params as ResponseReceived)
        break
      case 'Network.loadingFinished':
        handleLoadingFinished(params as LoadingFinished)
        break
      case 'Network.loadingFailed':
        handleLoadingFailed(params as LoadingFailed)
        break
      default:
        break
    }
  }

  const onNavigate = (): void => {
    // A main-frame navigation resets the `since-nav` window; drop in-flight
    // requests that belong to the page we just left.
    buffer.markNavigation()
    pending.clear()
  }

  const teardownListeners = (): void => {
    dbg.removeListener('message', onMessage)
    dbg.removeListener('detach', onDbgDetach)
    guest.removeListener('did-navigate', onNavigate)
    guest.removeListener('destroyed', detach)
  }

  const onDbgDetach = (): void => {
    // The debugger was torn down out from under us (window closed, or the user
    // opened DevTools). Stop capturing; do not try to detach again.
    active = false
    detached = true
    teardownListeners()
  }

  const detach = (): void => {
    if (detached) return
    detached = true
    active = false
    teardownListeners()
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch {
      // Already detached — nothing to do.
    }
  }

  // ── attach + enable ────────────────────────────────────────────────────
  try {
    dbg.attach(CDP_PROTOCOL)
  } catch {
    // A debugger is already attached (real DevTools open) or attach is
    // unsupported — degrade gracefully, no capture, no crash.
    return { detach: () => {}, available: () => false }
  }

  active = true
  dbg.on('message', onMessage)
  dbg.on('detach', onDbgDetach)
  guest.on('did-navigate', onNavigate)
  guest.once('destroyed', detach)

  // Enable the domains we consume. If this fails, tear everything back down.
  void (async () => {
    try {
      await dbg.sendCommand('Runtime.enable')
      await dbg.sendCommand('Log.enable')
      await dbg.sendCommand('Network.enable')
    } catch {
      detach()
    }
  })()

  return {
    detach,
    available: () => active,
  }
}
