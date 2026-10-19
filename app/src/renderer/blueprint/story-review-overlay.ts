/**
 * PLAN CHANGE REVIEW ON THE CODE STORY — the review as a layer over the one
 * storyline layout (plan `plan_change_review`; allowed-pattern #14). PURE —
 * no DOM, no IPC.
 *
 * A reviewed plan's story is drawn exactly like any code story (the entry on
 * the left, what it calls to its right, the real code in every box, an arrow
 * from each call line, the class frames, the data column, the step rail):
 * `buildStory` lays it out, told to draw every piece the plan's story holds
 * (`also`). This module only decides what the review lays ON it, per mode:
 *
 *   - Today: nothing — the same story, with no note on it. A function the
 *     plan adds and the run already built is not drawn (it is not Today's).
 *   - Proposal: each change note under its function's box, its quoted lines
 *     marked; a file note on its file's label (its quote marked in whichever
 *     piece holds it); a new function as a dashed box right of its callers,
 *     wired by dashed "will call" arrows; a note whose code cannot be found
 *     as a box that says so.
 *   - Verify: the same notes with their verdicts (the diff itself is the
 *     story's own Today ⇄ After look); a built new function is its real box.
 *
 * The DOM is `storyline-view.ts`.
 */
import type { StorylineNotePrediction, StorylinePiece, StorylineResult } from '../../shared/ipc-contract'
import { STORY_ROW, type StoryCell, type StoryPlan } from './storyline-model'
import type { ReviewMode, ReviewNoteView } from './storyline-view-model'
import { noteMissingSentence } from './storyline-view-model'

/** A line range of a file, 1-based and inclusive. */
export interface LineRange {
  startLine: number
  endLine: number
}

/** A function a new note adds: a dashed box, in its file's cell, right of its callers. */
export interface ReviewGhostBox {
  id: string
  n: number
  /** `memberPage` — the note's symbol. */
  name: string
  file: string
  /** The callers on the sheet (piece ids), in the note's order. */
  callers: string[]
}

/** A box with no code: a note whose code is not on the sheet, saying why. */
export interface ReviewLooseBox {
  id: string
  kind: 'file' | 'missing'
  /** The note's symbol, or null for a file note. */
  name: string | null
  file: string
  notes: number[]
  message: string | null
}

/** File notes on a file that IS drawn: written under the file's label. */
export interface ReviewFileNotes {
  file: string
  notes: number[]
  /** One sentence per note whose quote could not be placed. */
  messages: string[]
}

/** A dashed "will call": a caller (from the quoted line of its note that names the new function, else its box) to a new function. */
export interface ReviewWillCall {
  from: string
  fromLine: number | null
  to: string
}

export interface ReviewOverlay {
  mode: ReviewMode
  /** Every piece the review draws, in reading order — `buildStory`'s `also`. */
  draw: string[]
  /** Pieces the story holds that this mode does not draw. */
  hidden: string[]
  /** Where the story opens, or null when there is no code to draw. */
  entry: string | null
  /** Quoted lines to mark, per piece — Proposal only. */
  highlights: Record<string, LineRange[]>
  /** Change notes (and built new ones, in Verify) under each piece, in note order. */
  pieceNotes: Record<string, number[]>
  badges: Record<string, 'change' | 'new'>
  /** A sentence under a piece instead of a guess (a quote that is not there). */
  messages: Record<string, string>
  ghosts: ReviewGhostBox[]
  loose: ReviewLooseBox[]
  fileNotes: ReviewFileNotes[]
  willCall: ReviewWillCall[]
  /** Note → the box to bring to the reader when its pill is pressed (absent when this mode does not draw it). */
  noteBox: Record<number, string>
}

/** The sentence a box says when the review has no code for its note at all. */
export const NOTE_CODE_UNREAD = 'Flow could not read the code this note is about.'
/** A note whose file is not in its project. */
export const NOTE_FILE_MISSING = "Flow can't find this file in the project."

