import type { StorylineNote } from '../../shared/ipc-contract'
import {
  canRecordVerdict,
  canSend,
  composeReviewMessage,
  decisionLabel,
  decisionOf,
  draftStorageKey,
  loadDrafts,
  nextStatus,
  notePlacementKey,
  notesToAcceptAll,
  noteSubject,
  noteWordsKey,
  parseDrafts,
  reviewChips,
  reviewCounts,
  reviewHeadline,
  reviewTally,
  saveDrafts,
  sendBlockedReason,
  stripSentence,
  withComment,
  type DraftStorage,
  type ReviewNote,
} from './note-review-model'

const NOTES: ReviewNote[] = [
  { n: 1, kind: 'change', file: 'src/chat/logic.ts', symbol: 'useMessageInputContentLogic', status: 'accepted' },
  { n: 2, kind: 'new', file: 'src/chat/slashGate.ts', symbol: 'isSlashMenuEligible', status: 'rejected', reason: 'keep it inline' },
  { n: 3, kind: 'file', file: 'src/chat/logic.client.test.ts', status: 'proposed' },
]

function memoryStorage(seed: Record<string, string> = {}): DraftStorage & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

describe('decisions', () => {
  it('reads proposed as not reviewed', () => {
    expect(decisionOf('proposed')).toBe('unreviewed')
    expect(decisionOf('accepted')).toBe('accepted')
    expect(decisionOf('rejected')).toBe('rejected')
    expect(decisionLabel('unreviewed')).toBe('Not reviewed yet')
  })

  it('takes a decision back when the same one is pressed again', () => {
    expect(nextStatus('proposed', 'accepted')).toBe('accepted')
    expect(nextStatus('accepted', 'accepted')).toBe('proposed')
    expect(nextStatus('accepted', 'rejected')).toBe('rejected')
    expect(nextStatus('rejected', 'rejected')).toBe('proposed')
  })
})

describe('Accept all', () => {
  it('touches only the notes not reviewed yet — never a rejected or an accepted one', () => {
    const notes: ReviewNote[] = [
      ...NOTES,
      { n: 4, kind: 'change', file: 'a.ts', status: 'proposed' },
      { n: 5, kind: 'file', file: 'b.ts', status: 'accepted' },
    ]
    expect(notesToAcceptAll(notes)).toEqual([3, 4])
  })

  it('leaves a note whose decision is still being saved alone, and has nothing to do when all are reviewed', () => {
    const notes: ReviewNote[] = [...NOTES, { n: 4, kind: 'change', file: 'a.ts', status: 'proposed' }]
    expect(notesToAcceptAll(notes, new Set([3]))).toEqual([4])
    expect(notesToAcceptAll(NOTES.map((note) => ({ ...note, status: 'accepted' as const })))).toEqual([])
  })
})

describe('counts and sentences', () => {
  it('counts decisions and comments', () => {
    expect(reviewCounts(NOTES, { 2: 'one call site', 3: '  ' })).toEqual({ total: 3, accepted: 1, rejected: 1, unreviewed: 1, comments: 1 })
  })

  it('offers Send only when every note is reviewed', () => {
    expect(canSend(NOTES)).toBe(false)
    expect(sendBlockedReason(NOTES)).toBe('Review every note first')
    const all = NOTES.map((note) => ({ ...note, status: 'accepted' as const }))
    expect(canSend(all)).toBe(true)
    expect(sendBlockedReason(all)).toBeNull()
    expect(canSend([])).toBe(false)
  })

  it('blocks Send while a decision is saving or failed to save — the agent never gets a decision the plan does not hold', () => {
    const all = NOTES.map((note) => ({ ...note, status: 'accepted' as const }))
    expect(canSend(all, { 2: { state: 'saving' } })).toBe(false)
    expect(sendBlockedReason(all, { 2: { state: 'saving' } })).toBe('Wait for every decision to be saved')
    expect(canSend(all, { 3: { state: 'failed' } })).toBe(false)
    expect(sendBlockedReason(all, { 3: { state: 'failed' } })).toBe('A decision was not saved — decide that note again first')
    expect(canSend(all, {})).toBe(true)
    expect(sendBlockedReason(all, {})).toBeNull()
  })

  it('records a verdict only on a note that was to be built', () => {
    expect(canRecordVerdict({ status: 'rejected' })).toBe(false)
    expect(canRecordVerdict({ status: 'accepted' })).toBe(true)
    expect(canRecordVerdict({ status: 'proposed' })).toBe(true)
  })

  it('says what is left, and what executing does with it', () => {
    const counts = reviewCounts(NOTES, { 2: 'x' })
    expect(reviewHeadline(counts)).toBe('1 note still to review')
    expect(reviewTally(counts)).toBe('1 accepted · 1 rejected · 1 comment')
    expect(stripSentence(counts)).toBe('1 not reviewed — executing builds them as written, and never builds a rejected note')
    const done = reviewCounts(NOTES.map((note) => ({ ...note, status: 'accepted' as const })), {})
    expect(reviewHeadline(done)).toBe('Review complete')
    expect(stripSentence(done)).toBe('All reviewed')
  })

  it('makes one chip per decided or commented note, in order', () => {
    const chips = reviewChips([...NOTES].reverse(), { 1: 'fine', 3: 'add the coworker case' })
    expect(chips.map((chip) => chip.text)).toEqual([
      'useMessageInputContentLogic · accepted — "fine"',
      'isSlashMenuEligible · rejected',
      'logic.client.test.ts · not reviewed yet — "add the coworker case"',
    ])
    // Each chip is named by what its note is about — the function, else the file.
    expect(chips.map((chip) => chip.title)).toEqual(['useMessageInputContentLogic', 'isSlashMenuEligible', 'logic.client.test.ts'])
  })
})

