// The review tour's pure model — "Step 2 of 6 · Phase 2 · Data".
//
// The tour walks a plan's change notes one at a time and moves the camera to
// each note's code. Which notes it can walk depends on the mode (Today draws
// none), on what the sheet really draws (`overlay.noteBox`) and on whether the
// note's code was found. This file decides all of that without a DOM so the
// view only paints and the rules stay testable. The DOM is `storyline-view.ts`.
import type { PlanPhaseTitle, StorylineNote } from '../../shared/ipc-contract'
import {
  canSend,
  decisionOf,
  noteSubject,
  noteTitle,
  reviewCounts,
  type ReviewDrafts,
  type ReviewNote,
  type ReviewSaves,
} from './note-review-model'
import type { ReviewOverlay } from './story-review-overlay'
import { noteMissingSentence, VERDICT_CHOICES, type ReviewMode, type ReviewNoteView } from './storyline-view-model'

export interface TourStep {
  /** The note's number — a step is named by it, never by its position. */
  n: number
  /** The box that shows the note in this mode. */
  boxId: string
  /** The first quoted file line to aim the camera at (1-based); null when the quote was not found exactly once. */
  line: number | null
  phase: number
  /** The phase's title, or null when the plan did not name one. */
  phaseTitle: string | null
  kind: 'change' | 'new' | 'file'
  /** What the note is about, as the review's message names it (`the new function x`). */
  subject: string
  /** The short title the chips use — the function, else the file's name. */
  title: string
  /** False when the note's code is not on the sheet — the view then shows `codeMessage`. */
  codeFound: boolean
  /** The review's own sentence for a note without code; null when the code was found. */
  codeMessage: string | null
  /** What the step tells: the file, what changes there, and why. */
  story: TourStory
}

/**
 * THE STEP'S STORY — the note told in a few short lines on the step bar, so
 * the walk-through explains each change where it is shown: "In ActivityRow.tsx
 * · Changing ActivityRow · <what> · Because <why>". The note's own words,
 * never invented ones; a line the note does not carry is null.
 */
export interface TourStory {
  /** The file's name, with its project when it is a sibling's. */
  file: string
  /** "Changing ActivityRow", "Adding getFilters", "Changing this file". */
  action: string
  /** What changes (`what:`), or what a new function is for (`purpose:`). */
  change: string | null
  /** "Because …" (`why:`), or who calls a new function. */
  reason: string | null
  /** Verify only: how it was built — "Done as described: …". */
  result: string | null
}