function isCallable(piece: StorylinePiece | undefined): boolean {
  return piece !== undefined && (piece.kind === 'function' || piece.kind === 'method')
}

/** The reading order of a story's pieces: its ways in, then the files in order, each top to bottom. */
function readingOrder(result: StorylineResult): string[] {
  const fileIndex = new Map(result.files.map((file, index) => [file, index]))
  const byFile = [...result.pieces].sort(
    (a, b) => (fileIndex.get(a.file) ?? result.files.length) - (fileIndex.get(b.file) ?? result.files.length) || a.startLine - b.startLine,
  )
  const ids = new Set(result.pieces.map((piece) => piece.id))
  const order: string[] = []
  for (const entry of result.entries) if (ids.has(entry.pieceId) && !order.includes(entry.pieceId)) order.push(entry.pieceId)
  for (const piece of byFile) if (!order.includes(piece.id)) order.push(piece.id)
  return order
}

/** A why for a note whose code the sheet does not hold. */
function looseMessage(view: ReviewNoteView): string {
  const prediction = view.prediction
  if (prediction === undefined) return NOTE_CODE_UNREAD
  if (prediction.fileMissing === true && prediction.codeUnavailable !== true) return NOTE_FILE_MISSING
  return noteMissingSentence(view) ?? NOTE_CODE_UNREAD
}

