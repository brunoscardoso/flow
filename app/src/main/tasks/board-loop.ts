// THE BOARD'S OWN LOOP — the part that actually puts somebody to work.
//
// The Todo column had a play button that could not. It cleared a pause on a CLI
// loop, and that loop drains `flow/loops/queue.jsonl`, while a card promoted
// from the Remote column is a Flow task record on no queue at all. The user
// pressed play, waited six hours, and nothing came: the press worked, the loop
// was running nothing, and no surface said the two facts were unrelated.
//
// So the board works its own list. One card at a time, in the card's OWN 1:1
// thread — which is what makes the run visible: it is a conversation you can
// open, read, interrupt and take over, not a background process reporting from
// somewhere else.
//
// WHAT IS ALREADY BUILT AND IS NOT REBUILT HERE, because the lane automation
// this needs has existed since #1192:
//
//   · a turn starting moves its task `todo → doing`  (makeOnTurnStart)
//   · a clean turn sets `suggestDone`                 (makeOnTurnComplete)
//   · a thread with `originLoop` draws the ↻ glyph    (thread-sidebar)
//
// This adds only the missing verb: pick the next card, hand it over, and when
// that turn ends, do it again — until nothing ticked is left.
//
// THE ADVANCE ITSELF IS NO LONGER HERE. "Subscribe to turn completion, ask a
// pure module what to do next, send the next message, repeat" is now
// `TurnDriver`, shared with the autopilot chain — because writing that machine
// a second time beside this one is how two mechanisms that agree today stop
// agreeing tomorrow (allowed-pattern #14). What stays in this file is the only
// part that is about a BOARD: which card, which thread, and what happens to a
// card whose turn just ended. The behaviour is unchanged in every respect a
// test or a person can see.

import type { TaskStore, TaskRecord } from '../store/task-store'
import type { ThreadStore } from '../store/thread-store'
import { TurnDriver, type Dispatched, type ThreadClaims } from '../drive/turn-driver'
import { nextBoardStep, boardLoopPrompt, BOARD_LOOP_NAME } from './board-loop-model'

/** What one project's loop is doing, as any surface asks it. */
export interface BoardLoopStatus {
  running: boolean
  /** The task being worked, or null. */
  taskId: string | null
  /** Why it stopped, when it stopped itself. Null while running. */
  stoppedReason: string | null
}

export interface BoardLoopDeps {
  taskStore: TaskStore
  threadStore: ThreadStore
  /** Guarantee the task has a live 1:1 thread and return the task. */
  ensureThread: (taskId: string) => TaskRecord
  /** Start a turn on a thread. Rejects like the IPC verb does. */
  sendMessage: (threadId: string, content: string) => Promise<unknown>
  /** Tell every surface this project's loop changed. */
  onChange: (rootPath: string, status: BoardLoopStatus) => void
  /**
   * Open a pull request for a thread whose loop turn just finished cleanly, and
   * return its URL — or null when there is nothing to open one from (an unbound
   * thread, no `gh`, a base that lives only on this computer). Absent → the loop
   * never moves a card to Review, which is the board exactly as it was before
   * the Review lane existed.
   */
  openPullRequestForReview?: (threadId: string) => Promise<{ url: string } | null>
  /**
   * Put a card's thread under an autopilot chain, and say whether one took it.
   *
   * THE ASYMMETRY LIVES HERE, and it is deliberate. `autopilot` is a
   * PROJECT-WIDE key: a chain refuses to start on an ordinary conversation in a
   * project whose switch is off, because the switch is the consent and a chain
   * that ignored it would make it decorative. A board-loop thread is not an
   * ordinary conversation — it exists because somebody pressed play on a list
   * of cards they ticked, which IS the consent, and it is autonomous by
   * definition. So it chains whatever the project's key says, and the wiring
   * passes the flag that says so.
   *
   * This replaces the sentence the loop used to open every thread with (see
   * `boardLoopPrompt`): the same reasoning, moved from a model's instructions
   * into the runner, which is the whole point of the change.
   *
   * Omitted → the loop works each card as a single turn, exactly as it did
   * before chains existed. `false` from a wired dep means a chain refused the
   * thread (something else is already driving it, or it is gone), and the loop
   * falls back to the same single turn rather than handing a card to nothing.
   */
  beginChain?: (threadId: string, brief: string) => Promise<boolean>
  /**
   * The app-wide claims registry, shared with every other driver.
   *
   * A card's thread can only be driven by one thing at a time: if an autopilot
   * chain is running the flow's steps in that conversation, the loop must not
   * also be issuing cards into it. Omitted → a private registry, which is a
   * test's business and never the app's.
   */
  claims?: ThreadClaims
}

