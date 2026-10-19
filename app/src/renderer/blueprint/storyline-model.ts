/**
 * CODE STORYLINE — the layout of one story. PURE — no DOM, no IPC.
 *
 * The board reads a file (or a part's files) as a story: the entry point on
 * the left, every piece it calls to its right in call order, an arrow from
 * each call line to the callee. Methods of a class sit in row 1 inside a
 * frame for the class, module-level functions in a band below (row 2), and
 * the data structures the drawn pieces use in one last column (row 3).
 *
 * This module turns the CLI's answer (`StorylineResult`, extracted once) into
 * everything the view needs to draw a chosen entry's story: visit order and
 * step numbers, columns, cells, class frames, edges, and per-line marks
 * (follow an arrow, a chip into another file, a call off the path, a call
 * nobody could name). Picking another entry rebuilds the plan from the same
 * answer — no second extraction.
 */
import type {
  StorylineCompare,
  StorylineHunk,
  StorylineNotePrediction,
  StorylinePhasePrediction,
  StorylinePiece,
  StorylinePieceKind,
  StorylinePrediction,
  StorylineResult,
} from '../../shared/ipc-contract'

/** A piece longer than this many lines opens folded to a preview. */
export const DEFAULT_LONG_PIECE_LINES = 60
/** How many lines a folded long piece shows. */
export const DEFAULT_PREVIEW_LINES = 14

/** The column depth of the entry point. */
const ENTRY_COLUMN = 0

/** Rows of the sheet: class members, module functions, data structures. */
export const STORY_ROW = { member: 1, function: 2, data: 3 } as const
export type StoryRow = (typeof STORY_ROW)[keyof typeof STORY_ROW]

const DATA_KINDS: ReadonlySet<StorylinePieceKind> = new Set(['interface', 'type', 'enum'])
const CALLABLE_KINDS: ReadonlySet<StorylinePieceKind> = new Set(['function', 'method'])

export interface EntryOption {
  pieceId: string
  /** `enqueueModule()` or `LearnOrchestrator.enqueueModule()`. */
  label: string
  doc: string | null
  usedFrom: number
}

export interface StoryEdge {
  from: string
  to: string
  /** The call's line in `from`. */
  line: number
  /** The callee's step number. */
  step: number
}

export interface StoryTypeEdge {
  from: string
  to: string
}

export interface StoryCell {
  col: number
  row: StoryRow
  /** Part mode only: the file whose pieces this cell holds. */
  file?: string
  /** Ordered by step (data structures: by file order). */
  pieceIds: string[]
}

export interface StoryFrame {
  className: string
  file: string
  startLine: number
  constructorSignature?: string
  colStart: number
  colEnd: number
}

export type StoryMarkKind = 'follow' | 'chip' | 'not-on-path' | 'unresolved'

export interface StoryMark {
  line: number
  kind: StoryMarkKind
  /** follow / not-on-path: the called piece. */
  to?: string
  /** chip: the other file and the name called there. */
  file?: string
  /** chip: the external name; unresolved: the name as written. */
  name?: string
}

export interface StoryLongPiece {
  previewLines: number
  totalLines: number
}

export interface StoryPlan {
  entry: string
  /** Callable pieces in visit order (depth-first, calls sorted by line). */
  order: string[]
  /** Step number of each visited piece; the entry is 0. */
  stepOf: Record<string, number>
  /** Everything drawn: `order`, then the data structures they use. */
  drawn: string[]
  edges: StoryEdge[]
  typeEdges: StoryTypeEdge[]
  /** Column of each drawn piece; data structures share the last one. */
  columns: Record<string, number>
  /** The data-structure column (max call depth + 1). */
  dataColumn: number
  cells: StoryCell[]
  /**
   * One per class with at least one drawn member. Two classes may cover the
   * same columns (part mode, or a file with two classes); the view stacks
   * such frames rather than this model reshuffling columns.
   */
  frames: StoryFrame[]
  marks: Record<string, StoryMark[]>
  long: Record<string, StoryLongPiece>
  /** File → drawn piece ids, in file order of `result.files`. */
  fileGroups: Record<string, string[]>
}

