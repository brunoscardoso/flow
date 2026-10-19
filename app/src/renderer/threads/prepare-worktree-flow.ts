/**
 * ONE PATH FROM "GIVE THIS THREAD ITS OWN BRANCH" TO THE ANSWER — the
 * prepare-then-ask protocol, in one place.
 *
 * It was in two. `threads/index.ts` ran it when a person pressed Send on a
 * thread that had no branch of its own; `thread-sidebar.ts` ran it when they
 * chose the row-menu action. Same two calls, same `needs-choice` branch, same
 * question — written out twice, which is the drift allowed-pattern #14 exists
 * to stop. Two spellings of one question do not disagree on the day they are
 * written; they disagree on the day somebody fixes one of them.
 *
 * WHAT MAIN DECIDES AND WHAT THIS DECIDES. Main decides whether this project
 * wants a branch of its own at all, whether the repository can have one, and
 * whether there is uncommitted work worth mentioning. This decides exactly one
 * thing: that a `needs-choice` is put to a person rather than answered on their
 * behalf, and that walking away from it makes nothing. Every other rule is on
 * the other side of the channel.
 *
 * DOM-FREE, AND THAT IS THE POINT. The asking is injected, so the protocol is
 * testable without a renderer and so the surface that asks can be a menu on one
 * caller's chip and a menu on another caller's row without the protocol knowing
 * or caring.
 */

import type {
  CarryChoice,
  ThreadWorktreeResult,
  WorktreeStart,
} from '../../shared/ipc-contract'
import { carryQuestion, type CarryAnswer, type CarryQuestion } from './new-thread-branch'

/** What a caller asks for, minus the carry — which only the person can answer. */
export interface PrepareWorktreeAsk {
  threadId: string
  /**
   * True when a person pressed something. It is what lets main retry a
   * repository that refused earlier, and what lets it drop an idle session so
   * the next turn starts on the new branch.
   */
  requested?: boolean
  start?: WorktreeStart
  branch?: string
}

export interface PrepareWorktreeDeps {
  /** `threads:prepareWorktree`, exactly as the bridge exposes it. */
  prepare(request: PrepareWorktreeAsk & { carry?: CarryChoice }): Promise<ThreadWorktreeResult>
  /** Put the carry question on screen and resolve with what was pressed, or null. */
  askCarry(question: CarryQuestion): Promise<CarryAnswer>
}

/**
 * How it ended.
 *
 * `dismissed` IS NOT A RESULT STATUS, and that is deliberate. Main's
 * `needs-choice` means "I am waiting for an answer"; handing it to a caller as
 * though it were an outcome makes every caller decide for itself whether that
 * counts as a failure — and the one that guessed wrong would tell a person
 * "Flow couldn't set this up" when what happened is that they changed their
 * mind. A separate shape makes the difference impossible to miss and impossible
 * to forget.
 */
export type PrepareWorktreeOutcome =
  | { kind: 'settled'; result: ThreadWorktreeResult }
  | { kind: 'dismissed' }

/**
 * Ask main to give this thread a branch of its own, putting the one question it
 * refuses to answer to the person instead.
 *
 * Never throws for a dismissal and never invents a carry: the only three ways
 * out are a settled result, a question nobody answered, and whatever the
 * channel itself throws.
 */
export async function prepareThreadWorktree(
  deps: PrepareWorktreeDeps,
  ask: PrepareWorktreeAsk,
): Promise<PrepareWorktreeOutcome> {
  const first = await deps.prepare(ask)
  if (first.status !== 'needs-choice') return { kind: 'settled', result: first }

  const question = carryQuestion({
    changedFiles: first.changedFiles ?? 0,
    baseBranch: first.baseBranch ?? null,
  })
  // Main said there was something to ask about and the question disagrees —
  // take the answer that moves nothing rather than inventing a menu with no
  // rows in it. This is the one place a carry is chosen without a person, and
  // it is chosen because there was nothing to show them.
  if (question === null) {
    return { kind: 'settled', result: await deps.prepare({ ...ask, carry: 'clean' }) }
  }

  const answer = await deps.askCarry(question)
  // Walking away makes nothing: no second call, no branch, no session dropped.
  // See `CarryAnswer` for why this is a change from the modal, and why the
  // change is strictly the quieter of the two.
  if (answer === null) return { kind: 'dismissed' }

  return { kind: 'settled', result: await deps.prepare({ ...ask, carry: answer }) }
}
