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
  BrowserPageTimings,
} from '../../shared/browser-capture-types'
import type { RollingBuffer } from './rolling-buffer'
import {
  applyResponseFacts,
  initiatorFrom,
  phasesFromTiming,
  type CdpInitiator,
  type CdpResourceTiming,
  type CdpResponseFacts,
} from './network-timing'

/** Called after each capture lands so the controller can broadcast the new counts. */
export type BufferUpdatedFn = (kind: BrowserCaptureKind, counts: BrowserBufferCounts) => void

/** The lifecycle handle the coordinator holds for one attached guest. */
export interface CdpCaptureHandle {
  /** Detach the debugger and stop all listeners. Idempotent. */
  detach(): void
  /** Whether capture is currently active (false once degraded/detached). */
  available(): boolean
  /** When the page reached DOMContentLoaded and load, epoch ms. */
  pageTimings(): BrowserPageTimings
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
  /** The frame that made the request — the main frame's marks a new page. */
  frameId?: string
  /** Document, Script, Fetch, XHR, Image, Preflight… */
  type?: string
  initiator?: CdpInitiator
  /** Present when this event continues a redirect: the hop that redirected. */
  redirectResponse?: CdpResponseFacts & { url: string; status: number; headers: Record<string, string> }
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
  type?: string
  response: CdpResponseFacts & {
    url: string
    status: number
    headers: Record<string, string>
    mimeType: string
  }
}

interface LoadingFinished {
  requestId: string
  timestamp: number
  /** Bytes over the network, headers included. */
  encodedDataLength?: number
}

interface LoadingFailed {
  requestId: string
  timestamp: number
  errorText?: string
  canceled?: boolean
  blockedReason?: string
}

interface DataReceived {
  requestId: string
  dataLength: number
}

interface PageLifecycle {
  /** Monotonic seconds. */
  timestamp: number
}

/** A network request accumulating across its CDP event lifecycle. */
interface PendingRequest {
  payload: BrowserNetworkPayload
  startTs: number // monotonic seconds
  order: number // insertion order, for oldest-first pending eviction
  timing?: CdpResourceTiming
  /** Decoded body bytes, summed from dataReceived. */
  decoded: number
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
  /** Wall-clock seconds minus monotonic seconds, from the newest request. */
  let wallOffset: number | null = null
  const timings: BrowserPageTimings = { domContentLoaded: null, load: null }
  /**
   * THE START OF A PAGE CAN GO UNRECORDED. A new page's own process sends its
   * first stylesheets and scripts before network capture is listening there
   * (measured: capture answers ~100 ms after the navigation starts, and holding
   * the navigation only deadlocks, since capture waits for that very process).
   * The browser still reports those requests' extra-info events, by id, with
   * no request to match — so they are counted here, until the page's own
   * requests start arriving, and the panel offers a reload.
   */
  const missedIds = new Set<string>()
  const seenIds = new Set<string>()
  let listening = false
  /** Bumped at every new page, so a late body knows which page it belongs to. */
  let page = 0
  /** The page's top frame, from CDP — null until CDP has said. */
  let mainFrameId: string | null = null