/** The name this driver claims threads under. Internal, never rendered. */
export const BOARD_LOOP_DRIVER = 'board-loop'

/**
 * One loop per project, held in main.
 *
 * IN MAIN, NOT IN THE BOARD. A run outlives the tab: closing the Tasks view, or
 * switching to another project, must not abandon an agent mid-task. The board
 * asks this what is happening and draws the answer; it does not own it.
 */
export class BoardLoop {
  /**
   * The cards each run has already handed over.
   *
   * A RUN DOES NOT REVISIT ITS OWN WORK. A turn that fails leaves its card in
   * Doing, and without this the loop either sat waiting on a turn that had
   * already ended or handed the same failing card over again all night. Cleared
   * on start, so pressing play again is a fresh pass over whatever is ticked.
   */
  private readonly attempted = new Map<string, Set<string>>()
  private readonly driver: TurnDriver<TaskRecord>

  constructor(private readonly deps: BoardLoopDeps) {
    this.driver = new TurnDriver<TaskRecord>({
      name: BOARD_LOOP_DRIVER,
      claims: deps.claims,
      // The board's policy is unchanged and still lives in `board-loop-model.ts`;
      // only the word for "this one" differs, because the driver is generic
      // over what a caller works on.
      decide: (rootPath, state) => {
        const step = nextBoardStep(
          this.deps.taskStore.listTasks(rootPath, { includeArchived: false }),
          state.inFlight,
          this.attempted.get(rootPath) ?? new Set(),
        )
        return step.kind === 'work' ? { kind: 'work', work: step.task } : step
      },
      dispatch: (rootPath, task) => this.hand(rootPath, task),
      onStart: (rootPath) => this.attempted.set(rootPath, new Set()),
      onEnd: (rootPath) => this.attempted.delete(rootPath),
      // A CLEAN FINISH GOES TO REVIEW. The card the loop just worked produced a
      // pull request; open it and move the card to Review so a human can merge.
      // A turn that FAILED is left where it is (still in Doing, with whatever
      // the agent said) — the same "failure stays visible, not hidden" rule the
      // advance follows. Fire-and-forget so it never delays taking the next
      // card, and it degrades to nothing when no PR can be opened.
      onSettled: (_rootPath, threadId, success) => {
        if (success) void this.reviewOnClean(threadId)
      },
      onChange: (rootPath) => this.deps.onChange(rootPath, this.status(rootPath)),
    })
  }

  status(rootPath: string): BoardLoopStatus {
    const drive = this.driver.status(rootPath)
    return {
      running: drive.running,
      taskId: drive.detail,
      stoppedReason: drive.stoppedReason,
    }
  }

  /** Switch this project's loop on and take the first card. */
  async start(rootPath: string): Promise<BoardLoopStatus> {
    await this.driver.start(rootPath)
    return this.status(rootPath)
  }

  /**
   * Switch it off.
   *
   * THE TURN IN FLIGHT IS LEFT ALONE. Stopping the loop means "take no more
   * cards", not "kill the agent that is mid-sentence" — interrupting a run is
   * its own gesture, on the thread, where a person can see what they are
   * interrupting.
   */
  stop(rootPath: string, reason = 'Stopped.'): BoardLoopStatus {
    this.driver.stop(rootPath, reason)
    return this.status(rootPath)
  }

  /**
   * A turn ended somewhere. If it was ours, take the next card.
   *
   * SUCCESS AND FAILURE BOTH ADVANCE, deliberately. A card whose turn failed is
   * still a card that was worked: it keeps its thread, its lane and whatever the
   * agent said, and a person can read it. Stopping the whole loop on one bad
   * card would mean a single failure silently ends the night's work — the
   * failure is visible either way, in a conversation with a name on it.
   *
   * ONLY OURS, and that is now enforced rather than checked: the shared claims
   * registry says which driver is waiting on this thread, so a card whose
   * conversation is being run by an autopilot chain is that chain's to advance,
   * not this loop's.
   */
  onTurnComplete(threadId: string, success = true): void {
    this.driver.onTurnComplete(threadId, success)
  }

