import type { BrowserNetworkPayload } from '../../shared/browser-capture-types'
import { MAX_INITIATOR_FRAMES, applyResponseFacts, initiatorFrom, phasesFromTiming, type CdpResourceTiming } from './network-timing'

const timing = (over: Partial<CdpResourceTiming> = {}): CdpResourceTiming => ({
  requestTime: 10.0,
  dnsStart: -1,
  dnsEnd: -1,
  connectStart: -1,
  connectEnd: -1,
  sslStart: -1,
  sslEnd: -1,
  sendStart: 1,
  sendEnd: 1.5,
  receiveHeadersEnd: 41.5,
  ...over,
})

describe('phasesFromTiming', () => {
  it('splits a fresh HTTPS request, with TLS taken out of the connect span', () => {
    const phases = phasesFromTiming(
      9.998,
      timing({ dnsStart: 0, dnsEnd: 10, connectStart: 10, connectEnd: 50, sslStart: 25, sslEnd: 50, sendStart: 50, sendEnd: 51, receiveHeadersEnd: 151 }),
      10.161,
    )
    expect(phases).toEqual({ queued: 2, dns: 10, connect: 15, tls: 25, send: 1, wait: 100, download: 10 })
  })

  it('leaves out the steps a reused connection skipped', () => {
    const phases = phasesFromTiming(10, timing(), 10.05)
    expect(phases).toEqual({ queued: 1, send: 0.5, wait: 40, download: 8.5 })
    expect(phases).not.toHaveProperty('dns')
  })

  it('gives nothing when the browser reported no timing', () => {
    expect(phasesFromTiming(10, undefined, 11)).toBeUndefined()
  })
})

describe('initiatorFrom', () => {
  it('keeps the stack 1-based and marks where async code resumed', () => {
    const initiator = initiatorFrom({
      type: 'script',
      stack: {
        callFrames: [{ functionName: 'fetchJson', url: 'http://localhost:3000/api.js', lineNumber: 41, columnNumber: 4 }],
        parent: { callFrames: [{ functionName: 'load', url: 'http://localhost:3000/page.js', lineNumber: 9, columnNumber: 0 }] },
      },
    })
    expect(initiator).toEqual({
      type: 'script',
      url: 'http://localhost:3000/api.js',
      line: 42,
      column: 5,
      stack: [
        { functionName: 'fetchJson', url: 'http://localhost:3000/api.js', line: 42, column: 5 },
        { functionName: 'load', url: 'http://localhost:3000/page.js', line: 10, column: 1, async: true },
      ],
    })
  })

  it('names the parser’s own line for a tag in the page, and bounds the stack', () => {
    expect(initiatorFrom({ type: 'parser', url: 'http://localhost:3000/', lineNumber: 11 })).toEqual({ type: 'parser', url: 'http://localhost:3000/', line: 12 })
    const frames = Array.from({ length: 40 }, (_, i) => ({ functionName: `f${String(i)}`, url: 'u', lineNumber: i, columnNumber: 0 }))
    expect(initiatorFrom({ type: 'script', stack: { callFrames: frames } })?.stack).toHaveLength(MAX_INITIATOR_FRAMES)
    expect(initiatorFrom(undefined)).toBeUndefined()
  })
})

describe('applyResponseFacts', () => {
  it('copies the MIME type, protocol, address and where it was served from', () => {
    const payload = { method: 'GET', url: 'u', status: 200, timingMs: 0, requestHeaders: {}, responseHeaders: {}, ts: 0 } as BrowserNetworkPayload
    applyResponseFacts(payload, { mimeType: 'text/css', protocol: 'h2', remoteIPAddress: '::1', remotePort: 3000, fromDiskCache: true })
    expect(payload).toMatchObject({ mimeType: 'text/css', protocol: 'h2', remoteAddress: '[::1]:3000', servedFrom: 'disk cache' })
  })
})
