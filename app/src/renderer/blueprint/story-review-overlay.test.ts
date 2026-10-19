/**
 * The plan review laid on the ONE storyline layout (plan `plan_change_review`):
 * the review's story is `buildStory` told to draw every piece of the plan's
 * story, and the overlay says what sits on it in each mode.
 */
import type { StorylineNote, StorylineNotePrediction, StorylinePiece, StorylineResult } from '../../shared/ipc-contract'
import { buildStory, STORY_ROW } from './storyline-model'
import { mergeReviewNotes } from './storyline-view-model'
import {
  buildReviewOverlay,
  NOTE_CODE_UNREAD,
  NOTE_FILE_MISSING,
  placeReviewBoxes,
  REVIEW_HIT_CONTEXT_LINES,
  shownLinesFor,
  wordsName,
} from './story-review-overlay'

const PAGE = 'e2e/support/pages/chat/thread-page.ts'
const TYPES = 'e2e/support/types/chat/chats.ts'
const FIXTURES = 'e2e/support/fixtures/chat/chats.ts'
const SPEC = 'e2e/tests/chats/access.spec.ts'

function piece(file: string, name: string, startLine: number, lines: number, extra: Partial<StorylinePiece> = {}): StorylinePiece {
  const id = `${file}#${extra.className === undefined ? '' : `${extra.className}.`}${name}`
  return {
    id,
    kind: 'function',
    name,
    file,
    startLine,
    endLine: startLine + lines - 1,
    doc: null,
    text: Array.from({ length: lines }, (_, index) => `line ${String(startLine + index)}`).join('\n'),
    exported: true,
    ...extra,
  }
}

const ctor = piece(PAGE, 'constructor', 43, 12, { kind: 'method', className: 'ChatThreadPage', isConstructor: true })
const locators = piece(PAGE, 'locators', 60, 4, { kind: 'method', className: 'ChatThreadPage' })
const open = piece(PAGE, 'open', 70, 5, { kind: 'method', className: 'ChatThreadPage' })
const started = piece(TYPES, 'StartedChat', 15, 10, { kind: 'type' })
const fixturesLines = piece(FIXTURES, 'chats.ts', 53, 12, { kind: 'excerpt', id: `${FIXTURES}#L53-L64` } as Partial<StorylinePiece>)
const specLines = piece(SPEC, 'access.spec.ts', 30, 12, { kind: 'excerpt', id: `${SPEC}#L30-L41` } as Partial<StorylinePiece>)

function note(n: number, kind: StorylineNote['kind'], file: string, extra: Partial<StorylineNote> = {}): StorylineNote {
  return { n, phase: 1, kind, target: `file:${file}`, file, status: 'proposed', comments: [], ...extra }
}

const change: StorylineNotePrediction = {
  kind: 'note-change',
  file: PAGE,
  note: note(1, 'change', PAGE, { symbol: 'ChatThreadPage.constructor', where: "this.errorBanner = this.main.locator('p.text-destructive')" }),
  pieceId: ctor.id,
  symbol: 'ChatThreadPage.constructor',
  quoteLines: { startLine: 53, endLine: 53 },
}
const typesNote: StorylineNotePrediction = {
  kind: 'note-file',
  file: TYPES,
  note: note(2, 'file', TYPES, { where: 'export type StartedChat', what: 'add the member page' }),
  pieceId: started.id,
  quoteLines: { startLine: 15, endLine: 15 },
}
const fixturesNote: StorylineNotePrediction = { kind: 'note-file', file: FIXTURES, note: note(3, 'file', FIXTURES, { what: 'a member fixture' }) }
const memberPage: StorylineNotePrediction = {
  kind: 'note-new',
  file: FIXTURES,
  note: note(4, 'new', FIXTURES, { symbol: 'memberPage', signature: 'memberPage(): Page', purpose: 'a second user', callers: ['ChatThreadPage.open'] }),
  symbol: 'memberPage',
  signature: 'memberPage(): Page',
  purpose: 'a second user',
  callers: ['ChatThreadPage.open'],
  callerPieces: { 'ChatThreadPage.open': open.id },
}
const specNote: StorylineNotePrediction = {
  kind: 'note-file',
  file: SPEC,
  note: note(5, 'file', SPEC, { where: "test('denied'", what: 'the denied case' }),
  pieceId: specLines.id,
  quoteLines: { startLine: 33, endLine: 33 },
}

