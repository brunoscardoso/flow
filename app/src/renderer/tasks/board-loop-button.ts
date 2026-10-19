// THE PLAY BUTTON ON TODO — what it shows, and what pressing it would do.
//
// It used to drive the CLI's loop: pressing it cleared a pause on a producer
// that drains `flow/loops/queue.jsonl`. Every card on this board that came from
// the Remote column is a Flow task record on no queue at all, so the button
// worked perfectly and could never start anything — the user pressed it, waited
// six hours, and the card sat there.
//
// It drives the board's own loop now (`tasks:boardLoop`), which works the cards
// that are actually on the board — and only the ones somebody ticked, because
// "sometime the user wanna create some item manually just to track".
//
// Pure: no DOM, no IPC. Every sentence the control can say is decided here so
// each one can be read in a test rather than found on a screenshot.

import type { BoardLoopState, TaskSummary, ThreadSummary } from '../../shared/ipc-contract'
import type { BoardCard } from './board-model'

/** Everything the control renders. */
export interface BoardLoopButton {
  /** The glyph — a play when pressing it would start, a pause when it would stop. */
  glyph: '▶' | '⏸'
  /** True when pressing it starts the loop. */
  start: boolean
  disabled: boolean
  /** The accessible name — what pressing it DOES, never what it looks like. */
  label: string
  /** The hover: what pressing it does, or why it cannot act. */
  title: string
}

/** How many of a project's cards the loop is allowed to take. */
export function readyForTheLoop(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter((task) => task.autoFix && task.archivedAt === null && task.lane === 'todo')
}

/**
 * Loop-filed cards sitting in Todo — work the loop OWNS without a hand-tick.
 *
 * A card wears the `loop` origin only when a producer loop filed it (a dedup
 * fingerprint on the queue item — board-model.ts). That chip IS the offer to
 * work it; requiring a second tick the card cannot even carry — a bare queue
 * item is not a Flow record and has no `autoFix` to set — is the gate that
 * stranded loop work and left ▶ disabled over a Todo column full of it. The
 * notebook guarantee is untouched: a card a person typed (`you`) is not `loop`.
 */
export function loopCardsForTheLoop(cards: readonly BoardCard[]): BoardCard[] {
  return cards.filter((card) => card.origin === 'loop' && card.lane === 'todo')
}

/**
 * The button, from the loop's state and the board's cards.
 *
 * A DISABLED CONTROL OWES ITS REASON IN ITS OWN TERMS (forbidden-pattern #12),
 * and the reason here is the one thing a person cannot see by looking at the
 * column: that none of these cards has been offered to the loop. "Nothing to
 * work" over a Todo column with three cards in it would read as a bug.
 */
export function boardLoopButton(
  state: BoardLoopState | null,
  tasks: readonly TaskSummary[],
  threads: readonly ThreadSummary[] = [],
  cards: readonly BoardCard[] = [],
): BoardLoopButton {
  const running = state?.running === true
  if (running) {
    const current = tasks.find((task) => task.id === state?.taskId)
    // IS IT STUCK ON A QUESTION? A permission prompt puts the thread in
    // `needs-decision` and does NOT end the turn — so the loop holds, correctly,
    // and would otherwise report "Working…" for as long as nobody answered. The
    // whole point of this loop is that you can walk away from it; a stall that
    // looks identical to progress is the one failure it must never have.
    const chat = threads.find((thread) => thread.id === current?.threadId)
    const waiting = chat?.status === 'needs-decision' || chat?.status === 'blocked'
    if (waiting && current !== undefined) {
      return {
        glyph: '⏸',
        start: false,
        disabled: false,
        label: 'Stop working through the list',
        title: `“${current.title}” is waiting on you — open its chat to answer.`,
      }
    }
    return {
      glyph: '⏸',
      start: false,
      disabled: false,
      label: 'Stop working through the list',
      // NAMES THE CARD IT IS ON. "Running" says the loop is alive; this says
      // what it is alive doing, which is the question somebody watching a board
      // is actually asking.
      title:
        current === undefined
          ? 'Working through the list. Press to stop after this card.'
          : `Working “${current.title}”. Press to stop after this card.`,
    }
  }
  const readyRecords = readyForTheLoop(tasks)
  const readyRecordIds = new Set(readyRecords.map((task) => task.id))
  // Loop-filed Todo cards, minus any already counted as a ticked record: a
  // re-claimed loop card carries a `taskId`, and that record is the same work —
  // counting both would overstate what ▶ would take.
  const readyLoopCards = loopCardsForTheLoop(cards).filter(
    (card) => card.taskId === null || !readyRecordIds.has(card.taskId),
  )
  const readyCount = readyRecords.length + readyLoopCards.length
  const stopped = (state?.stoppedReason ?? '').trim()
  if (readyCount === 0) {
    return {
      glyph: '▶',
      start: true,
      disabled: true,
      label: 'Nothing is set to be worked',
      // WHAT JUST HAPPENED COMES FIRST, when something did. A run that works
      // every card leaves them all out of Todo, so this branch is also where a
      // FINISHED loop lands — and answering "tick a card" to somebody who has
      // just watched it work six of them reads as though the run never
      // happened. The remedy still follows, because it is still the way back.
      title:
        stopped.length === 0
          ? 'No card here is set to be worked automatically. Open one and tick “Let the loop work this”.'
          : `${stopped} Tick another card to work more.`,
    }
  }
  const many = readyCount === 1 ? '1 card' : `${String(readyCount)} cards`
  return {
    glyph: '▶',
    start: true,
    disabled: false,
    label: 'Start working through the list',
    // WHAT IT STOPPED FOR, WHEN IT STOPPED ITSELF. Somebody who walked away and
    // came back to a board that is no longer running deserves to know whether
    // it finished or fell over — and the count says what pressing it again
    // would take on.
    title: stopped.length === 0 ? `Work ${many}, one at a time.` : `${stopped} Press to work ${many}.`,
  }
}