export interface BuildStoryOptions {
  longPieceLines?: number
  previewLines?: number
  /**
   * Pieces drawn even when the entry does not reach them (a plan review draws
   * every piece of the plan's story): a function the walk has not visited is
   * walked as one more way in, from the first column; a data structure joins
   * the data column; anything else (a file note's excerpt) sits in the first
   * column, in its file's cell.
   */
  also?: readonly string[]
  /** Pieces never drawn, even when a drawn piece calls them. */
  hidden?: readonly string[]
  /** Group every cell by file, whatever the answer's scope (a review always names its files). */
  byFile?: boolean
}

/** `name()`, `Class.name()`, `new Class()`, `interface Name`. */
export function pieceLabel(piece: StorylinePiece): string {
  if (piece.isConstructor === true && piece.className !== undefined) return `new ${piece.className}()`
  if (piece.kind === 'method' && piece.className !== undefined) return `${piece.className}.${piece.name}()`
  if (piece.kind === 'function' || piece.kind === 'method') return `${piece.name}()`
  return `${piece.kind} ${piece.name}`
}

function isCallable(piece: StorylinePiece | undefined): boolean {
  return piece !== undefined && CALLABLE_KINDS.has(piece.kind)
}

function isData(piece: StorylinePiece | undefined): boolean {
  return piece !== undefined && DATA_KINDS.has(piece.kind)
}

function byFileOrder(result: StorylineResult): (a: StorylinePiece, b: StorylinePiece) => number {
  const fileIndex = new Map(result.files.map((file, index) => [file, index]))
  return (a, b) => {
    const fa = fileIndex.get(a.file) ?? result.files.length
    const fb = fileIndex.get(b.file) ?? result.files.length
    if (fa !== fb) return fa - fb
    return a.startLine - b.startLine
  }
}

/** Where the story opens: the top-ranked entry, else the first callable piece. */
export function defaultEntry(result: StorylineResult): string | null {
  const ranked = result.entries[0]
  if (ranked !== undefined) return ranked.pieceId
  const first = [...result.pieces].filter(isCallable).sort(byFileOrder(result))[0]
  return first?.id ?? null
}

/** Every way into the story, in rank order, ready for the picker. */
export function entryOptions(result: StorylineResult): EntryOption[] {
  const pieces = new Map(result.pieces.map((piece) => [piece.id, piece]))
  const options: EntryOption[] = []
  for (const entry of result.entries) {
    const piece = pieces.get(entry.pieceId)
    if (piece === undefined) continue
    options.push({ pieceId: piece.id, label: pieceLabel(piece), doc: piece.doc, usedFrom: entry.usedFrom })
  }
  return options
}

function rowOf(piece: StorylinePiece): StoryRow {
  if (isData(piece)) return STORY_ROW.data
  if (piece.className !== undefined) return STORY_ROW.member
  return STORY_ROW.function
}

function emptyPlan(entry: string): StoryPlan {
  return {
    entry,
    order: [],
    stepOf: {},
    drawn: [],
    edges: [],
    typeEdges: [],
    columns: {},
    dataColumn: ENTRY_COLUMN,
    cells: [],
    frames: [],
    marks: {},
    long: {},
    fileGroups: {},
  }
}

/** The calls leaving each piece that land on a callable piece, by line. */
function forwardCalls(result: StorylineResult, pieces: Map<string, StorylinePiece>): Map<string, Array<{ to: string; line: number }>> {
  const out = new Map<string, Array<{ to: string; line: number }>>()
  for (const call of result.calls) {
    if (call.to === null || !isCallable(pieces.get(call.to))) continue
    const list = out.get(call.from) ?? []
    out.set(call.from, [...list, { to: call.to, line: call.line }])
  }
  for (const [from, list] of out) out.set(from, [...list].sort((a, b) => a.line - b.line))
  return out
}

/**
 * Depth-first from the entry: visit order, plus the tree/forward edges (a
 * call to a piece still on the stack is a back edge — recursion or a cycle —
 * and does not push its callee further right).
 */
