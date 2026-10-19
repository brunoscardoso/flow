/**
 * PLAN CHANGE REVIEW — the review's state, without a DOM. PURE.
 *
 * A plan carries change notes (plan `plan_change_review`). The person reviews
 * them in the code story: Accept and Reject are written to the plan file at
 * once (through main's one writer), while a COMMENT is context — kept here, in
 * the app, until **Send review to the agent** sends one message with every
 * decision and every comment. Unsent comments are a per-plan draft in the
 * renderer's own storage (like an unsent composer draft), so a restart before
 * Send does not lose them; sending clears the draft.
 *
 * This module decides everything about that state a test can check: each
 * note's decision, the counts, whether Send is possible, the sentences on the
 * strip and the bar, the chips, and the one message the agent receives. The
 * message names notes by number and function — never a command, a path or a
 * config key (forbidden-pattern #12).
 */
import type { PlanNoteStatus, StorylineNote } from '../../shared/ipc-contract'

/** What the person decided about a note — `proposed` is not reviewed yet. */
export type NoteDecision = 'accepted' | 'rejected' | 'unreviewed'

/** A note as the review needs it: its number, kind, target and decision. */
export type ReviewNote = Pick<StorylineNote, 'n' | 'kind' | 'file' | 'status'> &
  Partial<Pick<StorylineNote, 'symbol' | 'reason' | 'project'>>

/** Unsent comments by note number — the review's context. */
export type ReviewDrafts = Readonly<Record<number, string>>

export interface ReviewCounts {
  total: number
  accepted: number
  rejected: number
  unreviewed: number
  /** Notes carrying a comment in context. */
  comments: number
}

/** One chip on the review bar: a note that was decided or commented. */
export interface ReviewChip {
  n: number
  decision: NoteDecision
  comment: string | null
  /** What the note is about — `ChatThreadPage.constructor`, or `chats.ts`. */
  title: string
  /** `ChatThreadPage.constructor · accepted — "keep it inline"` */
  text: string
}

/** The storage the drafts live in — `localStorage` in the app, a fake in tests. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The prefix of every review draft's storage key. */
export const REVIEW_DRAFT_KEY_PREFIX = 'flow.planReview.drafts'
/** A comment longer than this is clamped on its chip; the message carries it whole. */
export const REVIEW_CHIP_MAX_CHARS = 80

export function decisionOf(status: PlanNoteStatus): NoteDecision {
  if (status === 'accepted') return 'accepted'
  if (status === 'rejected') return 'rejected'
  return 'unreviewed'
}

/** `Accepted`, `Rejected`, `Not reviewed yet` — the label beside a note's actions. */
export function decisionLabel(decision: NoteDecision): string {
  if (decision === 'accepted') return 'Accepted'
  if (decision === 'rejected') return 'Rejected'
  return 'Not reviewed yet'
}

/** The status a press asks for: pressing the decision already held takes it back. */
export function nextStatus(current: PlanNoteStatus, pressed: 'accepted' | 'rejected'): PlanNoteStatus {
  return current === pressed ? 'proposed' : pressed
}

// ── Drafts ────────────────────────────────────────────────────────────────

/** One key per project and plan: two projects may each have a plan of one name. */
export function draftStorageKey(rootPath: string, plan: string): string {
  return `${REVIEW_DRAFT_KEY_PREFIX}:${rootPath}:${plan}`
}

/** The drafts as stored — anything unreadable reads as no drafts. */
export function parseDrafts(raw: string | null): Record<number, string> {
  if (raw === null || raw === '') return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const drafts: Record<number, string> = {}
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(key)
    if (!Number.isInteger(n) || n < 1 || typeof text !== 'string' || text.trim() === '') continue
    drafts[n] = text
  }
  return drafts
}

/** Read a plan's drafts. Storage may be missing or throw (a private window): no drafts, said once. */
export function loadDrafts(storage: DraftStorage | null, key: string): Record<number, string> {
  if (storage === null) return {}
  try {
    return parseDrafts(storage.getItem(key))
  } catch (error) {
    console.warn('flow: could not read the review comments kept for this plan', error)
    return {}
  }
}

