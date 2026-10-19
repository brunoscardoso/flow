/**
 * CODE STORYLINE — what the VIEW decides, without a DOM. PURE.
 *
 * `storyline-model.ts` decides the story (which pieces, in what order, in
 * which column). This module decides how each piece is WRITTEN on its box and
 * how the wires between boxes run: which line of the code is the call line,
 * where on that line the callee's name sits (so it can be underlined and
 * pressed), which chip a call into another file gets, the badge a box wears,
 * the curve a wire takes from measured rectangles, and the camera that opens
 * the sheet.
 *
 * SEPARATE FROM `storyline-view.ts` because the app's jest runs in a node
 * environment with no DOM: everything that can be wrong about offsets and
 * geometry is here, where it can be tested; the view only turns these answers
 * into elements.
 *
 * The renderer never parses code. A call's LINE comes from the CLI's
 * extraction; this module only finds the callee's NAME on that line, so it can
 * be underlined — and when the name cannot be found, the line is still tinted
 * and the wire still lands on it.
 */
import type {
  PlanNoteVerdict,
  StorylineNote,
  StorylineNotePrediction,
  StorylinePiece,
  StorylineResult,
} from '../../shared/ipc-contract'
import { isStorylineExtensionPath, MIXED_STORYLINE_LANGUAGE, STORYLINE_LANGUAGE_LABELS } from '../../shared/storyline-languages'
import { STORY_ROW, type StoryMark, type StoryPlan } from './storyline-model'

/** The scale the sheet opens at: readable, not fit-all. */
export const STORY_OPEN_SCALE = 0.85
/** …and in a narrow pane, where 0.85 would show a single box. */
export const STORY_NARROW_SCALE = 0.6
/** Below this viewport width the narrow scale applies. */
export const STORY_NARROW_VIEWPORT_PX = 700
/** Margin between the viewport's edge and the story's first box when it opens. */
export const STORY_OPEN_MARGIN_PX = 24
/** Where a followed callee lands, measured from the viewport's top. */
export const STORY_FOLLOW_TOP_PX = 56
/** The zoom step of the header's − and + buttons. */
export const STORY_ZOOM_STEP = 1.2
/** Padding around the story when Fit frames all of it. */
export const STORY_FIT_PADDING_PX = 32
/** Where a call wire lands on its callee: the middle of the box's header row. */
export const STORY_WIRE_HEADER_Y = 17
/** Where a type wire leaves its box when there is no call line to leave from. */
export const STORY_TYPE_WIRE_Y = 26
/** The least horizontal pull of a wire's curve, so short hops still bend. */
export const STORY_WIRE_MIN_PULL = 46
/** How much of the horizontal distance becomes the curve's pull. */
export const STORY_WIRE_PULL_RATIO = 0.45
/** The numbered dot sits just above-left of the callee's corner. */
export const STORY_DOT_OFFSET = { x: -4, y: -6 } as const

/** True when a file can be read as a story — any language the CLI has a reader for (`shared/storyline-languages`). */
export function isStorylinePath(path: string): boolean {
  return isStorylineExtensionPath(path)
}

/** Monaco's id for a story language where it differs from the CLI's. */
const MONACO_LANGUAGE: Readonly<Record<string, string>> = { bash: 'shell' }

/**
 * The Monaco language a box is coloured with: the story's own language, or —
 * in a part mixing languages — the language of the box's own file.
 */
export function monacoLanguageFor(language: string, file: string): string {
  let id = language
  if (language === MIXED_STORYLINE_LANGUAGE) {
    const tail = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
    const dot = tail.lastIndexOf('.')
    const extension = dot <= 0 ? '' : tail.slice(dot)
    id = STORYLINE_LANGUAGE_LABELS.find((label) => label.extensions.includes(extension))?.id ?? 'plaintext'
  }
  return MONACO_LANGUAGE[id] ?? id
}

/** The last path segment — the name a reader navigates by. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Each file's label on a sheet: its name, or as many of its last folders as
 * it takes to tell it from another drawn file of the same name
 * (`types/chats.ts`, `fixtures/chats.ts`).
 */
export function fileLabels(files: readonly string[]): Map<string, string> {
  const unique = [...new Set(files)]
  const tail = (file: string, depth: number): string => file.split('/').slice(-depth).join('/')
  const labels = new Map<string, string>()
  for (const file of unique) {
    const segments = file.split('/').length
    let depth = 1
    while (depth < segments && unique.some((other) => other !== file && tail(other, depth) === tail(file, depth))) depth += 1
    labels.set(file, tail(file, depth))
  }
  return labels
}

