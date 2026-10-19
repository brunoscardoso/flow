// The always-on, memory-capped ring buffer for embedded-browser captures.
//
// Covers the three responsibilities in rolling-buffer.ts: the per-kind entry
// AND byte caps (oldest-first drop), the per-body byte cap on the way in, and
// the three `TagWindow` selectors — with `since-nav` surviving eviction because
// it keys on a monotonic seq, not an index into a shifting array.

import { RollingBuffer, type RollingBufferLimits } from './rolling-buffer'
import type {
  BrowserConsoleCapture,
  BrowserNetworkCapture,
} from '../../shared/browser-capture-types'

function con(id: string, text = 'log line'): BrowserConsoleCapture {
  return {
    kind: 'console',
    id,
    componentPath: 'console.log',
    redacted: false,
    payload: { level: 'log', text, ts: 0 },
  }
}

function net(id: string, body?: string): BrowserNetworkCapture {
  return {
    kind: 'network',
    id,
    componentPath: 'GET /x',
    redacted: false,
    payload: {
      method: 'GET',
      url: 'http://localhost:3000/x',
      status: 200,
      timingMs: 1,
      requestHeaders: {},
      responseHeaders: {},
      ts: 0,
      ...(body === undefined ? {} : { responseBody: body }),
    },
  }
}

const LOOSE: RollingBufferLimits = {
  maxEntriesPerKind: 1000,
  maxBytesPerKind: 10 * 1024 * 1024,
  maxBodyBytes: 64 * 1024,
}

describe('entry cap', () => {
  it('drops oldest-first once the entry cap is exceeded', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxEntriesPerKind: 3 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) buffer.push(con(id))

    expect(buffer.counts().console).toBe(3)
    expect(buffer.get('a')).toBeNull() // oldest evicted
    expect(buffer.get('b')).toBeNull()
    expect(buffer.get('c')).not.toBeNull()
    expect(buffer.get('e')).not.toBeNull()
    expect(buffer.slice('console', { mode: 'last-n', n: 3 }).map((c) => c.id)).toEqual([
      'c',
      'd',
      'e',
    ])
  })
})

describe('byte cap', () => {
  it('drops oldest-first once the per-kind byte cap is exceeded', () => {
    // ~1 KB of text per entry; a 2.5 KB cap holds roughly two.
    const buffer = new RollingBuffer({ ...LOOSE, maxBytesPerKind: 2500 })
    const text = 'z'.repeat(1000)
    for (const id of ['a', 'b', 'c', 'd']) buffer.push(con(id, text))

    expect(buffer.get('a')).toBeNull() // oldest gone under the byte cap
    expect(buffer.get('d')).not.toBeNull() // newest retained
    expect(buffer.counts().console).toBeLessThanOrEqual(3)
  })

  it('keeps at least one entry even if a single entry exceeds the byte cap', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxBytesPerKind: 10 })
    buffer.push(con('solo', 'x'.repeat(500)))
    expect(buffer.counts().console).toBe(1)
    expect(buffer.get('solo')).not.toBeNull()
  })
})

describe('body-byte cap', () => {
  it('truncates an oversized body on the way in and notes the drop', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxBodyBytes: 10 })
    buffer.push(net('big', 'y'.repeat(50)))

    const stored = buffer.get('big') as BrowserNetworkCapture
    expect(stored.payload.responseBody?.startsWith('y'.repeat(10))).toBe(true)
    expect(stored.payload.responseBody).toContain('truncated')
    expect(stored.payload.responseBody).toContain('bytes]')
  })

  it('leaves a body within the cap untouched', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxBodyBytes: 1000 })
    buffer.push(net('small', 'ok'))
    const stored = buffer.get('small') as BrowserNetworkCapture
    expect(stored.payload.responseBody).toBe('ok')
  })

  it('does not mutate the caller capture when truncating (forbidden-pattern #4)', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxBodyBytes: 5 })
    const capture = net('orig', 'w'.repeat(50))
    const before = JSON.parse(JSON.stringify(capture))
    buffer.push(capture)
    expect(capture).toEqual(before)
  })
})

describe('slice selectors', () => {
  it('last-n returns the most-recent n, oldest-to-newest', () => {
    const buffer = new RollingBuffer(LOOSE)
    for (const id of ['a', 'b', 'c', 'd']) buffer.push(con(id))
    expect(buffer.slice('console', { mode: 'last-n', n: 2 }).map((c) => c.id)).toEqual([
      'c',
      'd',
    ])
  })

  it('last-n clamps n to the available entries', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('a'))
    expect(buffer.slice('console', { mode: 'last-n', n: 99 }).map((c) => c.id)).toEqual(['a'])
    expect(buffer.slice('console', { mode: 'last-n', n: 0 })).toEqual([])
  })

  it('single returns the one entry by id, else empty', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('a'))
    buffer.push(con('b'))
    expect(buffer.slice('console', { mode: 'single', id: 'b' }).map((c) => c.id)).toEqual(['b'])
    expect(buffer.slice('console', { mode: 'single', id: 'missing' })).toEqual([])
  })

  it('since-nav returns only entries after the last markNavigation()', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('pre-1'))
    buffer.push(con('pre-2'))
    buffer.markNavigation()
    buffer.push(con('post-1'))
    buffer.push(con('post-2'))

    expect(buffer.slice('console', { mode: 'since-nav' }).map((c) => c.id)).toEqual([
      'post-1',
      'post-2',
    ])
  })

  it('since-nav before any navigation returns everything', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('a'))
    buffer.push(con('b'))
    expect(buffer.slice('console', { mode: 'since-nav' }).map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('since-nav survives eviction (seq-based, not index-based)', () => {
  it('still returns exactly the post-nav entries after pre-nav ones are evicted', () => {
    const buffer = new RollingBuffer({ ...LOOSE, maxEntriesPerKind: 3 })
    buffer.push(con('pre-1'))
    buffer.push(con('pre-2'))
    buffer.markNavigation()
    // Three more pushes overflow the cap of 3, evicting both pre-nav entries.
    buffer.push(con('post-1'))
    buffer.push(con('post-2'))
    buffer.push(con('post-3'))

    expect(buffer.get('pre-1')).toBeNull()
    expect(buffer.get('pre-2')).toBeNull()
    // An index-based marker would now point into the wrong slot; the seq marker
    // still selects exactly the entries pushed after the navigation.
    expect(buffer.slice('console', { mode: 'since-nav' }).map((c) => c.id)).toEqual([
      'post-1',
      'post-2',
      'post-3',
    ])
  })
})

describe('counts and clear', () => {
  it('counts() carries all three kinds independently', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('c1'))
    buffer.push(con('c2'))
    buffer.push(net('n1'))
    buffer.push({
      kind: 'element',
      id: 'e1',
      componentPath: 'App',
      redacted: false,
      payload: { componentPath: 'App', selector: 'div', domSummary: 'div' },
    })

    expect(buffer.counts()).toEqual({ element: 1, console: 2, network: 1 })
  })

  it('clear() empties every kind', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(con('a'))
    buffer.push(net('b'))
    buffer.clear()
    expect(buffer.counts()).toEqual({ element: 0, console: 0, network: 0 })
    expect(buffer.get('a')).toBeNull()
  })

  it('get() finds an entry across kinds and returns null when absent', () => {
    const buffer = new RollingBuffer(LOOSE)
    buffer.push(net('n'))
    expect(buffer.get('n')?.kind).toBe('network')
    expect(buffer.get('nope')).toBeNull()
  })
})
