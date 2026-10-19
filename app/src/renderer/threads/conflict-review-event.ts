/**
 * The decoupled `flow:conflict-review` channel (conflict-UX v2, Phase 4). The
 * resolve-flow orchestration (editor/conflict-resolve-index.ts) dispatches this
 * document CustomEvent when the agent's proposals are ready for human review;
 * the conversation pane (threads/conversation-pane.ts) listens and mounts a
 * ConflictReviewCard. The callbacks are in-process JS refs — fine to pass over a
 * CustomEvent since dispatch + listen live in the one renderer.
 *
 * Types only + one event-name const, so the DOM-free resolve-index can import it
 * without pulling the card's DOM (the responder types are `import type`, erased
 * at compile — this module has no runtime dependency on the card).
 */
import type { ConflictDecisionAllFn, ConflictDecisionFn } from './conflict-review-card'
import type { ConflictReviewInput } from './conflict-review-card-model'

/** The document event the resolve flow dispatches to request a review card. */
export const CONFLICT_REVIEW_EVENT = 'flow:conflict-review'

/**
 * The `detail` of a {@link CONFLICT_REVIEW_EVENT}: the card's input rows plus the
 * responders the card wires its Accept / Reject (and Accept all / Reject all)
 * buttons to. `onDecision` MUST resolve to collapse a row and throw to trigger the
 * card's error-recovery (re-enable the row). `onDecisionAll` resolves with the
 * rowIds it decided; on a mid-loop failure it throws an error carrying the
 * already-decided rowIds (`decidedRowIds`), so the card collapses those and
 * re-enables only the still-pending rows — the card's existing contract.
 */
export interface ConflictReviewEventDetail {
  inputs: ConflictReviewInput[]
  onDecision: ConflictDecisionFn
  onDecisionAll: ConflictDecisionAllFn
}