describe('drafts', () => {
  it('keys drafts by project and plan', () => {
    expect(draftStorageKey('/repo/a', 'pay')).not.toBe(draftStorageKey('/repo/b', 'pay'))
  })

  it('reads only well-formed comments', () => {
    expect(parseDrafts(null)).toEqual({})
    expect(parseDrafts('not json')).toEqual({})
    expect(parseDrafts('[1]')).toEqual({})
    expect(parseDrafts('{"1":"keep","x":"no","2":"  ","3":4}')).toEqual({ 1: 'keep' })
  })

  it('saves, reloads and clears through storage', () => {
    const storage = memoryStorage()
    const key = draftStorageKey('/repo', 'pay')
    expect(saveDrafts(storage, key, { 1: 'a', 2: ' ' })).toBe(true)
    expect(loadDrafts(storage, key)).toEqual({ 1: 'a' })
    saveDrafts(storage, key, {})
    expect(storage.data[key]).toBeUndefined()
  })

  it('survives storage that throws', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadDrafts(broken, 'k')).toEqual({})
    expect(saveDrafts(broken, 'k', { 1: 'a' })).toBe(false)
    expect(loadDrafts(null, 'k')).toEqual({})
    expect(saveDrafts(null, 'k', {})).toBe(false)
    warn.mockRestore()
  })

  it('replaces a note comment, and an empty one removes it', () => {
    const drafts = withComment({ 1: 'old' }, 1, '  new  ')
    expect(drafts).toEqual({ 1: 'new' })
    expect(withComment(drafts, 1, '   ')).toEqual({})
  })
})

describe('composeReviewMessage', () => {
  it('lists every note in order with its decision, reason and comment', () => {
    const message = composeReviewMessage('slash_menu', [...NOTES].reverse(), { 2: 'there is one call site', 3: 'add the\ncoworker case' })
    expect(message).toContain('the plan slash_menu')
    const lines = message.split('\n')
    const one = lines.findIndex((line) => line.startsWith('- Note 1'))
    const two = lines.findIndex((line) => line.startsWith('- Note 2'))
    const three = lines.findIndex((line) => line.startsWith('- Note 3'))
    expect(one).toBeLessThan(two)
    expect(two).toBeLessThan(three)
    expect(lines[one]).toBe('- Note 1 (useMessageInputContentLogic): accepted.')
    expect(lines[two]).toBe('- Note 2 (the new function isSlashMenuEligible): rejected — reason: keep it inline.')
    expect(lines[two + 1]).toBe('  Comment: there is one call site')
    expect(lines[three]).toBe('- Note 3 (logic.client.test.ts as a whole): not reviewed.')
    expect(lines[three + 1]).toBe('  Comment: add the coworker case')
  })

  it('names no command, path or config key', () => {
    const message = composeReviewMessage('pay', NOTES, { 1: 'ok' })
    expect(message).not.toMatch(/\/[a-z-]+-plan|planflow-ai|src\/|flow\/|\.flowconfig|@/)
  })

  it('names a sibling project note by its project', () => {
    expect(noteSubject({ n: 4, kind: 'change', file: 'api/routes.ts', symbol: 'list', status: 'proposed', project: 'backend' })).toBe('list in backend')
  })
})

describe('what a re-read changed', () => {
  const full = (extra: Partial<StorylineNote> = {}): StorylineNote => ({ n: 1, phase: 1, kind: 'change', target: 't', file: 'a.ts', status: 'proposed', comments: [], ...extra })
  it('decisions are neither words nor placement; a new quote is both', () => {
    expect(noteWordsKey([full()])).toBe(noteWordsKey([full({ status: 'accepted', verdict: 'done' })]))
    expect(notePlacementKey([full()])).toBe(notePlacementKey([full({ status: 'rejected', what: 'other' })]))
    expect(noteWordsKey([full()])).not.toBe(noteWordsKey([full({ what: 'other' })]))
    expect(notePlacementKey([full()])).not.toBe(notePlacementKey([full({ where: 'x' })]))
  })
})