/** The user's plan, as `blueprint storyline --plan` answers it: real code around every note. */
const story: StorylineResult = {
  ok: true,
  scope: 'part',
  files: [PAGE, TYPES, FIXTURES, SPEC],
  language: 'typescript',
  pieces: [ctor, locators, open, started, fixturesLines, specLines],
  calls: [
    { from: ctor.id, line: 50, to: locators.id },
    { from: open.id, line: 72, to: null, external: { file: 'e2e/support/pages/base.ts', name: 'goto' } },
  ],
  typeUses: [{ from: open.id, to: started.id }],
  entries: [
    { pieceId: ctor.id, usedFrom: 0 },
    { pieceId: open.id, usedFrom: 0 },
  ],
  classes: [{ name: 'ChatThreadPage', file: PAGE, startLine: 20 }],
}
const views = mergeReviewNotes([change, typesNote, fixturesNote, memberPage, specNote], null)

function laidOut(result: StorylineResult, mode: 'today' | 'proposal' | 'verify', noteViews = views) {
  const overlay = buildReviewOverlay(result, noteViews, mode)
  const plan = placeReviewBoxes(buildStory(result, overlay.entry ?? '', { also: overlay.draw, hidden: overlay.hidden, byFile: true }), overlay)
  return { overlay, plan }
}

