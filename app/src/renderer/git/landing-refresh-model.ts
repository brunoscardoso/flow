/**
 * When the landing bar re-reads what is waiting (thread-worktrees Phase 9).
 *
 * THE DEFECT THIS EXISTS FOR. The bar read its preview once — at the moment the
 * thread's checkout was created — and never again. At that moment the checkout
 * is a pristine checkout, so the preview says "nothing has changed
 * yet" and Merge is disabled with that as its reason. Everything the thread
 * then writes is invisible to the bar, which is to say: the surface that exists
 * to land a thread's work never learns the work happened.
 *
 * WHY THERE IS NO EVENT TO SUBSCRIBE TO. A thread's checkout is deliberately
 * never a registered project root, so nothing watches it: no `git:changed`,
 * no `project:fileChanged`. The bar cannot be told; it has to look. So the
 * two triggers below are the two moments looking is worth it —
 *
 *   1. THE PANEL COMES INTO VIEW. A person turning to Source Control is asking
 *      what is waiting. Reading git once per reveal is the cheapest honest
 *      answer, and it catches every write nothing broadcast.
 *   2. THE BOUND THREAD'S OWN TURN MOVES. `thread updated` fires at turn
 *      boundaries (working / idle / failed / titled) — a handful per turn, not
 *      a stream — and a turn ending is exactly when an agent has finished
 *      writing into the checkout.
 *
 * Both are filtered, and both are gated on the panel being on screen
 * (allowed-pattern #17 — this repo has answered a hot broadcast with a full
 * refresh five times). A batch that names no thread the bar is bound to draws
 * nothing; a panel nobody can see re-reads when it comes back, not before.
 *
 * Pure and DOM-free so both rules are unit-testable without the panel.
 */
import type { ThreadChangeEvent } from '../../shared/ipc-contract'

/** What the subscription should do with what just arrived. */
export type LandingRefreshAction = 'refresh' | 'skip'

/**
 * A `threads:updated` batch: does the landing bar have to look again?
 *
 * Only `thread`-entity events for the bar's OWN thread count. `message` and
 * `tool_call` churn is the bulk of a streaming turn's batches and moves nothing
 * the bar reads (it reads git in a checkout, not the thread's rows), and
 * another thread's turn is another thread's business.
 */
export function landingRefreshOnThreadEvents(options: {
  events: readonly ThreadChangeEvent[]
  boundThreadId: string | null
  panelOnScreen: boolean
}): LandingRefreshAction {
  const { events, boundThreadId, panelOnScreen } = options
  if (boundThreadId === null) return 'skip'
  // Off screen is not "later" — the reveal below re-reads unconditionally, so
  // a deferred refresh would be the same read done twice.
  if (!panelOnScreen) return 'skip'
  const touchesBoundThread = events.some(
    (event) => event.entity === 'thread' && event.threadId === boundThreadId,
  )
  return touchesBoundThread ? 'refresh' : 'skip'
}

/**
 * The panel's visibility moved: does the landing bar have to look again?
 *
 * The RISING EDGE only. A panel that was already on screen has just been
 * re-announced (a rail click that changed nothing, a view-mode toggle), and a
 * panel going away has nothing to show. A bar bound to no thread has nothing to
 * read either — `setThread` does that read when a thread arrives.
 */
export function landingRefreshOnVisibility(options: {
  wasOnScreen: boolean
  nowOnScreen: boolean
  boundThreadId: string | null
}): LandingRefreshAction {
  const { wasOnScreen, nowOnScreen, boundThreadId } = options
  if (boundThreadId === null) return 'skip'
  return !wasOnScreen && nowOnScreen ? 'refresh' : 'skip'
}
