// code-highlight — syntax colour for the chat's fenced code blocks, tokenized
// by the Monaco the app already ships and painted with text nodes.

import { monacoLanguageFor, planCodeSpans, tokenClass } from './code-highlight'

describe('monacoLanguageFor', () => {
  it('maps the tags people actually type', () => {
    expect(monacoLanguageFor('ts')).toBe('typescript')
    expect(monacoLanguageFor('py')).toBe('python')
    expect(monacoLanguageFor('sh')).toBe('shell')
    expect(monacoLanguageFor('yml')).toBe('yaml')
  })

  it('is case- and space-insensitive, because a fence tag is typed by hand', () => {
    expect(monacoLanguageFor('  TS ')).toBe('typescript')
  })

  it('returns null for a tag it does not know, rather than guessing a grammar', () => {
    // Highlighting the WRONG grammar is worse than not highlighting: it colours
    // arbitrary words and tells the reader something untrue about the code.
    expect(monacoLanguageFor('diff')).toBeNull()
    expect(monacoLanguageFor('text')).toBeNull()
    expect(monacoLanguageFor('')).toBeNull()
    expect(monacoLanguageFor('not-a-language')).toBeNull()
  })
})

describe('tokenClass', () => {
  it('collapses Monaco’s dotted, language-suffixed scopes to their head', () => {
    expect(tokenClass('keyword.ts')).toBe('fl-tok-keyword')
    expect(tokenClass('string.quote.js')).toBe('fl-tok-string')
    expect(tokenClass('type.identifier.ts')).toBe('fl-tok-type')
  })

  it('gives plain text no class, so it inherits the block’s colour', () => {
    expect(tokenClass('')).toBeNull()
    expect(tokenClass('source.ts')).toBeNull()
    expect(tokenClass('identifier.ts')).toBeNull()
    expect(tokenClass('white.ts')).toBeNull()
  })
})

describe('planCodeSpans', () => {
  const joined = (body: string, lines: Parameters<typeof planCodeSpans>[1]): string =>
    planCodeSpans(body, lines)
      .map((span) => span.text)
      .join('')

  it('reproduces the source text exactly, character for character', () => {
    // The one property that must never break: colour is presentation, and a
    // highlighter that drops or reorders a character has corrupted the code
    // somebody is about to copy.
    const body = "const x = 'hi'\nreturn x"
    expect(
      joined(body, [
        [
          { offset: 0, type: 'keyword.ts' },
          { offset: 5, type: '' },
          { offset: 6, type: 'identifier.ts' },
          { offset: 8, type: 'delimiter.ts' },
          { offset: 10, type: 'string.ts' },
        ],
        [
          { offset: 0, type: 'keyword.ts' },
          { offset: 6, type: 'identifier.ts' },
        ],
      ]),
    ).toBe(body)
  })

  it('classifies a keyword and leaves an identifier bare', () => {
    const spans = planCodeSpans('const x', [
      [
        { offset: 0, type: 'keyword.ts' },
        { offset: 5, type: 'identifier.ts' },
      ],
    ])
    expect(spans[0]).toEqual({ text: 'const', className: 'fl-tok-keyword' })
    expect(spans.filter((s) => s.className !== null)).toHaveLength(1)
  })

  it('keeps blank lines, so the shape of the code survives', () => {
    const body = 'a\n\nb'
    expect(joined(body, [[{ offset: 0, type: 'identifier.ts' }], [], []])).toBe(body)
  })

  it('survives a line the tokenizer said nothing about', () => {
    const body = 'a\nb'
    expect(joined(body, [[{ offset: 0, type: 'keyword.ts' }]])).toBe(body)
  })

  it('keeps text before a token that does not start at column 0', () => {
    const body = '  const x'
    expect(joined(body, [[{ offset: 2, type: 'keyword.ts' }]])).toBe(body)
  })

  it('never emits an empty run', () => {
    const spans = planCodeSpans('ab', [
      [
        { offset: 0, type: 'keyword.ts' },
        { offset: 0, type: 'string.ts' },
      ],
    ])
    expect(spans.every((span) => span.text.length > 0)).toBe(true)
  })

  it('passes markup through as TEXT, never as structure', () => {
    // The markdown renderer's invariant, restated where it could be lost: code
    // containing `<script>` ends up as characters, and `planCodeSpans` never
    // produces anything but text runs to put in a text node.
    const body = '<script>alert(1)</script>'
    const spans = planCodeSpans(body, [[{ offset: 0, type: 'string.ts' }]])
    expect(spans.map((s) => s.text).join('')).toBe(body)
  })
})
