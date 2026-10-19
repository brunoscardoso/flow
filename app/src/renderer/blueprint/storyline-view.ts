/**
 * CODE STORYLINE — the sheet. Turns one `StorylineAnswer` into the picture
 * the approved mockup draws: the entry point on the left, every piece it calls
 * to its right in call order, the real code in every box, an arrow from each
 * call LINE to the callee, the class as a frame, module functions in a band
 * below, the data structures in the last column, and the story's steps on a
 * rail under the sheet.
 *
 * Decides nothing about the story (`storyline-model.ts`) or about offsets and
 * geometry (`storyline-view-model.ts`); this file only makes the elements,
 * measures them once they are laid out, and drives the camera (`camera.ts`).
 *
 * THE RENDERER NEVER PARSES CODE. Lines come from the CLI's piece text; calls,
 * chips and "not on this path" come from the model's marks; colour comes from
 * Monaco's own tokenizer, late and fail-soft — a box prints plain text first
 * and stays readable when Monaco never answers.
 */
import type { StorylineAnswer, StorylinePiece, StorylineRefusal, StorylineResult } from '../../shared/ipc-contract'
import { monacoNamespace } from '../editor/monaco-host'
import { tokenClass } from '../threads/code-highlight'
import { fitViewInRect, gridBackgroundSize, startsPan, zoomAt, type Camera } from './camera'
import {
  applyCompare,
  buildStory,
  compareStory,
  defaultEntry,
  notePredictionsOf,
  STORY_ROW,
  type StoryCompareView,
  type StoryDisplayLine,
  type StoryGhost,
  type StoryPieceLook,
  type StoryPlan,
  type StoryTime,
} from './storyline-model'
import {
  boxName,
  classKey,
  commentRuns,
  decorateLines,
  dedentLines,
  fileLabels,
  fileName,
  followCamera,
  frameCaption,
  kindBadge,
  monacoLanguageFor,
  openingCamera,
  planLineRuns,
  STORY_FIT_PADDING_PX,
  STORY_ZOOM_STEP,
  storyRows,
  storySummary,
  whereLabel,
  wireGeometry,
  mergeReviewNotes,
  noteNumbersLabel,
  reviewBadgeLabel,
  type LineDecor,
  type LineToken,
  type ReviewMode,
  type ReviewNoteView,
  type StoryRect,
} from './storyline-view-model'
import type { PlanNoteVerdict, StorylineNote } from '../../shared/ipc-contract'
import { buildNoteBlock, paintNoteStrip, paintReviewBar, type NoteBlock } from './note-review-view'
import { decisionOf } from './note-review-model'
import type { PlanReviewState } from './plan-review-session'
import {
  buildReviewOverlay,
  placeReviewBoxes,
  shownLinesFor,
  type ReviewGhostBox,
  type ReviewLooseBox,
  type ReviewOverlay,
} from './story-review-overlay'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Trackpad pinch / ⌘-wheel zoom sensitivity, per wheel delta unit. */
const WHEEL_ZOOM_SENSITIVITY = 0.0022
/** How long a followed callee's camera move takes, and its flash. */
const FOLLOW_MOVE_MS = 320
const FLASH_MS = 900
/** Numbered dot radius. */
const DOT_RADIUS = 9
/** A press on these never starts a pan: they are controls, or text to select. */
// ONLY THE CODE SELECTS (user, 2026-10-07): a drag that starts inside a box's
// code block selects that code; a drag anywhere else — the background, a box's
// header, between boxes — pans and never selects. Buttons (follow a call,
// chips, folds) still press; the plain-code fallback still selects.
// A review's note (its words, its inputs) is text to read and type in, never a handle.
const NO_PAN_SELECTOR = 'button, select, a, input, textarea, .fb-note, .fb-story-plain, pre.fb-story-code'
/** The code block a selection drag may start in. */
const CODE_BLOCK_SELECTOR = 'pre.fb-story-code'
/** Not code: injected next to the code, never copied with it. */
const NOT_CODE_SELECTOR = '.fb-story-chip, .fb-story-fold, .fb-story-fold-lines[hidden]'

let markerSeq = 0

export interface StorylineViewCallbacks {
  /** A chip into another file: open that file's story (at `pieceName` when found). */
  onOpenFile(file: string, pieceName?: string): void
  /** A box's door: the file in the editor, the piece's lines revealed and highlighted. */
  onOpenInEditor(file: string, line: number, endLine: number): void
  /** A folded long piece: make it the entry of this story. */
  onReadAsOwnStory(pieceId: string): void
  /** A refusal with no text to show: the board's read-only peek. */
  onPeek(file: string): void
  /** The camera's scale changed — the header's percentage follows. */
  onCameraChange(scale: number): void
}

/**
 * A plan change review bound to the sheet (plan `plan_change_review`): the
 * open review's state and mode, and what its note blocks may ask of it. While
 * one is bound, the sheet draws the plan's code story — the same layout as
 * any story — with the review laid on it (`story-review-overlay.ts`).
 */
export interface StoryReviewBinding {
  mode(): ReviewMode
  state(): PlanReviewState
  /** This project's name, for the first band. */
  thisProject: string | null
  decide(n: number, pressed: 'accepted' | 'rejected', reason?: string): void
  comment(n: number, text: string): void
  setVerdict(n: number, verdict: PlanNoteVerdict, why: string): void
  send(): void
  /** Accept every note not reviewed yet. */
  acceptAll(): void
}

/** The answer a review stands on when no story could be read: no code, notes only. */
const NO_STORY: StorylineResult = {
  ok: true,
  scope: 'part',
  files: [],
  language: 'typescript',
  pieces: [],
  calls: [],
  typeUses: [],
  entries: [],
  classes: [],
}

/** The words of every note, as the review draws them — a change means a rebuild. */
function reviewShape(notes: readonly StorylineNote[]): string {
  return JSON.stringify(
    notes.map((note) => [note.n, note.kind, note.target, note.where, note.what, note.why, note.signature, note.purpose, note.callers, note.comments, note.verdict, note.verdictWhy]),
  )
}

/** What a drawn box remembers so it can be repainted once Monaco answers. */
interface BoxLines {
  piece: StorylinePiece
  /** The printed lines' text, in order (a diff's removed lines included). */
  lines: string[]
  decor: Array<LineDecor | undefined>
  els: HTMLElement[]
  /** The element printing After line `index` of the piece — where its wires leave. */
  lineAt: (index: number) => HTMLElement | undefined
}

export class StorylineView {
  readonly element: HTMLElement
  readonly #callbacks: StorylineViewCallbacks
  readonly #viewport: HTMLElement
  readonly #stage: HTMLElement
  readonly #rail: HTMLElement
  /** The review's note strip, under the story's rail (empty outside a review). */
  readonly #notes: HTMLElement
  readonly #foot: HTMLElement
  readonly #markerId: string
  readonly #resize: ResizeObserver
  #result: StorylineResult | null = null
  #pieces = new Map<string, StorylinePiece>()
  #plan: StoryPlan | null = null
  #entry: string | null = null
  #camera: Camera = { x: 0, y: 0, k: 1 }
  #types = false
  /** Today or After — meaningful only when the answer carries a comparison. */
  #time: StoryTime = 'after'
  /** The comparison as drawn in `#time`, or null outside a plan. */
  #compare: StoryCompareView | null = null
  #boxes = new Map<string, HTMLElement>()
  #boxLines = new Map<string, BoxLines>()
  #frames = new Map<string, HTMLElement>()
  #svg: SVGSVGElement | null = null
  #wireFrame: number | null = null
  #moveTimer: number | null = null
  #paintSeq = 0
  #drag: { pointerId: number; x: number; y: number; camera: Camera; moving: boolean } | null = null
  #destroyed = false
  /** The plan review bound to this sheet, or null for a plain story. */
  #review: StoryReviewBinding | null = null
  /** The review laid on the story as drawn, and the notes' words it was drawn from. */
  #overlay: ReviewOverlay | null = null
  #reviewShape = ''
  #reviewViews = new Map<number, ReviewNoteView>()
  /** Why the plan's code could not be read, when it could not — said on the sheet, never swallowed. */
  #reviewRefusal: string | null = null
  #noteBlocks: NoteBlock[] = []
  /** Every element a note sits on (its box, or its file's label), by note — repainted on a decision. */
  #noteHosts = new Map<number, HTMLElement[]>()
  /** The story's own foot, for the review modes whose foot is not the review bar. */
  #storyFoot: { result: StorylineResult; plan: StoryPlan } | null = null
  /** Each drawn file's label — its name, or enough of its path to tell two of one name apart. */
  #fileLabels = new Map<string, string>()

