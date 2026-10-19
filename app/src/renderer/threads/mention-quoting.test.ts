import {
  mentionTrigger,
  needsQuoting,
  quoteMentionPath,
  unquoteMentionPath,
} from './mention-quoting'

// #1417: the @-popup offered paths with spaces and then inserted a reference
// it could not read back. `@design docs/` closed the popup, never reopened,
// and meant `@design` followed by the words `docs/tokens.md`.

describe('quoting (#1417)', () => {
  it('leaves ordinary paths bare', () => {
    expect(needsQuoting('src/index.ts')).toBe(false)
    expect(quoteMentionPath('src/index.ts')).toBe('src/index.ts')
  })

  it('quotes a path with a space', () => {
    expect(needsQuoting('design docs/')).toBe(true)
    expect(quoteMentionPath('design docs/')).toBe('"design docs/"')
  })

  it('round-trips, including embedded quotes', () => {
    for (const path of ['src/a.ts', 'design docs/', 'weird "name".md', 'a\\b c']) {
      expect(unquoteMentionPath(quoteMentionPath(path))).toBe(path)
    }
  })
})

describe('mentionTrigger (#1417)', () => {
  it('finds a bare trigger, as before', () => {
    expect(mentionTrigger('look at @src/ind')).toEqual({ start: 8, query: 'src/ind' })
  })

  it('finds a bare trigger at the very start', () => {
    expect(mentionTrigger('@src')).toEqual({ start: 0, query: 'src' })
  })

  it('keeps completing inside an OPEN quote — the case that dead-ended', () => {
    // Typing the rest of a spaced name must reopen/keep the popup; before,
    // the session ended the moment the space landed.
    expect(mentionTrigger('see @"design doc')).toEqual({ start: 4, query: 'design doc' })
  })

  it('reads a closed quoted reference back', () => {
    expect(mentionTrigger('see @"design docs/"')).toEqual({ start: 4, query: 'design docs/' })
  })

  it('is null when there is no trigger', () => {
    expect(mentionTrigger('no mention here')).toBeNull()
    expect(mentionTrigger('email@example.com')).toBeNull()
  })
})
