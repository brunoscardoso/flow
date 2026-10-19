/**
 * WHAT THE CHIP SAYS WHEN YOU PRESS IT — and what stopping actually does.
 *
 * `chainChipState` decides what is happening; this decides how that is
 * explained to somebody who opened the chip to find out, and it exists as its
 * own module for the reason the branch chip's hint did: the words are the whole
 * product here, and words that live in a DOM file cannot be tested in this repo
 * at all (renderer view modules do not import under the node-env runner).
 *
 * THE STOP SENTENCE IS THE POINT OF THIS FILE. Stopping takes no further step;
 * it does NOT interrupt the turn that is running right now, which finishes on
 * its own. Those are two different promises, a person pressing a button called
 * Stop is entitled to know which one they are getting, and the difference is
 * not guessable from the word. Main's own comment on the verb says the same
 * thing in the same order — one behaviour, said once, quoted here for the
 * person rather than re-invented (allowed-pattern #14).
 *
 * IT NEVER SAYS HOW ANY OF THIS IS BUILT. No command, no file, no setting
 * (forbidden-pattern #12) — a person reading this popover is being told what
 * happened and what they can do about it, and nothing else.
 *
 * Pure and DOM-free; the view renders whatever this returns.
 */

import type { ChainChipState } from './chain-chip'

/** One thing the popover offers a press on. */
export interface ChainChipAction {
  label: string
  /** What pressing it does, in full — never an invitation to press it. */
  explain: string
}

export interface ChainChipPopover {
  /** What this popover is about. The feature's name, not a status. */
  title: string
  /** What is happening, in one sentence of our own. */
  status: string
  /**
   * Main's own sentence for this state, when there is one — why it stopped, or
   * why the work was not published. Verbatim, never re-worded.
   */
  detail: string | null
  /** A further sentence when the state needs one, else null. */
  note: string | null
  /** The Stop control, or null when there is no run to end. */
  stop: ChainChipAction | null
  /** The pull request, when one was opened. */
  link: { label: string; url: string } | null
}

/** The feature's name, as a person meets it. */
export const POPOVER_TITLE = 'Autopilot'

export const STOP_LABEL = 'Stop autopilot'

/**
 * The whole truth about the button, in the order that matters.
 *
 * The first sentence is what changes. The second is what does NOT, and it is
 * there because the opposite is the reasonable assumption: a Stop button beside
 * a working agent looks like it kills the agent, and this one does not touch
 * it. Interrupting a reply mid-sentence is its own gesture, on the conversation
 * below, where a person can see what they are interrupting.
 */
export const STOP_EXPLAIN =
  'Nothing further is started. The step running right now is not interrupted — it finishes, and is simply not followed by another.'

export const PR_LINK_LABEL = 'Open the pull request'

/** What the popover says for one moment. */
export function chainChipPopover(state: ChainChipState): ChainChipPopover {
  const stop: ChainChipAction | null = state.canStop
    ? { label: STOP_LABEL, explain: STOP_EXPLAIN }
    : null
  const link =
    state.prUrl === null ? null : { label: PR_LINK_LABEL, url: state.prUrl }

  switch (state.tone) {
    case 'running':
      return {
        title: POPOVER_TITLE,
        // THE STEP IS ALREADY THE STATUS. Main writes it as words a person
        // reads ("Planning the work"), so it is shown as the sentence it is
        // rather than wrapped in a second sentence about itself.
        status: `${state.label}.`,
        detail: null,
        note: 'Each step starts the next one when its turn ends.',
        stop,
        link,
      }
    case 'waiting':
      return {
        title: POPOVER_TITLE,
        status: 'Waiting for your answer in this conversation.',
        detail: null,
        // A HOLD IS NOT AN ERROR AND NOT PROGRESS. Saying what ends it is the
        // whole value of this line: the person is the next step.
        note: 'Nothing is started until you reply here. Your reply starts the next step.',
        stop,
        link,
      }
    case 'held':
      return {
        title: POPOVER_TITLE,
        status: 'Every step ran. The work is built, reviewed and saved on this conversation’s branch.',
        detail: state.detail,
        note: 'Nothing was lost, and publishing it is yours to do.',
        stop,
        link,
      }
    case 'published':
      return {
        title: POPOVER_TITLE,
        status: 'Finished. The work is published and open for review.',
        detail: state.detail,
        note: null,
        stop,
        link,
      }
    case 'ended':
      return {
        title: POPOVER_TITLE,
        status: 'Not running on this conversation.',
        detail: state.detail,
        note: null,
        stop,
        link,
      }
  }
}
