/**
 * WHAT AUTOPILOT IS DOING TO THIS CONVERSATION — the chip, decided.
 *
 * A driver in main now issues a workflow's steps into a thread on its own, and
 * the board's loop hands every card it works to that driver. The stop for it
 * existed in main and over the wire from the day it shipped, and there was no
 * control: a person could start a multi-step autonomous run and then neither
 * see which step it was on nor end it from the app. An enforced chain that
 * cannot be interrupted is a worse product than one that never chains, so this
 * module is the half of that sentence that makes it false.
 *
 * ONE MARK ON THE CONVERSATION IT IS ABOUT. Autopilot is a property of the
 * thread on screen exactly as its branch is, so it lives in the same header row
 * beside `branch-chip.ts`, one press from the thing it changes — not in a
 * panel, not in a status bar that belongs to no conversation, and not in a
 * second surface a person has to learn.
 *
 * A THREAD WITH NO AUTOPILOT SHOWS NOTHING. `chainChipState` returns null, and
 * the chip is ABSENT rather than empty. Most conversations will never have one,
 * and a permanent blank strip reporting "nothing" for all of them is the exact
 * failure the deleted status-bar segment was made of.
 *
 * THE FIVE STATES READ DIFFERENTLY BECAUSE THEY ARE DIFFERENT. Running a step,
 * holding because the agent asked the person something, ended itself with a
 * reason, finished-but-not-published, and finished with a pull request are five
 * different pieces of news; collapsing any two of them into one tone or one
 * sentence is the surface lying about what happened.
 *
 * NOT PUBLISHED IS NOT A FAILURE, and it is the state most likely to be
 * rendered as one. The work is built, reviewed and committed on this
 * conversation's branch; what is missing is a person's say-so. The label leads
 * with what exists, never with what did not happen.
 *
 * A PERSON'S OWN STOP LEAVES NO REASON — `stoppedReason: null` is deliberate on
 * main's side, because somebody's own gesture needs no explanation. That state
 * is drawn as the chip GOING AWAY, never as a chip with a blank reason in it.
 *
 * Pure and DOM-free; `chain-chip-view.ts` renders whatever this returns.
 */

import type { ChainState } from '../../shared/ipc-contract'

/**
 * How the chip reads — the palette role, never a literal.
 *
 * `waiting` and `held` are BOTH "a person is the next thing that has to
 * happen", and they are still two tones: one is a question waiting inside this
 * conversation, the other is finished work waiting outside it, and the answer
 * to them is a different action in a different place.
 */
export type ChainChipTone = 'running' | 'waiting' | 'held' | 'published' | 'ended'

export interface ChainChipState {
  /** What the chip says. Never '' — every state has words of its own. */
  label: string
  tone: ChainChipTone
  /** The hover text: what this state MEANS, not what the control does. */
  title: string
  /** True only while there is a run to end. Drives whether Stop is offered. */
  canStop: boolean
  /**
   * The sentence MAIN wrote for this state, when it wrote one — why it stopped,
   * or why the work was not published. Shown verbatim wherever it is shown:
   * re-wording somebody else's explanation is how one fact becomes two
   * different stories (allowed-pattern #14).
   */
  detail: string | null
  /** The pull request it opened, when it opened one. */
  prUrl: string | null
}

/** What the chip says while a run has started but has not named a step yet. */
export const STARTING_LABEL = 'Getting started'

/** What it says while the run is holding for an answer in this conversation. */
export const WAITING_LABEL = 'Waiting for you'

/**
 * What it says when every step ran and the work was not published.
 *
 * IT LEADS WITH WHAT EXISTS. "Not published" as a label puts the absence first
 * and reads as a breakage; the work is built and committed, and the only thing
 * missing is a person.
 */
export const HELD_LABEL = 'Built, waiting on you'

/** What it says when the run ended by opening a pull request. */
export const PUBLISHED_LABEL = 'Pull request opened'

