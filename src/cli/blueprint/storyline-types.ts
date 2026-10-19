/**
 * CODE STORYLINE — the shape one file (or one part's files) takes when it is
 * read as a story (discovery `code-storyline`, 2026-10-06).
 *
 * The CLI is the one writer (`blueprint storyline`, allowed-pattern #14); the
 * app mirrors these types in `app/src/shared/ipc-contract.ts` and only relays
 * them. Nothing here enters `graph.json` — the canonical contract is frozen,
 * and a storyline is a read, not part of the derived map.
 *
 * Only what the syntax proves is carried: a call whose target cannot be named
 * from the file's own declarations or its relative imports is kept as an
 * `unresolvedName`, never guessed into an arrow.
 */

/** Bumped whenever the extracted shape changes, so cached answers are re-read. */
export const STORYLINE_VERSION = 1

/**
 * `excerpt` is not a declaration: a few lines of a file a plan's FILE note is
 * about when no declaration holds the place it means (an import block, a
 * top-level call, a file with no functions) — so the note sits on code.
 * Only `blueprint storyline --plan` alone ever answers one.
 */
export type StorylinePieceKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'excerpt'

/** One declaration of the file: a box on the sheet. */
export interface StorylinePiece {
  /** Stable within one answer: `<file>#<name>` or `<file>#<Class>.<member>`. */
  id: string
  kind: StorylinePieceKind
  name: string
  /** The class a method belongs to. */
  className?: string
  /** Project-relative path of the file it lives in. */
  file: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** The first sentence of its doc comment, or null. */
  doc: string | null
  /** The exact source text, `startLine`..`endLine`. */
  text: string
  /** Exported from its module (a method: its class is exported). */
  exported: boolean
  isConstructor?: boolean
}

/** A call made inside a piece's body. */
export interface StorylineCall {
  /** The calling piece. */
  from: string
  /** 1-based absolute line of the call. */
  line: number
  /** The called piece of this answer, or null when it is not one. */
  to: string | null
  /** A call into another file of the project (resolved through a relative import). */
  external?: { file: string; name: string }
  /** A call nobody could name a target for — kept as plain text. */
  unresolvedName?: string
}

/** A piece naming a data structure of this answer in its types. */
export interface StorylineTypeUse {
  from: string
  to: string
}

/** A way into the story, ranked: the first is where it opens. */
export interface StorylineEntry {
  pieceId: string
  /** How many other project files import it by name. */
  usedFrom: number
}

export interface StorylineClass {
  name: string
  file: string
  startLine: number
  /** `constructor(deps: Deps)` — absent when the class declares none. */
  constructorSignature?: string
}

/** `typescript` | `javascript` | a tree-sitter table's id (`python`, …). */
export type StorylineLanguageId = 'typescript' | 'javascript' | (string & {})

export interface StorylineResult {
  ok: true
  scope: 'file' | 'part'
  /** Project-relative paths read, in order. */
  files: string[]
  /**
   * The language read: `typescript` / `javascript` (the TypeScript compiler),
   * or the id of a tree-sitter language table (`python`, …,
   * `storyline-languages.ts`).
   */
  language: StorylineLanguageId
  pieces: StorylinePiece[]
  calls: StorylineCall[]
  typeUses: StorylineTypeUse[]
  entries: StorylineEntry[]
  classes: StorylineClass[]
  /**
   * The plan's Today ⇄ After for this story — present only when the story was
   * asked for in a plan's context (`--plan`) and that plan was found.
   */
  compare?: StorylineCompare
  /** Why a story asked for in a plan's context carries no `compare` (one sentence). */
  compareNote?: string
  /**
   * The story's files grouped by project — this project first — present only
   * when the story was opened for a plan that carries change notes (whose
   * files, and sibling projects' files, join the story). Every story file is
   * in exactly one band, spelled as `files` spells it.
   */
  bands?: StorylineBand[]
}

/**
 * One project's share of a story. A sibling project's files are spelled
 * `<project-slug>/<path>` in `files`, piece ids and calls, so two projects'
 * same-named files never share an id.
 */
export interface StorylineBand {
  /** A sibling Workspace project's slug — null is this project. */
  project: string | null
  /** The project's colour slot (its position in the Workspace), when it is in one. */
  colorIndex?: number
  files: string[]
}

// ── Today ⇄ After (plan `story-today-after`) ────────────

/** What happened to one piece between the plan's starting point and the working tree. */
export type StorylinePieceChange = 'added' | 'removed' | 'changed' | 'same'

/**
 * Where the starting point came from: `given` (`--base`), `run` (the plan's
 * recorded run start), `head` (HEAD, because the working tree differs from it
 * for the story's files) or `worktree` (a thread worktree's base the app
 * passes). Null on the compare means no starting point: After is the plan's
 * prediction only.
 */
export type StorylineBaseSource = 'given' | 'run' | 'head' | 'worktree'

/** One line of a piece's diff. */
export interface StorylineDiffLine {
  op: 'context' | 'added' | 'removed'
  text: string
}

/** A run of nearby changed lines inside one piece, with a little context. */
export interface StorylineHunk {
  /** 1-based file line of the hunk's first Today line. */
  todayStart: number
  /** 1-based file line of the hunk's first After line. */
  afterStart: number
  lines: StorylineDiffLine[]
}

/** What the plan says will happen — labelled intent, never code. */
export type StorylinePrediction = StorylinePhasePrediction | StorylineNotePrediction

/**
 * A prediction read from the plan's phases and Story anchors — what a plan
 * WITHOUT change notes predicts (old plans, unchanged).
 */