  const record = (kind: BrowserCaptureKind, capture: BrowserConsoleCapture | BrowserNetworkCapture, beforeNavigation = false): void => {
    buffer.push(capture, { beforeNavigation })
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
    if (params.wallTime !== undefined) wallOffset = params.wallTime - params.timestamp
    // A NEW PAGE STARTS AT ITS DOCUMENT REQUEST. Marking it on the guest's
    // 'did-navigate' was late: main hears that event after the new page's
    // first scripts have already sent requests, so those landed before the
    // mark, and the in-flight ones were dropped as the old page's.
    if (params.type === 'Document' && params.redirectResponse === undefined && params.frameId !== undefined) {
      // The first document a fresh tab loads is its main frame's — an iframe
      // cannot load before its parent — so that names the main frame before
      // Page.getFrameTree has answered.
      if (mainFrameId === null) mainFrameId = params.frameId
      if (params.frameId === mainFrameId) startPage()
    }
    // A redirect reuses the request id: the hop that redirected is finished,
    // and is a row of its own, as it is in Chrome.
    const previous = pending.get(params.requestId)
    if (previous !== undefined && params.redirectResponse !== undefined) {
      pending.delete(params.requestId)
      const hop = previous.payload
      hop.status = params.redirectResponse.status
      hop.responseHeaders = params.redirectResponse.headers ?? {}
      applyResponseFacts(hop, params.redirectResponse)
      hop.redirectedTo = params.request.url
      if (params.redirectResponse.encodedDataLength !== undefined) hop.transferBytes = params.redirectResponse.encodedDataLength
      hop.timingMs = Math.max(0, Math.round((params.timestamp - previous.startTs) * 1000))
      const phases = phasesFromTiming(previous.startTs, params.redirectResponse.timing, params.timestamp)
      if (phases !== undefined) hop.phases = phases
      commitNetwork(hop)
    }
    const payload: BrowserNetworkPayload = {
      method: params.request.method.toUpperCase(),
      url: params.request.url,
      status: 0,
      timingMs: 0,
      requestHeaders: params.request.headers ?? {},
      responseHeaders: {},
      ts: params.wallTime !== undefined ? Math.round(params.wallTime * 1000) : Date.now(),
    }
    seenIds.add(params.requestId)
    missedIds.delete(params.requestId)
    // The page's own process is reporting now: what it sends from here on is seen.
    if (params.type !== undefined && params.type !== 'Document') listening = true
    if (params.request.postData !== undefined) payload.requestBody = params.request.postData
    if (params.type !== undefined) payload.resourceType = params.type
    const initiator = initiatorFrom(params.initiator)
    if (initiator !== undefined) payload.initiator = initiator
    pending.set(params.requestId, { payload, startTs: params.timestamp, order: pendingOrder++, decoded: 0 })
    evictOldestPending()
  }

