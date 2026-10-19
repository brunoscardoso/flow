import { parseQuery } from './palette-query'

describe('parseQuery', () => {
  it('parses plain typing as content mode', () => {
    expect(parseQuery('button')).toEqual({ mode: 'content', term: 'button', isEmpty: false })
  })

  it('parses a leading > as command mode with the remainder as the term', () => {
    expect(parseQuery('>new thread')).toEqual({ mode: 'command', term: 'new thread', isEmpty: false })
    expect(parseQuery('> open')).toEqual({ mode: 'command', term: 'open', isEmpty: false })
  })

  it('flags an empty content term (recents path)', () => {
    expect(parseQuery('')).toEqual({ mode: 'content', term: '', isEmpty: true })
    expect(parseQuery('   ')).toEqual({ mode: 'content', term: '', isEmpty: true })
  })

  it('flags an empty command term (bare > shows all commands)', () => {
    expect(parseQuery('>')).toEqual({ mode: 'command', term: '', isEmpty: true })
    expect(parseQuery('>   ')).toEqual({ mode: 'command', term: '', isEmpty: true })
  })

  it('trims surrounding whitespace before mode detection', () => {
    expect(parseQuery('  >run  ')).toEqual({ mode: 'command', term: 'run', isEmpty: false })
    expect(parseQuery('  file  ')).toEqual({ mode: 'content', term: 'file', isEmpty: false })
  })
})
