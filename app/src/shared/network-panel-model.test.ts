import type { BrowserNetworkCapture, BrowserNetworkPayload } from './browser-capture-types'
import {
  barOf,
  buildRows,
  failureLabel,
  formatSize,
  initiatorLabel,
  isRecorded,
  isSameSite,
  nameOf,
  parseNetworkQuery,
  parseSize,
  passesFilters,
  phaseList,
  sortRows,
  statusLabel,
  summarize,
  timeRange,
  transferSize,
  typeCounts,
  typeOf,
  type NetworkFilters,
} from './network-panel-model'

let n = 0
function req(url: string, extra: Partial<BrowserNetworkPayload> = {}): BrowserNetworkCapture {
  n += 1
  return {
    kind: 'network',
    id: `net-${String(n)}`,
    componentPath: url,
    redacted: false,
    payload: {
      method: 'GET',
      url,
      status: 200,
      timingMs: 50,
      requestHeaders: {},
      responseHeaders: {},
      ts: 1_000 + n * 100,
      ...extra,
    },
  }
}

const NONE: NetworkFilters = { query: '', type: 'all', invert: false, errorsOnly: false, hideOtherSites: false, pageHost: 'localhost:3000' }

describe('types', () => {
  it('uses the browser’s own word, else the MIME type, else the content-type header', () => {
    expect(typeOf(req('http://x/a', { resourceType: 'XHR' }).payload)).toBe('fetch')
    expect(typeOf(req('http://x/a', { resourceType: 'Preflight' }).payload)).toBe('other')
    expect(typeOf(req('http://x/a', { mimeType: 'text/css' }).payload)).toBe('css')
    expect(typeOf(req('http://x/a', { responseHeaders: { 'Content-Type': 'application/json; charset=utf-8' } }).payload)).toBe('fetch')
    expect(typeOf(req('http://x/a').payload)).toBe('other')
  })

  it('counts each type for the chips', () => {
    const counts = typeCounts([req('http://x/a', { resourceType: 'Fetch' }), req('http://x/b', { resourceType: 'Fetch' }), req('http://x/c', { resourceType: 'Script' })])
    expect(counts.fetch).toBe(2)
    expect(counts.js).toBe(1)
    expect(counts.img).toBe(0)
  })
})

describe('status and failure', () => {
  it('says failed, canceled or blocked in words', () => {
    expect(statusLabel(req('http://x', { status: 404 }).payload)).toBe('404')
    expect(statusLabel(req('http://x', { status: 0, failure: 'net::ERR_CONNECTION_REFUSED' }).payload)).toBe('(failed)')
    expect(statusLabel(req('http://x', { status: 0, canceled: true }).payload)).toBe('(canceled)')
    expect(statusLabel(req('http://x', { status: 0, failure: 'blocked: mixed-content' }).payload)).toBe('(blocked)')
  })

  it('turns the browser’s error code into words', () => {
    expect(failureLabel(req('http://x', { failure: 'net::ERR_CONNECTION_REFUSED' }).payload)).toBe('connection refused')
    expect(failureLabel(req('http://x').payload)).toBe('')
  })
})

