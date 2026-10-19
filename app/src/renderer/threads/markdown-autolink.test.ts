import { findAutolink, trimUrlTail } from './markdown-autolink'

// #1127 — the pure half of bare-URL autolinking: where a URL starts and, the
// hard part, where it ENDS. The renderer-side wiring (anchor attributes,
// code-span/bracketed-link precedence) is covered by the DOM tests in
// markdown-file-links.test.ts and the conversation-bare-url e2e probe.

describe('trimUrlTail', () => {
  it('leaves a clean URL untouched', () => {
    expect(trimUrlTail('https://docs.example.com/guide/setup')).toBe(
      'https://docs.example.com/guide/setup',
    )
  })

  it('drops sentence punctuation the scan swallowed', () => {
    expect(trimUrlTail('https://example.com/a.')).toBe('https://example.com/a')
    expect(trimUrlTail('https://example.com/a,')).toBe('https://example.com/a')
    expect(trimUrlTail('https://example.com/a?')).toBe('https://example.com/a')
    expect(trimUrlTail('https://example.com/a!')).toBe('https://example.com/a')
    expect(trimUrlTail('https://example.com/a...')).toBe('https://example.com/a')
  })

  it('keeps BALANCED parentheses — they belong to the URL', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    )
  })

  it('drops an UNBALANCED closing bracket — it belongs to the prose', () => {
    expect(trimUrlTail('https://example.com/a)')).toBe('https://example.com/a')
    expect(trimUrlTail('https://example.com/a]')).toBe('https://example.com/a')
  })

  it('iterates until the tail is clean (bracket then punctuation)', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Foo_(bar).')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    )
    expect(trimUrlTail('https://example.com/a).')).toBe('https://example.com/a')
  })
})

describe('findAutolink', () => {
  it('finds a bare URL written in prose', () => {
    const text = 'Opened the PR: https://github.com/acme/widgets/pull/42'
    expect(findAutolink(text)).toEqual({
      index: 15,
      length: 39,
      url: 'https://github.com/acme/widgets/pull/42',
    })
  })

  it('reports a span that excludes the trailing sentence period', () => {
    const text = 'See https://docs.example.com/guide/setup.'
    const hit = findAutolink(text)
    expect(hit).not.toBeNull()
    expect(hit?.url).toBe('https://docs.example.com/guide/setup')
    // The consumed span must stop before the period so the renderer emits it
    // as prose rather than swallowing it into the anchor.
    expect(text.slice(hit!.index, hit!.index + hit!.length)).toBe(hit?.url)
  })

  it('accepts http as well as https', () => {
    expect(findAutolink('go to http://localhost:5173/ now')?.url).toBe('http://localhost:5173/')
  })

  it('consumes the brackets of the angle form', () => {
    const text = 'docs at <https://example.com/x> today'
    expect(findAutolink(text)).toEqual({ index: 8, length: 23, url: 'https://example.com/x' })
  })

  it('prefers the angle form when both start at the same place', () => {
    const hit = findAutolink('<https://example.com/x>')
    expect(hit?.index).toBe(0)
    expect(hit?.length).toBe(23)
  })

  it('returns the EARLIEST url when several appear', () => {
    expect(findAutolink('a https://one.example.com b https://two.example.com')?.url).toBe(
      'https://one.example.com',
    )
  })

  it('ignores text with no url', () => {
    expect(findAutolink('nothing to see, not even example.com here')).toBeNull()
  })

  it('ignores a scheme with no host', () => {
    expect(findAutolink('the prefix https:// on its own')).toBeNull()
  })

  it('skips a scheme-only fragment and still finds the real url after it', () => {
    expect(findAutolink('https:// then https://real.example.com/x')?.url).toBe(
      'https://real.example.com/x',
    )
  })

  it('does not start mid-word', () => {
    expect(findAutolink('xhttps://example.com')).toBeNull()
  })

  it('does not start inside a backticked code span', () => {
    // The renderer's code-span rule wins by position; the detector additionally
    // refuses to begin immediately after a backtick.
    expect(findAutolink('`https://example.com`')).toBeNull()
  })

  it('finds the url inside a bracketed markdown link (the renderer resolves precedence)', () => {
    // Ordering is the renderer's job: the [text](url) rule matches at index 0,
    // strictly earlier than this hit, so it wins.
    const hit = findAutolink('[docs](https://example.com/x)')
    expect(hit?.index).toBe(7)
    expect(hit?.url).toBe('https://example.com/x')
  })

  it('stops at whitespace, quotes and angle brackets', () => {
    expect(findAutolink('url "https://example.com/x" end')?.url).toBe('https://example.com/x')
  })
})
