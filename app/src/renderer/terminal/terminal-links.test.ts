import { detectTerminalLinks, isOpenableTerminalUrl } from './terminal-links'

describe('detectTerminalLinks (#1190)', () => {
  it('finds a dev-server URL in ordinary output', () => {
    // The exact line every vite/next/astro run prints.
    expect(detectTerminalLinks('  ➜  Local:   http://localhost:5173/')).toEqual([
      { url: 'http://localhost:5173/', startColumn: 15, endColumn: 37 },
    ])
  })

  it('uses 1-based inclusive/exclusive columns, as xterm expects', () => {
    const [span] = detectTerminalLinks('https://x.dev')
    expect(span.startColumn).toBe(1)
    expect(span.endColumn).toBe(14) // exclusive
  })

  it('finds several URLs on one line', () => {
    expect(detectTerminalLinks('a https://one.dev b https://two.dev').map((s) => s.url)).toEqual([
      'https://one.dev',
      'https://two.dev',
    ])
  })

  it('does not swallow a sentence’s full stop', () => {
    expect(detectTerminalLinks('see https://x.dev/docs.').map((s) => s.url)).toEqual([
      'https://x.dev/docs',
    ])
  })

  it('keeps a balanced bracket that belongs to the URL', () => {
    expect(detectTerminalLinks('https://en.wikipedia.org/wiki/Foo_(bar)').map((s) => s.url)).toEqual(
      ['https://en.wikipedia.org/wiki/Foo_(bar)'],
    )
  })

  it('ignores a line with no URL', () => {
    expect(detectTerminalLinks('$ npm run build')).toEqual([])
  })

  it('ignores non-http schemes — a terminal prints untrusted output', () => {
    expect(detectTerminalLinks('file:///etc/passwd ftp://x.dev')).toEqual([])
  })
})

describe('isOpenableTerminalUrl (#1190)', () => {
  it('allows http and https only', () => {
    expect(isOpenableTerminalUrl('https://x.dev')).toBe(true)
    expect(isOpenableTerminalUrl('http://localhost:5173/')).toBe(true)
  })

  it('refuses schemes an OSC 8 escape could smuggle in', () => {
    // OSC 8 can name ANY scheme, and the click would otherwise reach the OS.
    expect(isOpenableTerminalUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableTerminalUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableTerminalUrl('not a url')).toBe(false)
  })
})
