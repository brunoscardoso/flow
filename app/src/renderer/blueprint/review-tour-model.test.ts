import type { StorylineNote, StorylineNotePrediction } from '../../shared/ipc-contract'
import { buildTourSteps, stepAfterRebuild, tourStepIndexOf, tourStory, tourSummary } from './review-tour-model'
import type { ReviewOverlay } from './story-review-overlay'
import type { ReviewNoteView } from './storyline-view-model'

const FILE = 'src/a.ts'

function note(n: number, extra: Partial<StorylineNote> = {}): StorylineNote {
  return { n, phase: 1, kind: 'change', target: `file:${FILE}`, file: FILE, symbol: `fn${String(n)}`, status: 'proposed', comments: [], ...extra }
}
function change(n: number, extra: Partial<Extract<StorylineNotePrediction, { kind: 'note-change' }>> = {}, noteExtra: Partial<StorylineNote> = {}): ReviewNoteView {
  const base = note(n, noteExtra)
  return { note: base, prediction: { kind: 'note-change', file: FILE, note: base, symbol: `fn${String(n)}`, ...extra } }
}
function overlay(noteBox: Record<number, string>, loose: ReviewOverlay['loose'] = []): ReviewOverlay {
  return { mode: 'proposal', draw: [], hidden: [], entry: null, highlights: {}, pieceNotes: {}, badges: {}, messages: {}, ghosts: [], loose, fileNotes: [], willCall: [], noteBox }
}

const phases = [{ number: 1, title: 'Data' }, { number: 2, title: 'View' }]

describe('buildTourSteps', () => {
  const views = [change(3, { quoteLines: { startLine: 30, endLine: 31 } }), change(1, { quoteLines: { startLine: 10, endLine: 12 } }), change(2)]
  const boxes = overlay({ 1: 'p1', 2: 'p2', 3: 'p3' })

  it('is empty in Today', () => {
    expect(buildTourSteps(boxes, views, phases, 'today')).toEqual([])
  })

  it('follows note order and aims at the first quoted line', () => {
    const steps = buildTourSteps(boxes, views, phases, 'proposal')
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3])
    expect(steps.map((s) => s.line)).toEqual([10, null, 30])
    expect(steps[0]).toMatchObject({ boxId: 'p1', kind: 'change', codeFound: true, codeMessage: null, subject: 'fn1' })
  })

  it('skips a note the mode does not draw', () => {
    const steps = buildTourSteps(overlay({ 1: 'p1', 3: 'p3' }), views, phases, 'verify')
    expect(steps.map((s) => s.n)).toEqual([1, 3])
  })

  it('marks a missing-code note: no line, the review sentence', () => {
    const missing = change(1, { quoteLines: { startLine: 5, endLine: 5 } })
    const loose = [{ id: 'note-missing:1', kind: 'missing' as const, name: 'fn1', file: FILE, notes: [1], message: 'Flow could not read the code this note is about.' }]
    const [step] = buildTourSteps(overlay({ 1: 'note-missing:1' }, loose), [missing], phases, 'proposal')
    expect(step).toMatchObject({ codeFound: false, line: null, codeMessage: 'Flow could not read the code this note is about.' })
  })

  it('treats a quote found twice or not at all as no code to aim at', () => {
    const twice = change(1, { quoteMissing: true, quoteCount: 2 })
    const none = change(2, { quoteMissing: true })
    const steps = buildTourSteps(overlay({ 1: 'p1', 2: 'p2' }), [twice, none], phases, 'proposal')
    expect(steps.map((s) => [s.codeFound, s.line])).toEqual([[false, null], [false, null]])
    expect(steps[0]?.codeMessage).toContain('2 times')
  })

  it('looks up the phase title, null when the plan names none', () => {
    const steps = buildTourSteps(overlay({ 1: 'p1', 2: 'p2' }), [change(1), change(2, {}, { phase: 9 })], phases, 'proposal')
    expect(steps.map((s) => s.phaseTitle)).toEqual(['Data', null])
    expect(steps.map((s) => s.phase)).toEqual([1, 9])
  })
})

describe('step positions', () => {
  const steps = buildTourSteps(overlay({ 2: 'a', 4: 'b', 6: 'c' }), [change(2), change(4), change(6)], phases, 'proposal')

  it('finds a note or -1', () => {
    expect(tourStepIndexOf(steps, 4)).toBe(1)
    expect(tourStepIndexOf(steps, 5)).toBe(-1)
  })

  it('keeps the same note, falls forward, then to the last, -1 when empty', () => {
    expect(stepAfterRebuild(4, steps)).toBe(1)
    expect(stepAfterRebuild(3, steps)).toBe(1)
    expect(stepAfterRebuild(9, steps)).toBe(2)
    expect(stepAfterRebuild(null, steps)).toBe(0)
    expect(stepAfterRebuild(4, [])).toBe(-1)
  })
})

describe('tourSummary', () => {
  const views = [change(1, {}, { status: 'accepted' }), change(2), change(3, {}, { status: 'rejected' }), change(4)]
  const steps = buildTourSteps(overlay({ 1: 'a', 2: 'b', 3: 'c', 4: 'd' }), views, phases, 'proposal')
  const notes = views.map((v) => v.note)

  it('counts decisions and names the first note still to review', () => {
    expect(tourSummary(steps, notes)).toEqual({ accepted: 1, rejected: 1, unreviewed: 2, firstUnreviewedN: 2, canSend: false })
  })

  it('can send once every note is decided and saved', () => {
    const decided = notes.map((n) => ({ ...n, status: 'accepted' as const }))
    expect(tourSummary(steps, decided)).toMatchObject({ unreviewed: 0, firstUnreviewedN: null, canSend: true })
    expect(tourSummary(steps, decided, {}, { 1: { state: 'saving' } }).canSend).toBe(false)
  })
})

describe('tourStory', () => {
  it('tells a change: the file, the function, what and why', () => {
    const told = tourStory(note(5, { file: 'src/activity/ActivityRow.tsx', symbol: 'ActivityRow', what: 'take the clamp from the caller', why: 'Markdown cannot line-clamp' }), 'proposal')
    expect(told).toEqual({
      file: 'ActivityRow.tsx',
      action: 'Changing ActivityRow',
      change: 'Take the clamp from the caller',
      reason: 'Because markdown cannot line-clamp',
      result: null,
    })
  })

  it('tells a new function by its purpose and its callers, in a sibling project', () => {
    const told = tourStory(note(2, { kind: 'new', project: 'api', symbol: 'getFilters', purpose: 'reads the filters', callers: ['load', 'save'] }), 'proposal')
    expect(told).toMatchObject({ file: 'api / a.ts', action: 'Adding getFilters', change: 'Reads the filters', reason: 'Called from load, save' })
  })

  it('tells a file note as the file, and leaves out a line the note does not carry', () => {
    const told = tourStory(note(3, { kind: 'file', symbol: undefined, what: 'register the route' }), 'proposal')
    expect(told).toMatchObject({ action: 'Changing this file', change: 'Register the route', reason: null })
  })

  it('adds how it was built, in Verify only', () => {
    const built = note(4, { verdict: 'differs', verdictWhy: 'the clamp moved to the card' })
    expect(tourStory(built, 'verify').result).toBe('Differs: the clamp moved to the card')
    expect(tourStory(built, 'proposal').result).toBeNull()
  })

  it('rides on every step', () => {
    const steps = buildTourSteps(overlay({ 1: 'p1' }), [change(1, {}, { what: 'cache it' })], phases, 'proposal')
    expect(steps[0]?.story).toMatchObject({ action: 'Changing fn1', change: 'Cache it' })
  })
})