/** A note's words as a sentence: a capital first letter, nothing else changed. */
function sentence(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? null : trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/** The step's story, from the note alone. */
export function tourStory(note: StorylineNote, mode: ReviewMode): TourStory {
  const name = note.file.slice(note.file.lastIndexOf('/') + 1)
  const file = note.project === undefined ? name : `${note.project} / ${name}`
  const symbol = note.symbol === undefined || note.symbol === '' ? null : note.symbol
  let action: string
  let change: string | null
  let reason: string | null
  if (note.kind === 'new') {
    action = symbol === null ? 'Adding a new function' : `Adding ${symbol}`
    change = sentence(note.purpose) ?? sentence(note.what)
    const callers = (note.callers ?? []).filter((caller) => caller.trim() !== '')
    reason = callers.length > 0 ? `Called from ${callers.join(', ')}` : sentence(note.why)
  } else {
    action = note.kind === 'file' || symbol === null ? 'Changing this file' : `Changing ${symbol}`
    change = sentence(note.what)
    const why = sentence(note.why)
    reason = why === null ? null : `Because ${why.charAt(0).toLowerCase()}${why.slice(1)}`
  }
  let result: string | null = null
  if (mode === 'verify' && note.verdict !== undefined) {
    const label = VERDICT_CHOICES.find((choice) => choice.verdict === note.verdict)?.label ?? note.verdict
    const why = note.verdictWhy?.trim() ?? ''
    result = why === '' ? label : `${label}: ${why}`
  }
  return { file, action, change, reason, result }
}

/** The quoted line to aim at: only a quote found exactly once points anywhere. */
function lineOf(view: ReviewNoteView): number | null {
  const prediction = view.prediction
  if (prediction === undefined || prediction.kind === 'note-new') return null
  if (prediction.quoteMissing === true || (prediction.quoteCount ?? 1) > 1) return null
  return prediction.quoteLines?.startLine ?? null
}

/** One step per note the mode draws, in note order. Today draws none, so it has no tour. */
export function buildTourSteps(
  overlay: ReviewOverlay,
  notes: readonly ReviewNoteView[],
  phases: readonly PlanPhaseTitle[],
  mode: ReviewMode,
): TourStep[] {
  if (mode === 'today') return []
  const titles = new Map(phases.map((phase) => [phase.number, phase.title]))
  const looseMessages = new Map(overlay.loose.map((box) => [box.id, box.message]))
  const steps: TourStep[] = []
  for (const view of [...notes].sort((a, b) => a.note.n - b.note.n)) {
    const { note } = view
    const boxId = overlay.noteBox[note.n]
    if (boxId === undefined) continue
    const missingBox = boxId.startsWith('note-missing:')
    const message = looseMessages.get(boxId) ?? noteMissingSentence(view)
    const codeMessage = missingBox || message !== null ? (message ?? noteMissingSentence(view)) : null
    const codeFound = !missingBox && codeMessage === null
    steps.push({
      n: note.n,
      boxId,
      line: codeFound ? lineOf(view) : null,
      phase: note.phase,
      phaseTitle: titles.get(note.phase) ?? null,
      kind: note.kind,
      subject: noteSubject(note),
      title: noteTitle(note),
      codeFound,
      codeMessage,
      story: tourStory(note, mode),
    })
  }
  return steps
}

/** The step showing note `n`, or -1. */
export function tourStepIndexOf(steps: readonly TourStep[], n: number): number {
  return steps.findIndex((step) => step.n === n)
}

/**
 * Where the tour stands after the sheet was rebuilt (a decision, a mode switch):
 * the same note if it is still there, else the next one, else the last.
 */
export function stepAfterRebuild(previousN: number | null, steps: readonly TourStep[]): number {
  if (steps.length === 0) return -1
  if (previousN === null) return 0
  const same = tourStepIndexOf(steps, previousN)
  if (same !== -1) return same
  const following = steps.findIndex((step) => step.n > previousN)
  return following === -1 ? steps.length - 1 : following
}

export interface TourSummary {
  accepted: number
  rejected: number
  unreviewed: number
  /** The first note (in tour order) still to review — where the summary's "Review the rest" goes. */
  firstUnreviewedN: number | null
  /** The review bar's own Send rule, so the tour never offers what the bar refuses. */
  canSend: boolean
}

/** The end-of-tour card: counts over ALL the plan's notes, the walked ones first for the jump. */
export function tourSummary(
  steps: readonly TourStep[],
  notes: readonly ReviewNote[],
  drafts: ReviewDrafts = {},
  saves: ReviewSaves = {},
): TourSummary {
  const counts = reviewCounts(notes, drafts)
  const byN = new Map(notes.map((note) => [note.n, note]))
  const inTour = steps.find((step) => {
    const note = byN.get(step.n)
    return note !== undefined && decisionOf(note.status) === 'unreviewed'
  })
  const anyOther = [...notes].sort((a, b) => a.n - b.n).find((note) => decisionOf(note.status) === 'unreviewed')
  return {
    accepted: counts.accepted,
    rejected: counts.rejected,
    unreviewed: counts.unreviewed,
    firstUnreviewedN: inTour?.n ?? anyOther?.n ?? null,
    canSend: canSend(notes, saves),
  }
}

/** "Step 2 of 6 · Phase 2 · Data" — the phase's title only when the plan named one. */
export function tourStepLabel(step: TourStep, index: number, total: number): string {
  const phase = step.phaseTitle === null ? `Phase ${String(step.phase)}` : `Phase ${String(step.phase)} · ${step.phaseTitle}`
  return `Step ${String(index + 1)} of ${String(total)} · ${phase}`
}
