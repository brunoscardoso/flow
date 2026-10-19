// THE SEAM NOBODY OWNED — the chain asking whether the rung below it left proof.
//
// Autopilot was built as two mechanisms. A REFUSAL (`planflow-ai flow stage
// <stage> --check`, 614 lines of ladder, 431 of gate, 122 tests) and a DRIVER
// (`autopilot-chain.ts`) that issues the next rung when a turn ends. Both
// shipped. Nothing connected them: no caller under `app/src/main`, no skill
// telling an agent to run it, and four command files describing the refusal in
// the passive as though something did (#1915 C2). So the driver advanced on
// `lastTurnSucceeded` alone — a stage whose turn ended cleanly having written
// NOTHING carried the chain on to the next rung, which is the plan's own Goal
// ("a stage refused when its predecessor left nothing behind") unmet, and the
// prose asserting otherwise is the exact defect class the feature existed to
// delete.
//
// This module is that seam. It is deliberately tiny and deliberately its own
// file: the invariant "an edge is proved before it is crossed" now has a name,
// a header, and one place to read it.
//
// WHAT IT IS NOT. No filesystem, no child process, no judgement about proofs.
// The proofs are files and they are read on the CLI side, once, where the
// ladder lives (allowed-pattern #14) — reading them here would be a second
// implementation of the ladder inside the process that answers every IPC call
// (allowed-pattern #19). The app spawns the verb, async and timeout-bounded,
// exactly as the publish gate spawns `flow risk --check`, and turns its
// verdict into the two things this module defines: a boolean and a sentence.
//
// FAIL CLOSED, ALWAYS. Every path that does not produce a clear `may run`
// stops the chain — a refusal, an unreadable answer, a verb that could not be
// run at all. A gate that opens when it cannot tell is not a gate, and a chain
// that advances blind is the bug being fixed rather than a graceful
// degradation of it.
//
// THE SENTENCE IS FOR A PERSON (forbidden-pattern #12). The verb writes for a
// terminal and its payload names modules and paths; what crosses into the app
// is what happened, in the words of the thing on screen. It surfaces through
// `ChainRunStatus.stoppedReason`, which the chain chip renders.

import { type WorkflowStage, nextStage, stageLabel } from './chain-model'

/** What the gate is asked about — one edge of one chain's ladder. */
export interface StageGateInput {
  /** The conversation the chain is driving. */
  threadId: string
  /** The run asking. Its presence is what makes the verb refuse rather than report. */
  chainId: string
  /** The subject — what this chain's documents are named for (`feature-slug.ts`). */
  feature: string
  /** The rung about to be issued. */
  stage: WorkflowStage
  /** The rung whose proof is being asked for — the one this chain just ran. */
  previous: WorkflowStage
}

/** The answer. `detail` is a sentence somebody reads, and only used when refused. */
export interface StageGateStep {
  ok: boolean
  detail: string
}

/**
 * Which edge, if any, this dispatch has to prove before it sends anything.
 *
 * TWO CONDITIONS, AND THE SECOND IS THE INTERESTING ONE.
 *
 *  · The bottom rung is not gated. `discovery` has no predecessor — the CLI's
 *    own `previousStage('discovery')` is null and its verdict for that stage is
 *    an unconditional yes — so asking would spawn a process to be told what the
 *    ladder already says.
 *  · A rung the chain did not itself run the predecessor of is not gated
 *    either, and that is a decision rather than an omission. This chain tells
 *    each stage what to name its document; it can only hold a stage to a name
 *    it gave. A run started part-way up the ladder (`startAt`) inherits
 *    documents some earlier, unchained run named for something else, and
 *    refusing on that would be refusing on a guess — a lockout of a legitimate
 *    entry point, dressed as enforcement. Every edge the chain actually steps
 *    across is gated, which is every edge it is in a position to judge.
 *
 * Returns the rung to prove, or `null` when this issue is not an edge.
 */
export function edgeToProve(
  lastIssued: WorkflowStage | null,
  next: WorkflowStage,
): WorkflowStage | null {
  if (lastIssued === null) return null
  return nextStage(lastIssued) === next ? lastIssued : null
}

/** The chain could not get an answer at all, so it did not go on. */
export const STAGE_UNCHECKED =
  'The last step could not be checked, so nothing more was started.'

/** The verb's refusal reasons, as the payload spells them. */
export type StageRefusalReason = 'predecessor-missing' | 'predecessor-unreadable'

/**
 * Why the chain stopped, in the words a person reads.
 *
 * Names the two steps by their labels — the same sentences the chain chip
 * already shows — and never the document, the directory or the verb. What a
 * person can do about it is look at the step that was supposed to produce
 * something; telling them a filename would be handing them the app's internals
 * and asking them to finish the job.
 */
export function stageGateReason(
  reason: StageRefusalReason | null,
  input: Pick<StageGateInput, 'stage' | 'previous'>,
): string {
  const held = lowerFirst(stageLabel(input.stage))
  const done = stageLabel(input.previous)
  if (reason === 'predecessor-unreadable') {
    return `${done} left something that could not be read, so ${held} was not started.`
  }
  if (reason === 'predecessor-missing') {
    return `${done} left nothing behind, so ${held} was not started.`
  }
  return STAGE_UNCHECKED
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}