  constructor(callbacks: StorylineViewCallbacks) {
    this.#callbacks = callbacks
    markerSeq += 1
    this.#markerId = `fb-story-arrow-${String(markerSeq)}`
    this.element = document.createElement('div')
    this.element.className = 'fb-story'
    this.#viewport = document.createElement('div')
    this.#viewport.className = 'fb-story-viewport'
    this.#stage = document.createElement('div')
    this.#stage.className = 'fb-story-stage'
    this.#viewport.appendChild(this.#stage)
    this.#rail = document.createElement('div')
    this.#rail.className = 'fb-story-rail'
    this.#rail.setAttribute('aria-label', 'The story, in call order')
    this.#notes = document.createElement('div')
    this.#notes.className = 'fb-story-notes'
    this.#foot = document.createElement('div')
    this.#foot.className = 'fb-story-foot'
    this.element.append(this.#viewport, this.#rail, this.#notes, this.#foot)
    this.#bindCamera()
    // WIRES ARE MEASURED, so anything that moves a box redraws them: a font
    // landing, Monaco's colours (which can re-wrap a line), a folded piece.
    this.#resize = new ResizeObserver(() => this.#scheduleWires())
    this.#resize.observe(this.#stage)
  }

  /** The entry the sheet is drawn from, or null before a story is shown. */
  get entry(): string | null {
    return this.#entry
  }

  get scale(): number {
    return this.#camera.k
  }

  get typesShown(): boolean {
    return this.#types
  }

  /** Which world the sheet shows: Today or After (After outside a plan). */
  get time(): StoryTime {
    return this.#time
  }

  /** Flip a plan's story between Today and After. The camera stays where it is. */
  setTime(time: StoryTime): void {
    if (time === this.#time) return
    this.#time = time
    if (this.#result?.compare !== undefined) this.#build(false)
  }

  /**
   * Bind (or unbind) a plan change review. Takes effect on the next `show`:
   * the plan's code story is drawn like any story, with the review laid on it.
   */
  setReview(review: StoryReviewBinding | null): void {
    this.#review = review
  }

  /** True while the sheet draws a plan change review. */
  get reviewing(): boolean {
    return this.#overlay !== null
  }

  /** The review's mode changed: redraw it, the camera where it is. */
  setReviewMode(): void {
    if (this.#overlay !== null) this.#buildReview(false)
  }

  /**
   * The review's state changed: a note's words (or a verdict) changed → the
   * sheet is redrawn, camera kept; only decisions, saves and comments → the
   * note blocks, the strip and the bar repaint in place.
   */
  refreshReview(): void {
    const review = this.#review
    if (review === null || this.#overlay === null) return
    const state = review.state()
    if (reviewShape(state.notes) !== this.#reviewShape) {
      this.#buildReview(false)
      return
    }
    this.#paintReviewChrome()
  }

  /** The same story read again (the plan file changed): redraw it, the camera where it is. */
  replaceAnswer(answer: StorylineAnswer): void {
    if (this.#review === null) return
    this.#takeReviewAnswer(answer)
    this.#buildReview(false)
  }

  /** A quiet line while the CLI reads the file. */
  showLoading(label: string): void {
    this.#reset()
    const note = document.createElement('div')
    note.className = 'fb-story-loading'
    note.setAttribute('role', 'status')
    note.textContent = `Reading ${label}…`
    this.#viewport.appendChild(note)
  }

  /** Draw an answer: the story at `entryId` (else its default entry), or the refusal. */
  show(answer: StorylineAnswer, entryId: string | null, time: StoryTime = 'after'): void {
    this.#reset()
    this.#time = time
    // A PLAN UNDER REVIEW draws its code story with its notes on it — and
    // over a refusal, its notes with the refusal's sentence: a note whose code
    // cannot be read is still a note to decide.
    if (this.#review !== null) {
      this.#takeReviewAnswer(answer)
      this.#buildReview(true)
      return
    }
    if (!answer.ok) {
      this.#renderRefusal(answer)
      return
    }
    this.#result = answer
    this.#pieces = new Map(answer.pieces.map((piece) => [piece.id, piece]))
    const entry = entryId !== null && this.#pieces.has(entryId) ? entryId : defaultEntry(answer)
    if (entry === null) {
      this.#renderRefusal({
        ok: false,
        reason: 'not-found',
        sentence: 'This file declares no functions to read as a story.',
        ...(answer.files[0] === undefined ? {} : { file: answer.files[0] }),
      })
      return
    }
    this.#entry = entry
    this.#build(true)
  }

  /** Re-draw the same answer from another entry — no second extraction. */
  setEntry(entryId: string): void {
    if (this.#result === null || !this.#pieces.has(entryId) || entryId === this.#entry) return
    this.#entry = entryId
    this.#build(true)
  }

  setTypes(on: boolean): void {
    this.#types = on
    this.#stage.classList.toggle('fb-story-types', on)
  }

  zoomBy(factor: number): void {
    const { w, h } = this.#viewportSize()
    this.#setCamera(zoomAt(this.#camera, factor, w / 2, h / 2))
  }

  zoomIn(): void {
    this.zoomBy(STORY_ZOOM_STEP)
  }

  zoomOut(): void {
    this.zoomBy(1 / STORY_ZOOM_STEP)
  }

  /** Frame the whole story. */
  fit(): void {
    if (this.#plan === null) return
    const { w, h } = this.#viewportSize()
    const bounds = { minX: 0, minY: 0, maxX: this.#stage.scrollWidth, maxY: this.#stage.scrollHeight }
    this.#setCamera(fitViewInRect(bounds, { x: 0, y: 0, w, h }, STORY_FIT_PADDING_PX))
  }

  /** Bring a piece to the reader: move the camera to it and flash it. */
  follow(pieceId: string): void {
    const box = this.#boxes.get(pieceId)
    if (box === undefined) return
    const next = followCamera(this.#camera, this.#rectOf(box), this.#viewportSize())
    this.#stage.classList.add('fb-story-moving')
    if (this.#moveTimer !== null) window.clearTimeout(this.#moveTimer)
    this.#moveTimer = window.setTimeout(() => {
      this.#moveTimer = null
      this.#stage.classList.remove('fb-story-moving')
    }, FOLLOW_MOVE_MS + 20)
    this.#setCamera(next)
    box.classList.remove('fb-story-flash')
    void box.offsetWidth
    box.classList.add('fb-story-flash')
    window.setTimeout(() => box.classList.remove('fb-story-flash'), FLASH_MS)
  }

  destroy(): void {
    this.#destroyed = true
    this.#resize.disconnect()
    if (this.#wireFrame !== null) cancelAnimationFrame(this.#wireFrame)
    if (this.#moveTimer !== null) window.clearTimeout(this.#moveTimer)
    this.element.remove()
  }

  // ── Building ────────────────────────────────────────────────────────────

  #reset(): void {
    this.#paintSeq += 1
    this.#result = null
    this.#plan = null
    this.#entry = null
    this.#boxes = new Map()
    this.#boxLines = new Map()
    this.#frames = new Map()
    this.#svg = null
    this.#compare = null
    this.#overlay = null
    this.#reviewShape = ''
    this.#reviewViews = new Map()
    this.#reviewRefusal = null
    this.#noteBlocks = []
    this.#noteHosts = new Map()
    this.#storyFoot = null
    this.element.classList.remove('fb-story-review')
    delete this.element.dataset['reviewMode']
    this.#stage.replaceChildren()
    this.#rail.replaceChildren()
    this.#notes.replaceChildren()
    this.#foot.replaceChildren()
    for (const child of [...this.#viewport.children]) if (child !== this.#stage) child.remove()
    this.element.classList.remove('fb-story-refused')
  }

  #build(openAtEntry: boolean): void {
    const result = this.#result ?? (this.#overlay === null ? null : NO_STORY)
    const entry = this.#entry
    const overlay = this.#overlay
    if (result === null || (entry === null && overlay === null)) return
    this.#paintSeq += 1
    // ONE LAYOUT (allowed-pattern #14): a plan under review is laid out by the
    // same story the board draws for any file — told to draw every piece the
    // plan's story holds, every cell a file's — and the review is laid on it.
    const story =
      overlay === null
        ? buildStory(result, entry as string)
        : buildStory(result, entry ?? '', { also: overlay.draw, hidden: overlay.hidden, byFile: true })
    // IN A PLAN'S CONTEXT the layout is the story's own, with the comparison
    // applied: pieces only one side has come and go, ghosts join (After only).
    // A review's Today is Today's code; its Verify is the real diff; its
    // Proposal is the code as it stands, with the notes on it.
    const time: StoryTime | null = overlay === null ? this.#time : overlay.mode === 'today' ? 'today' : overlay.mode === 'verify' ? 'after' : null
    const compare = result.compare === undefined || time === null ? null : compareStory(result, story, result.compare, time)
    this.#compare = compare
    const compared = compare === null ? story : applyCompare(story, compare)
    const plan = overlay === null ? compared : placeReviewBoxes(compared, overlay)
    const extras = new Map((compare?.extras ?? []).map((piece) => [piece.id, piece]))
    const ghosts = new Map((compare?.ghosts ?? []).map((ghost) => [ghost.id, ghost]))
    const reviewGhosts = new Map((overlay?.ghosts ?? []).map((ghost) => [ghost.id, ghost]))
    const looseBoxes = new Map((overlay?.loose ?? []).map((box) => [box.id, box]))
    this.#plan = plan
    this.element.classList.toggle('fb-story-compared', compare !== null && overlay === null)
    this.element.dataset['time'] = compare === null || overlay !== null ? '' : this.#time
    this.#boxes = new Map()
    this.#boxLines = new Map()
    this.#frames = new Map()
    this.#noteBlocks = []
    this.#noteHosts = new Map()
    this.#svg = null
    this.#stage.replaceChildren()
    // THE RAIL AND THE FOOT ARE THIS ENTRY'S TOO. `setEntry` re-builds without
    // a `#reset`, and before these two lines a new entry appended a second
    // rail after the first — the old story's pills stayed in front.
    this.#rail.replaceChildren()
    this.#foot.replaceChildren()
    this.#stage.classList.toggle('fb-story-types', this.#types)

    const rows = storyRows(plan)
    const columns = Math.max(plan.dataColumn, ...plan.cells.map((cell) => cell.col)) + 1
    this.#stage.style.gridTemplateColumns = `repeat(${String(columns)}, max-content)`
    this.#stage.style.gridTemplateRows = `repeat(${String(rows.count)}, auto)`

    // THE CLASS FRAMES GO DOWN FIRST so every box sits on one.
    for (const frame of plan.frames) {
      const key = classKey(frame.file, frame.className)
      const row = rows.classRow.get(key)
      if (row === undefined || this.#frames.has(key)) continue
      const el = document.createElement('div')
      el.className = 'fb-story-frame'
      el.style.gridRow = String(row)
      el.style.gridColumn = `${String(frame.colStart + 1)} / ${String(frame.colEnd + 2)}`
      const label = document.createElement('div')
      label.className = 'fb-story-frame-label'
      const name = document.createElement('span')
      name.className = 'fb-story-frame-name'
      name.textContent = `class ${frame.className}`
      const caption = document.createElement('span')
      caption.className = 'fb-story-frame-caption'
      caption.textContent = frameCaption(frame.startLine, frame.constructorSignature)
      label.append(name, caption)
      el.appendChild(label)
      this.#frames.set(key, el)
      this.#stage.appendChild(el)
    }

    // THE CELLS. A model cell is one (column, row); members of two classes in
    // one column split by their class's row, and in a part each file's pieces
    // carry their file's name.
    const containers = new Map<string, HTMLElement>()
    let functionBandPlaced = false
    const container = (gridRow: string, col: number, kind: 'member' | 'function' | 'data'): HTMLElement => {
      const key = `${gridRow}|${String(col)}`
      const existing = containers.get(key)
      if (existing !== undefined) return existing
      const el = document.createElement('div')
      el.className = `fb-story-cell fb-story-cell-${kind}`
      el.style.gridRow = gridRow
      el.style.gridColumn = String(col + 1)
      if (kind === 'function' && !functionBandPlaced) {
        functionBandPlaced = true
        el.appendChild(this.#bandLabel('Module functions'))
      }
      if (kind === 'data') el.appendChild(this.#bandLabel('Data structures'))
      containers.set(key, el)
      this.#stage.appendChild(el)
      return el
    }
    const placedLabels = new Set<string>()
    this.#fileLabels = fileLabels(plan.cells.flatMap((cell) => (cell.file === undefined ? [] : [cell.file])))
    // A FILE NOTE SITS ON ITS FILE'S LABEL — the first one the sheet draws.
    const fileNotesPlaced = new Set<string>()
    for (const cell of plan.cells) {
      for (const id of cell.pieceIds) {
        const ghost = ghosts.get(id)
        if (ghost !== undefined) {
          container(String(rows.functionRow ?? rows.count), cell.col, 'function').appendChild(this.#buildGhost(ghost))
          continue
        }
        const reviewGhost = reviewGhosts.get(id)
        const loose = looseBoxes.get(id)
        const piece = this.#pieces.get(id) ?? extras.get(id)
        if (piece === undefined && reviewGhost === undefined && loose === undefined) continue
        let host: HTMLElement
        if (piece !== undefined && cell.row === STORY_ROW.data) {
          host = container(`1 / ${String(rows.count + 1)}`, cell.col, 'data')
        } else if (
          piece !== undefined &&
          cell.row === STORY_ROW.member &&
          piece.className !== undefined &&
          rows.classRow.has(classKey(piece.file, piece.className))
        ) {
          host = container(String(rows.classRow.get(classKey(piece.file, piece.className))), cell.col, 'member')
        } else {
          host = container(String(rows.functionRow ?? rows.count), cell.col, 'function')
        }
        if (cell.file !== undefined) {
          const labelKey = `${host.style.gridRow}|${host.style.gridColumn}|${cell.file}`
          if (!placedLabels.has(labelKey)) {
            placedLabels.add(labelKey)
            const label = document.createElement('div')
            label.className = 'fb-story-file'
            label.textContent = this.#fileLabels.get(cell.file) ?? fileName(cell.file)
            label.title = cell.file
            label.dataset['file'] = cell.file
            host.appendChild(label)
            if (overlay !== null && !fileNotesPlaced.has(cell.file)) {
              const notes = overlay.fileNotes.find((entryOf) => entryOf.file === cell.file)
              if (notes !== undefined) {
                fileNotesPlaced.add(cell.file)
                host.appendChild(this.#buildFileNotes(notes.file, notes.notes, notes.messages))
              }
            }
          }
        }
        if (reviewGhost !== undefined) host.appendChild(this.#buildReviewGhost(reviewGhost))
        else if (loose !== undefined) host.appendChild(this.#buildLooseBox(loose))
        else if (piece !== undefined) host.appendChild(this.#buildBox(piece, plan, id === entry, compare?.looks[id] ?? null))
      }
    }

    this.#buildRail(plan)
    // The story's own size — before ghosts and removed pieces joined the sheet,
    // and without what this time does not have.
    const absent = new Set(compare?.hidden ?? [])
    this.#storyFoot = {
      result,
      plan: absent.size === 0 ? story : { ...story, order: story.order.filter((id) => !absent.has(id)), drawn: story.drawn.filter((id) => !absent.has(id)) },
    }
    if (overlay === null) this.#buildFoot(this.#storyFoot.result, this.#storyFoot.plan)
    else this.#paintReviewChrome()
    void this.#colorize(this.#paintSeq)
    requestAnimationFrame(() => {
      if (this.#destroyed || this.#plan !== plan) return
      this.#drawWires()
      if (openAtEntry) this.#openAtEntry()
    })
  }

  // ── Plan change review ──────────────────────────────────────────────────

  /** Keep a review's answer: the story, or — when it could not be read — the reason, to say on the sheet. */
  #takeReviewAnswer(answer: StorylineAnswer): void {
    this.#result = answer.ok ? answer : null
    this.#pieces = new Map((answer.ok ? answer.pieces : []).map((piece) => [piece.id, piece]))
    this.#reviewRefusal = answer.ok ? null : answer.sentence
  }

  /**
   * Draw the bound review in its mode: the plan's code story, laid out like
   * any story, with the review on it (`buildReviewOverlay`). The notes are the
   * freshest read of the plan file, matched to where the story placed them.
   */
  #buildReview(openAtStart: boolean): void {
    const review = this.#review
    if (review === null) return
    const state = review.state()
    const mode = review.mode()
    const result = this.#result
    const views = mergeReviewNotes(notePredictionsOf(result?.compare), state.loaded ? state.notes : null)
    this.#reviewViews = new Map(views.map((view) => [view.note.n, view]))
    const overlay = buildReviewOverlay(result, views, mode)
    this.#overlay = overlay
    this.#reviewShape = reviewShape(state.notes)
    this.#entry = overlay.entry
    this.element.classList.remove('fb-story-refused')
    this.element.classList.add('fb-story-review')
    this.element.dataset['reviewMode'] = mode
    for (const child of [...this.#viewport.children]) if (child !== this.#stage) child.remove()
    if (this.#reviewRefusal !== null || (state.loaded && views.length === 0)) {
      const banner = document.createElement('div')
      banner.className = 'fb-nr-banner'
      banner.setAttribute('role', 'status')
      banner.textContent = this.#reviewRefusal ?? 'This plan has no change notes to show here.'
      this.#viewport.appendChild(banner)
    }
    this.#build(openAtStart)
  }

  /** A note's block, wired to the open review, remembered so a decision repaints it. */
  #noteBlock(n: number, host: HTMLElement): HTMLElement | null {
    const view = this.#reviewViews.get(n)
    const overlay = this.#overlay
    if (view === undefined || overlay === null) return null
    const block = buildNoteBlock(view.note, overlay.mode, view.prediction?.fact, {
      decide: (note, pressed, reason) => this.#review?.decide(note, pressed, reason),
      comment: (note, text) => this.#review?.comment(note, text),
      setVerdict: (note, verdict, why) => this.#review?.setVerdict(note, verdict, why),
    })
    this.#noteBlocks.push(block)
    this.#noteHosts.set(n, [...(this.#noteHosts.get(n) ?? []), host])
    return block.element
  }

  /** The review on a drawn piece: its badge in the header, a sentence, and its notes under the code. */
  #decorateReviewBox(box: HTMLElement, head: HTMLElement, pieceId: string): void {
    const overlay = this.#overlay
    if (overlay === null) return
    const badge = overlay.badges[pieceId]
    const notes = overlay.pieceNotes[pieceId] ?? []
    if (badge !== undefined) {
      box.classList.add('fb-nr-box', `fb-nr-badged-${badge}`)
      const pill = document.createElement('span')
      pill.className = `fb-nr-badge fb-nr-badge-${badge}`
      pill.textContent = reviewBadgeLabel(badge)
      head.insertBefore(pill, head.querySelector('.fb-story-bwhere'))
      const where = head.querySelector<HTMLElement>('.fb-story-bwhere')
      if (where !== null && notes.length > 0) where.title = `${where.textContent ?? ''} · ${noteNumbersLabel(notes)}`
    }
    const message = overlay.messages[pieceId]
    if (message !== undefined) {
      const line = document.createElement('div')
      line.className = 'fb-nr-message'
      line.textContent = message
      box.appendChild(line)
    }
    for (const n of notes) {
      const block = this.#noteBlock(n, box)
      if (block !== null) box.appendChild(block)
    }
  }

  /** File notes, under their file's label: the note blocks, and a sentence for a quote that is not there. */
  #buildFileNotes(file: string, notes: readonly number[], messages: readonly string[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fb-nr-filenotes'
    wrap.dataset['file'] = file
    for (const message of messages) {
      const line = document.createElement('div')
      line.className = 'fb-nr-message'
      line.textContent = message
      wrap.appendChild(line)
    }
    for (const n of notes) {
      const block = this.#noteBlock(n, wrap)
      if (block !== null) wrap.appendChild(block)
    }
    return wrap
  }

  /** A function the plan adds: dashed, in its file's cell, its note as its body. */
  #buildReviewGhost(ghost: ReviewGhostBox): HTMLElement {
    const box = document.createElement('div')
    box.className = 'fb-story-box fb-nr-box fb-nr-box-new fb-nr-badged-new'
    box.dataset['piece'] = ghost.id
    const head = document.createElement('div')
    head.className = 'fb-story-bhead'
    const kind = document.createElement('span')
    kind.className = 'fb-story-kind'
    kind.textContent = 'new function'
    const name = document.createElement('span')
    name.className = 'fb-story-bname'
    name.textContent = ghost.name
    const badge = document.createElement('span')
    badge.className = 'fb-nr-badge fb-nr-badge-new'
    badge.textContent = reviewBadgeLabel('new')
    head.append(kind, name, badge)
    box.appendChild(head)
    const block = this.#noteBlock(ghost.n, box)
    if (block !== null) box.appendChild(block)
    box.addEventListener('pointerenter', () => this.#setFocus(ghost.id))
    box.addEventListener('pointerleave', () => this.#setFocus(null))
    this.#boxes.set(ghost.id, box)
    return box
  }

  /** A note whose code is not on the sheet: the note, and the sentence that says why. */
  #buildLooseBox(loose: ReviewLooseBox): HTMLElement {
    const box = document.createElement('div')
    box.className = `fb-story-box fb-nr-box fb-nr-box-${loose.kind}`
    box.dataset['piece'] = loose.id
    const head = document.createElement('div')
    head.className = 'fb-story-bhead'
    const kind = document.createElement('span')
    kind.className = 'fb-story-kind'
    kind.textContent = loose.kind === 'file' ? 'file' : 'function'
    const name = document.createElement('span')
    name.className = 'fb-story-bname'
    name.textContent = loose.name ?? fileName(loose.file)
    name.title = loose.file
    head.append(kind, name)
    box.appendChild(head)
    if (loose.message !== null) {
      const line = document.createElement('div')
      line.className = 'fb-nr-message'
      line.textContent = loose.message
      box.appendChild(line)
    }
    for (const n of loose.notes) {
      const block = this.#noteBlock(n, box)
      if (block !== null) box.appendChild(block)
    }
    this.#boxes.set(loose.id, box)
    return box
  }

  /** Repaint what a decision, a save or a comment changes: the note blocks, the boxes' marks, the strip, the bar. */
  #paintReviewChrome(): void {
    const review = this.#review
    const overlay = this.#overlay
    if (review === null || overlay === null) return
    const state = review.state()
    const mode = review.mode()
    for (const block of this.#noteBlocks) block.paint(state)
    const byHost = new Map<HTMLElement, number[]>()
    for (const [n, hosts] of this.#noteHosts) for (const host of hosts) byHost.set(host, [...(byHost.get(host) ?? []), n])
    for (const [host, notes] of byHost) {
      const decisions = notes.map((n) => decisionOf(state.notes.find((note) => note.n === n)?.status ?? 'proposed'))
      host.classList.toggle('fb-nr-accepted', decisions.length > 0 && decisions.every((decision) => decision === 'accepted'))
      host.classList.toggle('fb-nr-rejected', decisions.length > 0 && decisions.every((decision) => decision === 'rejected'))
    }
    paintNoteStrip(this.#notes, state, new Set(Object.keys(overlay.noteBox).map(Number)), (n) => {
      const id = overlay.noteBox[n]
      if (id !== undefined) this.follow(id)
    })
    // The review bar is the foot in Proposal (and when the notes could not be
    // read); Today and Verify keep the story's own foot.
    if (mode === 'proposal' || state.error !== null) {
      paintReviewBar(this.#foot, state, mode, () => review.send(), () => review.acceptAll())
    } else if (this.#storyFoot !== null) {
      this.#foot.replaceChildren()
      this.#buildFoot(this.#storyFoot.result, this.#storyFoot.plan)
    }
    this.#scheduleWires()
  }

  #bandLabel(text: string): HTMLElement {
    const label = document.createElement('div')
    label.className = 'fb-story-band'
    label.textContent = text
    return label
  }

  #buildBox(piece: StorylinePiece, plan: StoryPlan, isEntry: boolean, look: StoryPieceLook | null): HTMLElement {
    const box = document.createElement('div')
    box.className = isEntry ? 'fb-story-box fb-story-entry' : 'fb-story-box'
    box.dataset['piece'] = piece.id
    if (look !== null && look.state !== 'same') {
      box.classList.add(`fb-story-st-${look.state}`)
      box.dataset['state'] = look.state
    }

    const head = document.createElement('div')
    head.className = 'fb-story-bhead'
    const badge = kindBadge(piece)
    const kind = document.createElement('span')
    kind.className = `fb-story-kind fb-story-kind-${badge.tone}`
    kind.textContent = badge.text
    const name = document.createElement('span')
    name.className = 'fb-story-bname'
    // A file's lines are named by the file, as its label names it.
    name.textContent = piece.kind === 'excerpt' ? (this.#fileLabels.get(piece.file) ?? boxName(piece)) : boxName(piece)
    const where = document.createElement('span')
    where.className = 'fb-story-bwhere'
    where.textContent = whereLabel(look === null ? piece : { ...piece, startLine: look.startLine, endLine: look.endLine })
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'fb-story-open'
    open.title = 'Open in the editor'
    open.setAttribute('aria-label', `Open ${boxName(piece)} in the editor`)
    open.appendChild(openGlyph())
    open.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#callbacks.onOpenInEditor(piece.file, piece.startLine, piece.endLine)
    })
    head.append(kind, name)
    if (look?.pill !== null && look?.pill !== undefined) head.appendChild(this.#pill(look.pill, look.state))
    head.append(where, open)
    box.appendChild(head)
    if (look?.caption !== null && look?.caption !== undefined) box.appendChild(this.#caption(look.caption, look.captionTitle))

    if (piece.doc !== null && piece.doc !== '') {
      const doc = document.createElement('div')
      doc.className = 'fb-story-bdoc'
      doc.textContent = piece.doc
      box.appendChild(doc)
    }

    if (look?.lines !== null && look?.lines !== undefined) {
      this.#buildDisplayCode(box, piece, plan, look)
      this.#decorateReviewBox(box, head, piece.id)
      if (isEntry) box.appendChild(this.#entryTag())
      box.addEventListener('pointerenter', () => this.#setFocus(piece.id))
      box.addEventListener('pointerleave', () => this.#setFocus(null))
      this.#boxes.set(piece.id, box)
      return box
    }

    // THE ENTRY IS NEVER FOLDED: "read it as its own story" makes a long piece
    // the entry so it can be read whole. A REVIEW'S QUOTED LINES are never
    // folded away either: a long piece opens far enough to show them, and a
    // comment run holding one stays open.
    const lines = dedentLines(piece.text)
    const long = isEntry ? undefined : plan.long[piece.id]
    const highlights = this.#overlay?.highlights[piece.id]
    const hit = new Set<number>()
    for (const range of highlights ?? []) for (let line = range.startLine; line <= range.endLine; line += 1) hit.add(line - piece.startLine)
    const shown = long === undefined ? lines.length : shownLinesFor(lines.length, long.previewLines, piece.startLine, highlights)
    const decor = decorateLines(piece, lines, plan.marks[piece.id] ?? [], this.#pieces, shown)
    const pre = document.createElement('pre')
    pre.className = long === undefined || shown >= lines.length ? 'fb-story-code' : 'fb-story-code fb-story-fade'
    const els: HTMLElement[] = []
    const folds = new Map(commentRuns(lines, shown, (index) => decor[index]?.callsite === true || hit.has(index)).map((run) => [run.start, run]))
    let foldGroup: HTMLElement | null = null
    let foldEnd = -1
    for (let index = 0; index < shown; index += 1) {
      const run = folds.get(index)
      if (run !== undefined) {
        foldGroup = this.#buildCommentFold(pre, run.end - run.start + 1, /^\s*/.exec(lines[index] ?? '')?.[0] ?? '')
        foldEnd = run.end
      }
      const line = document.createElement('span')
      line.className = hit.has(index) ? 'fb-story-ln fb-nr-hit' : 'fb-story-ln'
      line.dataset['line'] = String(piece.startLine + index)
      this.#paintLine(line, lines[index] ?? '', null, decor[index])
      els.push(line)
      if (foldGroup !== null) foldGroup.appendChild(line)
      else pre.appendChild(line)
      if (index === foldEnd) foldGroup = null
    }
    box.appendChild(pre)
    this.#boxLines.set(piece.id, { piece, lines: lines.slice(0, shown), decor, els, lineAt: (index) => els[index] })

    if (long !== undefined && shown < lines.length) {
      const foot = document.createElement('div')
      foot.className = 'fb-story-bfoot'
      const count = document.createElement('span')
      count.textContent = `First ${String(shown)} of ${String(long.totalLines)} lines`
      const read = document.createElement('button')
      read.type = 'button'
      read.className = 'fb-story-bfoot-btn'
      read.textContent = 'Read it as its own story'
      read.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#callbacks.onReadAsOwnStory(piece.id)
      })
      foot.append(count, read)
      box.appendChild(foot)
    }
    this.#decorateReviewBox(box, head, piece.id)

    // BELOW the box, not above: above, it collided with the class frame's label.
    if (isEntry) box.appendChild(this.#entryTag())

    box.addEventListener('pointerenter', () => this.#setFocus(piece.id))
    box.addEventListener('pointerleave', () => this.#setFocus(null))
    this.#boxes.set(piece.id, box)
    return box
  }

  #entryTag(): HTMLElement {
    const tag = document.createElement('div')
    tag.className = 'fb-story-entry-tag'
    tag.textContent = 'Entry point'
    return tag
  }

  /** A box's pill: Added, Changed, Removed — or the plan's own label for a prediction. */
  #pill(text: string, state: string): HTMLElement {
    const pill = document.createElement('span')
    pill.className = `fb-story-pill fb-story-pill-${state}`
    pill.textContent = text
    return pill
  }

  /** The plan's words under a box's header: clamped, the whole line on hover. */
  #caption(text: string, title: string | null): HTMLElement {
    const caption = document.createElement('div')
    caption.className = 'fb-story-caption'
    caption.textContent = text
    if (title !== null && title !== text) caption.title = title
    return caption
  }

  /**
   * A box whose lines are not simply its own text: a changed piece's diff
   * (After), or its rebuilt Today text. Calls still decorate the lines After
   * has; a removed line is plain code, tinted and struck.
   */
  #buildDisplayCode(box: HTMLElement, piece: StorylinePiece, plan: StoryPlan, look: StoryPieceLook): void {
    const display = look.lines ?? []
    const texts = dedentLines(display.map((line) => line.text).join('\n'))
    // Calls are found on the PRINTED text, indexed by the After line it is —
    // so a call's name is underlined where this box actually prints it.
    const afterLines = dedentLines(piece.text).map(() => '')
    display.forEach((line, index) => {
      if (line.afterIndex !== null) afterLines[line.afterIndex] = texts[index] ?? ''
    })
    const afterDecor = decorateLines(piece, afterLines, plan.marks[piece.id] ?? [], this.#pieces)
    const pre = document.createElement('pre')
    pre.className = 'fb-story-code fb-story-diff'
    const els: HTMLElement[] = []
    const decor: Array<LineDecor | undefined> = []
    const byAfter = new Map<number, HTMLElement>()
    display.forEach((line: StoryDisplayLine, index) => {
      const el = document.createElement('span')
      el.className = line.op === 'plain' ? 'fb-story-ln' : `fb-story-ln fb-story-ln-${line.op}`
      const lineDecor = line.afterIndex === null ? undefined : afterDecor[line.afterIndex]
      if (line.afterIndex !== null) {
        el.dataset['line'] = String(piece.startLine + line.afterIndex)
        byAfter.set(line.afterIndex, el)
      }
      this.#paintLine(el, texts[index] ?? '', null, lineDecor)
      els.push(el)
      decor.push(lineDecor)
      pre.appendChild(el)
    })
    box.appendChild(pre)
    this.#boxLines.set(piece.id, { piece, lines: texts, decor, els, lineAt: (index) => byAfter.get(index) })
    if (look.hiddenLines > 0 || look.partial) {
      const foot = document.createElement('div')
      foot.className = 'fb-story-bfoot fb-story-diff-foot'
      foot.textContent =
        look.hiddenLines > 0
          ? `+${String(look.hiddenLines)} ${look.hiddenLines === 1 ? 'line' : 'lines'} of this change not shown`
          : "Some of this piece's earlier lines are not shown"
      box.appendChild(foot)
    }
  }

  /** A function or file the plan names that has no code yet: dashed, the task as its body. */
  #buildGhost(ghost: StoryGhost): HTMLElement {
    const box = document.createElement('div')
    box.className = `fb-story-box fb-story-ghost fb-story-ghost-${ghost.kind}`
    box.dataset['piece'] = ghost.id
    box.dataset['state'] = 'planned'
    const head = document.createElement('div')
    head.className = 'fb-story-bhead'
    const kind = document.createElement('span')
    kind.className = 'fb-story-kind'
    kind.textContent = ghost.kind === 'planned-file' ? 'file' : 'function'
    const name = document.createElement('span')
    name.className = 'fb-story-bname'
    name.textContent = ghost.name
    if (ghost.kind === 'planned-file') name.title = ghost.file
    head.append(kind, name, this.#pill(ghost.pill, 'planned'))
    box.appendChild(head)
    const body = document.createElement('div')
    body.className = 'fb-story-ghost-task'
    body.textContent = ghost.task === '' ? 'Named by the plan; no code yet.' : ghost.task
    box.appendChild(body)
    this.#boxes.set(ghost.id, box)
    return box
  }

  /** One folded comment run: a quiet line that opens it, and the lines it hides. */
  #buildCommentFold(pre: HTMLElement, count: number, indent: string): HTMLElement {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'fb-story-fold'
    toggle.textContent = `${indent}// ${String(count)} comment lines`
    toggle.title = 'Show these comment lines'
    const group = document.createElement('span')
    group.className = 'fb-story-fold-lines'
    group.hidden = true
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      group.hidden = !group.hidden
      toggle.classList.toggle('open', !group.hidden)
      toggle.title = group.hidden ? 'Show these comment lines' : 'Hide these comment lines'
      // The box changed height: every wire below the fold moved with it.
      this.#scheduleWires()
    })
    pre.append(toggle, group)
    return group
  }

  /** Write one line: its runs (coloured once tokens exist), its calls, its chips. */
  #paintLine(el: HTMLElement, text: string, tokens: readonly LineToken[] | null, decor: LineDecor | undefined): void {
    el.replaceChildren()
    el.classList.toggle('fb-story-callsite', decor?.callsite === true)
    const follows = decor?.follows ?? []
    let lastButton: { follow: number; el: HTMLElement } | null = null
    for (const run of planLineRuns(text, tokens, follows)) {
      const node: Node =
        run.className === null
          ? document.createTextNode(run.text)
          : Object.assign(document.createElement('span'), { className: run.className, textContent: run.text })
      if (run.follow === null) {
        el.appendChild(node)
        lastButton = null
        continue
      }
      if (lastButton !== null && lastButton.follow === run.follow) {
        lastButton.el.appendChild(node)
        continue
      }
      const target = follows[run.follow]?.to ?? ''
      const callee = this.#pieces.get(target)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fb-story-call'
      button.dataset['to'] = target
      button.title = callee === undefined ? 'Follow this call' : `Follow ${boxName(callee)}`
      button.appendChild(node)
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        this.follow(target)
      })
      el.appendChild(button)
      lastButton = { follow: run.follow, el: button }
    }
    for (const chip of decor?.chips ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fb-story-chip'
      button.textContent = `↗ ${chip.label}`
      button.title = chip.name === '' ? `Read ${chip.label} as a story` : `Read ${chip.label} as a story, from ${chip.name}`
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#callbacks.onOpenFile(chip.file, chip.name === '' ? undefined : chip.name)
      })
      el.appendChild(button)
    }
    if (decor?.notOnPath === true) {
      const dim = document.createElement('span')
      dim.className = 'fb-story-chip fb-story-chip-dim'
      dim.textContent = 'not on this path'
      dim.title = 'Called here, but not part of the story that starts at this entry'
      el.appendChild(dim)
    }
  }

  /** Colour every box through Monaco's tokenizer. Late, and fail-soft. */
  async #colorize(seq: number): Promise<void> {
    const result = this.#result
    if (result === null) return
    // A part mixing languages colours each box in its own file's language.
    const languageOf = (box: BoxLines): string => monacoLanguageFor(result.language, box.piece.file)
    let monaco: Awaited<ReturnType<typeof monacoNamespace>>
    try {
      monaco = await monacoNamespace()
      // `tokenize` does not wait for a lazily registered language; `colorize`
      // does — called for that side effect only, once per language on screen.
      const languages = new Set([...this.#boxLines.values()].map(languageOf))
      await Promise.all([...languages].map((language) => monaco.editor.colorize('', language, {})))
    } catch {
      return // the plain text stands
    }
    if (seq !== this.#paintSeq || this.#destroyed) return
    for (const box of this.#boxLines.values()) {
      let tokenLines: Array<Array<{ offset: number; type: string }>>
      try {
        tokenLines = monaco.editor.tokenize(box.lines.join('\n'), languageOf(box)) as Array<Array<{ offset: number; type: string }>>
      } catch {
        continue
      }
      box.els.forEach((el, index) => {
        const tokens = (tokenLines[index] ?? []).map((token) => ({ offset: token.offset, className: tokenClass(token.type) }))
        this.#paintLine(el, box.lines[index] ?? '', tokens, box.decor[index])
      })
    }
    this.#scheduleWires()
  }

  #buildRail(plan: StoryPlan): void {
    const label = document.createElement('span')
    label.className = 'fb-story-rail-label'
    label.textContent = 'The story'
    this.#rail.appendChild(label)
    plan.order.forEach((id, index) => {
      const piece = this.#pieces.get(id)
      if (piece === undefined) return
      if (index > 0) {
        const arrow = document.createElement('span')
        arrow.className = 'fb-story-rail-arrow'
        arrow.textContent = '›'
        arrow.setAttribute('aria-hidden', 'true')
        this.#rail.appendChild(arrow)
      }
      const step = document.createElement('button')
      step.type = 'button'
      step.className = index === 0 ? 'fb-story-step fb-story-step-entry' : 'fb-story-step'
      step.dataset['piece'] = id
      const mark = this.#compare?.rail[id]
      if (mark !== undefined) {
        step.classList.add(`fb-story-step-${mark}`)
        step.dataset['state'] = mark
      }
      step.title = piece.doc ?? boxName(piece)
      const number = document.createElement('b')
      number.textContent = index === 0 ? '' : String(index)
      if (index === 0) number.setAttribute('aria-label', 'Entry point')
      const name = document.createElement('span')
      name.textContent = boxName(piece)
      step.append(number, name)
      step.addEventListener('click', () => this.follow(id))
      step.addEventListener('pointerenter', () => this.#setFocus(id))
      step.addEventListener('pointerleave', () => this.#setFocus(null))
      this.#rail.appendChild(step)
    })
  }

  #buildFoot(result: StorylineResult, plan: StoryPlan): void {
    const summary = document.createElement('span')
    summary.className = 'fb-story-summary'
    summary.textContent = storySummary(result, plan)
    const spacer = document.createElement('span')
    spacer.className = 'fb-story-spacer'
    const legend = (cls: string, text: string): HTMLElement => {
      const item = document.createElement('span')
      item.className = 'fb-story-legend'
      const swatch = document.createElement('i')
      swatch.className = cls
      item.append(swatch, text)
      return item
    }
    const compare = this.#compare
    // A review says what the plan will change in its notes; only Verify's foot counts what did.
    if (compare !== null && (this.#overlay === null || this.#overlay.mode === 'verify')) {
      const sentence = document.createElement('span')
      sentence.className = 'fb-story-compare-sum'
      sentence.textContent = compare.summary
      if (compare.note !== null) sentence.title = compare.note
      this.#foot.appendChild(sentence)
    }
    this.#foot.append(
      summary,
      spacer,
      legend('fb-story-legend-call', 'calls'),
      legend('fb-story-legend-type', 'uses type'),
      legend('fb-story-legend-class', 'class'),
    )
  }

  #renderRefusal(refusal: StorylineRefusal): void {
    this.element.classList.add('fb-story-refused')
    const wrap = document.createElement('div')
    wrap.className = 'fb-story-refusal'
    const sentence = document.createElement('p')
    sentence.className = 'fb-story-refusal-sentence'
    sentence.textContent = refusal.sentence
    wrap.appendChild(sentence)
    if (refusal.text !== undefined) {
      const pre = document.createElement('pre')
      pre.className = 'fb-story-plain'
      refusal.text.replace(/\r\n?/g, '\n').split('\n').forEach((text, index) => {
        const row = document.createElement('span')
        row.className = 'fb-story-plain-row'
        const number = document.createElement('span')
        number.className = 'fb-story-plain-no'
        number.textContent = String(index + 1)
        number.setAttribute('aria-hidden', 'true')
        row.append(number, text)
        pre.appendChild(row)
      })
      wrap.appendChild(pre)
    } else if (refusal.file !== undefined) {
      this.#callbacks.onPeek(refusal.file)
    }
    this.#viewport.appendChild(wrap)
  }

  // ── Wires ───────────────────────────────────────────────────────────────

  #scheduleWires(): void {
    if (this.#wireFrame !== null || this.#plan === null) return
    this.#wireFrame = requestAnimationFrame(() => {
      this.#wireFrame = null
      if (!this.#destroyed) this.#drawWires()
    })
  }

  /** A rectangle in stage coordinates (unscaled), measured from the DOM. */
  #rectOf(el: Element): StoryRect {
    const base = this.#stage.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const k = this.#camera.k
    return { x: (rect.left - base.left) / k, y: (rect.top - base.top) / k, w: rect.width / k, h: rect.height / k }
  }

  #drawWires(): void {
    const plan = this.#plan
    if (plan === null) return
    this.#svg?.remove()
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'fb-story-wires')
    svg.setAttribute('width', String(this.#stage.scrollWidth))
    svg.setAttribute('height', String(this.#stage.scrollHeight))
    svg.setAttribute('aria-hidden', 'true')
    const defs = document.createElementNS(SVG_NS, 'defs')
    const marker = document.createElementNS(SVG_NS, 'marker')
    marker.setAttribute('id', this.#markerId)
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '9')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '7')
    marker.setAttribute('markerHeight', '7')
    marker.setAttribute('orient', 'auto-start-reverse')
    const head = document.createElementNS(SVG_NS, 'path')
    head.setAttribute('d', 'M0 0L10 5L0 10z')
    head.setAttribute('class', 'fb-story-arrowhead')
    marker.appendChild(head)
    defs.appendChild(marker)
    svg.appendChild(defs)

    const rects = new Map<string, StoryRect>()
    const rectFor = (id: string): StoryRect | null => {
      const cached = rects.get(id)
      if (cached !== undefined) return cached
      const box = this.#boxes.get(id)
      if (box === undefined) return null
      const rect = this.#rectOf(box)
      rects.set(id, rect)
      return rect
    }
    const seen = new Set<string>()
    const dotted = new Set<string>()
    for (const edge of plan.edges) {
      const key = `${edge.from}|${edge.to}|${String(edge.line)}`
      if (seen.has(key)) continue
      seen.add(key)
      const from = rectFor(edge.from)
      const to = rectFor(edge.to)
      if (from === null || to === null) continue
      const lineEl = this.#boxLines.get(edge.from)?.lineAt(edge.line - (this.#pieces.get(edge.from)?.startLine ?? edge.line))
      const geometry = wireGeometry('call', from, lineEl === undefined ? null : this.#rectOf(lineEl), to)
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', geometry.d)
      path.setAttribute('class', geometry.back ? 'fb-story-wire fb-story-wire-back' : 'fb-story-wire')
      path.setAttribute('marker-end', `url(#${this.#markerId})`)
      path.dataset['from'] = edge.from
      path.dataset['to'] = edge.to
      svg.appendChild(path)
      if (!dotted.has(edge.to) && edge.to !== plan.entry && edge.to in plan.stepOf) {
        dotted.add(edge.to)
        const g = document.createElementNS(SVG_NS, 'g')
        g.setAttribute('class', 'fb-story-dot')
        g.dataset['piece'] = edge.to
        const circle = document.createElementNS(SVG_NS, 'circle')
        circle.setAttribute('cx', String(geometry.dot.x))
        circle.setAttribute('cy', String(geometry.dot.y))
        circle.setAttribute('r', String(DOT_RADIUS))
        const text = document.createElementNS(SVG_NS, 'text')
        text.setAttribute('x', String(geometry.dot.x))
        text.setAttribute('y', String(geometry.dot.y))
        text.textContent = String(plan.stepOf[edge.to])
        g.append(circle, text)
        svg.appendChild(g)
      }
    }
    for (const edge of plan.typeEdges) {
      const from = rectFor(edge.from)
      const to = rectFor(edge.to)
      if (from === null || to === null) continue
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', wireGeometry('type', from, null, to).d)
      path.setAttribute('class', 'fb-story-wire fb-story-wire-type')
      path.dataset['from'] = edge.from
      path.dataset['to'] = edge.to
      svg.appendChild(path)
    }
    this.#drawReviewWires(svg, rectFor)
    this.#stage.insertBefore(svg, this.#stage.firstChild)
    this.#svg = svg
  }

  /** A review's dashed "will call" wires: each caller to the new function a note adds. */
  #drawReviewWires(svg: SVGSVGElement, rectFor: (id: string) => StoryRect | null): void {
    const edges = this.#overlay?.willCall ?? []
    if (edges.length === 0) return
    const markerId = `${this.#markerId}-proposed`
    const defs = svg.querySelector('defs')
    const marker = document.createElementNS(SVG_NS, 'marker')
    marker.setAttribute('id', markerId)
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '9')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '7')
    marker.setAttribute('markerHeight', '7')
    marker.setAttribute('orient', 'auto-start-reverse')
    const head = document.createElementNS(SVG_NS, 'path')
    head.setAttribute('d', 'M0 0L10 5L0 10z')
    head.setAttribute('class', 'fb-nr-arrowhead')
    marker.appendChild(head)
    defs?.appendChild(marker)
    for (const edge of edges) {
      const from = rectFor(edge.from)
      const to = rectFor(edge.to)
      if (from === null || to === null) continue
      const piece = this.#pieces.get(edge.from)
      const lineEl = edge.fromLine === null || piece === undefined ? undefined : this.#boxLines.get(edge.from)?.lineAt(edge.fromLine - piece.startLine)
      const lineRect = lineEl === undefined || lineEl.offsetParent === null ? null : this.#rectOf(lineEl)
      const geometry = wireGeometry('call', from, lineRect, to)
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', geometry.d)
      path.setAttribute('class', 'fb-story-wire fb-nr-wire')
      path.setAttribute('marker-end', `url(#${markerId})`)
      path.dataset['from'] = edge.from
      path.dataset['to'] = edge.to
      svg.appendChild(path)
      const label = document.createElementNS(SVG_NS, 'text')
      const x1 = from.x + from.w
      const y1 = lineRect === null ? from.y + 17 : lineRect.y + lineRect.h / 2
      label.setAttribute('x', String(Math.round((x1 + to.x) / 2 - 24)))
      label.setAttribute('y', String(Math.round((y1 + to.y + 17) / 2 - 8)))
      label.setAttribute('class', 'fb-nr-wire-label')
      label.textContent = 'will call'
      svg.appendChild(label)
    }
  }

  // ── Focus ───────────────────────────────────────────────────────────────

  /** Light one piece, its wires and its neighbours; dim the rest. */
  #setFocus(id: string | null): void {
    this.#stage.classList.toggle('fb-story-focus', id !== null)
    for (const box of this.#boxes.values()) box.classList.remove('on', 'near')
    for (const el of this.#stage.querySelectorAll('.fb-story-wire, .fb-story-dot')) el.classList.remove('on')
    for (const step of this.#rail.querySelectorAll<HTMLElement>('.fb-story-step')) step.classList.toggle('on', step.dataset['piece'] === id)
    if (id === null) return
    this.#boxes.get(id)?.classList.add('on')
    for (const wire of this.#stage.querySelectorAll<SVGElement>('.fb-story-wire')) {
      const from = wire.dataset['from']
      const to = wire.dataset['to']
      if (from !== id && to !== id) continue
      wire.classList.add('on')
      const other = from === id ? to : from
      if (other === undefined) continue
      this.#boxes.get(other)?.classList.add('near')
      for (const dot of this.#stage.querySelectorAll<SVGElement>('.fb-story-dot')) if (dot.dataset['piece'] === other) dot.classList.add('on')
    }
    for (const dot of this.#stage.querySelectorAll<SVGElement>('.fb-story-dot')) if (dot.dataset['piece'] === id) dot.classList.add('on')
  }

  // ── Camera ──────────────────────────────────────────────────────────────

  #viewportSize(): { w: number; h: number } {
    return { w: this.#viewport.clientWidth, h: this.#viewport.clientHeight }
  }

  #setCamera(camera: Camera): void {
    this.#camera = camera
    this.#stage.style.transform = `translate(${String(camera.x)}px, ${String(camera.y)}px) scale(${String(camera.k)})`
    this.#viewport.style.backgroundSize = gridBackgroundSize(camera.k)
    this.#viewport.style.backgroundPosition = `${String(camera.x)}px ${String(camera.y)}px`
    this.#callbacks.onCameraChange(camera.k)
  }

  /** Open readable, on the entry point — the story starts there, like reading. */
  #openAtEntry(): void {
    const entry = this.#entry
    // A review with no code to open on opens on its first box.
    const first = entry === null ? this.#boxes.values().next().value : undefined
    if (entry === null && first === undefined) return
    // Measured at k = 1, so the rectangles are the layout's own.
    this.#setCamera({ x: 0, y: 0, k: 1 })
    const box = entry === null ? first : this.#boxes.get(entry)
    if (box === undefined) return
    const rect = this.#rectOf(box)
    let x = rect.x
    let y = rect.y
    const piece = entry === null ? undefined : this.#pieces.get(entry)
    const frame = piece?.className === undefined ? undefined : this.#frames.get(classKey(piece.file, piece.className))
    if (frame !== undefined) {
      const framed = this.#rectOf(frame)
      x = Math.min(x, framed.x)
      y = Math.min(y, framed.y)
    }
    this.#setCamera(openingCamera({ x, y }, this.#viewportSize()))
  }

  /**
   * A SELECTION STAYS IN ITS BOX: while a drag that started in one code block
   * is in progress, every other code block is unselectable, so the selection
   * cannot spill across the sheet. Cleared on release — the selection itself
   * stays, to be copied.
   */
  #beginCodeSelection(block: HTMLElement): void {
    this.#stage.classList.add('fb-story-selecting')
    block.classList.add('fb-story-select-here')
    // A drag past the box's edge lands the selection's end on whatever is
    // there; it is pulled back to the block's own edge, so the selection is
    // only ever this box's code.
    const clamp = (): void => clampSelectionTo(block)
    document.addEventListener('selectionchange', clamp)
    const end = (): void => {
      document.removeEventListener('pointerup', end, true)
      document.removeEventListener('pointercancel', end, true)
      clamp()
      // selectionchange is async: one more turn so the last one is clamped too.
      window.setTimeout(() => {
        clamp()
        document.removeEventListener('selectionchange', clamp)
      }, 0)
      this.#stage.classList.remove('fb-story-selecting')
      block.classList.remove('fb-story-select-here')
    }
    document.addEventListener('pointerup', end, true)
    document.addEventListener('pointercancel', end, true)
  }

  /** Copy gives the code: lines joined by newlines, no chip, fold or button text. */
  #copyCode(event: ClipboardEvent): void {
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    if (start === null || start.closest(CODE_BLOCK_SELECTOR) === null) return
    const text = codeTextOf(range.cloneContents())
    if (event.clipboardData === null) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
  }

  #bindCamera(): void {
    const viewport = this.#viewport
    viewport.addEventListener('copy', (event) => this.#copyCode(event))
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      const block = target?.closest<HTMLElement>(CODE_BLOCK_SELECTOR) ?? null
      if (block !== null && target?.closest('button') === null) this.#beginCodeSelection(block)
      if (target !== null && target.closest(NO_PAN_SELECTOR) !== null) return
      this.#drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: this.#camera, moving: false }
    })
    viewport.addEventListener('pointermove', (event) => {
      const drag = this.#drag
      if (drag === null || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moving) {
        if (!startsPan(dx, dy)) return
        drag.moving = true
        viewport.classList.add('fb-story-dragging')
        viewport.setPointerCapture(event.pointerId)
      }
      this.#setCamera({ ...drag.camera, x: drag.camera.x + dx, y: drag.camera.y + dy })
    })
    const end = (event: PointerEvent): void => {
      if (this.#drag?.pointerId !== event.pointerId) return
      this.#drag = null
      viewport.classList.remove('fb-story-dragging')
    }
    viewport.addEventListener('pointerup', end)
    viewport.addEventListener('pointercancel', end)
    viewport.addEventListener(
      'wheel',
      (event) => {
        if (this.#plan === null) return
        // This sheet's wheel is this sheet's — nothing above it may scroll
        // or zoom on the same gesture.
        event.preventDefault()
        event.stopPropagation()
        if (event.ctrlKey || event.metaKey) {
          const rect = viewport.getBoundingClientRect()
          const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)
          this.#setCamera(zoomAt(this.#camera, factor, event.clientX - rect.left, event.clientY - rect.top))
          return
        }
        this.#setCamera({ ...this.#camera, x: this.#camera.x - event.deltaX, y: this.#camera.y - event.deltaY })
      },
      { passive: false },
    )
  }
}

/** Keep a selection's moving end inside `block`: past its end → its end, before its start → its start. */
function clampSelectionTo(block: HTMLElement): void {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (anchor === null || focus === null || !block.contains(anchor)) return
  const inside = document.createRange()
  inside.selectNodeContents(block)
  const where = inside.comparePoint(focus, selection.focusOffset)
  if (where === 0) return
  selection.extend(block, where > 0 ? block.childNodes.length : 0)
}

/**
 * The code in a copied fragment: what is not code removed, each line on its
 * own line. A selection inside one line clones no line element — its text is
 * the code as it is.
 */
function codeTextOf(fragment: DocumentFragment): string {
  for (const el of fragment.querySelectorAll(NOT_CODE_SELECTOR)) el.remove()
  const lines = [...fragment.querySelectorAll('.fb-story-ln')]
  if (lines.length === 0) return fragment.textContent ?? ''
  return lines.map((line) => line.textContent ?? '').join('\n')
}

/** The box door's glyph: an arrow leaving a square. */
function openGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5')
  svg.appendChild(path)
  return svg
}
