import { writeHar } from './har-write'
import { readHar } from './har-summary'
import type { BrowserNetworkPayload } from './browser-capture-types'

const T0 = 1_700_000_000_000

function net(over: Partial<BrowserNetworkPayload> = {}): BrowserNetworkPayload {
  return {
    method: 'GET',
    url: 'https://api.example.com/orders',
    status: 200,
    timingMs: 42,
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    ts: T0,
    ...over,
  }
}

const provenance = { startedAt: T0, endedAt: T0 + 5000, evicted: false, bodyCapBytes: 65536 }

describe('writeHar — a file devtools can open', () => {
  it('round-trips through the summariser this repo already has', () => {
    // WHAT THIS WRITES, THAT MUST READ. Two halves of one format in one repo
    // that never met would drift on the first edit.
    const text = writeHar([net(), net({ url: 'https://api.example.com/users', status: 500 })], provenance)
    const read = readHar(text)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.entries).toBe(2)
    expect(read.hosts.map((h) => h.host)).toContain('api.example.com')
  })

  it('orders entries by when they happened', () => {
    const text = writeHar(
      [net({ ts: T0 + 500, url: 'https://x/late' }), net({ ts: T0, url: 'https://x/early' })],
      provenance,
    )
    const log = JSON.parse(text).log
    expect(log.entries.map((e: { request: { url: string } }) => e.request.url)).toEqual([
      'https://x/early',
      'https://x/late',
    ])
  })

  it('states what it is NOT, where every viewer shows it', () => {
    // Devtools presents a HAR as fact. Everything this file cannot contain is
    // written into `creator.comment`, which no viewer hides.
    const log = JSON.parse(writeHar([net()], provenance)).log
    expect(log.creator.comment).toContain('RETAINED')
    expect(log.creator.comment).toContain('before capture attached')
    expect(log.creator.comment).toContain('Secrets')
    expect(log.creator.comment).toContain('truncated')
  })

  it('says so when the buffer dropped part of the window', () => {
    const log = JSON.parse(writeHar([net()], { ...provenance, evicted: true })).log
    expect(log.creator.comment).toContain('the beginning is incomplete')
    // …and stays quiet when it did not, rather than reassuring on every file.
    const clean = JSON.parse(writeHar([net()], provenance)).log
    expect(clean.creator.comment).not.toContain('incomplete')
  })

  it('explains a zero status instead of leaving a reader to guess', () => {
    // A connection refused has no better HAR representation than status 0, and
    // a reader seeing "0" assumes the FILE is broken rather than the request.
    const log = JSON.parse(writeHar([net({ status: 0, responseBody: undefined })], provenance)).log
    expect(log.entries[0].comment).toContain('never completed')
  })

  it('marks a body the capture did not keep, rather than showing it as empty', () => {
    // Withheld is not empty (allowed-pattern #18).
    const log = JSON.parse(writeHar([net({ responseBody: undefined })], provenance)).log
    expect(log.entries[0].comment).toContain('not retained')
    expect(log.entries[0].response.content.text).toBeUndefined()
  })

  it('reports unknown sizes as -1, which is HAR’s own "not known"', () => {
    // A plausible number would be a lie a reader could do arithmetic with.
    const log = JSON.parse(writeHar([net()], provenance)).log
    expect(log.entries[0].request.headersSize).toBe(-1)
    expect(log.entries[0].response.headersSize).toBe(-1)
  })

  it('writes a valid, empty log when the session caught no traffic', () => {
    const read = readHar(writeHar([], provenance))
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.entries).toBe(0)
  })
})
