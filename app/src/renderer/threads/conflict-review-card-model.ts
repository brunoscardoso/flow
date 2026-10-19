/**
 * Pure, DOM-free model for the in-thread ConflictReviewCard (conflict-UX v2,
 * Phase 3). Everything here is deterministic and side-effect-free so it can be
 * unit tested under the app's node-env ts-jest (renderer components can't import
 * under that runtime — the view conflict-review-card.ts owns all DOM, this owns
 * the shaping + immutable state transitions).
 *
 * The card summarizes a set of AI conflict-resolution proposals (one row per
 * proposal) and lets the user Accept / Reject each — the shaping here turns an
 * input proposal set (a ConflictProposal plus its resolved side identity and
 * file/hunk location) into an ordered list of row view-models plus a header
 * summary, and the accept/reject/accept-all/reject-all transitions return a NEW
 * view-model each time (never mutate the input — see forbidden-pattern #4).
 *
 * The `choiceLabel` uses the SAME v2 wording as the editor's merge controls:
 * `Accept Current` (ours) / `Accept Incoming` (theirs) / `Accept Both` (both).
 * The `sideLabel` (branch · you · time) is the concrete identity disambiguation,
 * reusing the identity-chip labelling core so the card, the chips, and the
 * marker-line annotation all speak with one voice.
 */
import type { ConflictChoice, ConflictProposal } from '../editor/conflict-proposal'
import { relativeTimeFrom, sideDisplayLabel, type ConflictSide } from '../editor/identity-chip-parts'
import type { SideIdentity } from '../../shared/side-identity'

/** The lifecycle state of one proposal row within the card. */
export type ConflictReviewRowState = 'pending' | 'accepted' | 'rejected'

/** A decision the user can take on one row (or on all rows at once). */
export type ConflictReviewDecision = 'accept' | 'reject'

/**
 * One input proposal for the card: the AI's ConflictProposal, the resolved
 * concrete identity of the side it chose, and where the conflict lives. The
 * caller resolves the SideIdentity (via the git-backed provider) and passes it
 * in so this module stays DOM- and git-free.
 */
export interface ConflictReviewInput {
  /** The AI's proposed resolution for this conflict block. */
  proposal: ConflictProposal
  /** Concrete identity of the side the proposal chose — labels the row truthfully. */
  identity?: SideIdentity
  /** Which visual accent the chosen side carries: `a` (Current) or `b` (Incoming). */
  side: ConflictSide
  /** Absolute repository root the operation runs in (for identity/label parity). */
  rootPath: string
  /** Root-relative path of the conflicted file. */
  filePath: string
  /** The stable hunk id when this proposal targets one hunk; omitted for whole-file. */
  hunkId?: string
  /** Last-resort side label (marker label / branch) when identity is absent. */
  fallbackLabel?: string
  /** Injected clock for deterministic relative-time tests. Defaults to now. */
  now?: Date
}

/** One proposal, shaped into everything the card renders for its row. */
export interface ConflictReviewRow {
  /** Stable id for this row — the caller keys transitions + DOM by it. */
  id: string
  /** Absolute repository root — carried so the view can dispatch file navigation. */
  rootPath: string
  /** Root-relative path of the conflicted file. */
  filePath: string
  /** The hunk id when this row targets one hunk; absent for a whole-file proposal. */
  hunkId?: string
  /** Concrete side identity label (branch · you · time), never a bare stage word. */
  sideLabel: string
  /** v2 choice wording: 'Accept Current' | 'Accept Incoming' | 'Accept Both'. */
  choiceLabel: string
  /** Why this conflict happened / what each side intended (the proposal's `why`). */
  rationale: string
  /** The AI's confidence in its resolution, 0..1. */
  confidence: number
  /** The final risk opinion for the resolution. */
  risk: ConflictProposal['risk']
  /** This row's lifecycle state. */
  state: ConflictReviewRowState
}

/** The header summary a card shows above its rows. */
export interface ConflictReviewSummary {
  /** Total number of proposal rows. */
  proposalCount: number
  /** Distinct conflicted files across the rows. */
  fileCount: number
  /** Rows that target a specific hunk (vs whole-file). */
  hunkCount: number
}

/** The full card view-model: an ordered row list, a header summary, and the
 *  aggregate resolved flag (true once every row is accepted or rejected). */
export interface ConflictReviewViewModel {
  rows: ConflictReviewRow[]
  summary: ConflictReviewSummary
  /** True when every row has left `pending` (all accepted/rejected). */
  resolved: boolean
}

/**
 * The v2 choice wording, mirroring the editor's merge controls. `synthesized`
 * has no side to accept (it is new code the AI wrote) — it holds for review, so
 * the card presents it neutrally as "Review synthesized".
 */
const CHOICE_LABELS: Record<ConflictChoice, string> = {
  ours: 'Accept Current',
  theirs: 'Accept Incoming',
  both: 'Accept Both',
  synthesized: 'Review synthesized',
}

/** The v2 choice label for a proposal's choice. */
/** The generic fallback — used when the failure has nothing specific to say. */
export const GENERIC_DECISION_FAILURE = 'Failed to record decision — try again'

