// Whether this thread's agent TURN is running — a fact about the turn, not
// about the pane's indicator.
//
// `#busy` in the conversation pane drives the "Working…" loader, and every
// stream event that shows motion sets it: a tool starting, a thinking edge, a
// message block opening. Those events also arrive AFTER a turn's `done` — a
// background agent the turn left running reports its own tools — and nothing
// follows them with another `done`. So `#busy` could stay true across a turn
// that had ended, and anything asking "is a turn running?" of it got yes until
// the NEXT turn ended (live 2026-10-09: a doc's new card was held for a whole
// turn it had nothing to do with).
//
// The turn's liveness is decided only by the events that delimit a turn:
// the person's send, the thread status, `done` and `error`. Motion events never
// move it.
import type { ThreadStatus } from '../../shared/ipc-contract'
import type { FeedDensity } from './feed-density'

/** The events that can start or end a turn (everything else leaves it as it is). */
export type TurnEdge =
  | { kind: 'send' }
  | { kind: 'send-rolled-back' }
  | { kind: 'status'; status: ThreadStatus }
  | { kind: 'done' }
  | { kind: 'error' }
  | { kind: 'thread-opened'; status: ThreadStatus | undefined }
  | { kind: 'learning-first-failed' }
  /** Any other stream event — a tool, a thinking edge, a message block. */
  | { kind: 'motion' }

/**
 * Whether a thread with this status has a turn in flight. A turn waiting on a
 * person's decision (a permission, a question) is still that turn.
 */
export function statusHasLiveTurn(status: ThreadStatus | undefined): boolean {
  return status === 'working' || status === 'needs-decision'
}

/** The turn's liveness after `edge`, given what it was before. */
export function turnLiveAfter(live: boolean, edge: TurnEdge): boolean {
  switch (edge.kind) {
    case 'send':
      return true
    case 'send-rolled-back':
    case 'done':
    case 'error':
    case 'learning-first-failed':
      return false
    case 'status':
      return statusHasLiveTurn(edge.status)
    case 'thread-opened':
      return statusHasLiveTurn(edge.status)
    case 'motion':
      return live
  }
}

/**
 * Where live work lands in Compact: the request's live work row only while the
 * turn runs. A background agent the turn left running reports its tools and
 * blocks AFTER `done`; `#ensureLiveRequest` on one of those created a fresh row
 * that pulsed "Working" for ever, since no `done` follows it. Work after the
 * turn goes to the feed (the background-agents line says what is still out).
 */
export function liveWorkTarget(density: FeedDensity, turnLive: boolean): 'request-row' | 'feed' {
  return density === 'compact' && turnLive ? 'request-row' : 'feed'
}