/** Whether a note's words name a function — `ChatThreadPage.memberPage` or `memberPage`, as a whole word. */
export function wordsName(words: string, name: string): boolean {
  const short = name.slice(name.lastIndexOf('.') + 1)
  return [...new Set([name, short])]
    .filter((entry) => entry !== '')
    .some((entry) => {
      const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^\\w$])${escaped}($|[^\\w$])`).test(words)
    })
}

function builtPiece(prediction: StorylineNotePrediction | undefined, pieces: ReadonlyMap<string, StorylinePiece>): string | null {
  if (prediction?.kind !== 'note-new' || prediction.pieceId === undefined) return null
  return pieces.has(prediction.pieceId) ? prediction.pieceId : null
}

/** What the review lays on the story in `mode`. `result` is null when the story could not be read. */
export function buildReviewOverlay(result: StorylineResult | null, views: readonly ReviewNoteView[], mode: ReviewMode): ReviewOverlay {
  const pieces = new Map((result?.pieces ?? []).map((piece) => [piece.id, piece]))
  const notesOn = mode !== 'today'

  // A function the plan adds and the run already built is not Today's, and in
  // Proposal it is the dashed proposal — its real box belongs to Verify.
  const hidden = new Set<string>()
  if (mode !== 'verify') {
    for (const view of views) {
      const built = builtPiece(view.prediction, pieces)
      if (built !== null) hidden.add(built)
    }
  }
  const draw = result === null ? [] : readingOrder(result).filter((id) => !hidden.has(id))
  const entry =
    draw.find((id) => result?.entries.some((entryOf) => entryOf.pieceId === id) === true) ??
    draw.find((id) => isCallable(pieces.get(id))) ??
    draw[0] ??
    null

  const overlay: ReviewOverlay = {
    mode,
    draw,
    hidden: [...hidden],
    entry,
    highlights: {},
    pieceNotes: {},
    badges: {},
    messages: {},
    ghosts: [],
    loose: [],
    fileNotes: [],
    willCall: [],
    noteBox: {},
  }
  if (!notesOn) return overlay

  const drawnSet = new Set(draw)
  const onPiece = (id: string, n: number, badge: 'change' | 'new', message: string | null): void => {
    overlay.pieceNotes[id] = [...(overlay.pieceNotes[id] ?? []), n]
    overlay.badges[id] = overlay.badges[id] ?? badge
    if (message !== null && overlay.messages[id] === undefined) overlay.messages[id] = message
    overlay.noteBox[n] = id
  }
  const highlight = (id: string, range: LineRange | undefined): void => {
    if (mode !== 'proposal' || range === undefined || !drawnSet.has(id)) return
    overlay.highlights[id] = [...(overlay.highlights[id] ?? []), range]
  }
  const loose = (view: ReviewNoteView, kind: 'file' | 'missing'): void => {
    const { note, prediction } = view
    const file = prediction?.file ?? (note.project === undefined ? note.file : `${note.project}/${note.file}`)
    const id = `note-${kind}:${String(note.n)}`
    overlay.loose.push({ id, kind, name: kind === 'file' ? null : (note.symbol ?? null), file, notes: [note.n], message: looseMessage(view) })
    overlay.noteBox[note.n] = id
  }

  // Per piece, its change notes' marked lines and words — where a "will call" may leave from.
  const changeQuotes = new Map<string, Array<{ range: LineRange; words: string }>>()
  const ordered = [...views].sort((a, b) => a.note.n - b.note.n)
  // Change notes first: a caller wired to a new function leaves from its own note's quoted line.
  for (const view of ordered) {
    const { note, prediction } = view
    if (note.kind !== 'change') continue
    const pieceId = prediction?.kind === 'note-change' && prediction.pieceMissing !== true ? prediction.pieceId : undefined
    if (pieceId === undefined || !drawnSet.has(pieceId)) {
      loose(view, 'missing')
      continue
    }
    onPiece(pieceId, note.n, 'change', noteMissingSentence(view))
    if (prediction?.kind === 'note-change') {
      highlight(pieceId, prediction.quoteLines)
      if (prediction.quoteLines !== undefined && (overlay.highlights[pieceId] ?? []).includes(prediction.quoteLines)) {
        const words = [note.where, note.what, note.why].filter((part): part is string => part !== undefined).join('\n')
        changeQuotes.set(pieceId, [...(changeQuotes.get(pieceId) ?? []), { range: prediction.quoteLines, words }])
      }
    }
  }
  /**
   * The line a "will call" leaves from: the marked line of a change note on
   * that caller whose words name the new function — never just the caller's
   * first mark, which may be another note's. None names it: the box itself.
   */
  const callLine = (caller: string, name: string): number | null => {
    if (name === '') return null
    return changeQuotes.get(caller)?.find((quote) => wordsName(quote.words, name))?.range.startLine ?? null
  }

  for (const view of ordered) {
    const { note, prediction } = view
    if (note.kind === 'file') {
      const file = prediction?.file ?? (note.project === undefined ? note.file : `${note.project}/${note.file}`)
      const own = draw.filter((id) => pieces.get(id)?.file === file)
      if (prediction === undefined || prediction.codeUnavailable === true || prediction.fileMissing === true || own.length === 0) {
        loose(view, 'file')
        continue
      }
      const holder = prediction.kind === 'note-file' && prediction.pieceId !== undefined && drawnSet.has(prediction.pieceId) ? prediction.pieceId : undefined
      if (holder !== undefined && prediction.kind === 'note-file') highlight(holder, prediction.quoteLines)
      let entryFor = overlay.fileNotes.find((entryOf) => entryOf.file === file)
      if (entryFor === undefined) {
        entryFor = { file, notes: [], messages: [] }
        overlay.fileNotes.push(entryFor)
      }
      entryFor.notes.push(note.n)
      if (prediction.kind === 'note-file' && prediction.quoteMissing === true) {
        entryFor.messages.push(
          prediction.quoteCount !== undefined && prediction.quoteCount > 1
            ? `Note ${String(note.n)}: Flow finds this code ${String(prediction.quoteCount)} times in today's file, so it marks none of them.`
            : `Note ${String(note.n)}: Flow can't find this code in today's file.`,
        )
      }
      overlay.noteBox[note.n] = holder ?? own[0] ?? ''
      continue
    }
    if (note.kind !== 'new') continue
    const built = builtPiece(prediction, pieces)
    if (mode === 'verify' && built !== null && drawnSet.has(built)) {
      onPiece(built, note.n, 'new', null)
      continue
    }
    const file = prediction?.file ?? (note.project === undefined ? note.file : `${note.project}/${note.file}`)
    const id = `note-new:${String(note.n)}`
    const callers =
      prediction?.kind === 'note-new'
        ? [...new Set(Object.values(prediction.callerPieces))].filter((callerId) => drawnSet.has(callerId) && callerId !== id)
        : []
    overlay.ghosts.push({ id, n: note.n, name: note.symbol ?? prediction?.file ?? '', file, callers })
    overlay.noteBox[note.n] = id
    for (const caller of callers) {
      overlay.willCall.push({ from: caller, fromLine: callLine(caller, note.symbol ?? ''), to: id })
    }
  }
  for (const [id, list] of Object.entries(overlay.pieceNotes)) overlay.pieceNotes[id] = [...list].sort((a, b) => a - b)
  return overlay
}