describe('the filter box', () => {
  it('reads words, key:value filters and negation', () => {
    expect(parseNetworkQuery('orders status:4xx -domain:launchdarkly.com nope:1')).toEqual({
      words: [{ text: 'orders', negate: false }, { text: 'nope:1', negate: false }],
      filters: [
        { key: 'status', value: '4xx', negate: false },
        { key: 'domain', value: 'launchdarkly.com', negate: true },
      ],
    })
  })

  it('reads sizes with k and m', () => {
    expect(parseSize('10k')).toBe(10_000)
    expect(parseSize('1.5m')).toBe(1_500_000)
    expect(parseSize('512')).toBe(512)
    expect(parseSize('lots')).toBeNaN()
  })

  it('matches status ranges, methods, domains, sizes and MIME types', () => {
    const notFound = req('http://localhost:3000/api/status', { status: 404 })
    const post = req('http://localhost:3000/api', { method: 'POST', transferBytes: 20_000, mimeType: 'application/json' })
    const ld = req('https://events.launchdarkly.com/bulk', { method: 'POST' })
    const failed = req('http://localhost:3000/stream', { status: 0, failure: 'net::ERR_CONNECTION_REFUSED' })
    const all = [notFound, post, ld, failed]
    const shown = (query: string): string[] => all.filter((c) => passesFilters(c, { ...NONE, query })).map((c) => c.id)
    expect(shown('status:4xx')).toEqual([notFound.id])
    expect(shown('status:failed')).toEqual([failed.id])
    expect(shown('method:post')).toEqual([post.id, ld.id])
    expect(shown('-domain:launchdarkly.com method:post')).toEqual([post.id])
    expect(shown('domain:*.launchdarkly.com')).toEqual([ld.id])
    expect(shown('larger-than:10k')).toEqual([post.id])
    expect(shown('mime-type:json')).toEqual([post.id])
    expect(shown('STATUS')).toEqual([notFound.id])
  })

  it('inverts the box only; chips and toggles still apply', () => {
    const a = req('http://localhost:3000/a', { resourceType: 'Fetch' })
    const b = req('http://localhost:3000/b', { resourceType: 'Fetch' })
    const css = req('http://localhost:3000/c.css', { resourceType: 'Stylesheet' })
    const kept = [a, b, css].filter((c) => passesFilters(c, { ...NONE, query: '/a', invert: true, type: 'fetch' }))
    expect(kept.map((c) => c.id)).toEqual([b.id])
  })

  it('keeps errors only, and hides other sites', () => {
    const ok = req('http://localhost:3000/a')
    const bad = req('http://localhost:3000/b', { status: 500 })
    const other = req('https://events.launchdarkly.com/x')
    const api = req('http://127.0.0.1:8080/x')
    expect([ok, bad, other].filter((c) => passesFilters(c, { ...NONE, errorsOnly: true })).map((c) => c.id)).toEqual([bad.id])
    expect([ok, other, api].filter((c) => passesFilters(c, { ...NONE, hideOtherSites: true })).map((c) => c.id)).toEqual([ok.id, api.id])
  })
})

describe('same site', () => {
  it('treats local servers and sibling subdomains as the page’s own', () => {
    expect(isSameSite('localhost:3000', '127.0.0.1:6006')).toBe(true)
    expect(isSameSite('app.acme.com', 'api.acme.com')).toBe(true)
    expect(isSameSite('localhost:3000', 'events.launchdarkly.com')).toBe(false)
    expect(isSameSite('', 'anything.com')).toBe(true)
  })
})

describe('rows', () => {
  it('groups identical requests into one row showing the newest, with a count', () => {
    const first = req('http://localhost:3000/api/unread')
    const other = req('http://localhost:3000/api/desks')
    const second = req('http://localhost:3000/api/unread')
    const rows = buildRows([first, other, second], NONE, { group: true, sort: null })
    expect(rows.map((row) => [row.capture.id, row.count])).toEqual([
      [second.id, 2],
      [other.id, 1],
    ])
    expect(rows[0]?.ids).toEqual([first.id, second.id])
  })

  it('does not group requests that answered differently', () => {
    const ok = req('http://localhost:3000/api/status')
    const missing = req('http://localhost:3000/api/status', { status: 404 })
    expect(buildRows([ok, missing], NONE, { group: true, sort: null })).toHaveLength(2)
  })

  it('lists every request when grouping is off', () => {
    const a = req('http://localhost:3000/api/unread')
    const b = req('http://localhost:3000/api/unread')
    expect(buildRows([a, b], NONE, { group: false, sort: null })).toHaveLength(2)
  })

  it('sorts by a column both ways, ties in the order requests were made', () => {
    const slow = req('http://x/slow', { timingMs: 900 })
    const fast = req('http://x/fast', { timingMs: 10 })
    const tie = req('http://x/tie', { timingMs: 10 })
    const rows = buildRows([slow, fast, tie], NONE, { group: false, sort: null })
    expect(sortRows(rows, 'time', 1).map((row) => row.capture.id)).toEqual([fast.id, tie.id, slow.id])
    expect(sortRows(rows, 'time', -1).map((row) => row.capture.id)).toEqual([slow.id, fast.id, tie.id])
    expect(sortRows(rows, 'name', 1).map((row) => row.capture.id)).toEqual([fast.id, slow.id, tie.id])
  })
})