function walk(
  roots: readonly string[],
  calls: Map<string, Array<{ to: string; line: number }>>,
): { order: string[]; forward: Array<[string, string]> } {
  const order: string[] = []
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const forward: Array<[string, string]> = []
  const visit = (id: string): void => {
    visited.add(id)
    onStack.add(id)
    order.push(id)
    for (const call of calls.get(id) ?? []) {
      if (onStack.has(call.to)) continue
      forward.push([id, call.to])
      if (!visited.has(call.to)) visit(call.to)
    }
    onStack.delete(id)
  }
  // The entry first; each further root only when no earlier walk reached it.
  for (const root of roots) if (!visited.has(root)) visit(root)
  return { order, forward }
}

/**
 * Column = the longest call path from the entry over the non-back edges, so
 * every arrow except a back-call points right (the mockup's layout: `transition`
 * sits right of `runJob`, which calls it, not beside `admit`, which reached it
 * first).
 */
function callColumns(order: string[], forward: Array<[string, string]>, roots: readonly string[] = order.slice(0, 1)): Record<string, number> {
  const columns: Record<string, number> = {}
  const [entry] = order
  if (entry === undefined) return columns
  // Topological order of the acyclic forward graph: reverse DFS post-order.
  const children = new Map<string, string[]>()
  for (const [from, to] of forward) children.set(from, [...(children.get(from) ?? []), to])
  const post: string[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    seen.add(id)
    for (const child of children.get(id) ?? []) if (!seen.has(child)) visit(child)
    post.push(id)
  }
  for (const root of roots) if (!seen.has(root)) visit(root)
  for (const root of roots) columns[root] = ENTRY_COLUMN
  for (const id of [...post].reverse()) {
    const depth = columns[id] ?? ENTRY_COLUMN
    for (const child of children.get(id) ?? []) {
      columns[child] = Math.max(columns[child] ?? ENTRY_COLUMN, depth + 1)
    }
  }
  return columns
}

/** Data structures the drawn pieces use, and the ones those reference, transitively. */
function reachedData(
  callables: string[],
  result: StorylineResult,
  pieces: Map<string, StorylinePiece>,
): string[] {
  const uses = new Map<string, string[]>()
  for (const use of result.typeUses) uses.set(use.from, [...(uses.get(use.from) ?? []), use.to])
  const found = new Set<string>()
  const pending = callables.flatMap((id) => uses.get(id) ?? [])
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (found.has(id) || !isData(pieces.get(id))) continue
    found.add(id)
    pending.push(...(uses.get(id) ?? []))
  }
  return [...found]
    .map((id) => pieces.get(id) as StorylinePiece)
    .sort(byFileOrder(result))
    .map((piece) => piece.id)
}

function buildMarks(
  drawn: string[],
  drawnSet: ReadonlySet<string>,
  result: StorylineResult,
): Record<string, StoryMark[]> {
  const marks: Record<string, StoryMark[]> = {}
  for (const id of drawn) marks[id] = []
  for (const call of result.calls) {
    const list = marks[call.from]
    if (list === undefined) continue
    if (call.to !== null && drawnSet.has(call.to)) {
      list.push({ line: call.line, kind: 'follow', to: call.to })
    } else if (call.external !== undefined) {
      list.push({ line: call.line, kind: 'chip', file: call.external.file, name: call.external.name })
    } else if (call.to !== null) {
      list.push({ line: call.line, kind: 'not-on-path', to: call.to })
    } else if (call.unresolvedName !== undefined) {
      list.push({ line: call.line, kind: 'unresolved', name: call.unresolvedName })
    }
  }
  for (const id of drawn) marks[id] = [...(marks[id] ?? [])].sort((a, b) => a.line - b.line)
  return marks
}