  /**
   * A conversation this loop may have been working is gone.
   *
   * A DELETED THREAD ENDS NO TURN, which is why this is not something the loop
   * finds out by itself: the card it handed over is waiting on a turn that will
   * never complete, and without being told, the loop reports running for ever
   * and takes no further card. Told, it does exactly what it does for any card
   * that did not succeed — leaves it visibly unfinished, and takes the next one,
   * because a single card going wrong must not silently end the night's work.
   *
   * Costs a map walk for a thread no run was on, and changes nothing then.
   */
  onThreadGone(threadId: string): void {
    this.driver.onTurnComplete(threadId, false)
  }

  /** Hand a card to its own conversation. Throws like the IPC verb does. */
  private async hand(rootPath: string, task: TaskRecord): Promise<Dispatched> {
    // A CARD MUST HAVE A CHAT TO BE WORKED IN. `ensureThread` is idempotent
    // and re-checks that the thread still exists, so a healthy card and one
    // whose chat was deleted take the identical path (#1061).
    const ensured = this.deps.ensureThread(task.id)
    const threadId = ensured.threadId
    if (threadId === null) throw new Error(`Could not open a chat for ${ensured.title}.`)
    // THE ↻ GLYPH COMES FROM THIS. `originLoop` is what the sidebar reads to
    // draw a thread as a run rather than a conversation; marking it here is
    // what makes a loop-driven thread look different from one you opened.
    this.deps.threadStore.markAsLoopRun(threadId, BOARD_LOOP_NAME, ensured.title)
    // RECORDED BEFORE THE SEND, not after: a dispatch that throws is still an
    // attempt, and retrying it on the next pump would loop on the failure.
    this.attempted.get(rootPath)?.add(ensured.id)
    const brief = boardLoopPrompt(ensured)
    if (this.deps.beginChain !== undefined) {
      const chained = await this.deps.beginChain(threadId, brief)
      // HANDED OVER, NOT HELD. The chain issues every message in this
      // conversation from here on, so it takes the claim and this loop takes
      // none — and the card stays in flight until the CHAIN ends, not until one
      // of its stages does. `drivenElsewhere` is what says both.
      if (chained) return { threadId, detail: ensured.id, drivenElsewhere: true }
    }
    await this.deps.sendMessage(threadId, brief)
    return { threadId, detail: ensured.id }
  }

  /**
   * Open a pull request for a just-finished card and move it to Review.
   *
   * SILENT WHEN THERE IS NOTHING TO OPEN. An unbound thread, a machine with no
   * `gh`, or a base that lives only on this computer all come back null — the
   * card stays where it is and the global turn-complete hook's "Done?"
   * suggestion still stands. Never throws: a review move that failed must not
   * take the loop down with it.
   */
  private async reviewOnClean(threadId: string): Promise<void> {
    if (this.deps.openPullRequestForReview === undefined) return
    const card = this.deps.taskStore.getTaskByThreadId(threadId)
    if (card === null) return
    try {
      const opened = await this.deps.openPullRequestForReview(threadId)
      if (opened === null) return
      // The card may have been archived or moved while the PR was opening; a
      // card already in Done is left alone, and an unknown one would throw.
      const current = this.deps.taskStore.getTask(card.id)
      if (current === null || current.lane === 'done') return
      // Not activity: the app moved this card, not the user, so it must not jump
      // to the top of the lane's sort (the same carve-out every app-driven move
      // makes). `suggestDone` is cleared — the card's next step is a merge, not a
      // Done chip.
      this.deps.taskStore.updateTask(
        card.id,
        { lane: 'review', prUrl: opened.url, suggestDone: false },
        { activity: false },
      )
    } catch (error) {
      console.warn('[BoardLoop] could not open a pull request for review', {
        taskId: card.id,
        error,
      })
    }
  }
}