describe('names, sizes, initiator', () => {
  it('names a request by its last segment and query, else its host', () => {
    expect(nameOf('http://localhost:3000/api/threads/abc?x=1')).toBe('abc?x=1')
    expect(nameOf('https://example.com/')).toBe('example.com')
  })

  it('measures transfer from the browser, else content-length, else the body', () => {
    expect(transferSize(req('http://x', { transferBytes: 1234 }).payload)).toBe(1234)
    expect(transferSize(req('http://x', { responseHeaders: { 'Content-Length': '99' } }).payload)).toBe(99)
    expect(transferSize(req('http://x', { responseBody: 'abc' }).payload)).toBe(3)
    expect(formatSize(1840)).toBe('1.8 kB')
    expect(formatSize(0)).toBe('0 B')
  })

  it('labels the initiator by file and line', () => {
    expect(initiatorLabel(req('http://x', { initiator: { type: 'script', url: 'http://localhost:3000/_next/static/chunks/app.js?v=2', line: 42 } }).payload)).toBe('app.js:42')
    expect(initiatorLabel(req('http://x', { initiator: { type: 'parser' } }).payload)).toBe('page')
    expect(initiatorLabel(req('http://x').payload)).toBe('')
  })
})

describe('summary and timeline', () => {
  it('adds up what is shown against the total, with page milestones from the first request', () => {
    const a = req('http://localhost:3000/a', { transferBytes: 1000, resourceBytes: 3000 })
    const b = req('http://localhost:3000/b', { status: 500, transferBytes: 500 })
    const c = req('http://localhost:3000/c.css', { resourceType: 'Stylesheet', transferBytes: 9000 })
    const rows = buildRows([a, b, c], { ...NONE, type: 'all', query: '-c.css' }, { group: false, sort: null })
    const range = timeRange([a, b, c])
    const summary = summarize(rows, [a, b, c], { domContentLoaded: (range?.start ?? 0) + 250, load: null })
    expect(summary).toMatchObject({ shown: 2, total: 3, transferred: 1500, resources: 3500, failed: 1, domContentLoaded: 250, load: null })
    expect(summary.finish).toBe((c.payload.ts + 50) - a.payload.ts)
  })

  it('places a bar as fractions of the range', () => {
    const range = { start: 0, end: 1000 }
    expect(barOf({ ...req('http://x').payload, ts: 250, timingMs: 500 }, range)).toEqual({ left: 0.25, width: 0.5 })
    expect(barOf({ ...req('http://x').payload, ts: 900, timingMs: 500 }, range).width).toBeCloseTo(0.1)
  })

  it('lists the steps that happened, in order', () => {
    const steps = phaseList(req('http://x', { phases: { wait: 40, queued: 2, download: 5 } }).payload)
    expect(steps.map((step) => step.label)).toEqual(['Queued', 'Waiting for server', 'Downloading'])
  })
})

describe('recording', () => {
  it('hides what came before Clear and during a pause', () => {
    const pauses = [{ from: 200, to: 300 }, { from: 500, to: null }]
    expect(isRecorded(100, null, pauses)).toBe(true)
    expect(isRecorded(250, null, pauses)).toBe(false)
    expect(isRecorded(400, null, pauses)).toBe(true)
    expect(isRecorded(600, null, pauses)).toBe(false)
    expect(isRecorded(400, 450, [])).toBe(false)
  })
})