/** Longest failure text a row will render, so one long path cannot reshape the card. */
const MAX_FAILURE_TEXT = 200

/**
 * What a failed Accept/Reject should actually say.
 *
 * The row used to render {@link GENERIC_DECISION_FAILURE} unconditionally —
 * including when the reason was a hunk that no longer exists in the file, where
 * retrying can never succeed and the real fix is re-running Resolve with AI.
 * "Try again" was then not merely unhelpful but wrong.
 *
 * So the responder's own message wins when it has one. A thrown non-Error, or an
 * Error whose message is empty or whitespace, has nothing to tell the reader and
 * falls back to the generic prompt rather than rendering a blank row.
 */
export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (message.length === 0) return GENERIC_DECISION_FAILURE
  if (message.length <= MAX_FAILURE_TEXT) return message
  return `${message.slice(0, MAX_FAILURE_TEXT - 1)}…`
}

export function choiceLabel(choice: ConflictChoice): string {
  return CHOICE_LABELS[choice]
}

/**
 * The stable row id for one input. A hunk-scoped proposal keys by
 * `${filePath}#${hunkId}`; a whole-file proposal keys by `${filePath}#${blockId}`
 * so two blocks of one file never collide on a single id.
 *
 * Exported so the resolve-flow orchestration (Phase 4) can key its accept/reject
 * apply targets by the SAME id the card emits — one id derivation, no drift
 * between what the card shows and what the flow applies (allowed-pattern #14).
 */
export function rowIdForInput(input: ConflictReviewInput): string {
  const suffix = input.hunkId ?? String(input.proposal.blockId)
  return `${input.filePath}#${suffix}`
}

/**
 * Shape one input proposal into its row view-model. The side label reuses the
 * identity-chip core (branch · author · time), so the row names the chosen side
 * by identity, consistent with the editor. All rows start `pending`.
 */
function shapeRow(input: ConflictReviewInput): ConflictReviewRow {
  const primary = sideDisplayLabel(input.identity, {
    side: input.side,
    ...(input.fallbackLabel !== undefined ? { fallbackLabel: input.fallbackLabel } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const author = input.identity?.isCurrentUser ? 'you' : input.identity?.author?.trim()
  const relativeTime = relativeTimeFrom(input.identity?.when, input.now)
  const sideLabel = [primary, author, relativeTime].filter(Boolean).join(' · ')

  return {
    id: rowIdForInput(input),
    rootPath: input.rootPath,
    filePath: input.filePath,
    ...(input.hunkId !== undefined ? { hunkId: input.hunkId } : {}),
    sideLabel,
    choiceLabel: choiceLabel(input.proposal.choice),
    rationale: input.proposal.why,
    confidence: input.proposal.confidence,
    risk: input.proposal.risk,
    state: 'pending',
  }
}

/** Build the header summary from a set of shaped rows. */
function summarize(rows: readonly ConflictReviewRow[]): ConflictReviewSummary {
  const files = new Set<string>()
  let hunkCount = 0
  for (const row of rows) {
    files.add(row.filePath)
    if (row.hunkId !== undefined) hunkCount += 1
  }
  return { proposalCount: rows.length, fileCount: files.size, hunkCount }
}

/**
 * Shape an input proposal set into the card view-model: an ordered row list
 * (input order preserved), a header summary, and the aggregate resolved flag.
 * Pure — the inputs are never mutated.
 */
export function buildConflictReviewViewModel(
  inputs: readonly ConflictReviewInput[],
): ConflictReviewViewModel {
  const rows = inputs.map(shapeRow)
  return { rows, summary: summarize(rows), resolved: isAllResolved(rows) }
}

/** True when every row has left `pending`. An empty row list is resolved. */
function isAllResolved(rows: readonly ConflictReviewRow[]): boolean {
  return rows.every((row) => row.state !== 'pending')
}

/** The row state a decision lands. */
function stateFor(decision: ConflictReviewDecision): ConflictReviewRowState {
  return decision === 'accept' ? 'accepted' : 'rejected'
}

/**
 * Return a NEW view-model with row `id` set to the decided state. An unknown id
 * returns the view-model unchanged (defensive — a stale click can never throw).
 * The input view-model and its rows are never mutated (forbidden-pattern #4).
 */
export function decideRow(
  model: ConflictReviewViewModel,
  id: string,
  decision: ConflictReviewDecision,
): ConflictReviewViewModel {
  const nextState = stateFor(decision)
  const rows = model.rows.map((row) => (row.id === id ? { ...row, state: nextState } : row))
  return { rows, summary: model.summary, resolved: isAllResolved(rows) }
}

/**
 * Return a NEW view-model with EVERY row set to the decided state (Accept all /
 * Reject all). The input view-model and its rows are never mutated.
 */
export function decideAll(
  model: ConflictReviewViewModel,
  decision: ConflictReviewDecision,
): ConflictReviewViewModel {
  const nextState = stateFor(decision)
  const rows = model.rows.map((row) => ({ ...row, state: nextState }))
  return { rows, summary: model.summary, resolved: isAllResolved(rows) }
}
