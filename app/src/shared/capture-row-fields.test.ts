import {
  consoleSource,
  formatBytes,
  networkRowFields,
  requestName,
  shortType,
} from './capture-row-fields'
import type { BrowserNetworkPayload } from './browser-capture-types'

function net(over: Partial<BrowserNetworkPayload> = {}): BrowserNetworkPayload {
  return {
    method: 'get',
    url: 'https://api.example.com/v2/templates?page=2&sort=name',
    status: 200,
    timingMs: 120,
    requestHeaders: {},
    responseHeaders: { 'Content-Type': 'application/json; charset=utf-8', 'content-length': '2048' },
    responseBody: '{}',
    ts: 1_700_000_000_000,
    ...over,
  }
}

describe('requestName — what a reader identifies a request by', () => {
  it('takes the last path segment, which is what a person says out loud', () => {
    expect(requestName('https://api.example.com/v2/templates?page=2')).toEqual({
      name: 'templates',
      host: 'api.example.com',
    })
  })

  it('falls back to the host for a root request', () => {
    expect(requestName('https://example.com/')).toEqual({ name: 'example.com', host: 'example.com' })
  })

  it('shows a malformed URL rather than nothing', () => {
    // It is still a row somebody has to read.
    expect(requestName('not a url').name).toBe('not a url')
  })
})

describe('shortType — a content type as one word', () => {
  it('drops the charset and the top-level type', () => {
    expect(shortType('application/json; charset=utf-8')).toBe('json')
    expect(shortType('text/html')).toBe('html')
  })

  it('reads a +suffix type as its suffix', () => {
    // `application/vnd.api+json` is json to a reader scanning a column.
    expect(shortType('application/vnd.api+json')).toBe('json')
  })

  it('keeps an image subtype', () => {
    expect(shortType('image/png')).toBe('png')
  })

  it('is empty when nothing was declared, so the column stays blank', () => {
    expect(shortType('')).toBe('')
  })
})

describe('formatBytes', () => {
  it('scales the unit to the number', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('is empty for nothing measured, rather than "0 B"', () => {
    // An unmeasured size and a zero-byte response are different facts.
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(Number.NaN)).toBe('')
  })
})

describe('networkRowFields', () => {
  it('prefers the declared content-length over the body we kept', () => {
    // The body is capped at capture; content-length is what actually crossed.
    expect(networkRowFields(net()).size).toBe('2.0 kB')
  })

  it('falls back to the retained body when nothing was declared', () => {
    expect(networkRowFields(net({ responseHeaders: {}, responseBody: 'x'.repeat(300) })).size).toBe(
      '300 B',
    )
  })

  it('uppercases the method and explains a zero status', () => {
    const fields = networkRowFields(net({ status: 0 }))
    expect(fields.method).toBe('GET')
    expect(fields.status).toBe('—')
  })

  it('keeps the whole URL for the tooltip while the row shows the name', () => {
    const fields = networkRowFields(net())
    expect(fields.name).toBe('templates')
    expect(fields.url).toContain('?page=2')
  })
})

describe('consoleSource — where the entry came from', () => {
  it('reads a path from its tail', () => {
    expect(consoleSource('/Users/x/app/src/form.ts:42')).toBe('form.ts:42')
  })

  it('is empty when the anchor says nothing, so the column stays blank', () => {
    expect(consoleSource('')).toBe('')
    expect(consoleSource('unknown')).toBe('')
    expect(consoleSource(null)).toBe('')
    expect(consoleSource(undefined)).toBe('')
  })

  it('bounds a very long tail rather than letting it eat the row', () => {
    const out = consoleSource(`${'seg'.repeat(30)}.ts:1`)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.startsWith('…')).toBe(true)
  })
})