/** Keep a plan's drafts; an empty set removes the key. False when storage refused. */
export function saveDrafts(storage: DraftStorage | null, key: string, drafts: ReviewDrafts): boolean {
  if (storage === null) return false
  try {
    const kept = Object.entries(drafts).filter(([, text]) => text.trim() !== '')
    if (kept.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(Object.fromEntries(kept)))
    return true
  } catch (error) {
    console.warn('flow: could not keep the review comments for this plan', error)
    return false
  }
}

/** A comment added to context: trimmed; an empty one removes the note's comment. */
export function withComment(drafts: ReviewDrafts, n: number, text: string): Record<number, string> {
  const next: Record<number, string> = { ...drafts }
  const trimmed = text.trim()
  if (trimmed === '') delete next[n]
  else next[n] = trimmed
  return next
}

// ── Counts and sentences ──────────────────────────────────────────────────

function commentOf(drafts: ReviewDrafts, n: number): string | null {
  const text = drafts[n]
  return text === undefined || text.trim() === '' ? null : text.trim()
}

export function reviewCounts(notes: readonly ReviewNote[], drafts: ReviewDrafts): ReviewCounts {
  const counts: ReviewCounts = { total: notes.length, accepted: 0, rejected: 0, unreviewed: 0, comments: 0 }
  for (const note of notes) {
    counts[decisionOf(note.status)] += 1
    if (commentOf(drafts, note.n) !== null) counts.comments += 1
  }
  return counts
}

/**
 * The notes Accept all writes: every note not reviewed yet — never a rejected
 * or an accepted one, and never one whose decision is still being saved.
 */
export function notesToAcceptAll(notes: readonly ReviewNote[], saving: ReadonlySet<number> = new Set()): number[] {
  return [...notes]
    .filter((note) => decisionOf(note.status) === 'unreviewed' && !saving.has(note.n))
    .map((note) => note.n)
    .sort((a, b) => a - b)
}

/** A note's write as the review tracks it: in flight, or failed. */
export type ReviewSaves = Readonly<Record<number, { state: 'saving' | 'failed' }>>

function saveStates(saves: ReviewSaves): { saving: boolean; failed: boolean } {
  const states = Object.values(saves).map((save) => save.state)
  return { saving: states.includes('saving'), failed: states.includes('failed') }
}

/**
 * Send review is offered only when every note has a decision AND every
 * decision is in the plan file: one still saving, or one that failed, would
 * send the agent a decision the plan does not hold.
 */
export function canSend(notes: readonly ReviewNote[], saves: ReviewSaves = {}): boolean {
  const { saving, failed } = saveStates(saves)
  return notes.length > 0 && !saving && !failed && notes.every((note) => decisionOf(note.status) !== 'unreviewed')
}