  const handleResponseReceived = (params: ResponseReceived): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    req.payload.status = params.response.status
    req.payload.responseHeaders = params.response.headers ?? {}
    if (params.type !== undefined) req.payload.resourceType = params.type
    applyResponseFacts(req.payload, params.response)
    if (params.response.timing !== undefined) req.timing = params.response.timing
  }

  const handleDataReceived = (params: DataReceived): void => {
    const req = pending.get(params.requestId)
    if (req !== undefined && Number.isFinite(params.dataLength)) req.decoded += params.dataLength
  }

  const handleServedFromCache = (params: { requestId: string }): void => {
    const req = pending.get(params.requestId)
    if (req !== undefined) req.payload.servedFrom = 'memory cache'
  }

  const toWall = (monotonic: number): number =>
    wallOffset === null ? Date.now() : Math.round((monotonic + wallOffset) * 1000)

  const handleLoadingFinished = (params: LoadingFinished): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    pending.delete(params.requestId)
    req.payload.timingMs = Math.max(0, Math.round((params.timestamp - req.startTs) * 1000))
    if (params.encodedDataLength !== undefined) req.payload.transferBytes = Math.max(0, Math.round(params.encodedDataLength))
    if (req.decoded > 0) req.payload.resourceBytes = req.decoded
    const phases = phasesFromTiming(req.startTs, req.timing, params.timestamp)
    if (phases !== undefined) req.payload.phases = phases
    // Fetch the response body for this retained entry, then commit. The body is
    // only available until shortly after loadingFinished, so we fetch now.
    void fetchBodyThenCommit(params.requestId, req.payload, page)
  }

  const handleLoadingFailed = (params: LoadingFailed): void => {
    const req = pending.get(params.requestId)
    if (!req) return
    pending.delete(params.requestId)
    req.payload.timingMs = Math.max(0, Math.round((params.timestamp - req.startTs) * 1000))
    // A response that arrived and was then cut off keeps its status; only a
    // request that never got one reads as failed.
    if (params.blockedReason) req.payload.failure = `blocked: ${params.blockedReason}`
    else if (params.errorText) req.payload.failure = params.errorText
    if (params.canceled) req.payload.canceled = true
    if (req.decoded > 0) req.payload.resourceBytes = req.decoded
    commitNetwork(req.payload)
  }

  const fetchBodyThenCommit = async (requestId: string, payload: BrowserNetworkPayload, finishedOn: number): Promise<void> => {
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
    // A new page may have started while the body was read: this request still
    // belongs to the page it finished on.
    if (!detached) commitNetwork(payload, finishedOn !== page)
  }

  const commitNetwork = (payload: BrowserNetworkPayload, beforeNavigation = false): void => {
    const capture: BrowserNetworkCapture = {
      kind: 'network',
      id: `net-${randomUUID()}`,
      componentPath: networkAnchor(payload.method, payload.url),
      redacted: false,
      payload,
    }
    record('network', capture, beforeNavigation)
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
      case 'Network.requestWillBeSentExtraInfo': {
        const id = (params as { requestId?: string }).requestId
        if (id !== undefined && !listening && !seenIds.has(id) && missedIds.size < 500) missedIds.add(id)
        break
      }
      case 'Network.dataReceived':
        handleDataReceived(params as DataReceived)
        break
      case 'Network.requestServedFromCache':
        handleServedFromCache(params as { requestId: string })
        break
      case 'Page.domContentEventFired':
        timings.domContentLoaded = toWall((params as PageLifecycle).timestamp)
        break
      case 'Page.loadEventFired':
        timings.load = toWall((params as PageLifecycle).timestamp)
        break
      case 'Page.frameNavigated': {
        const frame = (params as { frame?: { id?: string; parentId?: string } }).frame
        if (frame?.id !== undefined && frame.parentId === undefined) mainFrameId = frame.id
        break
      }
      default:
        break
    }
  }

  /** A main-frame navigation resets the `since-nav` window and drops the
   *  requests the page we just left still had in flight. */
  const startPage = (): void => {
    page += 1
    missedIds.clear()
    seenIds.clear()
    listening = false
    buffer.markNavigation()
    pending.clear()
    timings.domContentLoaded = null
    timings.load = null
  }

  const onNavigate = (): void => {
    // Only when CDP could not name the main frame: the document request above
    // is the exact moment, and this event comes after it (see there).
    if (mainFrameId === null) startPage()
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
    return { detach: () => {}, available: () => false, pageTimings: () => ({ domContentLoaded: null, load: null }) }
  }

  active = true
  dbg.on('message', onMessage)
  dbg.on('detach', onDbgDetach)
  guest.on('did-navigate', onNavigate)
  guest.once('destroyed', detach)

  // Enable the domains we consume. If this fails, tear everything back down.
  //
  // NETWORK FIRST, AND NOT IN LINE. The three used to be awaited one after
  // another, Runtime first — and Runtime and Log wait on the page's renderer
  // process, which is still starting. A fast local page had finished its
  // document, its stylesheet and its first fetches before Network was on, so
  // the first load of every tab was missing its most important requests.
  // Network is handled in the browser process and answers at once.
  const network = dbg.sendCommand('Network.enable')
  // For DOMContentLoaded and load, and the main frame's id. Optional: a page
  // without them still captures.
  const pageDomain = dbg
    .sendCommand('Page.enable')
    .then(() => dbg.sendCommand('Page.getFrameTree'))
    .then((tree) => {
      const id = (tree as { frameTree?: { frame?: { id?: string } } } | null)?.frameTree?.frame?.id
      if (typeof id === 'string' && mainFrameId === null) mainFrameId = id
    })
    .catch(() => undefined)
  void Promise.all([network, dbg.sendCommand('Runtime.enable'), dbg.sendCommand('Log.enable'), pageDomain]).catch(() => detach())

  return {
    detach,
    available: () => active,
    pageTimings: () => ({ ...timings, missedRequests: missedIds.size }),
  }
}
