import { harSummaryText, hostOf, readHar } from './har-summary'

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  startedDateTime: '2026-09-09T10:00:00.000Z',
  time: 100,
  request: { method: 'GET', url: 'https://api.example.com/thing' },
  response: { status: 200, _transferSize: 2048 },
  ...over,
})

const har = (entries: Array<Record<string, unknown>>): string =>
  JSON.stringify({ log: { version: '1.2', entries } })

const ok = (text: string) => {
  const result = readHar(text)
  if (!result.ok) throw new Error(`expected a HAR, got: ${result.reason}`)
  return result
}

describe('readHar — refusing is better than half-reading', () => {
  it('says what is wrong instead of throwing into a send', () => {
    expect(readHar('not json')).toEqual({
      ok: false,
      reason: 'this file is not JSON, so it is not a HAR recording',
    })
    expect(readHar('{"hello":1}').ok).toBe(false)
    expect(readHar('{"log":{}}').ok).toBe(false)
    expect(readHar('{"log":{"entries":"nope"}}').ok).toBe(false)
  })

  it('reads an empty recording as empty, not as broken', () => {
    expect(ok(har([])).entries).toBe(0)
  })

  it('survives one odd record without losing the other four hundred', () => {
    // A recording with a malformed entry still answers every question about
    // the rest; refusing the file over one row would be the wrong trade.
    const result = ok(har([entry(), {}, entry({ request: null }), entry()]))
    expect(result.entries).toBe(4)
    // Two, not three: the entry with no request has no url, so it has no host
    // to count — it is still one of the four requests.
    expect(result.hosts[0]).toEqual({ host: 'api.example.com', count: 2 })
  })
})

describe('what a person opens a HAR to ask', () => {
  it('counts a transport error as a failure — status 0 is not "fine"', () => {
    // The failure someone is usually hunting has no status code at all.
    const result = ok(
      har([
        entry({ response: { status: 0, _error: 'net::ERR_FAILED' } }),
        entry({ response: { status: 500 } }),
        entry({ response: { status: 404 } }),
        entry(),
      ]),
    )
    expect(result.failures.map((f) => f.status)).toEqual([0, 500, 404])
  })

  it('ranks the slow ones slowest first, and ignores the quick ones', () => {
    const result = ok(
      har([entry({ time: 100 }), entry({ time: 9000 }), entry({ time: 2500 })]),
    )
    expect(result.slow.map((s) => s.ms)).toEqual([9000, 2500])
  })

  it('never reports a negative size — a cached response has bodySize -1', () => {
    const result = ok(har([entry({ response: { status: 200, bodySize: -1, _transferSize: 0 } })]))
    expect(result.failures).toEqual([])
    expect(ok(har([entry()])).entries).toBe(1)
    const cached = readHar(har([entry({ response: { status: 200, bodySize: -1 } })]))
    if (!cached.ok) throw new Error('expected a HAR')
    expect(cached.statuses).toEqual([{ status: 200, count: 1 }])
  })

  it('groups hosts most-used first and tolerates a url that is not one', () => {
    const result = ok(
      har([
        entry(),
        entry(),
        entry({ request: { method: 'GET', url: 'https://other.example.com/x' } }),
        entry({ request: { method: 'GET', url: 'not a url' } }),
      ]),
    )
    expect(result.hosts).toEqual([
      { host: 'api.example.com', count: 2 },
      { host: 'other.example.com', count: 1 },
    ])
    expect(hostOf('not a url')).toBe('')
  })
})

describe('the summary is a boundary, not a copy', () => {
  const text = (entries: Array<Record<string, unknown>>): string =>
    harSummaryText({
      fileName: 'capture.har',
      filePath: '/tmp/capture.har',
      byteSize: 5_600_000,
      summary: ok(har(entries)),
    })

  it('carries no headers, cookies or bodies — a HAR is full of secrets', () => {
    // A real capture holds session tokens and auth headers, and this summary
    // is persisted in a message and sent to a model. The SHAPE of the traffic
    // crosses that line; its contents do not.
    const out = text([
      entry({
        request: {
          method: 'POST',
          url: 'https://api.example.com/login',
          headers: [{ name: 'Authorization', value: 'Bearer SECRET-TOKEN' }],
          cookies: [{ name: 'session', value: 'SECRET-COOKIE' }],
          postData: { text: '{"password":"hunter2"}' },
        },
        response: { status: 200, content: { text: '{"token":"SECRET-RESPONSE"}' } },
      }),
    ])
    for (const secret of ['SECRET-TOKEN', 'SECRET-COOKIE', 'hunter2', 'SECRET-RESPONSE', 'Authorization']) {
      expect(out).not.toContain(secret)
    }
  })

  it('stays small however large the recording is', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      entry({ time: 5000, response: { status: 500 }, request: { method: 'GET', url: `https://api.example.com/${i}` } }),
    )
    const out = text(many)
    // 400 failing requests must not become 400 lines.
    expect(out.split('\n').length).toBeLessThan(45)
    expect(out).toContain('…and 388 more')
  })

  it('says where the rest is, so the omission is a boundary and not a loss', () => {
    const out = text([entry()])
    expect(out).toContain('/tmp/capture.har')
    expect(out).toContain('[index]')
    expect(out).toContain('NOT in this summary')
  })

  it('says plainly when nothing failed', () => {
    expect(text([entry()])).toContain('No failed requests.')
  })
})
