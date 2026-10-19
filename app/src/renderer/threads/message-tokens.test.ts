import { hasHighlights, tokenizeMessage, type MessageToken } from './message-tokens'

const COMMANDS = new Set(['create-plan', 'review-code', 'execute-plan', 'brainstorm', 'plugin:skill'])
const isCommand = (name: string): boolean => COMMANDS.has(name)
const tokens = (text: string): MessageToken[] => tokenizeMessage(text, isCommand)
const joined = (list: readonly MessageToken[]): string => list.map((token) => token.text).join('')
const highlighted = (text: string): string[] =>
  tokens(text)
    .filter((token) => token.kind !== 'text')
    .map((token) => `${token.kind}:${token.text}`)

describe('tokenizeMessage — commands', () => {
  it('finds a command at the start of the text', () => {
    expect(tokens('/create-plan now')).toEqual([
      { kind: 'command', text: '/create-plan' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('finds a command mid-sentence and at the start of a later line', () => {
    expect(highlighted('lets do that: /create-plan\n/review-code please')).toEqual([
      'command:/create-plan',
      'command:/review-code',
    ])
  })

  it('leaves trailing punctuation out of the command', () => {
    expect(tokens('run /create-plan, then /execute-plan.')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'command', text: '/create-plan' },
      { kind: 'text', text: ', then ' },
      { kind: 'command', text: '/execute-plan' },
      { kind: 'text', text: '.' },
    ])
    expect(highlighted('really /brainstorm?')).toEqual(['command:/brainstorm'])
  })

  it('accepts a namespaced skill', () => {
    expect(highlighted('use /plugin:skill: now')).toEqual(['command:/plugin:skill'])
  })

  it('leaves paths, fractions, URLs and unknown words plain', () => {
    for (const text of [
      '/usr/bin',
      'ls /usr/bin/env',
      '1/2 of it',
      'see https://example.com/create-plan',
      '/create-plan/sub',
      '/not-a-command here',
      'a/create-plan',
      '/create-plan.md',
      '/',
    ]) {
      expect(highlighted(text)).toEqual([])
    }
  })

  it('accepts an opening bracket before the slash', () => {
    expect(highlighted('(/create-plan) and `/review-code`')).toEqual([
      'command:/create-plan',
      'command:/review-code',
    ])
  })

  it('does not take a Unicode run as a known command', () => {
    expect(highlighted('/create-plané')).toEqual([])
    expect(highlighted('café /brainstorm über')).toEqual(['command:/brainstorm'])
  })
})

describe('tokenizeMessage — files', () => {
  it('finds an @ path as the composer inserts it', () => {
    expect(tokens('read @flow/discovery/discovery_x_v1.md now')).toEqual([
      { kind: 'text', text: 'read ' },
      { kind: 'file', text: '@flow/discovery/discovery_x_v1.md' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('finds a quoted path with spaces', () => {
    expect(highlighted('see @"design docs/tokens.md" ok')).toEqual(['file:@"design docs/tokens.md"'])
  })

  it('leaves an unterminated quote plain', () => {
    expect(highlighted('see @"design docs')).toEqual([])
  })

  it('leaves trailing sentence punctuation out of the path', () => {
    expect(tokens('check @src/a.ts.')).toEqual([
      { kind: 'text', text: 'check ' },
      { kind: 'file', text: '@src/a.ts' },
      { kind: 'text', text: '.' },
    ])
    expect(highlighted('check @src/a.ts, ok')).toEqual(['file:@src/a.ts'])
  })

  it('keeps relative paths and Unicode names whole', () => {
    expect(highlighted('@./x.md and @../docs/ and @notas/ação.md')).toEqual([
      'file:@./x.md',
      'file:@../docs/',
      'file:@notas/ação.md',
    ])
  })

  it('leaves emails and a lone @ plain', () => {
    for (const text of ['mail a@b.com', 'x@y', '@', '@ alone', '@.', 'a @@b']) {
      expect(highlighted(text)).toEqual([])
    }
    expect(highlighted('@a@b.com')).toEqual([])
  })
})

describe('tokenizeMessage — the whole message', () => {
  it('handles several tokens of both kinds', () => {
    expect(
      highlighted('ok, run /review-code on what changed in @app/src/composer.ts and then /execute-plan'),
    ).toEqual(['command:/review-code', 'file:@app/src/composer.ts', 'command:/execute-plan'])
  })

  it('round-trips every input exactly', () => {
    for (const text of [
      '',
      'plain words only',
      'lets do that: /create-plan @flow/discovery/discovery_x_v1.md',
      '/usr/bin and 1/2 and a@b.com',
      'emoji 🎉 /brainstorm 🎉 @a/🎉.md\n\n  /create-plan,\t@"q \\"x\\".md"',
    ]) {
      expect(joined(tokens(text))).toBe(text)
    }
  })

  it('merges plain runs into one text token', () => {
    expect(tokens('1/2 /usr a@b')).toEqual([{ kind: 'text', text: '1/2 /usr a@b' }])
  })

  it('reports whether there is anything to highlight', () => {
    expect(hasHighlights(tokens('/usr/bin'))).toBe(false)
    expect(hasHighlights(tokens('/create-plan'))).toBe(true)
    expect(hasHighlights(tokens('@x.md'))).toBe(true)
  })

  it('asks nothing of an empty command list', () => {
    expect(highlighted('/create-plan @x.md')).toEqual(['command:/create-plan', 'file:@x.md'])
    expect(tokenizeMessage('/create-plan @x.md', () => false).map((t) => t.kind)).toEqual([
      'text',
      'file',
    ])
  })
})