export interface StorylinePhasePrediction {
  /** The piece it is about — absent for a planned piece or file that does not exist yet. */
  pieceId?: string
  file: string
  symbol?: string
  /** The plan phase that names it, or null when no phase does. */
  phase: number | null
  /** The plan's own words: the task line naming it, else its phase's first task. */
  task: string
  /**
   * `changes` — an existing piece in a file (or named by a function anchor)
   * the plan touches; `planned` — a function anchor naming a piece that does
   * not exist; `planned-file` — a file the plan lists that does not exist.
   */
  kind: 'changes' | 'planned' | 'planned-file'
}

// ── Change notes (plan `plan_change_review`) ────────────

/** Where a change note's quote was found in today's code. */
export interface NoteQuote {
  found: 'once' | 'none' | 'many'
  /** 1-based, inclusive. */
  startLine?: number
  endLine?: number
  /** How many times, when found more than once. */
  count?: number
}

/** One change note as the plan holds it (the plan file is the record). */
export interface StorylineNote {
  n: number
  phase: number
  kind: 'change' | 'new' | 'file'
  /** The target as written, e.g. `api/file:src/a.ts:run`. */
  target: string
  /** A sibling Workspace project's slug, when the target names one. */
  project?: string
  /** Project-relative path (relative to `project` when set). */
  file: string
  symbol?: string
  where?: string
  what?: string
  why?: string
  signature?: string
  purpose?: string
  callers?: string[]
  status: 'proposed' | 'accepted' | 'rejected'
  reason?: string
  comments: string[]
  verdict?: 'done' | 'differs' | 'not-built'
  verdictWhy?: string
}

/**
 * What the real diff says about a note's function (or file), beside the
 * note — never instead of it. Absent when there is no starting point, or the
 * code is in a sibling project (its history is not this project's).
 */
export type StorylineNoteFact = 'changed' | 'added' | 'unchanged' | 'removed'

/** Fields every note prediction carries. */
interface StorylineNotePredictionBase {
  /** The story file the note is about (`<project>/<path>` for a sibling project). */
  file: string
  note: StorylineNote
  /** The sibling project the note names. */
  project?: string
  /** The sibling project has no checkout on this machine (or this project is in no Workspace). */
  codeUnavailable?: true
  /** The note's file is not in its project. */
  fileMissing?: true
  fact?: StorylineNoteFact
}

/** A change to an existing function. */
export interface StorylineNoteChangePrediction extends StorylineNotePredictionBase {
  kind: 'note-change'
  /** The function's piece — absent when it is not on the story. */
  pieceId?: string
  symbol: string
  /** The quoted lines of today's code (1-based, inclusive, file lines). */
  quoteLines?: { startLine: number; endLine: number }
  /** The quote is not in the function (or is found more than once) — nothing is highlighted. */
  quoteMissing?: true
  /** How many times the quote was found, when more than once. */
  quoteCount?: number
  /** The function is not on the story: its file has no piece of that name, or could not be read. */
  pieceMissing?: true
}

/** A function the plan adds. */
export interface StorylineNoteNewPrediction extends StorylineNotePredictionBase {
  kind: 'note-new'
  symbol: string
  signature: string
  purpose: string
  callers: string[]
  /** Caller name → its piece on the story; callers not found are left out. */
  callerPieces: Record<string, string>
  /** The function's piece, once the code has it (after execution). */
  pieceId?: string
}

/** A change to a file as a whole (a route table, a config). */
export interface StorylineNoteFilePrediction extends StorylineNotePredictionBase {
  kind: 'note-file'
  /** The piece holding the note's quote (`where:`, optional on a file note), when it has one and it was found. */
  pieceId?: string
  /** The quoted lines, found in the whole file (1-based, inclusive). */
  quoteLines?: { startLine: number; endLine: number }
  /** The note quotes code that is not in the file (or is found more than once). */
  quoteMissing?: true
  quoteCount?: number
}

/**
 * A plan WITH change notes predicts from its notes only — one prediction per
 * note, in plan order, kept even when the real diff already shows the change
 * (its `fact` says so, for Verify).
 */
export type StorylineNotePrediction =
  | StorylineNoteChangePrediction
  | StorylineNoteNewPrediction
  | StorylineNoteFilePrediction

export interface StorylineCompareSummary {
  changed: number
  added: number
  removed: number
  /** `changes` predictions the real diff has not (yet) confirmed, and change notes. */
  predicted: number
  /** Planned pieces and planned files; new and file notes. */
  planned: number
}

export interface StorylineCompare {
  /** The plan's name (its slug). */
  plan: string
  /** The starting commit, resolved to a full sha — null when there is none. */
  base: string | null
  baseSource: StorylineBaseSource | null
  /** One sentence when a starting point was asked for and could not be read. */
  baseNote?: string
  /** Every After piece and every removed piece → what happened to it (empty without a base). */
  pieces: Record<string, StorylinePieceChange>
  /** Today's pieces that After no longer has, with Today's text. */
  removed: StorylinePiece[]
  /** Changed pieces → their line diff, capped. */
  hunks: Record<string, StorylineHunk[]>
  /** Changed pieces whose diff was cut at the cap → how many diff lines were left out. */
  hiddenLines: Record<string, number>
  /** Story files whose Today could not be read as code (it does not parse) — not compared. */
  unreadable: string[]
  predicted: StorylinePrediction[]
  summary: StorylineCompareSummary
}

export type StorylineRefusalReason = 'unsupported-language' | 'syntax-error' | 'too-large' | 'no-compiler' | 'not-found'

/** Why a file cannot be read as a story — an answer, not a failure. */
export interface StorylineRefusal {
  ok: false
  reason: StorylineRefusalReason
  /** One sentence for the reader, in the terms of what is on screen. */
  sentence: string
  /** The file's text, for the plain read-only fallback (single files only). */
  text?: string
  file?: string
}

export type StorylineAnswer = StorylineResult | StorylineRefusal