const LEADING_SPACE = /^[ \t]*/

/**
 * The piece's lines with the declaration's own indentation removed.
 *
 * The CLI slices a piece from its first token, so line 1 starts flush while
 * every later line keeps the file's indentation (a method body is indented
 * twice). The common indent of the later, non-blank lines is that offset.
 */
export function dedentLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const rest = lines.slice(1).filter((line) => line.trim() !== '')
  if (rest.length === 0) return lines
  const indent = Math.min(...rest.map((line) => (LEADING_SPACE.exec(line)?.[0] ?? '').length))
  if (indent === 0) return lines
  return lines.map((line, index) => (index === 0 ? line : line.slice(Math.min(indent, (LEADING_SPACE.exec(line)?.[0] ?? '').length))))
}

export interface TextSpan {
  start: number
  end: number
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where `name` is CALLED on a line: the identifier followed by `(` (or a
 * generic `<…>(`); else the identifier anywhere, whole-word. Null when the
 * name is not on the line at all.
 */
export function findCallSpan(line: string, name: string): TextSpan | null {
  if (name === '') return null
  const word = escapeRegExp(name)
  const called = new RegExp(`(?<![\\w$])${word}(?=\\s*(?:<[^()]*>)?\\s*\\()`).exec(line)
  const match = called ?? new RegExp(`(?<![\\w$])${word}(?![\\w$])`).exec(line)
  if (match === null) return null
  return { start: match.index, end: match.index + name.length }
}

/** The name a call to `piece` is written with: a constructor is `new Class(`. */
export function calledName(piece: StorylinePiece): string {
  if (piece.isConstructor === true && piece.className !== undefined) return piece.className
  return piece.name
}

export interface LineFollow {
  /** The called piece. */
  to: string
  /** Where its name sits on the line, or null when it could not be found. */
  span: TextSpan | null
}

export interface LineChip {
  file: string
  name: string
  /** `learn-log.ts` — the file a reader navigates to. */
  label: string
}

/** Everything one line of a box carries besides its code. */
export interface LineDecor {
  /** The line calls a drawn piece: tinted, and wires leave from it. */
  callsite: boolean
  follows: LineFollow[]
  chips: LineChip[]
  /** The line calls a piece of this file that is not on this path. */
  notOnPath: boolean
}

function emptyDecor(): LineDecor {
  return { callsite: false, follows: [], chips: [], notOnPath: false }
}

/**
 * Decorate a piece's shown lines from its marks.
 *
 * `shown` is how many lines the box prints (a folded long piece prints a
 * preview); a mark on a line not shown decorates nothing. An unresolved call
 * decorates nothing either — it stays plain text on its line, honest rather
 * than guessed.
 */
export function decorateLines(
  piece: StorylinePiece,
  lines: readonly string[],
  marks: readonly StoryMark[],
  pieces: ReadonlyMap<string, StorylinePiece>,
  shown: number = lines.length,
): LineDecor[] {
  const decor = lines.slice(0, shown).map(() => emptyDecor())
  for (const mark of marks) {
    const index = mark.line - piece.startLine
    const line = lines[index]
    const slot = decor[index]
    if (line === undefined || slot === undefined) continue
    if (mark.kind === 'follow' && mark.to !== undefined) {
      if (slot.follows.some((follow) => follow.to === mark.to)) continue
      const callee = pieces.get(mark.to)
      const taken = slot.follows.map((follow) => follow.span)
      const span = callee === undefined ? null : findCallSpanAfter(line, calledName(callee), taken)
      decor[index] = { ...slot, callsite: true, follows: [...slot.follows, { to: mark.to, span }] }
    } else if (mark.kind === 'chip' && mark.file !== undefined) {
      const name = mark.name ?? ''
      if (slot.chips.some((chip) => chip.file === mark.file && chip.name === name)) continue
      decor[index] = { ...slot, chips: [...slot.chips, { file: mark.file, name, label: fileName(mark.file) }] }
    } else if (mark.kind === 'not-on-path') {
      decor[index] = { ...slot, notOnPath: true }
    }
  }
  return decor
}

/** The first call span of `name` that does not overlap a span already taken on the line. */
function findCallSpanAfter(line: string, name: string, taken: ReadonlyArray<TextSpan | null>): TextSpan | null {
  let from = 0
  while (from < line.length) {
    const found = findCallSpan(line.slice(from), name)
    if (found === null) return null
    const span = { start: found.start + from, end: found.end + from }
    const overlaps = taken.some((other) => other !== null && span.start < other.end && other.start < span.end)
    if (!overlaps) return span
    from = span.end
  }
  return null
}

/** One token of a line, as Monaco's `editor.tokenize` reports it. */
export interface LineToken {
  offset: number
  className: string | null
}

/** A run of a line's text: its token class, and the follow it belongs to. */
export interface LineRun {
  text: string
  className: string | null
  /** Index into the line's `follows`, when the run is (part of) a callee's name. */
  follow: number | null
}

/**
 * Cut one line into runs by its tokens AND its followable spans.
 *
 * The property that must never break: the runs' text, concatenated, is the
 * line exactly. Colour and underline are presentation; a reader copying the
 * code must get the code.
 */
export function planLineRuns(line: string, tokens: readonly LineToken[] | null, follows: readonly LineFollow[]): LineRun[] {
  const cuts = new Set<number>([0, line.length])
  const classAt: Array<{ offset: number; className: string | null }> = []
  for (const token of tokens ?? []) {
    if (token.offset < 0 || token.offset > line.length) continue
    cuts.add(token.offset)
    classAt.push(token)
  }
  follows.forEach((follow) => {
    if (follow.span === null) return
    cuts.add(Math.max(0, Math.min(line.length, follow.span.start)))
    cuts.add(Math.max(0, Math.min(line.length, follow.span.end)))
  })
  const points = [...cuts].sort((a, b) => a - b)
  const runs: LineRun[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] as number
    const end = points[i + 1] as number
    if (end <= start) continue
    let className: string | null = null
    for (const token of classAt) if (token.offset <= start) className = token.className
    const follow = follows.findIndex((entry) => entry.span !== null && entry.span.start <= start && end <= entry.span.end)
    runs.push({ text: line.slice(start, end), className, follow: follow === -1 ? null : follow })
  }
  return runs.length === 0 ? [{ text: line, className: null, follow: null }] : runs
}