/** Verify records a verdict only on a note that was to be built — a rejected note never was. */
export function canRecordVerdict(note: Pick<ReviewNote, 'status'>): boolean {
  return decisionOf(note.status) !== 'rejected'
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/** The bar's lead: `Review complete` or `2 notes still to review`. */
export function reviewHeadline(counts: ReviewCounts): string {
  return counts.unreviewed === 0 ? 'Review complete' : `${plural(counts.unreviewed, 'note', 'notes')} still to review`
}

/** The bar's tail: `2 accepted · 1 rejected · 2 comments`. */
export function reviewTally(counts: ReviewCounts): string {
  return `${String(counts.accepted)} accepted · ${String(counts.rejected)} rejected · ${plural(counts.comments, 'comment', 'comments')}`
}

/** The strip's right end: what executing now would do with what is not reviewed. */
export function stripSentence(counts: ReviewCounts): string {
  if (counts.total === 0) return 'This plan has no change notes'
  if (counts.unreviewed === 0) return 'All reviewed'
  return `${String(counts.unreviewed)} not reviewed — executing builds them as written, and never builds a rejected note`
}

/** Why Send review cannot be pressed yet, or null when it can. */
export function sendBlockedReason(notes: readonly ReviewNote[], saves: ReviewSaves = {}): string | null {
  if (notes.length === 0) return 'This plan has no change notes to review'
  const { saving, failed } = saveStates(saves)
  if (saving) return 'Wait for every decision to be saved'
  if (failed) return 'A decision was not saved — decide that note again first'
  return canSend(notes) ? null : 'Review every note first'
}

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** One chip per note that was decided or commented, in note order. */
export function reviewChips(notes: readonly ReviewNote[], drafts: ReviewDrafts): ReviewChip[] {
  const chips: ReviewChip[] = []
  for (const note of [...notes].sort((a, b) => a.n - b.n)) {
    const decision = decisionOf(note.status)
    const comment = commentOf(drafts, note.n)
    if (decision === 'unreviewed' && comment === null) continue
    const said = comment === null ? '' : ` — "${clamp(comment, REVIEW_CHIP_MAX_CHARS)}"`
    // NAMED BY WHAT IT IS ABOUT (user, 2026-10-09: "instead of 'Note 1' show
    // the title of the thing") — the function, or the file for a file note.
    const title = noteTitle(note)
    chips.push({ n: note.n, decision, comment, title, text: `${title} · ${decisionLabel(decision).toLowerCase()}${said}` })
  }
  return chips
}

// ── The message ───────────────────────────────────────────────────────────

/** The last segment of a path — a note names its file by name, never by path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A note's short title — the function it changes or adds, else its file's name. */
export function noteTitle(note: ReviewNote): string {
  const symbol = note.symbol === undefined || note.symbol === '' ? null : note.symbol
  return symbol ?? baseName(note.file)
}

/** How the message names a note's target: the function, a new function, or the file. */
export function noteSubject(note: ReviewNote): string {
  const symbol = note.symbol === undefined || note.symbol === '' ? null : note.symbol
  const where = note.project === undefined ? '' : ` in ${note.project}`
  if (note.kind === 'new') return symbol === null ? `a new function${where}` : `the new function ${symbol}${where}`
  if (note.kind === 'file' || symbol === null) return `${baseName(note.file)} as a whole${where}`
  return `${symbol}${where}`
}

function decisionSentence(note: ReviewNote): string {
  const decision = decisionOf(note.status)
  if (decision === 'accepted') return 'accepted'
  if (decision === 'rejected') {
    const reason = note.reason?.trim() ?? ''
    return reason === '' ? 'rejected' : `rejected — reason: ${reason}`
  }
  return 'not reviewed'
}

/**
 * The ONE message Send review puts in the plan's thread: every note in note
 * order with its decision, its reason and its comment, and what to do with
 * them. Plain language only — the agent finds the plan by its name.
 */
export function composeReviewMessage(plan: string, notes: readonly ReviewNote[], drafts: ReviewDrafts): string {
  const ordered = [...notes].sort((a, b) => a.n - b.n)
  const lines = ordered.map((note) => {
    const head = `- Note ${String(note.n)} (${noteSubject(note)}): ${decisionSentence(note)}.`
    const comment = commentOf(drafts, note.n)
    return comment === null ? head : `${head}\n  Comment: ${comment.replace(/\s*\n\s*/g, ' ')}`
  })
  const counts = reviewCounts(notes, drafts)
  return [
    `Here is my review of the change notes in the plan ${plan}.`,
    '',
    ...lines,
    '',
    `${reviewTally(counts)}.`,
    'Please revise the notes in the plan to answer each comment, and leave every accepted and rejected decision as it is. Rejected notes are not to be built.',
  ].join('\n')
}

// ── What a re-read changed ────────────────────────────────────────────────

/** The notes' words — what the agent revises after a review. Decisions and verdicts are not words. */
export function noteWordsKey(notes: readonly StorylineNote[]): string {
  return JSON.stringify(
    [...notes]
      .sort((a, b) => a.n - b.n)
      .map((note) => [note.n, note.kind, note.target, note.where, note.what, note.why, note.signature, note.purpose, note.callers]),
  )
}

/**
 * Where the notes land — their targets, quotes and callers. When a re-read
 * of the plan leaves this the same (an Accept just landed), the story need
 * not be read again; when it moved, the code story must be.
 */
export function notePlacementKey(notes: readonly StorylineNote[]): string {
  return JSON.stringify([...notes].sort((a, b) => a.n - b.n).map((note) => [note.n, note.kind, note.target, note.where, note.callers]))
}