/**
 * The story's layout with the review's boxes placed: a new function in its
 * file's cell one column right of its rightmost caller (the last call column
 * when no caller is drawn); a box with no code in the first column, in its
 * file's cell. Every cell is a file's (`byFile`), so each file keeps its label.
 */
export function placeReviewBoxes(plan: StoryPlan, overlay: ReviewOverlay): StoryPlan {
  if (overlay.ghosts.length === 0 && overlay.loose.length === 0) return plan
  const lastCallColumn = Math.max(0, ...plan.order.map((id) => plan.columns[id] ?? 0))
  let cells = [...plan.cells]
  const columns = { ...plan.columns }
  const place = (id: string, col: number, file: string): void => {
    columns[id] = col
    const row = STORY_ROW.function
    const existing = cells.find((cell) => cell.col === col && cell.row === row && cell.file === file)
    if (existing === undefined) {
      const cell: StoryCell = { col, row, file, pieceIds: [id] }
      cells = [...cells, cell].sort((a, b) => a.col - b.col || a.row - b.row)
      return
    }
    cells = cells.map((cell) => (cell === existing ? { ...cell, pieceIds: [...cell.pieceIds, id] } : cell))
  }
  for (const box of overlay.loose) place(box.id, 0, box.file)
  for (const ghost of overlay.ghosts) {
    const callerColumns = ghost.callers.map((id) => plan.columns[id]).filter((col): col is number => col !== undefined)
    place(ghost.id, callerColumns.length > 0 ? Math.max(...callerColumns) + 1 : lastCallColumn, ghost.file)
  }
  // THE DATA COLUMN STAYS LAST: a new function right of the last caller pushes it one further.
  const dataColumn = Math.max(plan.dataColumn, ...overlay.ghosts.map((ghost) => (columns[ghost.id] ?? 0) + 1))
  if (dataColumn !== plan.dataColumn) {
    cells = cells.map((cell) => (cell.row === STORY_ROW.data ? { ...cell, col: dataColumn } : cell)).sort((a, b) => a.col - b.col || a.row - b.row)
    for (const cell of cells) if (cell.row === STORY_ROW.data) for (const id of cell.pieceIds) columns[id] = dataColumn
  }
  return {
    ...plan,
    columns,
    cells,
    drawn: [...plan.drawn, ...overlay.loose.map((box) => box.id), ...overlay.ghosts.map((ghost) => ghost.id)],
    dataColumn,
  }
}

/**
 * The lines of a box the review must keep on screen: a long piece opens on
 * its first lines, and grows to reach its last quoted line (plus a little
 * context) rather than folding the note's place away.
 */
export const REVIEW_HIT_CONTEXT_LINES = 3

export function shownLinesFor(totalLines: number, previewLines: number, startLine: number, highlights: readonly LineRange[] | undefined): number {
  const last = Math.max(-1, ...(highlights ?? []).map((range) => range.endLine - startLine))
  if (last < 0) return Math.min(previewLines, totalLines)
  return Math.min(totalLines, Math.max(previewLines, last + 1 + REVIEW_HIT_CONTEXT_LINES))
}