/**
 * What it says when a run ended itself, or never started.
 *
 * DELIBERATELY THE SAME WORD FOR BOTH. Main carries one sentence for every such
 * ending — finished everything, a step that did not finish, a project with
 * autopilot switched off — and nothing on the wire says which of them it is
 * (see the `contract_gaps` note on this change). A label that guessed would be
 * confidently wrong for one of the three; this one is true for all of them, and
 * the sentence that says WHICH is one hover or one press away.
 */
export const ENDED_LABEL = 'Not running'

/** Every fixed label the chip can show — the enumeration the word ban loops over. */
export const CHAIN_CHIP_LABELS = [
  STARTING_LABEL,
  WAITING_LABEL,
  HELD_LABEL,
  PUBLISHED_LABEL,
  ENDED_LABEL,
] as const

/** A sentence worth showing, or null. Blank is not a sentence. */
function said(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** Two sentences, with the empty one dropped rather than joined to a space. */
function joined(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join(' ')
}

/**
 * The chip's whole answer for one moment, or null when there is no chip.
 *
 * PRECEDENCE, AND WHY IT IS THIS ORDER:
 *
 *  1. Running outranks every ending, because an ending held from a previous run
 *     is stale news the moment a new one starts.
 *  2. Within a run, a question outranks a step — a person being asked something
 *     is the one fact they can act on, and it is what main itself checks first.
 *  3. After a run, an unpublished ending outranks a bare reason: the reason for
 *     that ending says only that it stopped, while this says what is waiting.
 *  4. A pull request outranks the reason for the same reason.
 *
 * @param chain what main says this conversation's autopilot is doing, or null
 *        when nothing has been read yet.
 */
export function chainChipState(chain: ChainState | null): ChainChipState | null {
  if (chain === null) return null

  const step = said(chain.step)
  const notPublished = said(chain.notPublished)
  const stoppedReason = said(chain.stoppedReason)
  const prUrl = said(chain.prUrl)

  if (chain.running) {
    if (chain.waitingOnYou) {
      return {
        label: WAITING_LABEL,
        tone: 'waiting',
        title:
          'Autopilot is holding until you answer here. Your reply starts the next step.',
        canStop: true,
        detail: null,
        prUrl: null,
      }
    }
    return {
      label: step ?? STARTING_LABEL,
      tone: 'running',
      title:
        step === null
          ? 'Autopilot is running this conversation.'
          : `Autopilot is running this conversation. Right now: ${step}.`,
      canStop: true,
      detail: null,
      prUrl: null,
    }
  }

  // NOT RUNNING, AND NOTHING TO REPORT. No run has been started here, or a
  // person ended the one that was — which main records by leaving the reason
  // empty, because somebody's own gesture needs no explanation. Either way
  // there is no chip: an empty one would be a permanent blank on every
  // conversation in the app.
  if (notPublished === null && prUrl === null && stoppedReason === null) return null

  if (notPublished !== null) {
    return {
      label: HELD_LABEL,
      tone: 'held',
      // TRUE WHETHER THE PUBLISH WAS WITHHELD OR ATTEMPTED AND REFUSED. Both
      // arrive in this one field and nothing on the wire separates them, so the
      // half this sentence asserts is the half that holds in both: the work
      // exists, it is reviewed, and it is saved where this conversation put it.
      title: joined(
        'Every step ran, and the work is built, reviewed and saved on this conversation’s branch.',
        notPublished,
      ),
      canStop: false,
      detail: notPublished,
      prUrl: null,
    }
  }

  if (prUrl !== null) {
    return {
      label: PUBLISHED_LABEL,
      tone: 'published',
      title: 'Autopilot finished, and the work is published and open for review.',
      canStop: false,
      detail: stoppedReason,
      prUrl,
    }
  }

  return {
    label: ENDED_LABEL,
    tone: 'ended',
    title: joined('Autopilot is not running this conversation.', stoppedReason),
    canStop: false,
    detail: stoppedReason,
    prUrl: null,
  }
}
