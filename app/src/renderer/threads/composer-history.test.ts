import {
  HISTORY_CAP,
  caretOnFirstLine,
  caretOnLastLine,
  emptyHistory,
  navigate,
  pushEntry,
  recallableText,
  resetNavigation,
  seedEntries,
} from './composer-history'

describe('composer history (#776)', () => {
  it('ArrowUp with no entries does nothing', () => {
    expect(navigate(emptyHistory(), 'back', 'draft')).toBeNull()
  })

  it('walks back newest → oldest, stopping at the oldest', () => {
    let h = pushEntry(pushEntry(emptyHistory(), 'first'), 'second')
    const s1 = navigate(h, 'back', 'my draft')!
    expect(s1.text).toBe('second')
    h = s1.history
    const s2 = navigate(h, 'back', s1.text)!
    expect(s2.text).toBe('first')
    // At the oldest — a further back is a no-op.
    expect(navigate(s2.history, 'back', s2.text)).toBeNull()
  })

  it('walks forward and restores the saved draft past the newest', () => {
    let h = pushEntry(pushEntry(emptyHistory(), 'first'), 'second')
    h = navigate(h, 'back', 'my draft')!.history // at 'second'
    h = navigate(h, 'back', 'second')!.history // at 'first'
    const f1 = navigate(h, 'forward', 'first')!
    expect(f1.text).toBe('second')
    const f2 = navigate(f1.history, 'forward', f1.text)!
    expect(f2.text).toBe('my draft') // draft restored
    expect(f2.history.index).toBeNull()
    // Not navigating — forward is a no-op.
    expect(navigate(f2.history, 'forward', 'my draft')).toBeNull()
  })

  it('an edit while navigating resets the cursor (next Up starts from newest)', () => {
    let h = pushEntry(pushEntry(emptyHistory(), 'first'), 'second')
    h = navigate(h, 'back', '')!.history
    h = navigate(h, 'back', 'second')!.history // at 'first'
    h = resetNavigation(h) // user typed
    expect(h.index).toBeNull()
    expect(navigate(h, 'back', 'first edited')!.text).toBe('second')
  })

  it('collapses consecutive duplicates and caps the history', () => {
    let h = pushEntry(pushEntry(emptyHistory(), 'same'), 'same')
    expect(h.entries).toEqual(['same'])
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushEntry(h, `msg ${i}`)
    expect(h.entries.length).toBe(HISTORY_CAP)
    expect(h.entries[h.entries.length - 1]).toBe(`msg ${HISTORY_CAP + 9}`)
  })

  it('skips blank sends', () => {
    expect(pushEntry(emptyHistory(), '   ').entries).toEqual([])
  })

  it('caret line helpers gate multiline editing', () => {
    const value = 'line one\nline two'
    expect(caretOnFirstLine(value, 3)).toBe(true)
    expect(caretOnFirstLine(value, 12)).toBe(false)
    expect(caretOnLastLine(value, 12)).toBe(true)
    expect(caretOnLastLine(value, 3)).toBe(false)
    expect(caretOnFirstLine('', 0)).toBe(true)
    expect(caretOnLastLine('', 0)).toBe(true)
  })
})

describe('recallableText (#776 cross-session seeding)', () => {
  it('passes plain typed text through', () => {
    expect(recallableText('what do you think?')).toBe('what do you think?')
  })

  it('strips leading blueprint chip lines', () => {
    expect(recallableText('[blueprint: module:src — src]\n\nfix the board')).toBe('fix the board')
    expect(recallableText('[blueprint story: plan/step — title]\nquestion here')).toBe(
      'question here',
    )
  })

  it('strips a leading context fenced block (label + fence through its close)', () => {
    const content = [
      'Context from design-notes.md:',
      '```',
      '# Design notes',
      'The content travels.',
      '```',
      '',
      'what do you think?',
    ].join('\n')
    expect(recallableText(content)).toBe('what do you think?')
  })

  it('strips stacked preambles (chips + multiple context blocks)', () => {
    const content = [
      '[blueprint: module:a — a]',
      'Context from Terminal:',
      '````',
      'a ``` inside',
      '````',
      'Context from file.ts:',
      '```',
      'code',
      '```',
      '',
      'the actual question',
    ].join('\n')
    expect(recallableText(content)).toBe('the actual question')
  })

  it('returns empty for a preamble-only (attachment-only) send', () => {
    expect(recallableText('Context from x.md:\n```\nstuff\n```')).toBe('')
  })
})

describe('seedEntries (#776 cross-session seeding)', () => {
  it('places persisted texts BEFORE in-session entries', () => {
    const session = pushEntry(emptyHistory(), 'newest this session')
    const seeded = seedEntries(session, ['old one', 'old two'])
    expect(seeded.entries).toEqual(['old one', 'old two', 'newest this session'])
  })

  it('drops blanks, collapses runs, and dedupes the seam', () => {
    const session = pushEntry(emptyHistory(), 'same')
    const seeded = seedEntries(session, ['a', 'a', '  ', 'same'])
    expect(seeded.entries).toEqual(['a', 'same'])
  })

  it('caps the combined history and leaves navigation state untouched', () => {
    const many = Array.from({ length: HISTORY_CAP + 20 }, (_, i) => `m${i}`)
    const seeded = seedEntries(emptyHistory(), many)
    expect(seeded.entries.length).toBe(HISTORY_CAP)
    expect(seeded.index).toBeNull()
  })
})
