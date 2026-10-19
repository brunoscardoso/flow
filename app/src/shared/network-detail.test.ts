import { contentTypeOf, detailSections, detailTabs, formatBody, toCurl } from './network-detail'
import type { BrowserNetworkPayload } from './browser-capture-types'

function net(over: Partial<BrowserNetworkPayload> = {}): BrowserNetworkPayload {
  return {
    method: 'POST',
    url: 'https://api.example.com/orders?id=7',
    status: 500,
    timingMs: 1243,
    requestHeaders: { 'content-type': 'application/json', accept: '*/*' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: '{"name":"Invoice"}',
    responseBody: '{"error":"duplicate key"}',
    ts: 1_700_000_000_000,
    ...over,
  }
}

describe('detailSections', () => {
  it('leads with what a reader looks for first', () => {
    const [general] = detailSections(net())
    expect(general?.title).toBe('General')
    expect(general?.rows?.map((r) => r.name)).toEqual([
      'Request URL',
      'Method',
      'Status',
      'Duration',
      'Time',
    ])
  })

  it('explains a zero status instead of printing "0"', () => {
    // A reader seeing "0" assumes the tool is broken rather than the request.
    const [general] = detailSections(net({ status: 0 }))
    expect(general?.rows?.find((r) => r.name === 'Status')?.value).toContain('never completed')
  })

  it('sorts headers, because a reader scans them by name', () => {
    const sections = detailSections(
      net({ requestHeaders: { zeta: '1', alpha: '2', mid: '3' } }),
    )
    const request = sections.find((s) => s.title === 'Request headers')
    expect(request?.rows?.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('distinguishes a withheld body from an absent one', () => {
    // allowed-pattern #18: rendering "nothing here" for a body the capture
    // dropped is the app lying about what it saw.
    const withheld = detailSections(net({ responseBody: undefined }), true)
    expect(withheld.find((s) => s.title === 'Response body')?.note).toContain('Not retained')
    const absent = detailSections(net({ responseBody: undefined }), false)
    expect(absent.find((s) => s.title === 'Response body')?.note).toBe('No body.')
  })

  it('says when there were no headers at all, rather than an empty block', () => {
    const sections = detailSections(net({ requestHeaders: {} }))
    expect(sections.find((s) => s.title === 'Request headers')?.note).toBe('None captured.')
  })

  it('pretty-prints a JSON body and leaves everything else alone', () => {
    const sections = detailSections(net())
    expect(sections.find((s) => s.title === 'Response body')?.body).toBe(
      '{\n  "error": "duplicate key"\n}',
    )
    expect(formatBody('<html>hi</html>', 'text/html')).toBe('<html>hi</html>')
  })

  it('shows a body that CLAIMS to be JSON and is not, raw', () => {
    // The malformed body is itself the finding; an error message about it is
    // less useful than the thing.
    expect(formatBody('{not json', 'application/json')).toBe('{not json')
  })

  it('truncates an enormous body and says by how much', () => {
    const big = 'x'.repeat(30_000)
    const body = detailSections(net({ responseBody: big, responseHeaders: {} }))
      .find((s) => s.title === 'Response body')?.body
    expect(body?.length).toBeLessThan(big.length)
    expect(body).toContain('more characters, truncated')
  })

  it('reads the content type case-insensitively', () => {
    expect(contentTypeOf({ 'Content-Type': 'application/json' })).toBe('application/json')
  })
})

describe('toCurl', () => {
  it('builds a command with the method, headers and body', () => {
    const curl = toCurl(net())
    expect(curl).toContain("curl 'https://api.example.com/orders?id=7'")
    expect(curl).toContain('-X POST')
    expect(curl).toContain("-H 'accept: */*'")
    expect(curl).toContain(`--data-raw '{"name":"Invoice"}'`)
  })

  it('omits -X for a GET, which is what curl does anyway', () => {
    expect(toCurl(net({ method: 'GET', requestBody: undefined }))).not.toContain('-X')
  })

  it('escapes a single quote so the command cannot break out of its own string', () => {
    // The one place a shell command can go wrong, and the reason this is pure
    // and tested rather than built inline in a click handler.
    const curl = toCurl(net({ requestBody: `{"name":"O'Brien"}` }))
    expect(curl).toContain(`'{"name":"O'\\''Brien"}'`)
  })

  it('WARNS when the command cannot authenticate, instead of looking replayable', () => {
    // The capture redacts credentials, so this command will get a 401 the page
    // did not. A reader who does not know that debugs the wrong failure.
    const curl = toCurl(net({ requestHeaders: { authorization: 'Bearer [redacted]' } }))
    expect(curl).toContain('redacted at capture')
    expect(curl).toContain('will not authenticate')
  })

  it('stays quiet when nothing was redacted', () => {
    expect(toCurl(net())).not.toContain('redacted at capture')
  })
})

describe('detailTabs — what a reader is actually asking', () => {
  it('splits into Headers, Request and Response', () => {
    // Everything stacked meant a CSP header — routinely a paragraph — pushed
    // the response body off the bottom.
    expect(detailTabs(net()).map((t) => t.label)).toEqual(['Headers', 'Request', 'Response'])
  })

  it('keeps General with the headers, where a reader looks first', () => {
    const [headers] = detailTabs(net())
    expect(headers?.sections.map((s) => s.title)).toEqual([
      'General',
      'Request headers',
      'Response headers',
    ])
  })

  it('puts each body in its own tab, and nothing else there', () => {
    const tabs = detailTabs(net())
    expect(tabs[1]?.sections.map((s) => s.title)).toEqual(['Request body'])
    expect(tabs[2]?.sections.map((s) => s.title)).toEqual(['Response body'])
  })

  it('marks a body tab EMPTY rather than removing it', () => {
    // A strip whose tabs come and go makes a reader hunt for the one that moved.
    const tabs = detailTabs(net({ requestBody: undefined }))
    expect(tabs.map((t) => t.label)).toEqual(['Headers', 'Request', 'Response'])
    expect(tabs[1]?.empty).toBe(true)
    expect(tabs[2]?.empty).toBe(false)
  })

  it('treats a withheld body as empty for the tab, while the section still says why', () => {
    const tabs = detailTabs(net({ responseBody: undefined }), true)
    expect(tabs[2]?.empty).toBe(true)
    expect(tabs[2]?.sections[0]?.note).toContain('Not retained')
  })

  it('never calls the Headers tab empty — General is always there', () => {
    const tabs = detailTabs(net({ requestHeaders: {}, responseHeaders: {} }))
    expect(tabs[0]?.empty).toBe(false)
  })
})