describe('the review is the code story, with the review laid on it', () => {
  it('lays the plan out like any story: the entry first, its callee to the right with an arrow, every file in its own cell', () => {
    const { overlay, plan } = laidOut(story, 'proposal')
    expect(overlay.entry).toBe(ctor.id)
    expect(plan.entry).toBe(ctor.id)
    // Every piece of the plan's story is drawn — a second way in walks from the first column.
    expect(plan.drawn).toEqual(expect.arrayContaining([ctor.id, locators.id, open.id, started.id, fixturesLines.id, specLines.id]))
    expect(plan.columns[ctor.id]).toBe(0)
    expect(plan.columns[locators.id]).toBe(1)
    expect(plan.columns[open.id]).toBe(0)
    expect(plan.edges.map((edge) => [edge.from, edge.to, edge.line])).toEqual([[ctor.id, locators.id, 50]])
    // The step rail reads in call order: the entry, its callee, then the next way in.
    expect(plan.order).toEqual([ctor.id, locators.id, open.id])
    // The class frame and the data column, as any story draws them.
    expect(plan.frames.map((frame) => frame.className)).toEqual(['ChatThreadPage'])
    expect(plan.cells.find((cell) => cell.pieceIds.includes(started.id))?.row).toBe(STORY_ROW.data)
    // Every cell names its file; an excerpt sits in the first column, in its file's cell.
    expect(plan.cells.every((cell) => cell.file !== undefined)).toBe(true)
    expect(plan.cells.find((cell) => cell.pieceIds.includes(specLines.id))).toMatchObject({ col: 0, file: SPEC })
  })

  it('Proposal: the change note under its box with its quoted line marked; a file note on its file, its quote marked in the piece that holds it', () => {
    const { overlay } = laidOut(story, 'proposal')
    expect(overlay.pieceNotes[ctor.id]).toEqual([1])
    expect(overlay.badges[ctor.id]).toBe('change')
    expect(overlay.highlights[ctor.id]).toEqual([{ startLine: 53, endLine: 53 }])
    expect(overlay.fileNotes).toEqual([
      { file: TYPES, notes: [2], messages: [] },
      { file: FIXTURES, notes: [3], messages: [] },
      { file: SPEC, notes: [5], messages: [] },
    ])
    expect(overlay.highlights[started.id]).toEqual([{ startLine: 15, endLine: 15 }])
    expect(overlay.highlights[specLines.id]).toEqual([{ startLine: 33, endLine: 33 }])
    expect(overlay.noteBox).toMatchObject({ 1: ctor.id, 2: started.id, 3: fixturesLines.id, 5: specLines.id })
  })

  it('Proposal: a new function is a dashed box right of its caller, in its own file, wired by a "will call"', () => {
    const { overlay, plan } = laidOut(story, 'proposal')
    expect(overlay.ghosts).toEqual([{ id: 'note-new:4', n: 4, name: 'memberPage', file: FIXTURES, callers: [open.id] }])
    expect(overlay.willCall).toEqual([{ from: open.id, fromLine: null, to: 'note-new:4' }])
    expect(plan.columns['note-new:4']).toBe((plan.columns[open.id] ?? 0) + 1)
    expect(plan.cells.find((cell) => cell.pieceIds.includes('note-new:4'))).toMatchObject({ row: STORY_ROW.function, file: FIXTURES })
    // The data column stays the last one.
    expect(plan.dataColumn).toBeGreaterThan(plan.columns['note-new:4'] ?? 0)
    expect(plan.cells.find((cell) => cell.pieceIds.includes(started.id))?.col).toBe(plan.dataColumn)
  })

  it('a caller leaves from the quoted line of ITS note that names the new function', () => {
    const naming: StorylineNotePrediction = { ...change, note: { ...change.note, what: 'call memberPage() for the second user' } }
    const fromCtor = mergeReviewNotes([naming, { ...memberPage, callerPieces: { 'ChatThreadPage.constructor': ctor.id } } as StorylineNotePrediction], null)
    const { overlay } = laidOut(story, 'proposal', fromCtor)
    expect(overlay.willCall).toEqual([{ from: ctor.id, fromLine: 53, to: 'note-new:4' }])
  })

  it('a caller whose first mark belongs to another note leaves from the naming note — or from the box when none names it', () => {
    // Note 1 marks line 53 and is about the error banner; note 6 marks line 51 and calls the new function.
    const other: StorylineNotePrediction = { ...change, note: { ...change.note, what: 'show the error banner' } }
    const naming: StorylineNotePrediction = {
      ...change,
      note: { ...change.note, n: 6, where: 'this.page = page', what: 'open the second user with memberPage' },
      quoteLines: { startLine: 51, endLine: 51 },
    }
    const wired = { ...memberPage, callerPieces: { 'ChatThreadPage.constructor': ctor.id } } as StorylineNotePrediction
    const both = laidOut(story, 'proposal', mergeReviewNotes([other, naming, wired], null)).overlay
    expect(both.highlights[ctor.id]?.[0]).toEqual({ startLine: 53, endLine: 53 })
    expect(both.willCall).toEqual([{ from: ctor.id, fromLine: 51, to: 'note-new:4' }])
    // Only the unrelated note on the caller: the arrow starts at the box, not at that note's line.
    const unrelated = laidOut(story, 'proposal', mergeReviewNotes([other, wired], null)).overlay
    expect(unrelated.willCall).toEqual([{ from: ctor.id, fromLine: null, to: 'note-new:4' }])
  })

  it('a note names a function only as a whole word', () => {
    expect(wordsName('call memberPage()', 'memberPage')).toBe(true)
    expect(wordsName('call memberPage()', 'Fixtures.memberPage')).toBe(true)
    expect(wordsName('call memberPages()', 'memberPage')).toBe(false)
    expect(wordsName('the $memberPage', 'memberPage')).toBe(false)
  })

  it('Today: the same story with nothing on it — and a function the run already built is not Today’s', () => {
    const built = piece(FIXTURES, 'memberPage', 80, 6)
    const withBuilt: StorylineResult = { ...story, pieces: [...story.pieces, built] }
    const builtViews = mergeReviewNotes([change, { ...memberPage, pieceId: built.id } as StorylineNotePrediction], null)
    const { overlay, plan } = laidOut(withBuilt, 'today', builtViews)
    expect(overlay.pieceNotes).toEqual({})
    expect(overlay.highlights).toEqual({})
    expect(overlay.ghosts).toEqual([])
    expect(overlay.fileNotes).toEqual([])
    expect(overlay.noteBox).toEqual({})
    expect(overlay.hidden).toEqual([built.id])
    expect(plan.drawn).not.toContain(built.id)
    expect(plan.drawn).toContain(ctor.id)
  })

  it('Verify: a built new function is its real box, marked New; nothing is highlighted; Proposal still shows it dashed', () => {
    const built = piece(FIXTURES, 'memberPage', 80, 6)
    const withBuilt: StorylineResult = { ...story, pieces: [...story.pieces, built] }
    const builtViews = mergeReviewNotes([change, { ...memberPage, pieceId: built.id } as StorylineNotePrediction], null)
    const verify = laidOut(withBuilt, 'verify', builtViews)
    expect(verify.overlay.badges[built.id]).toBe('new')
    expect(verify.overlay.pieceNotes[built.id]).toEqual([4])
    expect(verify.overlay.ghosts).toEqual([])
    expect(verify.overlay.highlights).toEqual({})
    expect(verify.plan.drawn).toContain(built.id)
    const proposal = laidOut(withBuilt, 'proposal', builtViews)
    expect(proposal.plan.drawn).not.toContain(built.id)
    expect(proposal.overlay.ghosts.map((ghost) => ghost.id)).toEqual(['note-new:4'])
  })

  it('says what it cannot place, never guesses: a quote not found, a gone function, a missing file, a sibling with no code here', () => {
    const lost = { ...change, quoteLines: undefined, quoteMissing: true } as StorylineNotePrediction
    const gone: StorylinePrediction = { kind: 'note-change', file: PAGE, note: note(6, 'change', PAGE, { symbol: 'close' }), symbol: 'close', pieceMissing: true, quoteMissing: true }
    const missingFile: StorylinePrediction = { kind: 'note-file', file: 'e2e/gone.ts', note: note(7, 'file', 'e2e/gone.ts'), fileMissing: true }
    const away: StorylinePrediction = { kind: 'note-change', file: 'api/routes.ts', project: 'api', codeUnavailable: true, symbol: 'list', note: note(8, 'change', 'routes.ts', { project: 'api' }) }
    const badQuote = { ...typesNote, quoteLines: undefined, pieceId: undefined, quoteMissing: true } as StorylineNotePrediction
    const { overlay, plan } = laidOut(story, 'proposal', mergeReviewNotes([lost, gone, missingFile, away, badQuote] as StorylineNotePrediction[], null))
    expect(overlay.highlights[ctor.id]).toBeUndefined()
    expect(overlay.messages[ctor.id]).toBe("Flow can't find this code in today's file.")
    expect(overlay.loose.map((box) => [box.id, box.kind, box.message])).toEqual([
      ['note-missing:6', 'missing', "Flow can't find close in today's file."],
      ['note-missing:8', 'missing', "This project's code is not on this computer, so the note is shown without it."],
      ['note-file:7', 'file', NOTE_FILE_MISSING],
    ])
    expect(overlay.fileNotes).toEqual([{ file: TYPES, notes: [2], messages: ["Note 2: Flow can't find this code in today's file."] }])
    // A box with no code sits in the first column, in its file's cell.
    expect(plan.cells.find((cell) => cell.pieceIds.includes('note-missing:8'))).toMatchObject({ col: 0, file: 'api/routes.ts' })
  })

  it('with no story at all (a refusal), every note is still a box to decide, saying why it has no code', () => {
    const { overlay, plan } = laidOut({ ...story, pieces: [], calls: [], typeUses: [], entries: [], classes: [] }, 'proposal')
    expect(overlay.entry).toBeNull()
    const nothing = buildReviewOverlay(null, mergeReviewNotes([], [note(1, 'change', PAGE, { symbol: 'x' })]), 'proposal')
    expect(nothing.loose).toEqual([{ id: 'note-missing:1', kind: 'missing', name: 'x', file: PAGE, notes: [1], message: NOTE_CODE_UNREAD }])
    expect(plan.cells.flatMap((cell) => cell.pieceIds).sort()).toEqual(['note-file:2', 'note-file:3', 'note-file:5', 'note-missing:1', 'note-new:4'].sort())
  })
})

describe('shownLinesFor — a long box never folds its quoted line away', () => {
  it('opens on the preview, and grows to the last quoted line plus context', () => {
    expect(shownLinesFor(100, 14, 400, undefined)).toBe(14)
    expect(shownLinesFor(100, 14, 400, [{ startLine: 405, endLine: 405 }])).toBe(14)
    expect(shownLinesFor(100, 14, 400, [{ startLine: 450, endLine: 451 }])).toBe(52 + REVIEW_HIT_CONTEXT_LINES)
    expect(shownLinesFor(60, 14, 1, [{ startLine: 59, endLine: 60 }])).toBe(60)
  })
})

type StorylinePrediction = StorylineNotePrediction
