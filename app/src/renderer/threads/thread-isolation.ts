/**
 * WHETHER A CONVERSATION'S CHANGES ARE KEPT APART — one mark, and nothing else.
 *
 * WHAT THIS REPLACES. Flow used to manage the thing behind this mark as an
 * object: a status segment with a menu, a ledger dialog, a start dialog, an
 * offer dialog and seven settings fields — thirty-three controls for a noun the
 * reader was never introduced to. The unit a person actually holds in their
 * head is the THREAD, so the isolation stops being an object and becomes a
 * property of one: a rule at the head of a row, and a branch name in the
 * header. This module decides the first of those.
 *
 * IT READS THE SAME TWO FIELDS THE STATUS SEGMENT READ — `worktreePath` and
 * `originLoop` — because the split it has to report is the one the unattended
 * gate created: a thread kept apart because somebody ASKED, and a thread kept
 * apart because a loop took it while nobody was watching. Those are different
 * facts about who is driving, and a mark that reported only "this one is apart"
 * would make that harder to follow rather than easier.
 *
 * IT HAS AN EMPTY CASE, and that is the difference from the segment it
 * replaces. The segment could never go blank, because a footer that vanishes is
 * ambiguous. A rule at the head of a list row is not: the row is still there,
 * the rule simply has no colour, and the surface reserves its width whether or
 * not it is lit — so nothing shifts and nothing is ambiguous. `null` here means
 * "this conversation changes the project's own files", which is the ordinary
 * case and needs no explanation of its own.
 *
 * THE TITLE NAMES THE BRANCH, NEVER A CONTAINER. Where the changes physically
 * sit is Flow's business; which branch they land on is the reader's
 * (forbidden-pattern #12). A branch name is also the one string here that is
 * free to be long — it lives in hover text, where nothing can shred a layout.
 *
 * Pure and DOM-free: decided here, where it is testable under the app's
 * node-env jest; the sidebar row owns the rule it draws.
 */

import type { ThreadSummary } from '../../shared/ipc-contract'

/**
 * Why a conversation is marked — the palette role, never a literal.
 *
 * `null` is not a third colour. It is the absence of the mark, and the reason
 * it is spelled here rather than left to a renderer's truthiness check is that
 * `title` has to be empty in exactly the same case: there is nothing to
 * explain, so explaining nothing is the answer.
 */
export type IsolationTone = 'own' | 'loop'

export interface IsolationMark {
  /** `null` when the conversation changes the project's own files. */
  tone: IsolationTone | null
  /** The hover text: what this MEANS. Empty exactly when `tone` is null. */
  title: string
}

/**
 * The three fields the mark is decided from.
 *
 * A STRUCTURAL SUBSET of `ThreadSummary` rather than a shape of its own, so a
 * rename on the wire is a compile error here instead of a mark that quietly
 * stops appearing. Only two of them decide anything — the third is for the
 * sentence.
 */
export type IsolationSubject = Pick<
  ThreadSummary,
  'worktreePath' | 'worktreeBranch' | 'originLoop'
>

/** A branch worth printing, or null. Blank is not a name. */
function named(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** A name in the reader's own quotes — never backticks, which read as code. */
function quoted(name: string): string {
  return `‘${name}’`
}

/**
 * What a branch that has no name yet is explained as.
 *
 * DETACHED IS THE NORMAL EARLY STATE, not a fault: a conversation has no title
 * to name a branch after until its first reply lands. So this says when the
 * name arrives rather than apologising for its absence — and, critically, it is
 * a whole sentence instead of a blank where a name would go. Printing
 * `‘’` because a field was null is how a real product tells a person it is
 * broken when it is working perfectly.
 */
const UNNAMED_TAIL = 'It goes on a branch of its own, named once its first reply lands.'

/**
 * The mark for one conversation.
 *
 * THE ORDER OF THE CHECKS IS THE MEANING. A loop's isolation is reported as a
 * loop's before it is reported as isolation at all, because "why is this one
 * apart when I never asked" is the question the unattended gate created, and
 * the answer is the whole value of the second tone.
 */
export function isolationMark(thread: IsolationSubject): IsolationMark {
  // NOT APART. The ordinary case, and it says nothing — see the header for why
  // an empty case is safe here and was not safe in the footer.
  if (named(thread.worktreePath) === null) {
    return { tone: null, title: '' }
  }

  const branch = named(thread.worktreeBranch)
  const loop = named(thread.originLoop)

  // A CONVERSATION ON ITS OWN BRANCH IS NO LONGER MARKED.
  //
  // The mark existed to answer "why is this one apart when I never asked" —
  // a question the flipped default retired: isolation is now something a person
  // reaches for. What is left is a rule that lit a rail on every row somebody
  // deliberately set up, saying nothing they did not already know, down a list
  // where the loop's amber is the one colour that still carries information
  // (user, 2026-09-16: "remove that blue indicator here").
  //
  // THE LOOP'S MARK STAYS, and keeps its meaning throughout: an autonomous run
  // is the one case where the reader is not the person using the checkout.
  if (loop === null) {
    return { tone: null, title: '' }
  }

  if (loop !== null) {
    return {
      tone: 'loop',
      title:
        branch === null
          ? `Work picked up on its own, with nothing of it touching the project’s own files. ${UNNAMED_TAIL}`
          : `Work picked up on its own. Everything it does goes on ${quoted(branch)}, and nowhere else.`,
    }
  }

  return {
    tone: 'own',
    title:
      branch === null
        ? `Nothing this conversation does touches the project’s own files. ${UNNAMED_TAIL}`
        : `Everything this conversation does goes on ${quoted(branch)}, and nowhere else.`,
  }
}