function buildCells(
  drawn: string[],
  pieces: Map<string, StorylinePiece>,
  columns: Record<string, number>,
  stepOf: Record<string, number>,
  partMode: boolean,
): StoryCell[] {
  const cells = new Map<string, StoryCell>()
  for (const id of drawn) {
    const piece = pieces.get(id) as StorylinePiece
    const col = columns[id] ?? ENTRY_COLUMN
    const row = rowOf(piece)
    const key = partMode ? `${col}|${row}|${piece.file}` : `${col}|${row}`
    const cell = cells.get(key)
    if (cell === undefined) {
      cells.set(key, partMode ? { col, row, file: piece.file, pieceIds: [id] } : { col, row, pieceIds: [id] })
    } else {
      cells.set(key, { ...cell, pieceIds: [...cell.pieceIds, id] })
    }
  }
  // `drawn` lists callables by step, then data structures in file order —
  // so each cell is already in the right order; sort defensively by step.
  const position = new Map(drawn.map((id, index) => [id, index]))
  const rank = (id: string): number => stepOf[id] ?? drawn.length + (position.get(id) ?? 0)
  return [...cells.values()]
    .map((cell) => ({ ...cell, pieceIds: [...cell.pieceIds].sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => a.col - b.col || a.row - b.row)
}

function buildFrames(
  drawn: string[],
  pieces: Map<string, StorylinePiece>,
  columns: Record<string, number>,
  result: StorylineResult,
): StoryFrame[] {
  const frames: StoryFrame[] = []
  for (const cls of result.classes) {
    const memberCols = drawn
      .map((id) => pieces.get(id) as StorylinePiece)
      .filter((piece) => piece.className === cls.name && piece.file === cls.file && !isData(piece))
      .map((piece) => columns[piece.id] ?? ENTRY_COLUMN)
    if (memberCols.length === 0) continue
    const frame: StoryFrame = {
      className: cls.name,
      file: cls.file,
      startLine: cls.startLine,
      colStart: Math.min(...memberCols),
      colEnd: Math.max(...memberCols),
    }
    frames.push(cls.constructorSignature === undefined ? frame : { ...frame, constructorSignature: cls.constructorSignature })
  }
  return frames
}

/**
 * The ways in a walk really started from: the entry, and each further root
 * no forward edge reaches (a root a later walk calls is pushed right like
 * any callee, so its arrow still points right).
 */
function rootsOfWalk(roots: readonly string[], forward: ReadonlyArray<[string, string]>): string[] {
  const called = new Set(forward.map(([, to]) => to))
  return roots.filter((id, index) => index === 0 || !called.has(id))
}

/** The whole layout of the story that opens at `entryId`. */
export function buildStory(result: StorylineResult, entryId: string, options: BuildStoryOptions = {}): StoryPlan {
  const longPieceLines = options.longPieceLines ?? DEFAULT_LONG_PIECE_LINES
  const previewLines = options.previewLines ?? DEFAULT_PREVIEW_LINES
  const hidden = new Set(options.hidden ?? [])
  const pieces = new Map(result.pieces.filter((piece) => !hidden.has(piece.id)).map((piece) => [piece.id, piece]))
  if (!pieces.has(entryId)) return emptyPlan(entryId)

  const calls = forwardCalls(result, pieces)
  const also = (options.also ?? []).filter((id) => pieces.has(id) && id !== entryId)
  // The entry walks first; a function it never reaches is one more way in.
  const roots = [entryId, ...also.filter((id) => isCallable(pieces.get(id)))]
  const { order, forward } = walk(roots, calls)
  const stepOf: Record<string, number> = {}
  order.forEach((id, index) => {
    stepOf[id] = index
  })

  const visitedRoots = roots.filter((id, index) => index === 0 || order.includes(id))
  const callColumnsOf = callColumns(order, forward, rootsOfWalk(visitedRoots, forward))
  const maxDepth = Math.max(ENTRY_COLUMN, ...Object.values(callColumnsOf))
  const dataColumn = maxDepth + 1
  const reached = reachedData(order, result, pieces).filter((id) => !(id in stepOf))
  const data = [...reached, ...also.filter((id) => isData(pieces.get(id)) && !reached.includes(id) && !(id in stepOf))]
  // Neither a function nor a data structure (a file note's excerpt): the first column.
  const loose = also.filter((id) => !(id in stepOf) && !data.includes(id) && !isData(pieces.get(id)))
  const drawn = [...order, ...data, ...loose]
  const drawnSet = new Set(drawn)
  const columns: Record<string, number> = { ...callColumnsOf }
  for (const id of data) columns[id] = dataColumn
  for (const id of loose) columns[id] = ENTRY_COLUMN

  const edges: StoryEdge[] = result.calls
    .filter((call) => call.to !== null && drawnSet.has(call.from) && drawnSet.has(call.to))
    .map((call) => {
      const to = call.to as string
      return { from: call.from, to, line: call.line, step: stepOf[to] ?? drawn.length }
    })
    .sort((a, b) => (stepOf[a.from] ?? 0) - (stepOf[b.from] ?? 0) || a.line - b.line)

  const typeEdges: StoryTypeEdge[] = result.typeUses
    .filter((use) => drawnSet.has(use.from) && drawnSet.has(use.to))
    .map((use) => ({ from: use.from, to: use.to }))

  const long: Record<string, StoryLongPiece> = {}
  for (const id of drawn) {
    const piece = pieces.get(id) as StorylinePiece
    const totalLines = piece.endLine - piece.startLine + 1
    if (totalLines > longPieceLines) long[id] = { previewLines, totalLines }
  }

  const fileGroups: Record<string, string[]> = {}
  for (const file of result.files) {
    const ids = drawn.filter((id) => pieces.get(id)?.file === file)
    if (ids.length > 0) fileGroups[file] = ids
  }

  return {
    entry: entryId,
    order,
    stepOf,
    drawn,
    edges,
    typeEdges,
    columns,
    dataColumn,
    cells: buildCells(drawn, pieces, columns, stepOf, result.scope === 'part' || options.byFile === true),
    frames: buildFrames(drawn, pieces, columns, result),
    marks: buildMarks(drawn, drawnSet, result),
    long,
    fileGroups,
  }
}

// ── Today ⇄ After (plan `story-today-after`) ──────────────────────────────
//
// A story opened in a plan's context carries the CLI's comparison. This half
// decides, per piece and per time, what the sheet draws: its state, the text
// it shows (Today's text for a changed or removed piece), the diff lines of a
// changed piece in After, the plan's words for a prediction, the pieces that
// exist only on one side, and the foot's sentence. Prediction and fact never
// share a state: `predicted` and `planned` come only from the plan's words,
// `added` / `changed` / `removed` only from the code.

/** Which world the story shows. */
export type StoryTime = 'today' | 'after'

/** What a box is, in the time on screen. */
export type StoryPieceState = 'same' | 'added' | 'changed' | 'removed' | 'predicted' | 'planned'

/** A task caption longer than this is clamped; the full line is its title. */
export const STORY_CAPTION_MAX_CHARS = 90

/** One printed line of a box, with the After line it is (for calls and wires). */
export interface StoryDisplayLine {
  text: string
  /** `plain` — the code; `added` / `removed` — a line of the diff. */
  op: 'plain' | 'added' | 'removed'
  /** 0-based index into the After piece's lines, or null for a line After does not have. */
  afterIndex: number | null
}

export interface StoryPieceLook {
  state: StoryPieceState
  /** The box's pill, or null for none. */
  pill: string | null
  /** The plan's words under the header (clamped), and the whole line. */
  caption: string | null
  captionTitle: string | null
  /** The lines to print, when they are not simply the piece's own text. */
  lines: StoryDisplayLine[] | null
  /** Where the shown text sits in its file. */
  startLine: number
  endLine: number
  /** Diff lines the CLI left out (After), shown as "+N lines". */
  hiddenLines: number
  /** Today's text could only be rebuilt in part — the diff was capped. */
  partial: boolean
}

/** A box for something the plan names that has no code: a function, or a file. */
export interface StoryGhost {
  id: string
  kind: 'planned' | 'planned-file'
  /** `retry()`, or the file's name. */
  name: string
  file: string
  phase: number | null
  pill: string
  /** The plan's task line, whole — the ghost's body. */
  task: string
}

export interface StoryCompareView {
  time: StoryTime
  plan: string
  /** Every drawn piece's look (real pieces, removed pieces). */
  looks: Record<string, StoryPieceLook>
  /** Removed pieces to draw: real Today pieces the After story no longer has. */
  extras: StorylinePiece[]
  /** Planned functions and files — After only. */
  ghosts: StoryGhost[]
  /** Pieces of the After story not drawn in this time (added pieces, Today). */
  hidden: string[]
  /** Rail marks: a step's state when it is not `same` (After only). */
  rail: Record<string, StoryPieceState>
  /** The foot's sentence. */
  summary: string
  /** Why the starting point could not be read, or why some files were not compared. */
  note: string | null
}

/** True for a prediction read from a plan's phases (not from a change note). */
export function isPhasePrediction(prediction: StorylinePrediction): prediction is StorylinePhasePrediction {
  return prediction.kind === 'changes' || prediction.kind === 'planned' || prediction.kind === 'planned-file'
}

/** True for a prediction read from a change note (plan `plan_change_review`). */
export function isNotePrediction(prediction: StorylinePrediction): prediction is StorylineNotePrediction {
  return prediction.kind === 'note-change' || prediction.kind === 'note-new' || prediction.kind === 'note-file'
}

/** A comparison's change-note predictions, in plan order — empty for a plan without notes. */
export function notePredictionsOf(compare: StorylineCompare | undefined): StorylineNotePrediction[] {
  return compare === undefined ? [] : compare.predicted.filter(isNotePrediction)
}

/** `Changes in phase 2`, `Planned in phase 3` — the plan's own label for a prediction. */
export function predictionPill(kind: StorylinePhasePrediction['kind'], phase: number | null): string {
  if (kind === 'changes') return phase === null ? 'Changes in this plan' : `Changes in phase ${String(phase)}`
  return phase === null ? 'Planned in this plan' : `Planned in phase ${String(phase)}`
}

/** A caption clamped to `max` characters, with an ellipsis when it was cut. */
export function clampCaption(text: string, max: number = STORY_CAPTION_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

function pieceLines(piece: StorylinePiece): string[] {
  return piece.text.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * A changed piece's lines with its diff woven in: After's lines in order, each
 * hunk's removed lines inserted where they were. A capped diff keeps the rest
 * of After's lines plain — its removed lines past the cap are not known.
 */
export function diffDisplayLines(piece: StorylinePiece, hunks: readonly StorylineHunk[]): StoryDisplayLine[] {
  const after = pieceLines(piece)
  const out: StoryDisplayLine[] = []
  let cursor = 0
  const plainUntil = (end: number): void => {
    for (; cursor < Math.min(end, after.length); cursor += 1) out.push({ text: after[cursor] ?? '', op: 'plain', afterIndex: cursor })
  }
  for (const hunk of [...hunks].sort((a, b) => a.afterStart - b.afterStart)) {
    plainUntil(hunk.afterStart - piece.startLine)
    for (const line of hunk.lines) {
      if (line.op === 'removed') {
        out.push({ text: line.text, op: 'removed', afterIndex: null })
        continue
      }
      if (cursor >= after.length) continue
      out.push({ text: after[cursor] ?? line.text, op: line.op === 'added' ? 'added' : 'plain', afterIndex: cursor })
      cursor += 1
    }
  }
  plainUntil(after.length)
  return out
}

/**
 * Today's text of a changed piece, rebuilt from After and its diff: the woven
 * lines without the added ones. Exact whenever the diff was not capped.
 */
export function todayDisplayLines(woven: readonly StoryDisplayLine[]): StoryDisplayLine[] {
  return woven.filter((line) => line.op !== 'added').map((line) => ({ ...line, op: 'plain' as const }))
}

/** Where Today's piece started: the first hunk's Today line, less the unchanged lines before it. */
function todayStartLine(piece: StorylinePiece, hunks: readonly StorylineHunk[]): number {
  const first = [...hunks].sort((a, b) => a.afterStart - b.afterStart)[0]
  if (first === undefined) return piece.startLine
  return first.todayStart - (first.afterStart - piece.startLine)
}

function plainLook(piece: StorylinePiece, state: StoryPieceState = 'same'): StoryPieceLook {
  return {
    state,
    pill: null,
    caption: null,
    captionTitle: null,
    lines: null,
    startLine: piece.startLine,
    endLine: piece.endLine,
    hiddenLines: 0,
    partial: false,
  }
}

function predictionLook(piece: StorylinePiece, prediction: StorylinePhasePrediction): StoryPieceLook {
  const task = prediction.task.trim()
  return {
    ...plainLook(piece, 'predicted'),
    pill: predictionPill(prediction.kind, prediction.phase),
    caption: task === '' ? null : clampCaption(task),
    captionTitle: task === '' ? null : task,
  }
}

function changedLook(piece: StorylinePiece, compare: StorylineCompare, time: StoryTime): StoryPieceLook {
  const hunks = compare.hunks[piece.id] ?? []
  const hidden = compare.hiddenLines[piece.id] ?? 0
  const woven = diffDisplayLines(piece, hunks)
  if (time === 'after') {
    return { ...plainLook(piece, 'changed'), pill: 'Changed', lines: woven, hiddenLines: hidden }
  }
  const lines = todayDisplayLines(woven)
  const startLine = todayStartLine(piece, hunks)
  return { ...plainLook(piece, 'same'), lines, startLine, endLine: startLine + lines.length - 1, partial: hidden > 0 }
}

function ghostName(prediction: StorylinePhasePrediction): string {
  if (prediction.kind === 'planned-file' || prediction.symbol === undefined) {
    return prediction.file.slice(prediction.file.lastIndexOf('/') + 1)
  }
  return `${prediction.symbol}()`
}

function plural(count: number, one: string, many: string = one): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/** The foot's sentence: the real change counted, then what the plan still says. */
export function compareSummary(compare: StorylineCompare): string {
  if (compare.base === null) return 'No starting point yet — showing what the plan says will change'
  const { changed, added, removed, predicted, planned } = compare.summary
  const parts = [
    changed > 0 ? plural(changed, 'changed') : null,
    added > 0 ? plural(added, 'added') : null,
    removed > 0 ? plural(removed, 'removed') : null,
    predicted > 0 ? plural(predicted, 'still to change') : null,
    planned > 0 ? plural(planned, 'planned') : null,
  ].filter((part): part is string => part !== null)
  return `Plan ${compare.plan}: ${parts.length === 0 ? 'nothing changed yet' : parts.join(' · ')}`
}

function compareNote(compare: StorylineCompare): string | null {
  const notes: string[] = []
  if (compare.baseNote !== undefined && compare.baseNote !== '') notes.push(compare.baseNote)
  if (compare.unreadable.length > 0) {
    const names = compare.unreadable.map((file) => file.slice(file.lastIndexOf('/') + 1)).join(', ')
    notes.push(`Not compared — the starting point of ${names} could not be read as code.`)
  }
  return notes.length === 0 ? null : notes.join(' ')
}

/**
 * What every piece of the story looks like in `time`. `plan` is the story's
 * layout (`buildStory`), which decides which pieces are drawn at all.
 */
export function compareStory(result: StorylineResult, plan: StoryPlan, compare: StorylineCompare, time: StoryTime): StoryCompareView {
  const looks: Record<string, StoryPieceLook> = {}
  const rail: Record<string, StoryPieceState> = {}
  const hidden: string[] = []
  const pieces = new Map(result.pieces.map((piece) => [piece.id, piece]))
  // Change-note predictions are drawn by the note review (plan
  // `plan_change_review`); this view draws a plan's phase predictions only.
  const phasePredictions = compare.predicted.filter(isPhasePrediction)
  const predictions = new Map<string, StorylinePhasePrediction>()
  for (const prediction of phasePredictions) {
    if (prediction.pieceId !== undefined && !predictions.has(prediction.pieceId)) predictions.set(prediction.pieceId, prediction)
  }

  for (const id of plan.drawn) {
    const piece = pieces.get(id)
    if (piece === undefined) continue
    const change = compare.pieces[id]
    if (change === 'added') {
      // Today has no such code — except the entry, which the story stands on.
      if (time === 'today' && id !== plan.entry) hidden.push(id)
      looks[id] = time === 'after' ? { ...plainLook(piece, 'added'), pill: 'Added' } : plainLook(piece)
    } else if (change === 'changed') {
      looks[id] = changedLook(piece, compare, time)
    } else {
      const prediction = predictions.get(id)
      looks[id] = time === 'after' && prediction !== undefined ? predictionLook(piece, prediction) : plainLook(piece)
    }
    const state = looks[id]?.state ?? 'same'
    if (time === 'after' && state !== 'same') rail[id] = state
  }

  const extras = compare.removed
  for (const piece of extras) {
    looks[piece.id] = time === 'after' ? { ...plainLook(piece, 'removed'), pill: 'Removed' } : plainLook(piece)
  }

  const ghosts: StoryGhost[] =
    time === 'today'
      ? []
      : phasePredictions
          .filter((prediction) => prediction.kind !== 'changes')
          .map((prediction) => ({
            id: prediction.kind === 'planned-file' ? `planned-file:${prediction.file}` : `planned:${prediction.file}#${prediction.symbol ?? ''}`,
            kind: prediction.kind === 'planned-file' ? ('planned-file' as const) : ('planned' as const),
            name: ghostName(prediction),
            file: prediction.file,
            phase: prediction.phase,
            pill: predictionPill(prediction.kind, prediction.phase),
            task: prediction.task.trim(),
          }))

  return { time, plan: compare.plan, looks, extras, ghosts, hidden, rail, summary: compareSummary(compare), note: compareNote(compare) }
}

/**
 * The layout with the comparison applied: hidden pieces leave their cells (and
 * the rail), removed pieces and ghosts are appended where the story would put
 * them — a removed member beside its class's last drawn member, a removed
 * function in the last call column's function band, a removed data structure
 * with the data structures, a ghost at the end of the last call column (its
 * file's cell, in a part). A removed piece is drawn but never wired: After has
 * no calls from it.
 */
export function applyCompare(plan: StoryPlan, view: StoryCompareView): StoryPlan {
  const hidden = new Set(view.hidden)
  const lastCallColumn = Math.max(ENTRY_COLUMN, ...plan.order.filter((id) => !hidden.has(id)).map((id) => plan.columns[id] ?? ENTRY_COLUMN))
  let cells = plan.cells
    .map((cell) => ({ ...cell, pieceIds: cell.pieceIds.filter((id) => !hidden.has(id)) }))
    .filter((cell) => cell.pieceIds.length > 0)
  const columns = { ...plan.columns }
  const partMode = plan.cells.some((cell) => cell.file !== undefined)

  const place = (id: string, col: number, row: StoryRow, file: string): void => {
    columns[id] = col
    const match = (cell: StoryCell): boolean => cell.col === col && cell.row === row && (!partMode || cell.file === file)
    const existing = cells.find(match)
    if (existing === undefined) {
      const cell: StoryCell = partMode ? { col, row, file, pieceIds: [id] } : { col, row, pieceIds: [id] }
      cells = [...cells, cell].sort((a, b) => a.col - b.col || a.row - b.row)
      return
    }
    cells = cells.map((cell) => (cell === existing ? { ...cell, pieceIds: [...cell.pieceIds, id] } : cell))
  }

  for (const piece of view.extras) {
    if (isData(piece)) {
      place(piece.id, plan.dataColumn, STORY_ROW.data, piece.file)
      continue
    }
    const frame = piece.className === undefined ? undefined : plan.frames.find((entry) => entry.className === piece.className && entry.file === piece.file)
    if (frame !== undefined) place(piece.id, frame.colEnd, STORY_ROW.member, piece.file)
    else place(piece.id, lastCallColumn, STORY_ROW.function, piece.file)
  }
  for (const ghost of view.ghosts) place(ghost.id, lastCallColumn, STORY_ROW.function, ghost.file)

  const order = plan.order.filter((id) => !hidden.has(id))
  const drawn = [...plan.drawn.filter((id) => !hidden.has(id)), ...view.extras.map((piece) => piece.id), ...view.ghosts.map((ghost) => ghost.id)]
  const fileGroups: Record<string, string[]> = {}
  for (const [file, ids] of Object.entries(plan.fileGroups)) {
    const kept = ids.filter((id) => !hidden.has(id))
    if (kept.length > 0) fileGroups[file] = kept
  }
  return {
    ...plan,
    order,
    drawn,
    columns,
    cells,
    edges: plan.edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to)),
    typeEdges: plan.typeEdges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to)),
    fileGroups,
  }
}
