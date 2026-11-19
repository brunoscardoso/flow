import { highlightShell, highlightShellLine } from './script-highlight'

const kinds = (line: string): Array<[string, string]> =>
  highlightShellLine(line)
    .filter((token) => token.kind !== 'plain')
    .map((token) => [token.kind, token.text])

describe('highlightShell', () => {
  it('keeps every character, in order, across lines', () => {
    const script = '#!/usr/bin/env bash\nset -euo pipefail\n\nuntil docker compose exec -T pg pg_isready >/dev/null 2>&1; do\n  sleep 1\ndone\n'
    expect(highlightShell(script).map((token) => token.text).join('')).toBe(script)
  })

  it('colours comments, keywords, programs, strings and variables', () => {
    expect(kinds('# reset it')).toEqual([['comment', '# reset it']])
    expect(kinds('until docker compose ps; do')).toEqual([
      ['keyword', 'until'],
      ['program', 'docker'],
      ['keyword', 'do'],
    ])
    expect(kinds('  uv run alembic upgrade head')).toEqual([['program', 'uv']])
    expect(kinds('echo "hi $USER" \'x\' ${HOME} # note')).toEqual([
      ['program', 'echo'],
      ['string', '"hi $USER"'],
      ['string', "'x'"],
      ['variable', '${HOME}'],
      ['comment', '# note'],
    ])
    // A redirection is not a new command; an assignment is not a program.
    expect(kinds('pg_isready >/dev/null 2>&1')).toEqual([['program', 'pg_isready']])
    expect(kinds('FOO=1 make seed')).toEqual([['program', 'make']])
  })

  it('a # inside a word is not a comment', () => {
    expect(kinds('echo a#b')).toEqual([['program', 'echo']])
  })
})
