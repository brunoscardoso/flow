// WHAT THE BOARD'S LOOP DOES NEXT — the pure half.
//
// WHY THIS EXISTS AT ALL. The Todo column had a play button that could not put
// anybody to work. It cleared a pause on a CLI loop, and that loop drains
// `flow/loops/queue.jsonl` — while a card promoted from the Remote column is a
// Flow TASK RECORD, on no queue at all. So a person could add work, press play,
// and wait six hours for an agent that was never going to arrive: the press
// really did unpause the loop, the loop really was running nothing, and nothing
// on screen said the two facts were unrelated.
//
// The user's decision was that the board should work its own list:
//
//   "TODO ▶ → picks the top card → its thread: autopilot ON, ↻ loop badge →
//    card moves to DOING → on finish, next card → Todo+Doing empty → stops"
//
// which is also the shape they described when the loops were first reworked:
// "The fixed loop will be start and stop. If there are no issues in the to-do
// anymore or in doing, the loop will stop."
//
// NOT EVERY CARD IS THE LOOP'S BUSINESS, and that is the second half of the
// design: "sometime the user wanna create some item manually just to track, but
// no fix or implement at that moment". A board is also a notebook. So a card
// joins the loop's population only when somebody ticks it — `autoFix` — and
// pressing play works those and nothing else. Default off: a list you were
// keeping to remember things must not become a list an agent starts on because
// you pressed a button somewhere else.
//
// Pure — no store, no IPC, no clock. Given the board's tasks it says what to do
// next, which is the whole of the policy and the only part worth testing
// exhaustively.

import type { TaskRecord } from '../store/task-store'

/** What the runner should do now. */
export type BoardLoopStep =
  | { kind: 'work'; task: TaskRecord }
  | { kind: 'wait'; reason: string }
  | { kind: 'stop'; reason: string }

/**
 * The next thing to do, given every task on this project's board.
 *
 * THE THREE ANSWERS ARE DIFFERENT AND MUST STAY THAT WAY:
 *
 *  · `work` — take this card.
 *  · `wait` — something is already in flight. NOT a stop: the loop is alive and
 *    the card it is on will finish. Reporting this as a stop would switch the
 *    button off under a running agent.
 *  · `stop` — there is nothing in Todo and nothing in Doing, which is the
 *    user's own end condition. It is also the ONLY end condition: a loop that
 *    stopped for any other reason would be a loop that quietly gave up.
 */
export function nextBoardStep(
  tasks: readonly TaskRecord[],
  inFlight: string | null,
  attempted: ReadonlySet<string> = new Set(),
): BoardLoopStep {
  // THE LOOP'S POPULATION IS THE TICKED CARDS, and only those. Everything below
  // — what to take, whether to wait, when to stop — is asked of this list, so a
  // card somebody is only keeping a note about can sit in Todo for ever without
  // ever being picked up, and without holding the loop open either.
  const live = tasks.filter((task) => task.archivedAt === null && task.autoFix)
  // IN FLIGHT WINS OVER EVERYTHING. The dispatched card may already have been
  // moved to Doing by the turn-start hook, or may still read Todo if the turn
  // has not started yet — so the runner's own record of what it sent is the
  // authority, never the lane.
  if (inFlight !== null && live.some((task) => task.id === inFlight)) {
    return { kind: 'wait', reason: 'a card is being worked' }
  }
  const doing = live.filter((task) => task.lane === 'doing')
  const todo = live.filter((task) => task.lane === 'todo')
  if (todo.length === 0) {
    // A CARD THIS RUN ALREADY TOOK DOES NOT HOLD IT OPEN, and finding that out
    // needed a live run rather than a test. A turn that fails leaves its card in
    // Doing — `makeOnTurnComplete` only suggests Done on success — so counting
    // every open card as work-in-progress meant ONE bad card stalled the loop
    // for ever: it sat waiting on a turn that had already ended. Seen the first
    // time the runner was driven end to end with no agent account.
    //
    // A card somebody ELSE dragged into Doing still holds it, which is the case
    // this branch was written for.
    const held = doing.filter((task) => !attempted.has(task.id))
    if (held.length > 0) {
      return { kind: 'wait', reason: 'nothing left to take, and a card is still open' }
    }
    return { kind: 'stop', reason: 'Nothing left that is set to be worked.' }
  }
  // OLDEST FIRST, by the clock the card was created on rather than by the one
  // the board sorts on. `updatedAt` moves every time anything touches a record
  // — a brief arriving, a lane nudge — so ordering by it would let a card that
  // was merely edited jump the queue in front of work that has been waiting.
  // AND NEVER THE SAME CARD TWICE IN ONE RUN. Without this, a card whose turn
  // failed goes straight back to the front of the queue and the loop spends the
  // night re-running the one thing that does not work.
  const fresh = todo.filter((task) => !attempted.has(task.id))
  if (fresh.length === 0) return { kind: 'stop', reason: 'Nothing left that is set to be worked.' }
  const next = [...fresh].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
  if (next === undefined) return { kind: 'stop', reason: 'Nothing left that is set to be worked.' }
  return { kind: 'work', task: next }
}

/**
 * The brief for one card — what the agent is being asked to do, and nothing
 * about how the run is sequenced.
 *
 * THE SENTENCE THAT USED TO OPEN THIS SAID AUTOPILOT WAS ON. It read
 * "Autopilot is ON for this thread: chain the flow's commands through to the
 * end", and it was an instruction because there was nothing else: `autopilot`
 * is a PROJECT-WIDE key, so switching it on to make loop cards chain would have
 * changed how the person's own conversations behave, which nobody asked for.
 * Saying it on the turn reached exactly the loop's threads and no others.
 *
 * That reasoning survives; what changed is that the chaining is now a runner
 * (`../drive/autopilot-chain.ts`), so the loop CHAINS the thread instead of
 * asking it to chain itself — and the asymmetry the sentence was working around
 * is now written into `BoardLoop.hand` in the one place that decides it: a
 * board-loop thread is autonomous by definition and is chained whatever the
 * project's switch says, while an ordinary conversation is chained only when
 * the project has autopilot on. The sentence had to go the day a driver
 * existed: two things telling a thread to chain is how one of them ends up
 * doing it twice.
 *
 * THE TICKET'S OWN WORDS GO IN, unchanged. The agent is being handed work
 * nobody is watching; a bare "do this task" would make it go and find the
 * description it is already holding. This text is the card's brief either way —
 * sent as the turn when the loop works a card directly, and carried as the
 * chain's aim when it hands the card to one.
 */
export function boardLoopPrompt(task: TaskRecord): string {
  const lines = [
    `You are working this task from the board's loop. Nobody is watching it, so work it through to the end.`,
    '',
    `## ${task.title}`,
  ]
  if (task.externalKey !== null && task.externalKey.trim().length > 0) {
    lines.push('', `Tracker reference: ${task.externalKey}`)
  }
  if (task.externalUrl !== null && task.externalUrl.trim().length > 0) {
    lines.push(`Link: ${task.externalUrl}`)
  }
  const description = (task.description ?? '').trim()
  if (description.length > 0) {
    lines.push('', '### What the ticket says', '', description)
  }
  lines.push(
    '',
    'Reproduce it end to end before changing anything, then fix it and verify the same way (allowed-pattern #7). When you are done, say what you verified and how.',
  )
  return lines.join('\n')
}

/** The name a loop-driven thread carries, so the sidebar can say what it is. */
export const BOARD_LOOP_NAME = 'board'
