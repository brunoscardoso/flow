// The Network panel's extra facts, read out of CDP events.
//
// Pure, so the arithmetic is testable without a debugger — and the arithmetic
// is where this goes wrong: CDP's ResourceTiming mixes a monotonic base in
// SECONDS with offsets in MILLISECONDS from that base, uses -1 for "did not
// happen", and counts TLS inside the connect span. Chrome's own panel undoes
// all three; so does this.

import type {
  BrowserNetworkInitiator,
  BrowserNetworkPayload,
  BrowserNetworkPhases,
  BrowserStackFrame,
} from '../../shared/browser-capture-types'

/** CDP Network.ResourceTiming — only the fields read here. */
export interface CdpResourceTiming {
  /** Monotonic base, seconds. Every other field is ms after it, or -1. */
  requestTime: number
  dnsStart: number
  dnsEnd: number
  connectStart: number
  connectEnd: number
  sslStart: number
  sslEnd: number
  sendStart: number
  sendEnd: number
  receiveHeadersEnd: number
}

interface CdpCallFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

interface CdpStackTrace {
  callFrames: CdpCallFrame[]
  parent?: CdpStackTrace
}

/** CDP Network.Initiator — only the fields read here. */
export interface CdpInitiator {
  type: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stack?: CdpStackTrace
}

/** CDP Network.Response — only the fields read here. */
export interface CdpResponseFacts {
  mimeType?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  fromPrefetchCache?: boolean
  remoteIPAddress?: string
  remotePort?: number
  protocol?: string
  encodedDataLength?: number
  timing?: CdpResourceTiming
}

/** Frames kept from an initiator stack: enough to find the caller, never a
 *  framework's whole call tree. */
export const MAX_INITIATOR_FRAMES = 12

const span = (start: number, end: number): number | undefined =>
  start >= 0 && end >= start ? round(end - start) : undefined

const round = (ms: number): number => Math.round(ms * 10) / 10

/**
 * The request's time split into steps, Chrome's way.
 *
 * `startTs` is when the request was created (monotonic seconds, from
 * requestWillBeSent), `endTs` when its last byte arrived (loadingFinished).
 * Queued runs from creation to the first step the network stack took.
 */
export function phasesFromTiming(
  startTs: number,
  timing: CdpResourceTiming | undefined,
  endTs: number | undefined,
): BrowserNetworkPhases | undefined {
  if (timing === undefined || !Number.isFinite(timing.requestTime)) return undefined
  const phases: BrowserNetworkPhases = {}
  const firstStep = [timing.dnsStart, timing.connectStart, timing.sendStart].find((v) => v >= 0) ?? 0
  const queued = (timing.requestTime - startTs) * 1000 + firstStep
  if (queued > 0) phases.queued = round(queued)
  const dns = span(timing.dnsStart, timing.dnsEnd)
  if (dns !== undefined) phases.dns = dns
  const tls = span(timing.sslStart, timing.sslEnd)
  const connect = span(timing.connectStart, timing.connectEnd)
  // TLS sits INSIDE the connect span; counting both would double it.
  if (connect !== undefined) phases.connect = round(Math.max(0, connect - (tls ?? 0)))
  if (tls !== undefined) phases.tls = tls
  const send = span(timing.sendStart, timing.sendEnd)
  if (send !== undefined) phases.send = send
  const wait = span(timing.sendEnd, timing.receiveHeadersEnd)
  if (wait !== undefined) phases.wait = wait
  if (endTs !== undefined && timing.receiveHeadersEnd >= 0) {
    const download = (endTs - timing.requestTime) * 1000 - timing.receiveHeadersEnd
    if (download >= 0) phases.download = round(download)
  }
  return Object.keys(phases).length === 0 ? undefined : phases
}

/** What sent the request, 1-based, with async boundaries marked. */
export function initiatorFrom(raw: CdpInitiator | undefined): BrowserNetworkInitiator | undefined {
  if (raw === undefined || typeof raw.type !== 'string') return undefined
  const initiator: BrowserNetworkInitiator = { type: raw.type }
  const frames: BrowserStackFrame[] = []
  let stack: CdpStackTrace | undefined = raw.stack
  let afterBoundary = false
  while (stack !== undefined && frames.length < MAX_INITIATOR_FRAMES) {
    for (const frame of stack.callFrames) {
      if (frames.length >= MAX_INITIATOR_FRAMES) break
      frames.push({
        functionName: frame.functionName,
        url: frame.url,
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
        ...(afterBoundary ? { async: true } : {}),
      })
      afterBoundary = false
    }
    stack = stack.parent
    afterBoundary = true
  }
  if (frames.length > 0) initiator.stack = frames
  // The line to name: the parser's own (a <script> tag in the page), else the
  // first frame with a real address.
  const top = frames.find((frame) => frame.url !== '')
  const url = raw.url ?? top?.url
  if (url !== undefined && url !== '') initiator.url = url
  const line = raw.lineNumber !== undefined ? raw.lineNumber + 1 : top?.line
  if (line !== undefined) initiator.line = line
  const column = raw.columnNumber !== undefined ? raw.columnNumber + 1 : top?.column
  if (column !== undefined) initiator.column = column
  return initiator
}

/** Copy what a response said about itself onto the payload. Mutates `payload`
 *  (it is the pending request's own, not shared). */
export function applyResponseFacts(payload: BrowserNetworkPayload, response: CdpResponseFacts): void {
  if (response.mimeType) payload.mimeType = response.mimeType
  if (response.protocol) payload.protocol = response.protocol
  if (response.remoteIPAddress) {
    const host = response.remoteIPAddress.includes(':') ? `[${response.remoteIPAddress}]` : response.remoteIPAddress
    payload.remoteAddress = response.remotePort ? `${host}:${String(response.remotePort)}` : host
  }
  if (response.fromServiceWorker) payload.servedFrom = 'service worker'
  else if (response.fromPrefetchCache) payload.servedFrom = 'prefetch cache'
  else if (response.fromDiskCache) payload.servedFrom = 'disk cache'
}
