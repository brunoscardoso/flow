// A DELETED CONVERSATION, TOLD TO EVERY DRIVER — once, from one place.
//
// WHAT WENT WRONG. `threads:delete` hard-deleted the row and told nothing: no
// chain ended, no run stopped, no claim released. The only check for a thread
// that is no longer there lives in the chain's own decision, and a decision is
// only asked for when a turn ends — so a chain HELD on a question, which has no
// turn in flight, was never asked again. Delete a chained card's conversation
// while it is waiting on somebody and the run sat alive for ever.
//
// AND THE COST WAS NOT THE STRANDED RUN. A board-loop card handed to a chain
// takes no claim of its own and is woken by the chain ENDING (`onChainEnd`), so
// a chain that can never end is a project whose board loop reports running for
// ever and dispatches no further cards — silently, with nothing on any surface
// saying why. One deleted chat stopped the whole night's work.
//
// WHY A CHANGE EVENT AND NOT THE HANDLER. `threads:delete` is one of several
// doors: a card's delete cascades to a thread, removing a project deletes every
// thread in it, and the task service cleans threads up on its own. Patching the
// handler would fix one door and leave the rest, so the boundary is the place
// they all pass through — `ThreadStore.deleteThread`, which emits exactly one
// `thread`/`deleted` change event per row that really went. `AgentManager`
// already tears its SDK session down on that same event, for the same reason
// and with the same reach; this is the drivers' half of it.
//
// WHERE THE BOUNDARY DELIBERATELY STOPS. Archiving a thread is NOT this: the
// row survives, the conversation can still be opened and a chain driving it is
// still driving something real. Releasing a thread's checkout is not this
// either — the worktree goes, the conversation stays. Only a row that no
// longer exists ends a run, because only then is there nothing left to drive.

import type { AutopilotChain } from './autopilot-chain'
import type { BoardLoop } from '../tasks/board-loop'
import { THREAD_STORE_CHANGE_EVENT, type ThreadChangeEvent } from '../store/thread-store'

/**
 * The drivers that must hear about it.
 *
 * Narrow on purpose: this module may tell a driver a conversation is gone and
 * nothing else, so no future edit here can reach into a run's state.
 */
export interface ThreadGoneDeps {
  /** Null in a build with no chain — then there is no chain to end. */
  autopilotChain: Pick<AutopilotChain, 'forgetThread'> | null
  boardLoop: Pick<BoardLoop, 'onThreadGone'>
}

/** The slice of the store this needs: its change events, and nothing else. */
export interface ThreadDeletions {
  on(event: string, listener: (event: ThreadChangeEvent) => void): unknown
  off(event: string, listener: (event: ThreadChangeEvent) => void): unknown
}

/**
 * Tell both drivers, in this order, and let each decide what it knew.
 *
 * BOTH, NOT THE FIRST THAT MATCHES. The chain goes first because ending it is
 * what releases the claim and wakes a loop that handed this card over — but a
 * chain that was refused, or that had not issued its first stage yet, announces
 * no ending at all, and a loop driving the thread ITSELF was never in the
 * chain's picture in the first place. Telling the loop unconditionally is what
 * covers those; it costs a map walk and changes nothing when no run was on this
 * thread, and the wake it may duplicate is a no-op by then (the run's turn is
 * already settled and its next card is a different conversation).
 *
 * Neither call throws, and neither is allowed to skip the other.
 */
export function forgetDeletedThread(threadId: string, deps: ThreadGoneDeps): void {
  deps.autopilotChain?.forgetThread(threadId)
  deps.boardLoop.onThreadGone(threadId)
}

/**
 * Subscribe the drivers to every thread deletion, whichever door it came
 * through. Returns the unsubscribe, so the app's own teardown stays symmetrical.
 */
export function watchDeletedThreads(store: ThreadDeletions, deps: ThreadGoneDeps): () => void {
  const onChange = (event: ThreadChangeEvent): void => {
    if (event.entity !== 'thread' || event.action !== 'deleted') return
    forgetDeletedThread(event.threadId, deps)
  }
  store.on(THREAD_STORE_CHANGE_EVENT, onChange)
  return () => {
    store.off(THREAD_STORE_CHANGE_EVENT, onChange)
  }
}