export type BadgeTone = 'class' | 'type' | 'plain'

/** The kind badge on a box: `method` in the class hue, data structures in the type hue. */
export function kindBadge(piece: StorylinePiece): { text: string; tone: BadgeTone } {
  if (piece.isConstructor === true) return { text: 'constructor', tone: 'class' }
  // A few lines of a file a plan's file note is about — not a declaration.
  if (piece.kind === 'excerpt') return { text: 'lines', tone: 'plain' }
  if (piece.kind === 'method') return { text: 'method', tone: 'class' }
  if (piece.kind === 'interface' || piece.kind === 'type' || piece.kind === 'enum') return { text: piece.kind, tone: 'type' }
  return { text: piece.kind, tone: 'plain' }
}

/** The name a box prints in its header. */
export function boxName(piece: StorylinePiece): string {
  if (piece.isConstructor === true && piece.className !== undefined) return `new ${piece.className}`
  return piece.name
}

/** `L1255 · 50 lines` — where the piece is, and how long. */
export function whereLabel(piece: StorylinePiece): string {
  const lines = piece.endLine - piece.startLine + 1
  return `L${String(piece.startLine)} · ${String(lines)} ${lines === 1 ? 'line' : 'lines'}`
}

/** `L786 · constructor(deps: Deps)` — the class frame's caption. */
export function frameCaption(startLine: number, constructorSignature: string | undefined): string {
  return constructorSignature === undefined ? `L${String(startLine)}` : `L${String(startLine)} · ${constructorSignature}`
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/** The foot's sentence: how big the story is and how much of it leaves. */
export function storySummary(result: StorylineResult, plan: StoryPlan): string {
  const pieces = new Map(result.pieces.map((piece) => [piece.id, piece]))
  const callables = plan.order.length
  const data = plan.drawn.length - callables
  const leaving = new Set<string>()
  for (const id of plan.drawn) {
    for (const mark of plan.marks[id] ?? []) if (mark.kind === 'chip' && mark.file !== undefined) leaving.add(`${mark.file}#${mark.name ?? ''}`)
  }
  const entry = pieces.get(plan.entry)
  const where = result.scope === 'part' ? 'this part' : 'this file'
  const parts = [
    entry === undefined ? null : `Starts at ${boxName(entry)}`,
    plural(callables, 'function', 'functions'),
    plural(data, 'data structure', 'data structures'),
    `${plural(leaving.size, 'call leaves', 'calls leave')} ${where}`,
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

/**
 * The grid rows of the sheet: one row per class frame (members), then the
 * module functions, if any. Data structures span every row present.
 */
export interface StoryRows {
  /** `<file>|<className>` → 1-based grid row. */
  classRow: Map<string, number>
  functionRow: number | null
  /** How many rows there are. */
  count: number
}

export function classKey(file: string, className: string): string {
  return `${file}|${className}`
}

export function storyRows(plan: StoryPlan): StoryRows {
  const classRow = new Map<string, number>()
  let next = 1
  for (const frame of plan.frames) {
    const key = classKey(frame.file, frame.className)
    if (classRow.has(key)) continue
    classRow.set(key, next)
    next += 1
  }
  const hasFunctions = plan.cells.some((cell) => cell.row === STORY_ROW.function)
  const functionRow = hasFunctions ? next : null
  if (hasFunctions) next += 1
  return { classRow, functionRow, count: Math.max(1, next - 1) }
}

/** A rectangle in stage coordinates (unscaled). */
export interface StoryRect {
  x: number
  y: number
  w: number
  h: number
}

export interface WireGeometry {
  /** SVG path data. */
  d: string
  /** Where the numbered dot sits (the callee's corner). */
  dot: { x: number; y: number }
  /** True when the wire runs back to a box at or left of its caller. */
  back: boolean
}

/**
 * The curve of one wire, from measured rectangles.
 *
 * A call leaves the RIGHT edge of its call line (the line's vertical middle)
 * and enters the callee's header from the left. A call to a box at or left of
 * the caller (a back-call to a box already drawn) would cross its own box that
 * way, so it enters the callee's header from the RIGHT instead, looping out
 * past both. A type wire leaves near the top of its box.
 */
export function wireGeometry(kind: 'call' | 'type', from: StoryRect, line: StoryRect | null, to: StoryRect): WireGeometry {
  const x1 = from.x + from.w
  const y1 = kind === 'call' && line !== null ? line.y + line.h / 2 : from.y + Math.min(from.h - 10, kind === 'call' ? STORY_WIRE_HEADER_Y : STORY_TYPE_WIRE_Y)
  const y2 = to.y + STORY_WIRE_HEADER_Y
  const dot = { x: to.x + STORY_DOT_OFFSET.x, y: to.y + STORY_DOT_OFFSET.y }
  const forwardX = to.x - (kind === 'call' ? 2 : 0)
  if (forwardX >= x1) {
    const pull = Math.max(STORY_WIRE_MIN_PULL, Math.abs(forwardX - x1) * STORY_WIRE_PULL_RATIO)
    return { d: curve(x1, y1, x1 + pull, y1, forwardX - pull, y2, forwardX, y2), dot, back: false }
  }
  const backX = to.x + to.w + (kind === 'call' ? 2 : 0)
  const reach = Math.max(x1, backX) + STORY_WIRE_MIN_PULL * 2
  return { d: curve(x1, y1, reach, y1, reach, y2, backX, y2), dot, back: true }
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10)
}

function curve(x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number): string {
  return `M${round(x1)} ${round(y1)} C${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(x2)} ${round(y2)}`
}

export interface ViewportSize {
  w: number
  h: number
}

/** The camera the sheet opens with: readable, the story's top-left on screen. */
export function openingCamera(content: { x: number; y: number }, viewport: ViewportSize): { x: number; y: number; k: number } {
  const k = viewport.w < STORY_NARROW_VIEWPORT_PX ? STORY_NARROW_SCALE : STORY_OPEN_SCALE
  return { k, x: STORY_OPEN_MARGIN_PX - content.x * k, y: STORY_OPEN_MARGIN_PX - content.y * k }
}

/**
 * The camera that brings `box` into view to be read: never below the opening
 * scale, the box centred across (or its left edge in view when it is wider
 * than the viewport), its top just under the viewport's top.
 */
export function followCamera(current: { k: number }, box: StoryRect, viewport: ViewportSize): { x: number; y: number; k: number } {
  const k = Math.max(current.k, viewport.w < STORY_NARROW_VIEWPORT_PX ? STORY_NARROW_SCALE : STORY_OPEN_SCALE)
  const width = box.w * k
  const x = width + STORY_OPEN_MARGIN_PX * 2 > viewport.w ? STORY_OPEN_MARGIN_PX - box.x * k : viewport.w / 2 - (box.x + box.w / 2) * k
  return { k, x, y: STORY_FOLLOW_TOP_PX - box.y * k }
}

/** The piece a chip into another file should open at: by name, else none. */
export function pieceNamed(result: StorylineResult, name: string | null | undefined): string | null {
  if (name === null || name === undefined || name === '') return null
  const callable = result.pieces.find((piece) => (piece.kind === 'function' || piece.kind === 'method') && piece.name === name)
  if (callable !== undefined) return callable.id
  return result.pieces.find((piece) => piece.name === name)?.id ?? null
}

/** A run of this many comment lines or more is folded to one line. */
export const COMMENT_FOLD_MIN_LINES = 3

/** A folded stretch of comment lines: 0-based, inclusive. */
export interface CommentRun {
  start: number
  end: number
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
}

/**
 * LONG COMMENTS FOLD (the approved mockup hid them): this codebase explains
 * itself in long comment blocks, and drawn in full they turn a twenty-line
 * method into a box a screen tall. Runs of `COMMENT_FOLD_MIN_LINES` or more
 * consecutive comment-only lines, within the lines shown, fold to one line a
 * reader can open. A line that makes a call is never folded.
 */
export function commentRuns(lines: readonly string[], shown: number, isCallsite: (index: number) => boolean): CommentRun[] {
  const runs: CommentRun[] = []
  let start = -1
  const close = (end: number): void => {
    if (start !== -1 && end - start + 1 >= COMMENT_FOLD_MIN_LINES) runs.push({ start, end })
    start = -1
  }
  for (let index = 0; index < shown; index += 1) {
    const comment = isCommentLine(lines[index] ?? '') && !isCallsite(index)
    if (comment && start === -1) start = index
    if (!comment) close(index - 1)
  }
  close(shown - 1)
  return runs
}

// ── Plan change review (plan `plan_change_review`) ────────────────────────
//
// A plan with change notes opens its code story as a REVIEW: Today (the code,
// nothing proposed), Proposal (each note under its function, the quoted lines
// marked, a new function as a dashed box wired to its callers) and Verify (the
// real diff beside each note, and its verdict). The story is laid out like any
// story; what the review lays on it is `story-review-overlay.ts`. This half
// holds the modes, the notes' words and the verdicts.

/** The three ways a reviewed plan's story is shown. */
export type ReviewMode = 'today' | 'proposal' | 'verify'

/** One note, with what the story knows about where it lands. */
export interface ReviewNoteView {
  note: StorylineNote
  /** The storyline's prediction for it — absent when no story could be read. */
  prediction?: StorylineNotePrediction
}

/** Today and Proposal always; Verify once the plan has a starting point or a verdict. */
export function reviewModes(compare: { base: string | null } | undefined, notes: readonly StorylineNote[]): ReviewMode[] {
  const verify = (compare !== undefined && compare.base !== null) || notes.some((note) => note.verdict !== undefined)
  return verify ? ['today', 'proposal', 'verify'] : ['today', 'proposal']
}

/** The labels on the switch, with what each shows. */
export const REVIEW_MODE_LABELS: Readonly<Record<ReviewMode, { label: string; title: string }>> = {
  today: { label: 'Today', title: 'The code as it is, with nothing proposed' },
  proposal: { label: 'Proposal', title: "Where each of the plan's notes lands in the code, to accept or reject" },
  verify: { label: 'Verify', title: 'What execution really changed, beside each note and its verdict' },
}

/**
 * The notes on the sheet: the freshest read of the plan file wins over the
 * copy the storyline carried (Accept and Reject land in the file, and the
 * review re-reads it), matched by number. A note only the story knows about is
 * kept; the order is the file's.
 */
export function mergeReviewNotes(predictions: readonly StorylineNotePrediction[], fresh: readonly StorylineNote[] | null): ReviewNoteView[] {
  const byNumber = new Map(predictions.map((prediction) => [prediction.note.n, prediction]))
  const notes = fresh ?? predictions.map((prediction) => prediction.note)
  const views: ReviewNoteView[] = notes.map((note) => {
    const prediction = byNumber.get(note.n)
    return prediction === undefined ? { note } : { note, prediction }
  })
  if (fresh !== null) {
    const seen = new Set(fresh.map((note) => note.n))
    for (const prediction of predictions) if (!seen.has(prediction.note.n)) views.push({ note: prediction.note, prediction })
  }
  return views.sort((a, b) => a.note.n - b.note.n)
}

/** The sentence a box says instead of guessing where a note lands, or null. */
export function noteMissingSentence(view: ReviewNoteView): string | null {
  const prediction = view.prediction
  if (prediction === undefined) return null
  if (prediction.codeUnavailable === true) return "This project's code is not on this computer, so the note is shown without it."
  if (prediction.fileMissing === true) {
    return view.note.kind === 'change' ? "Flow can't find this file in the project." : null
  }
  if (prediction.kind !== 'note-change') return null
  if (prediction.pieceMissing === true) return `Flow can't find ${prediction.symbol} in today's file.`
  if (prediction.quoteMissing === true) {
    return prediction.quoteCount !== undefined && prediction.quoteCount > 1
      ? `Flow finds this code ${String(prediction.quoteCount)} times in today's file, so it marks none of them.`
      : "Flow can't find this code in today's file."
  }
  return null
}

/** One row of a note block: its label, its text, and whether the text is code. */
export interface NoteRow {
  label: string
  text: string
  code: boolean
}

/**
 * A note's words under its box: Where / What / Why for a change, Signature /
 * Purpose / Called by / Why for a new function, (Where /) What / Why for a file.
 * Rows the note does not carry are left out.
 */
export function noteRows(note: StorylineNote): NoteRow[] {
  const rows: NoteRow[] = []
  const add = (label: string, text: string | undefined, code = false): void => {
    if (text !== undefined && text.trim() !== '') rows.push({ label, text: text.trim(), code })
  }
  if (note.kind === 'new') {
    add('Signature', note.signature, true)
    add('Purpose', note.purpose)
    add('Called by', (note.callers ?? []).join(', '), true)
    add('Why', note.why)
    return rows
  }
  // A change note's quote, and a file note's when it quotes its place.
  add('Where', note.where, true)
  add('What', note.what)
  add('Why', note.why)
  return rows
}

/** The badge on a noted box. */
export function reviewBadgeLabel(badge: 'change' | 'new'): string {
  return badge === 'new' ? 'New' : 'Proposed change'
}

/** `note 1`, `notes 1, 3` — the box's corner. */
export function noteNumbersLabel(notes: readonly number[]): string {
  if (notes.length === 0) return ''
  return `${notes.length === 1 ? 'note' : 'notes'} ${notes.map(String).join(', ')}`
}

/** How a verdict reads in Verify, and its tone. */
export interface VerdictView {
  tone: 'ok' | 'differs' | 'no' | 'none'
  text: string
}

/**
 * A note's verdict in Verify: the recorded one with its sentence, else what
 * the real diff says about the note's function, else that nothing is known.
 */
export function verdictView(note: StorylineNote, fact: StorylineNotePrediction['fact']): VerdictView {
  const why = note.verdictWhy?.trim() ?? ''
  const tail = why === '' ? '' : ` — ${why}`
  if (note.verdict === 'done') return { tone: 'ok', text: `Done as described${tail}` }
  if (note.verdict === 'differs') return { tone: 'differs', text: `Differs${tail}` }
  if (note.verdict === 'not-built') return { tone: 'no', text: `Not built${tail}` }
  if (note.status === 'rejected') return { tone: 'none', text: 'Rejected — execution leaves this note out' }
  if (fact === 'changed') return { tone: 'none', text: 'The code changed here; no verdict recorded yet' }
  if (fact === 'added') return { tone: 'none', text: 'Added; no verdict recorded yet' }
  if (fact === 'removed') return { tone: 'none', text: 'Removed; no verdict recorded yet' }
  if (fact === 'unchanged') return { tone: 'none', text: 'Not changed yet' }
  return { tone: 'none', text: 'No verdict yet' }
}

/** The verdicts a person may record in Verify, with their labels. */
export const VERDICT_CHOICES: ReadonlyArray<{ verdict: PlanNoteVerdict; label: string }> = [
  { verdict: 'done', label: 'Done as described' },
  { verdict: 'differs', label: 'Differs' },
  { verdict: 'not-built', label: 'Not built' },
]
