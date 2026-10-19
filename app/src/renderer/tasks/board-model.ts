// Pure model for the Kanban board once loops live on it (loops-on-the-board,
// Phase 5). DOM-free and IPC-free: given a queue snapshot, the loops' status
// snapshot, the project's local task records and a clock, it produces the four
// lanes' cards and Todo's per-queue grouping. Every decision the board makes
// lives HERE; the render layer only appends elements.
//
// THE ONE RULE THIS FILE ENFORCES:
//
//   Todo is a WINDOW. Doing, Blocked and Done are RECORDS.
//
// The list belongs to whoever owns it — a GitHub repo, or the Flow ledger — and
// the board reads it live and stores nothing. The *work on* the list belongs to
// Flow, and materializes as a local record only when execution starts. So an
// item nobody has started is a window pane (Todo, drawn from the live read and
// gone from the board the moment the owner closes it), while a card in Doing,
// Blocked or Done is a record Flow wrote and keeps.
//
// It inherits loops-panel-model.ts's discipline verbatim, because the failure
// it was written to prevent is the same one:
//
//  - Nothing is computed that the CLI did not report. No lane is inferred from
//    a previous render, no count is derived by subtracting one field from
//    another, and a fact neither snapshot carries is left absent rather than
//    guessed at.
//  - `items: null` and `items: []` ARE DIFFERENT ANSWERS and never collapse.
//    `[]` says the backlog is clear; null says nobody could find out. An
//    unreadable queue produces the `unreadable` state carrying the CLI's own
//    reason — never an empty Todo, which is the exact failure this feature was
//    asked to refuse (NFR-1/NFR-2).
//  - A FILTER NARROWS THE WINDOW, NEVER THE RECORDS. The hunt filter is a
//    question about a backlog, so it may hide items nobody has started and
//    nothing else: a card Flow wrote a record for stays on the board in whatever
//    lane it is in, and the number of cards the filter did remove is reported
//    (`filter.hidden`) rather than left for the reader to notice. Full argument
//    on `BoardHuntFilter`.
//  - THE SAME RULE, SAID GENERALLY — because a second filter forced it. The
//    thread filter (Phase 4) narrows the board to the conversation the reader is
//    in, and the cards it is about are records Flow wrote. Read as "records are
//    exempt", the sentence above would forbid that filter outright. Both filters
//    obey ONE policy, and the sentence above is an instance of it:
//
//      A filter may take a card off the board only when BOTH hold:
//        (1) NOBODY HAS STARTED IT — it is drawn in Todo, the one lane that
//            means "not begun"; and
//        (2) THE CARD ITSELF ANSWERS THE FILTER'S QUESTION.
//
//    (1) is H2's clause with a coincidence removed. When H2 was written, "has a
//    record" and "has been started" picked out the same cards, because the work
//    on a list materialized as a local record only when execution began (the
//    WINDOW/RECORDS rule above says exactly this). A todo mirrored out of a
//    conversation is the first record that exists BEFORE anybody starts, so the
//    two tests came apart, and the one that survives is the LANE. Every card H2
//    protected is in Doing, Blocked or Done and is protected still: work in
//    flight never leaves the board because a filter is on, whatever thread
//    produced it. Done is protected on the same clause — finished work was
//    started, and a record of it is not this conversation's to take away.
//
//    (2) is why the two filters hide different populations of Todo, without
//    either being an exception. A backlog item answers the hunt's question
//    either way: a filing carries a fingerprint and its loop's marker, and an
//    item carrying neither was filed by a person — a definite no. A card answers
//    the thread filter only when it NAMES a producing thread; `originThreadId:
//    null` is documented ignorance ("we do not know"), and hiding on it would
//    turn "nobody recorded where this came from" into "somebody else's
//    conversation", which is the guess this file refuses everywhere else. So the
//    shared backlog stays whatever thread is open, and a local record keeps its
//    exemption from the hunt filter — it carries none of the three facts that
//    filter reads. Full argument on `BoardThreadFilter`.
//  - AMBER IS RESERVED. `attention` is true for the state that wants a human —
//    an item behind the approval gate — and for nothing else. A budget spent and
//    a gate that refused are not blocked: they are the machinery working, and no
//    person can act on either.
//
// The truth source for a loop's queue is read off `queueKind` / `queueLocation`
// as `loop status` and `loop list` report them (D11). Nothing here parses a
// directive: that would be the second reader of one record this whole boundary
// exists to prevent.

import type {
  LoopInstructionStatus,
  LoopQueueGroup,
  LoopQueueItem,
  LoopQueueSnapshot,
  LoopQueueState,
  LoopsSnapshot,
  TaskLane,
  TaskSummary,
  ThreadStatus,
} from '../../shared/ipc-contract'
import { relativeAge } from '../loops/loops-panel-model'

/**
 * Where a card came from — one chip, lowercase, derived from provenance the
 * snapshots actually reported and never from a previous render.
 *
 * `azure` IS IN THE VOCABULARY even though the plan's chip list stopped at
 * `jira`/`github`: `TaskSource` has been `manual | jira | github | azure` since
 * the importer landed, a board can hold Azure work items today, and the two
 * ways to leave it out both lie — `you` would credit a person for an import,
 * and dropping the chip would make an imported card look local. The chip names
 * the store, so the store gets its name.
 *
 * `assistant` IS THE SIXTH, and it exists because the two words already here
 * both lie about a mirrored card. `you` says a person typed this into Flow, and
 * nobody did — an assistant listed it while thinking out loud in a chat. `loop`
 * says a producer filed it onto a list, and none did — a mirrored card is on no
 * list at all until somebody shares it. The word names the author, which is the
 * question a chip answers, and it is the corpus's own word for that author
 * (`todo-reconcile` and `agent-task-reconcile` both say "the assistant").
 */
export type BoardOrigin = 'loop' | 'you' | 'jira' | 'github' | 'azure' | 'assistant'

/**
 * The sentence a card behind the approval gate carries as its `blockedReason`.
 *
 * NAMED, because a second reader needs it. The board's approve control (Phase 6)
 * has to tell a gated card apart from every other blocked one, and the only
 * signal on the card that separates them is this line — so it is a constant with
 * one writer rather than a string literal repeated in the render layer, where a
 * reworded sentence here would silently unhook the control there.
 */
export const APPROVAL_BLOCKED_REASON = 'waiting for approval'

/** One card in one lane. */
export interface BoardCard {
  /** Stable identity for the row — the queue item's, or the local record's. */
  key: string
  title: string
  /**
   * The origin chip, or null when nothing reported where the card came from.
   *
   * Null is reachable only for a queue item whose group never named a
   * `queueKind` — a directive that did not parse, whose items are null anyway.
   * A card with no chip renders with no chip; it does not render a guess.
   */
  origin: BoardOrigin | null
  lane: TaskLane
  /** The local record backing this card, or null for an unclaimed queue item. */
  taskId: string | null
  /** The queue item backing this card, or null for a purely local card. */
  itemId: string | null
  /** The queue group this card came from, or null for a purely local card. */
  queueKey: string | null
  /** The loop whose queue holds it, as the item reports it (may be empty). */
  loop: string | null
  url: string | null
  /**
   * The pull request a Review card carries, or null. Read straight off the
   * task record (never derived); a Review card reads it to offer "PR ↗" and a
   * Merge button, and every other card reads null. A queue item is never a Flow
   * record, so it is always null there.
   */
  prUrl: string | null
  /** Amber. True only for an item awaiting approval. */
  attention: boolean
  /** Why the card is in Blocked, in the CLI's own terms, or null. */
  blockedReason: string | null
  /**
   * The run/owner id holding the item when somebody ELSE holds it — the queue
   * says claimed and this machine has no record of the claim. Reported, not
   * inferred, and deliberately not amber: another engineer's run is the system
   * working, not a state wanting a human.
   */
  heldBy: string | null
  /**
   * Set when a record's queue item was NOT in a read that succeeded — the item
   * was closed or removed while Flow still holds a record of the work.
   *
   * SURFACED, NEVER DROPPED. The card keeps its lane and carries this line, so
   * a run whose item disappeared under it is visible instead of silently
   * vanishing from the board mid-flight. It is set only against a group whose
   * read actually answered: absence proves nothing about a queue nobody could
   * reach, and claiming otherwise would be the empty-Todo lie wearing a
   * different hat.
   */
  missingReason: string | null
  /** Coarse age of the last thing its owner recorded, or null. */
  ageLabel: string | null
  /**
   * Whether the board's loop may work this card.
   *
   * ON THE CARD, not only inside it. Which cards ▶ will take is a property of
   * the column a person is looking at, and having to open each one to find out
   * makes the button's own count unverifiable from the board. A queue item is
   * never `true`: it is not a Flow record yet and has nothing to have been
   * offered.
   */
  autoFix: boolean
  /**
   * The status of the conversation this card owns — what its AGENT is doing —
   * or null when the card owns no thread (an unclaimed queue item) or the
   * thread's status was not supplied.
   *
   * READ, NEVER DERIVED, exactly like every other field here: it is the owning
   * thread's own `status`, looked up by `threadId`. The render layer turns
   * `working` into a pulse and `needs-decision` into the "Needs your input"
   * chip; a resting state (`idle`/`done`/null) draws nothing.
   */
  threadStatus: ThreadStatus | null
  /**
   * How many pieces of background work the owning thread is still waiting on.
   *
   * SEPARATE FROM `threadStatus`, for the reason the whole feature exists: a
   * thread that backgrounded four review agents finishes its turn cleanly and
   * rests, so its status alone says "nothing is happening" while four agents
   * run. 0 when there is no thread, no map, or nothing running.
   */
  backgroundTasks: number
}

/**
 * One queue, and the Todo cards drawn from it.
 *
 * GROUPED BY THE QUEUE, NOT BY THE LOOP. This repo is the case that settles it:
 * `find` and `fix` are two loops that both name `github dev/plan-flow`,
 * so grouping per loop would draw one backlog twice under two headings and
 * invite a reader to think there are two lists. A group is a list; the loops
 * that point at it are carried on `loops` for whoever wants to say so.
 */
/** The queue failures the CLI can name — mirrors the IPC contract's union. */
export type QueueFailureKind =
  | 'not-installed'
  | 'signed-out'
  | 'bad-credentials'
  | 'unreachable'
  | 'rate-limited'
  | 'unknown'

export interface BoardQueueGroup {
  /** `<kind>::<location>`, or `loop:<name>` when the directive named neither. */
  key: string
  kind: string | null
  location: string | null
  /** What to call this list: its location, else the loop that could not name one. */
  label: string
  /** The loops pointing at this queue, in the CLI's order. */
  loops: string[]
  /** False when NO loop on this queue returned a list — see `reason`. */
  readable: boolean
  /** The CLI's verbatim reason, when it gave one. Null is "it said nothing". */
  reason: string | null
  /**
   * WHICH failure the CLI named, when it named one — the half a control can be
   * hung off. `reason` is for reading and this is for deciding, and only
   * 'signed-out' has a remedy the board can offer.
   *
   * ABSENT rather than null when nothing was named, so a group with nothing
   * wrong keeps the exact shape it has always had.
   */
  reasonKind?: QueueFailureKind
  /** This queue's unclaimed items — the window pane. */
  todo: BoardCard[]
}

/**
 * A producer's standing hunt, as a card in Doing (Phase 7, Task 7.1).
 *
 * A HUNT IS NOT A RECORD AND NOT AN ITEM, which is why it is its own type and
 * not a `BoardCard` in `lanes.doing`. Every field on a card is about a piece of
 * work — a lane it sits in, an item it is about, a record Flow keeps of it — and
 * a hunt has none of those: it is the standing sentence a producer is filing
 * against. Squeezing it into `BoardCard` would give the drop handler, the claim
 * path and the detail modal a card with no `itemId` and no `taskId` to reason
 * about, and every one of them would need an `if` about a thing that is not
 * work. It renders in Doing because that is where a running producer belongs to
 * a reader; it is carried separately because that is what it is.
 *
 * EVERY FIELD IS OFF THE STATUS SNAPSHOT. `filed` and `cap` are the store's own
 * two numbers and `status` is the store's own word. Nothing here is derived from a previous
 * render, and nothing is computed that `loop status` did not report — which is
 * also why there is NO BUDGET on this card: the report carries the run's lock
 * but not the directive's `max_run_minutes`, so a remaining budget cannot be
 * computed from it without inventing the half that is missing (the lock's TTL
 * is the budget PLUS a wrap-up margin, so it is not that number either).
 */
export interface BoardHunt {
  /** Stable identity — the instruction's own normalized text, as the CLI keys it. */
  key: string
  /** The sentence a person typed, verbatim. */
  text: string
  /**
   * The loops whose rows reported this hunt, in the CLI's order.
   *
   * A LIST, BECAUSE THE STORE HAS NO OWNER. `flow/loops/instructions.json` is
   * one file per project whose entries carry no loop field, so `loop status`
   * reports the same hunts on every producer row — the honest read of a store
   * that never recorded which producer typed them. One card naming both loops
   * is that fact; two identical cards would be a project with twice the hunts.
   */
  loops: string[]
  /** The topics those loops file under, deduped — the filter's fallback (7.2). */
  topics: string[]
  filed: number
  cap: number
  /** Consecutive runs that found nothing new, as the store counted them. */
  quietRuns: number
  /** `active` | `stopped` | `dry` | `capped`, the CLI's own word. */
  status: LoopInstructionStatus
  /** Coarse age of the moment it was first typed, or null. */
  ageLabel: string | null
}

/**
 * The hunts, and whether anybody could say.
 *
 * `reason` is the same shape a queue group's is, and for the same reason: a
 * project whose instruction store will not parse has NOT said "no hunts". An
 * empty `cards` with a null reason is "nothing is being hunted"; an empty
 * `cards` with a reason is "nobody could find out", and the two must not read
 * alike.
 */
export interface BoardHunts {
  cards: BoardHunt[]
  reason: string | null
}

/**
 * The board narrowed to one hunt's filings (Task 7.2).
 *
 * THE LINEAGE DOES NOT EXIST, AND THIS IS WHAT IS DONE INSTEAD. Phase 2 went and
 * checked at the source: `file()` in queue-backend.ts writes a `<!-- loop: <name>
 * -->` marker, a fingerprint over `{loop, title, primaryFile}`, and labels made
 * of the directive's `label:`, the directive's `topic:` and the approval gate.
 * The instruction's text appears in NONE of them, and `Instruction.tag` — the
 * field that would have carried the link — is only ever preserved by the CLI,
 * never written. There is no item→instruction edge to follow.
 *
 * So the filter is built from the two facts a filing really does carry: the loop
 * that filed it (its own marker) and that loop's topic (a label on the item).
 * It is APPROXIMATE, it is labelled approximate everywhere it is shown, and it
 * is deliberately not called anything stronger. A hunt whose loops have no topic
 * degrades to "everything this producer filed", which is a wider net and an
 * honest one; inventing a text match against the item's body would be a second
 * reader of a record that never claimed to hold this.
 *
 * WHAT THE FILTER IS ALLOWED TO HIDE — THE WINDOW, AND ONLY THE WINDOW:
 *
 *   A hunt filter narrows the backlog. It never removes a card Flow has a
 *   record of, in any lane.
 *
 * This file's one rule already draws the line the filter has to respect: Todo is
 * a WINDOW onto somebody else's list, and Doing/Blocked/Done are RECORDS Flow
 * wrote. Narrowing a window is what a filter is for — "show what this loop
 * filed" is a sentence about a backlog. Taking a record off the board is not:
 * the run happened, the work is this project's, and no chip press should be able
 * to make it disappear.
 *
 * The first cut of this filter tested every card and hid the ones that failed,
 * which read fine against a screen of unclaimed items and was wrong the moment a
 * record existed: a task in Doing on a hand-filed issue (`fingerprint: ""`, so
 * test 1 refuses it) left `lanes.doing` entirely when the reader pressed a
 * different hunt's count. The card was drawn by neither pass — this one had
 * dropped it and the local-records pass below had already marked it joined —
 * and nothing on the board said so. Records are now exempt from the test in both
 * passes, and what the filter did remove is counted on `BoardFilterState.hidden`
 * so the reader is told rather than left to notice.
 */
export interface BoardHuntFilter {
  /** The hunt this filter is about — its key, so pressing twice can clear it. */
  huntKey: string
  /** What to call the filter in the UI: the hunt's own sentence. */
  label: string
  /** The loops whose filings count. A filing names its filing loop. */
  loops: string[]
  /** The topics those loops file under, or empty when none has one. */
  topics: string[]
}

/** The filter a hunt's filed count applies. Pure — the hunt already knows this. */
export function huntFilterFor(hunt: BoardHunt): BoardHuntFilter {
  return { huntKey: hunt.key, label: hunt.text, loops: [...hunt.loops], topics: [...hunt.topics] }
}

/**
 * What a filter did to the board, in cards.
 *
 * ONE SHAPE FOR EVERY FILTER, deliberately. The hunt filter and the thread
 * filter ask different questions of different populations, but a reader handed a
 * narrowed board needs the same two numbers from either — how much of what is
 * left is the answer, and how much went away to produce it. A second shape here
 * would be a second grammar in the bar, for no gain.
 */
export interface BoardFilterCounts {
  /**
   * How many cards MATCHED it, so an empty result reads as a filter, not a bug.
   *
   * Matched, not merely drawn. A card kept in spite of the filter — a record the
   * hunt filter may not touch, a card in Doing the thread filter may not touch —
   * is drawn whether or not it matched, and is counted in neither number: it is
   * not evidence the filter found something, and it is not something the filter
   * took away.
   */
  matched: number
  /**
   * How many cards the filter REMOVED from the board.
   *
   * REPORTED SO THE READER IS TOLD, because a narrowed board and a small board
   * look identical and only one of them is the reader's own doing. `matched: 0`
   * already says "the answer to this question is not on the board"; this says
   * how much of the board went with the question, which is the number a "N
   * hidden by this filter" line needs and the only honest way to offer clearing
   * it.
   *
   * Counted where a card would actually have been drawn: an item the lane rules
   * keep off the board anyway (a closed item Flow never touched) is not the
   * filter's doing and is not counted here.
   *
   * ONE REASON PER CARD, so two filters cannot both claim the same casualty.
   * When a hunt filter and a thread filter are both in force, the hunt filter is
   * asked first and a card it removed is counted only there — so the two numbers
   * SUM to the cards that actually left the board, and a bar showing both lines
   * cannot double-count its way into a total the board never lost.
   */
  hidden: number
}

/** The active hunt filter, as the board reports it back to the reader. */
export interface BoardFilterState extends BoardHuntFilter, BoardFilterCounts {
  /**
   * ALWAYS TRUE, and typed as the literal so no caller can set it false.
   *
   * There is no exact mode to switch to — see `BoardHuntFilter`. The field
   * exists so the render layer cannot forget to say so.
   */
  approximate: true
}

/**
 * The board narrowed to the conversation the reader is in (Phase 4, FR-5/FR-6).
 *
 * WHAT IT IS ALLOWED TO HIDE — the general policy in this file's header, applied:
 *
 *   The thread filter removes a card only when the card is in TODO and NAMES a
 *   producing thread that is not this one. Doing, Blocked and Done are never
 *   touched, and neither is a card that names no thread at all.
 *
 * THE CONTESTED HALF, SETTLED. A thread filter's obvious reading is "show this
 * conversation's cards and nothing else", which would take another thread's work
 * in flight off the board — the exact thing review finding H2 forbade. It is not
 * done, and the reason is that the board has already made the other promise: a
 * card Flow has a run record for is drawn in whatever lane it is in, and a run
 * that disappears from the board mid-flight is the failure H2 was written about.
 * A conversation is a question about what is NEXT, so it narrows the lane that
 * holds what is next, and answers with a count for the rest.
 *
 * ONE FACT IS READ, AND IT IS NOT THE CARD'S OWN THREAD. `TaskSummary` carries
 * two thread links with two meanings: `threadId` is the conversation a card
 * OWNS (click it, open it), and `originThreadId` is the conversation that
 * PRODUCED it. Only the second is provenance, and only the second is read here.
 * Reading `threadId` as well would hide every card that owns a conversation
 * other than the open one — which in a project that predates this feature is
 * most of the board, breaking the promise that a project with no agent todos
 * sees no change (NFR-5).
 *
 * A NULL ORIGIN IS SILENCE, NOT A DENIAL. The field is documented as "we do not
 * know": a task no conversation produced, a row written before the column
 * existed, or an origin thread since deleted. An unclaimed queue item has no
 * origin to read at all. Neither is hidden — treating an unknown as "somebody
 * else's" is the guess this whole model refuses, and it would empty the shared
 * backlog out of Todo the moment any thread was open.
 */
export interface BoardThreadFilter {
  /** The active thread's id — what a card's provenance is compared against. */
  threadId: string
  /**
   * What to call the conversation in the UI: its own title, or null when the
   * signal named the thread without naming it. Null renders as the bar's own
   * words for "this conversation" — never as an invented title.
   */
  label: string | null
}

/** The active thread filter, as the board reports it back to the reader. */
export interface BoardThreadFilterState extends BoardThreadFilter, BoardFilterCounts {}

/**
 * The board's top-level answer about the list itself.
 *
 * `unreadable` and `no-list-configured` are the two states that exist so the
 * board never renders a failure as an emptiness. They are distinct from each
 * other on purpose: "nobody could read your list" and "you have no list" want
 * opposite things from the reader (retry vs. set one up).
 */
export type BoardQueueState = 'ready' | 'partial' | 'unreadable' | 'no-list-configured'

export interface BoardLanes {
  todo: BoardCard[]
  doing: BoardCard[]
  blocked: BoardCard[]
  review: BoardCard[]
  done: BoardCard[]
}

export interface BoardModel {
  state: BoardQueueState
  /**
   * The snapshot-level reason a read failed, verbatim, or null.
   *
   * Snapshot-level ONLY — a single loop's unreachable backend lives on its own
   * group's `reason`, because the rest of the board is still true and a
   * whole-board banner would overstate the damage.
   */
  reason: string | null
  groups: BoardQueueGroup[]
  /** Todo cards belonging to no queue — manual and imported local records. */
  localTodo: BoardCard[]
  lanes: BoardLanes
  /** The producers' standing hunts, drawn in Doing (Task 7.1). */
  hunts: BoardHunts
  /**
   * The hunt filter in force, or null for the whole board (Task 7.2).
   *
   * THE HUNTS THEMSELVES ARE NEVER FILTERED. The filter is about the cards, and
   * the hunt is the thing it is about — hiding the other hunts would take away
   * the only control that can switch or clear it.
   */
  filter: BoardFilterState | null
  /**
   * The thread filter in force, or null when the board is not narrowed to a
   * conversation (Phase 4).
   *
   * SEPARATE FROM `filter`, not a replacement for it: the two ask different
   * questions and either can be on alone, so folding them into one field would
   * make the bar unable to say which question the board is currently answering.
   */
  threadFilter: BoardThreadFilterState | null
}

/** Everything the model reads. Dependency-injected: no globals, no clock call. */
export interface BoardModelInput {
  /**
   * The `loops:queue` read. THE PLAN CALLED FOR THIS ALONE; the loops status
   * snapshot is here too because Blocked is defined by a fact that lives only
   * on it (`awaitingApprovalIds`) and the alternative was to derive it
   * app-side, which this file is not allowed to do.
   */
  queue: LoopQueueSnapshot
  /** The `loops:activity` status snapshot, or null when the board has not got one. */
  loops: LoopsSnapshot | null
  /** The project's local task records (the run records), as the store lists them. */
  tasks: TaskSummary[]
  /** Injected clock, in epoch ms. */
  now: number
  /** Narrow the board to one hunt's filings (Task 7.2), or null for all of it. */
  filter?: BoardHuntFilter | null
  /**
   * Narrow the board to the conversation the reader is in (Phase 4), or null.
   *
   * ABSENT IS THE WHOLE OF FR-7: with no thread active the caller passes
   * nothing, no card is tested, and the board is exactly the board it was before
   * this feature existed.
   */
  threadFilter?: BoardThreadFilter | null
  /**
   * Each thread's current status, keyed by thread id — what its agent is doing.
   * The board already holds the thread summaries; this is the one field a card
   * reads off them. Absent/omitted → every card's `threadStatus` is null and the
   * board looks exactly as it did before this existed (backward compatible).
   */
  threadStatusById?: ReadonlyMap<string, ThreadStatus>
  /** How many background tasks each thread is waiting on — see
   *  `BoardCard.backgroundTasks`. Absent → every card reads 0. */
  backgroundTasksById?: ReadonlyMap<string, number>
}

/** What one loop's status says about blocking. Absent means "not measured". */
interface LoopBlockState {
  awaitingApprovalIds: Set<string>
}

/**
 * Index the status snapshot by loop.
 *
 * ONE FACT IS TAKEN FROM IT, and it is the CLI's own: which item ids are waiting
 * on a human. Everything else a status row carries — the cap, the last outcome —
 * is deliberately not read here, because none of it is a state a person can act
 * on and the Blocked lane is for the states that are.
 *
 * IT USED TO TAKE A SECOND ONE. A tripped consecutive-failure breaker put the
 * work a loop was holding into Blocked; the breaker went with the supervision
 * layer (loops-native-runtime, Phase 6), so nothing can trip and nothing can
 * carry that label. A lane no card can reach is a lane the board promises and
 * never fills.
 */
function blockStates(snapshot: LoopsSnapshot | null): Map<string, LoopBlockState> {
  const states = new Map<string, LoopBlockState>()
  if (snapshot === null || !snapshot.available) return states
  for (const row of snapshot.loops) {
    states.set(row.loop, {
      // Absent means NOT MEASURED, exactly as `queue: null` does — an empty set
      // here says "nothing was named", never "nothing is waiting", and the
      // item's own `approved` flag is the other half of that same one read.
      awaitingApprovalIds: new Set(row.awaitingApprovalIds ?? []),
    })
  }
  return states
}

/**
 * Is this item waiting on a human to approve it?
 *
 * TWO ANSWERS TO ONE READ, and either will do. `loop status` fills
 * `awaitingApprovalIds` from the same `backend.list()` that sets the item's
 * `approved` flag, so they cannot disagree about a queue state that existed —
 * but the board can be holding one snapshot without the other, and refusing to
 * answer because the *other* read is missing would hide a gate from the person
 * it is waiting for.
 */
/**
 * The status rows that speak for one item: the loop whose read returned it, and
 * the loop its own marker names when that is a different one. Both, because a
 * consumer draining another loop's filings is the normal case and either row
 * can be the one carrying the gate.
 */
function blockStatesFor(
  states: Map<string, LoopBlockState>,
  rowLoop: string,
  itemLoop: string,
): LoopBlockState[] {
  const found: LoopBlockState[] = []
  const fromRow = states.get(rowLoop)
  if (fromRow !== undefined) found.push(fromRow)
  const trimmed = itemLoop.trim()
  if (trimmed.length > 0 && trimmed !== rowLoop) {
    const fromItem = states.get(trimmed)
    if (fromItem !== undefined) found.push(fromItem)
  }
  return found
}

function awaitingApproval(item: LoopQueueItem, states: LoopBlockState[]): boolean {
  if (!item.approved) return true
  return states.some((state) => state.awaitingApprovalIds.has(item.id))
}

// ── Identity and joining ────────────────────────────────────────────────

/**
 * A URL as an identity, not as a link: trimmed, trailing slash removed, case
 * left alone. Hosts are case-insensitive and paths are not, and lowercasing the
 * whole thing to make one join easier would quietly merge two different items
 * on any backend that cares.
 */
function urlKey(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The external key a local record would carry for this item.
 *
 * `owner/repo#123` is not invented here — it is the exact key `parseIssueRef`
 * builds for a GitHub issue and the exact string the importer stores on the
 * task, so a queue item and an imported task meet on a key both sides already
 * write. A queue with no location has no such key and gets none.
 */
export function queueItemExternalKey(
  location: string | null | undefined,
  itemId: string,
): string | null {
  if (location === null || location === undefined) return null
  const trimmed = location.trim()
  return trimmed.length > 0 ? `${trimmed}#${itemId}` : null
}

/** The join index over the local records: by external key and by URL. */
interface RecordIndex {
  byKey: Map<string, TaskSummary>
  byUrl: Map<string, TaskSummary>
}

function indexRecords(tasks: TaskSummary[]): RecordIndex {
  const byKey = new Map<string, TaskSummary>()
  const byUrl = new Map<string, TaskSummary>()
  for (const task of tasks) {
    const key = task.externalKey?.trim()
    // First writer wins: two records on one key is a store-level anomaly (the
    // store has a unique index on it), and picking the later one arbitrarily
    // would make the board's join depend on list order.
    if (key !== undefined && key.length > 0 && !byKey.has(key)) byKey.set(key, task)
    const url = urlKey(task.externalUrl)
    if (url !== null && !byUrl.has(url)) byUrl.set(url, task)
  }
  return { byKey, byUrl }
}

/** The local record for one queue item, or null when Flow has none. */
function recordFor(
  index: RecordIndex,
  group: LoopQueueGroup,
  item: LoopQueueItem,
): TaskSummary | null {
  const key = queueItemExternalKey(group.queueLocation, item.id)
  if (key !== null) {
    const byKey = index.byKey.get(key)
    if (byKey !== undefined) return byKey
  }
  const url = urlKey(item.url)
  if (url !== null) {
    const byUrl = index.byUrl.get(url)
    if (byUrl !== undefined) return byUrl
  }
  return null
}

// ── Origin chips ────────────────────────────────────────────────────────

/**
 * Was this record MIRRORED out of a conversation, rather than typed or imported?
 *
 * `source` CANNOT ANSWER THIS, AND THAT IS THE FIRST THING TO KNOW ABOUT IT.
 * Both mirrors — the whole-list one and the id-addressed one — store their cards
 * as `source: 'manual'`, deliberately and permanently: `TaskSource` names an
 * external TRACKER, an assistant's list is not one, and `manual` is also what
 * keeps a mirror's internal key off every screen (every surface that renders
 * `externalKey` guards on `source !== 'manual'` first). So `source === 'manual'`
 * is necessary and nowhere near sufficient — a hand-typed card and a ledger
 * queue's run record are both `manual` too.
 *
 * WHAT ACTUALLY SAYS IT IS THE PAIR OF FIELDS THE MIRROR WROTE TOGETHER: the
 * card names a producing thread, and it is filed under a key BELONGING to that
 * thread. `mirrorExternalKey` builds `<originThreadId>#<todo identity>` and
 * `mirrorTaskExternalKey` builds `<originThreadId>#TASK#<id>`, so both mirrors
 * satisfy the one prefix test and nothing else does: a hand-typed card carries
 * no external key, an imported issue's key is `owner/repo#123` (no thread names
 * itself that), and a ledger run record — `manual` with a key, the one shape
 * that could be confused for this — carries no origin thread to prefix it. The
 * two facts are checked TOGETHER for the same reason `mirroredCardsFor` checks
 * them together in main: either alone is a fact about something else.
 *
 * DUPLICATED BY VALUE FROM `mirrorExternalKey`, like `huntKey` above and for the
 * same reason: that function lives in main next to the store, this file is pure
 * and may not reach into it, and the alternative — a chip derived from a title
 * or from `threadId` — would be a guess. The grammar it copies is one separator,
 * and the day it changes, the chip degrades to `you` rather than to a wrong
 * claim about somebody's conversation.
 *
 * WHEN THE ORIGIN THREAD IS DELETED THIS GOES QUIET, and that is the deletion
 * semantics FR-10 chose showing through rather than a defect here. The column is
 * `ON DELETE SET NULL` precisely so a card OUTLIVES the chat that produced it
 * while claiming no knowledge of a conversation that no longer exists; with the
 * origin gone there is nothing on the card that says a mirror wrote it, and the
 * chip falls back to what the board has always said about a `manual` record. A
 * fallback of "no chip" was considered and is not available: it would need this
 * function to recognise a thread id by its SHAPE, which is exactly the kind of
 * guess the rest of this file refuses.
 */
export function isMirroredTask(task: TaskSummary): boolean {
  if (task.source !== 'manual') return false
  const origin = trimmedOrNull(task.originThreadId)
  if (origin === null) return false
  const key = trimmedOrNull(task.externalKey)
  if (key === null) return false
  return key.startsWith(`${origin}#`) && key.length > origin.length + 1
}

/**
 * A local record's chip. `manual` is the only source a person typed into Flow
 * itself, so it is the only one that reads `you`; every other source names the
 * tracker the card was imported from — except a card an assistant mirrored out
 * of a conversation, which is `manual` in the store and neither of those things
 * to a reader (see `isMirroredTask`).
 *
 * THE MIRROR IS ASKED FIRST, because the tracker sources cannot be it and
 * `manual` can be either. Order is the whole rule: read the other way round,
 * every mirrored card would answer `you` before the question was put.
 */
export function originForTask(task: TaskSummary): BoardOrigin {
  if (isMirroredTask(task)) return 'assistant'
  switch (task.source) {
    case 'manual':
      return 'you'
    case 'jira':
      return 'jira'
    case 'github':
      return 'github'
    case 'azure':
      return 'azure'
  }
}

/**
 * A queue item's chip.
 *
 * THE FINGERPRINT IS THE TELL. A producer loop files with a dedup fingerprint
 * in the body marker and the backend reads it back into `fingerprint`; a human
 * opening an issue writes no marker, so their items arrive with `fingerprint:
 * ""` — which is exactly what every open item in this repo's own queue looks
 * like today. So a fingerprint means a loop filed it, and its absence means the
 * store's owner did: GitHub's items read `github`, and the Flow ledger is the
 * user's own list, so its items read `you`.
 *
 * A kind nobody reported yields null rather than a default. There is no third
 * backend to fall back to, and inventing one for a group that never parsed
 * would be a chip claiming knowledge no read produced.
 *
 * SINCE SHARING EXISTS, `loop` MEANS "FILED THROUGH A LOOP" RATHER THAN "FILED
 * BY A RUNNING PRODUCER", and the difference is worth stating because it is not
 * a widening this file chose. The share control (Phase 5) puts a card on the
 * list through `loop file` — the CLI is the only writer of a queue — and that
 * verb derives its fingerprint itself, from the loop whose directive supplied
 * the labels, the topic and the cap. So a person's share arrives back through
 * `loop list` carrying a marker identical to a producer's, and no field on the
 * item separates the two. The chip reports what the store recorded: this item
 * belongs to that loop's filings, which is true of both. Reading the local
 * record's `originThreadId` to say otherwise is not available here — a shared
 * item's card has no record at all once the local copy is archived (see
 * `shareOutcome`), and that is the same trade every unclaimed item makes.
 */
export function originForItem(kind: string | null | undefined, item: LoopQueueItem): BoardOrigin | null {
  if (item.fingerprint.trim().length > 0) return 'loop'
  if (kind === 'github') return 'github'
  if (kind === 'ledger') return 'you'
  return null
}

// ── Cards ───────────────────────────────────────────────────────────────

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cardForItem(
  group: BoardQueueGroup,
  item: LoopQueueItem,
  record: TaskSummary | null,
  lane: TaskLane,
  now: number,
  statusById?: ReadonlyMap<string, ThreadStatus>,
  backgroundById?: ReadonlyMap<string, number>,
): BoardCard {
  const held = trimmedOrNull(item.claimedBy)
  return {
    key: `queue:${group.key}#${item.id}`,
    title: item.title,
    origin: originForItem(group.kind, item),
    lane,
    taskId: record?.id ?? null,
    itemId: item.id,
    queueKey: group.key,
    loop: trimmedOrNull(item.loop),
    url: trimmedOrNull(item.url),
    // A queue item has produced no pull request of its own.
    prUrl: null,
    attention: false,
    blockedReason: null,
    // Only when THIS machine has no record of the claim: with a record, the
    // claim is ours and saying it is held elsewhere would be a lie about our
    // own run.
    heldBy: record === null ? held : null,
    missingReason: null,
    ageLabel: relativeAge(item.claimedAt ?? item.createdAt, now),
    // A queue item is not a Flow record, so nobody has offered it to anything.
    autoFix: false,
    // A window pane owns no thread; a claimed item with a local record does, so
    // its agent's status shows just as a task card's would.
    threadStatus: threadStatusOf(record?.threadId ?? null, statusById),
    backgroundTasks: backgroundTasksOf(record?.threadId ?? null, backgroundById),
  }
}

function cardForTask(
  task: TaskSummary,
  now: number,
  statusById?: ReadonlyMap<string, ThreadStatus>,
  backgroundById?: ReadonlyMap<string, number>,
): BoardCard {
  return {
    key: `task:${task.id}`,
    title: task.title,
    origin: originForTask(task),
    lane: task.lane,
    taskId: task.id,
    itemId: null,
    queueKey: null,
    loop: null,
    url: trimmedOrNull(task.externalUrl),
    prUrl: trimmedOrNull(task.prUrl),
    attention: false,
    blockedReason: null,
    heldBy: null,
    missingReason: null,
    ageLabel: relativeAge(task.updatedAt, now),
    autoFix: task.autoFix,
    threadStatus: threadStatusOf(task.threadId, statusById),
    backgroundTasks: backgroundTasksOf(task.threadId, backgroundById),
  }
}

/** The owning thread's status, or null when there is no thread or no map. */
function threadStatusOf(
  threadId: string | null,
  statusById?: ReadonlyMap<string, ThreadStatus>,
): ThreadStatus | null {
  return threadId !== null ? statusById?.get(threadId) ?? null : null
}

/** How much background work the owning thread is waiting on — 0 when it has
 *  no thread, the board has no map, or nothing is running. */
function backgroundTasksOf(
  threadId: string | null,
  backgroundById?: ReadonlyMap<string, number>,
): number {
  return threadId !== null ? (backgroundById?.get(threadId) ?? 0) : 0
}

// ── Grouping ────────────────────────────────────────────────────────────

function groupKeyFor(row: LoopQueueGroup): string {
  const kind = trimmedOrNull(row.queueKind)
  const location = trimmedOrNull(row.queueLocation)
  // A row whose directive named neither is its own group forever: it cannot be
  // merged with anything without guessing which list it meant, and guessing is
  // the one move this model does not make.
  if (kind === null && location === null) return `loop:${row.loop}`
  return `${kind ?? ''}::${location ?? ''}`
}

/**
 * Which readable queue a local record belongs to, or null.
 *
 * The test is the key the importer and the queue already agree on: a record
 * keyed `owner/repo#42` belongs to the queue located at `owner/repo`. A record
 * with no external key belongs to no queue — it is somebody's own card and its
 * absence from a backlog says nothing about it.
 */
function readableGroupForRecord(
  task: TaskSummary,
  groups: BoardQueueGroup[],
): BoardQueueGroup | null {
  const key = trimmedOrNull(task.externalKey)
  if (key === null) return null
  for (const group of groups) {
    if (!group.readable || group.location === null) continue
    if (key.startsWith(`${group.location}#`)) return group
  }
  return null
}

/**
 * The line a record carries when the queue it belongs to answered and did not
 * mention its item.
 *
 * IT NAMES THE SLICE THAT WAS READ, because that is the whole of what is known.
 * A default `loop list` covers OPEN items only, so an item missing from it may
 * have been closed, and a card claiming "removed" would be inventing the half
 * of the answer the read did not cover. `snapshot.state` is echoed by the CLI
 * precisely so no reader has to infer it.
 */
function missingReasonFor(group: BoardQueueGroup, state: LoopQueueState | null): string | null {
  if (state === null || group.location === null) return null
  if (state === 'open') return `no longer open in ${group.location}`
  if (state === 'all') return `no longer in ${group.location}`
  return `not in the ${state} list for ${group.location}`
}

/**
 * What to call one queue, in a heading a person reads.
 *
 * NOT THE RAW LOCATION, which is what this returned until the sweep was pointed
 * at it. A GitHub queue's location is `owner/name` and reads fine; a LEDGER's is
 * a file path (`flow/loops/queue.jsonl`), and printing that as a column heading
 * is forbidden pattern #12 — the board telling a reader where a file lives
 * instead of what the list is. The panel settled the same question first
 * (`queueLabelFor` in loops-settings-model.ts) and this follows its vocabulary
 * deliberately: two surfaces naming one queue two ways is how a reader ends up
 * believing there are two lists.
 *
 * A kind nobody has a word for passes through as the CLI spelled it — an
 * unknown store is still a fact, and inventing a name for it would be worse
 * than repeating the CLI's.
 */
function labelFor(kind: string | null, location: string | null, loop: string): string {
  if (kind === null) return location ?? loop
  const word = QUEUE_KIND_WORDS[kind] ?? kind
  if (location === null) return word
  // A ledger's own name, not the path to it — the last segment, extension off.
  if (kind === 'ledger') {
    const segment = location.split('/').pop() ?? ''
    const dot = segment.lastIndexOf('.')
    const stem = dot > 0 ? segment.slice(0, dot) : segment
    return stem.length === 0 ? word : `${word} · ${stem}`
  }
  return `${word} · ${location}`
}

/** The reader's word for a queue kind. Shared vocabulary with the loops panel. */
const QUEUE_KIND_WORDS: Record<string, string> = {
  github: 'GitHub',
  ledger: 'This project',
}

interface MutableGroup extends BoardQueueGroup {
  /** Whether ANY loop on this queue returned a list — a queue is one list. */
  answered: boolean
}

/**
 * Fold the CLI's per-loop rows into per-queue groups, in first-mention order.
 *
 * The rows are per LOOP and the groups are per QUEUE, so one group can be built
 * from several rows. Its `readable` is true when ANY of them answered, because
 * they are all reads of the same list and one success means the list was read;
 * its `reason` is the first reason a failing row gave, so a half-failing queue
 * still says what went wrong without stacking two sentences into one banner.
 */
function foldGroups(snapshot: LoopQueueSnapshot): MutableGroup[] {
  const groups: MutableGroup[] = []
  const byKey = new Map<string, MutableGroup>()
  for (const row of snapshot.loops) {
    const key = groupKeyFor(row)
    const kind = trimmedOrNull(row.queueKind)
    const location = trimmedOrNull(row.queueLocation)
    let group = byKey.get(key)
    if (group === undefined) {
      group = {
        key,
        kind,
        location,
        label: labelFor(kind, location, row.loop),
        loops: [],
        readable: false,
        reason: null,
        todo: [],
        answered: false,
      }
      byKey.set(key, group)
      groups.push(group)
    }
    if (!group.loops.includes(row.loop)) group.loops.push(row.loop)
    if (row.items !== null) group.answered = true
    if (group.reason === null) {
      group.reason = trimmedOrNull(row.queueError) ?? trimmedOrNull(row.directiveError)
      // The CLI's classification, carried as data. The renderer decides what to
      // SAY about it; the model states only what happened.
      if (row.queueErrorKind !== undefined) group.reasonKind = row.queueErrorKind
    }
  }
  for (const group of groups) group.readable = group.answered
  return groups
}

// ── Hunts (Task 7.1) ────────────────────────────────────────────────────

/**
 * The instruction's identity, exactly as the CLI computes it.
 *
 * THE SAME NORMALIZATION, DELIBERATELY DUPLICATED-BY-VALUE rather than guessed
 * at: `instructionKey` in src/cli/loop/instructions.ts collapses whitespace,
 * trims and lowercases, because a person retyping a sentence will not reproduce
 * their own spacing. Two producer rows report the same hunt (the store has no
 * owner field), and folding them with any weaker rule would draw one hunt twice
 * the moment the two rows disagreed about a space.
 */
function huntKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Fold every producer row's instructions into one card per hunt.
 *
 * IN THE CLI'S ORDER, first mention wins — the same rule `foldGroups` applies to
 * queues, and for the same reason: an order derived app-side is an order that
 * can disagree with the report it came from.
 *
 * `reason` is the FIRST `instructionsError` any row gave. One sentence, not a
 * stack of identical ones: the store is a single project-wide file, so every
 * producer row fails with the same message when it fails at all.
 */
function buildHunts(snapshot: LoopsSnapshot | null, now: number): BoardHunts {
  // A snapshot nobody has (or one that failed as a whole) says nothing about
  // hunts. The board's own banner already carries that failure; repeating it
  // here as a hunts-level reason would report one failure twice.
  if (snapshot === null || !snapshot.available) return { cards: [], reason: null }
  const cards: BoardHunt[] = []
  const byKey = new Map<string, BoardHunt>()
  let reason: string | null = null
  for (const row of snapshot.loops) {
    if (reason === null) reason = trimmedOrNull(row.instructionsError)
    const topic = trimmedOrNull(row.topic)
    for (const instruction of row.instructions ?? []) {
      const key = huntKey(instruction.text)
      if (key.length === 0) continue
      let hunt = byKey.get(key)
      if (hunt === undefined) {
        hunt = {
          key,
          text: instruction.text,
          loops: [],
          topics: [],
          filed: instruction.filed,
          cap: instruction.cap,
          quietRuns: instruction.quietRuns,
          status: instruction.status,
          ageLabel: relativeAge(instruction.since, now),
        }
        byKey.set(key, hunt)
        cards.push(hunt)
      }
      if (!hunt.loops.includes(row.loop)) hunt.loops.push(row.loop)
      if (topic !== null && !hunt.topics.includes(topic)) hunt.topics.push(topic)
    }
  }
  return { cards, reason }
}

/**
 * Is this item plausibly one of the filter's hunt's filings?
 *
 * THREE TESTS, ALL OFF THE ITEM ITSELF, none of them a guess:
 *
 *  1. It carries a FINGERPRINT. A producer files with a dedup fingerprint in the
 *     body marker; a person opening an issue by hand writes none. That is the
 *     same tell `originForItem` uses to award the `loop` chip, so a filter for
 *     "what a loop filed" and a chip saying "a loop filed this" cannot disagree.
 *  2. Its own marker names one of the hunt's LOOPS. `file()` writes it, the
 *     backend reads it back into `loop`, and it is the only per-item record of
 *     who filed anything.
 *  3. Its labels carry one of those loops' TOPICS — when the loops have one.
 *     The topic rides the labels at file time (queue-backend.ts merges it in),
 *     so this is a read of what was written, not a match against prose.
 *
 * With no topic anywhere the third test is skipped rather than failed: the loop
 * still filed these, and refusing to answer would be narrower than the truth.
 */
function matchesHuntFilter(filter: BoardHuntFilter, item: LoopQueueItem): boolean {
  if (item.fingerprint.trim().length === 0) return false
  if (!filter.loops.includes(item.loop.trim())) return false
  if (filter.topics.length === 0) return true
  return item.labels.some((label) => filter.topics.includes(label))
}

/**
 * What a card says about the conversation the thread filter is about.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one that matters: `unsaid` is a
 * card that names no producing thread — an unclaimed backlog item, an imported
 * issue, a card typed by hand, a row written before provenance existed, or a
 * task whose origin thread was deleted out from under it. It is not evidence
 * about any conversation, so no filter about a conversation may act on it. A
 * two-answer version of this function would collapse `unsaid` into "not this
 * one" and empty Todo of everything the reader did not produce in the open
 * chat — see `BoardThreadFilter`.
 */
type ThreadAnswer = 'this-thread' | 'another-thread' | 'unsaid'

function threadAnswerFor(
  filter: BoardThreadFilter | null,
  record: TaskSummary | null,
): ThreadAnswer {
  if (filter === null || record === null) return 'unsaid'
  // `originThreadId` ONLY. `threadId` is the conversation the card owns, not the
  // one that produced it, and reading it here would hide most of an existing
  // project's board (see `BoardThreadFilter`).
  const origin = trimmedOrNull(record.originThreadId)
  if (origin === null) return 'unsaid'
  return origin === filter.threadId ? 'this-thread' : 'another-thread'
}

/**
 * May the thread filter take this card off the board?
 *
 * BOTH CLAUSES OF THE FILTER POLICY, in one place so neither pass can apply half
 * of it: the card must be in Todo (nobody has started it) and must name another
 * conversation (it answers the question, and the answer is no).
 */
function threadFilterHides(answer: ThreadAnswer, lane: TaskLane): boolean {
  return answer === 'another-thread' && lane === 'todo'
}

// ── The model ───────────────────────────────────────────────────────────

function stateFor(snapshot: LoopQueueSnapshot, groups: BoardQueueGroup[]): BoardQueueState {
  // A snapshot that never happened says nothing about whether a list exists, so
  // `unreadable` outranks `no-list-configured` — reporting "no list configured"
  // over a failed read would invite the user to create the list they already have.
  if (!snapshot.available) return 'unreadable'
  if (groups.length === 0) return 'no-list-configured'
  const unreadable = groups.filter((group) => !group.readable).length
  if (unreadable === 0) return 'ready'
  return unreadable === groups.length ? 'unreadable' : 'partial'
}

/**
 * The whole board, from two snapshots and the local records. Pure: the same
 * inputs and the same `now` always produce the same model, which is what makes
 * the board testable without a DOM at all.
 */
export function buildBoardModel(input: BoardModelInput): BoardModel {
  const { queue, tasks, now } = input
  const filter = input.filter ?? null
  const threadFilter = input.threadFilter ?? null
  let matched = 0
  let hidden = 0
  // Counted apart from the hunt's, and never for a card the hunt filter already
  // removed — one reason per card, so the two numbers sum to what left the board
  // (see `BoardFilterCounts.hidden`).
  let threadMatched = 0
  let threadHidden = 0
  const records = tasks.filter((task) => task.archivedAt === null)
  const index = indexRecords(records)
  const groups = foldGroups(queue)
  const byKey = new Map(groups.map((group) => [group.key, group]))
  const blocking = blockStates(input.loops)

  const lanes: BoardLanes = { todo: [], doing: [], blocked: [], review: [], done: [] }
  const localTodo: BoardCard[] = []

  /** The records already drawn as a queue card — they must not draw twice. */
  const joined = new Set<string>()
  /**
   * The queue items already drawn — `<queue>\u0000<item id>`.
   *
   * A QUEUE IS ONE LIST, WHICH IS WHY THIS EXISTS. `loop list` reports per LOOP,
   * and a project whose `find` and `fix` both read the same list gets the same
   * item back on both rows — `foldGroups` already folds those rows into one
   * group for exactly this reason, and then the drawing below walked the rows
   * again and drew every item once per loop that could see it. Three findings
   * showed up as six cards, each pair identical, on a board whose own count
   * agreed with the duplicates.
   *
   * Keyed by QUEUE and not by item id alone: two lists can legitimately hold an
   * id apiece (a ledger's `3` is not GitHub's `3`), and folding those would be a
   * different lie in the other direction.
   */
  const drawn = new Set<string>()

  // TODO IS THE WINDOW: it is drawn from the live read, group by group, in the
  // CLI's own order. Nothing here is stored and nothing is remembered between
  // calls — an item that left the list simply is not drawn next time.
  for (const row of queue.loops) {
    const group = byKey.get(groupKeyFor(row))
    if (group === undefined || row.items === null) continue
    for (const queueItem of row.items) {
      // The second loop to report this item is reporting the same item. Skipped
      // before ANY bookkeeping: the counters, the join set and the lanes are all
      // about work, and this is not a second piece of work.
      const drawKey = `${group.key}\u0000${queueItem.id}`
      if (drawn.has(drawKey)) continue
      drawn.add(drawKey)
      const record = recordFor(index, row, queueItem)
      // JOINED BEFORE FILTERED, deliberately and still: whatever this item's
      // card turns out to be, the record behind it is accounted for HERE, so the
      // local-records pass below can never draw it a second time as a card with
      // no queue behind it. The bookkeeping is unconditional; only what follows
      // it changed.
      if (record !== null) joined.add(record.id)
      // ONE ANSWER, READ TWICE — computed here because the drawing below and the
      // count at the end are two readers of the same question, and a filter
      // asked twice is a filter that can answer differently.
      const matches = filter === null || matchesHuntFilter(filter, queueItem)
      // COMPUTED BEFORE THE DROP, and that ordering is the whole point. An
      // approval-gated item is the one card on the board that exists BECAUSE a
      // person has to act on it, and it has no record by definition — nothing
      // may claim it until the gate clears. Evaluating the gate after the
      // filter drop (which is where it used to live) meant pressing another
      // hunt's count took the amber card off the board entirely: the same
      // defect as hiding work in Doing, wearing the one costume where the
      // reader is the blocker.
      const states = blockStatesFor(blocking, row.loop, queueItem.loop)
      const gated = awaitingApproval(queueItem, states)
      // THE FILTER NARROWS THE WINDOW, NEVER THE RECORDS (see `BoardHuntFilter`).
      // An item nobody has started is a pane in a backlog the reader asked to see
      // one hunt's worth of, so it filters. A card Flow wrote a record for is
      // work this project is doing, and a control that says "show what this loop
      // filed" does not get to take that off the board — which is exactly what
      // the first cut did, dropping a task in Doing on a hand-filed issue out of
      // every lane the moment another hunt's count was pressed.
      if (!matches && record === null && !gated) {
        // Counted where the card would ACTUALLY have been drawn, the same
        // discipline `matched` follows below: a closed item Flow never touched
        // is off the board with or without a filter, so calling it hidden would
        // credit the filter with the lane rule's work and offer the reader a
        // card that clearing the filter would not bring back.
        if (queueItem.state !== 'closed') hidden += 1
        continue
      }
      // AN ITEM CLOSED ELSEWHERE LEAVES THE BOARD. Done is a lane of Flow's own
      // records — work this project did — and an item somebody closed in the
      // tracker without Flow ever touching it is not that. Drawing it in Done
      // would claim credit for work nobody here did; drawing it in Todo would
      // offer a card that cannot be claimed. It simply is not on the board.
      if (queueItem.state === 'closed' && record === null) continue
      // THE JOIN IS THE WHOLE RULE. An item nobody has started has no record,
      // so it can only be Todo; Doing, Blocked and Done are lanes a RECORD is
      // in, and the item is what that record is about.
      //
      // THE APPROVAL GATE IS THE ONE EXCEPTION, and it is named in the design:
      // an item behind the gate is waiting on a human BEFORE any run can claim
      // it, so it has no record by definition. Leaving it in Todo would put the
      // one card a person must act on in the lane of things nobody has looked
      // at yet.
      let lane: TaskLane = record === null ? 'todo' : record.lane
      let blockedReason: string | null = null
      if (gated) {
        lane = 'blocked'
        blockedReason = APPROVAL_BLOCKED_REASON
      }
      // THE THREAD FILTER, AFTER THE LANE IS KNOWN — it has to be, because the
      // lane is half its test. An item behind the approval gate has already been
      // moved to Blocked above, so it is out of this filter's reach for the same
      // reason a card in Doing is: nobody may hide work that is waiting on a
      // person.
      //
      // Asked AFTER the hunt filter's drop, so a card the hunt already removed
      // is never counted here as well.
      const threadAnswer = threadAnswerFor(threadFilter, record)
      if (threadFilterHides(threadAnswer, lane)) {
        threadHidden += 1
        continue
      }
      if (threadAnswer === 'this-thread') threadMatched += 1
      const card = cardForItem(
        group,
        queueItem,
        record,
        lane,
        now,
        input.threadStatusById,
        input.backgroundTasksById,
      )
      card.blockedReason = blockedReason
      // AMBER, AND ONLY HERE. The two states that want a human — nothing else
      // on the board is allowed this colour.
      card.attention = blockedReason !== null
      // Counted where the card is actually drawn, not where it passed the test:
      // an item that survived the filter and was then dropped for being closed
      // with no record of Flow's own is not on the board, and a count that said
      // otherwise would make an empty filter look populated.
      //
      // `matches` guards it because a record drawn in spite of the filter is not
      // one of this hunt's filings: counting it would let a board showing none
      // of what the reader asked for still report a match.
      if (filter !== null && matches) matched += 1
      if (lane === 'todo') group.todo.push(card)
      lanes[lane].push(card)
    }
  }

  for (const task of records) {
    if (joined.has(task.id)) continue
    // NO FILTER TEST HERE, AND THAT IS THE POINT. A local record carries no
    // fingerprint, no loop marker and no topic label — none of the three facts
    // `matchesHuntFilter` reads — so every one of them fails the test by
    // construction, and the first cut duly dropped the lot. That made the filter
    // hide the reader's own work, which is the one thing it may not do.
    //
    // The alternative considered and rejected was to exempt only the records
    // that JOINED a queue item, leaving these dropped. It would have made a
    // card's survival depend on whether some queue still happened to list its
    // item — a fact the reader cannot see, that changes under them when a loop
    // closes an issue, and that this very pass exists to surface rather than
    // hide (`missingReason`, below). One rule for every record is the only one
    // a reader can hold: the filter narrows the window, and these are records.
    //
    // Their view stays legible because they land in `localTodo`, a bucket the
    // per-queue backlogs never mix with — a hunt's own list is still that
    // hunt's filings plus whatever Flow has started on them.
    // THE THREAD FILTER DOES TEST THESE, and that is the difference from the
    // hunt filter two lines above. These records are the population the question
    // is about: a card mirrored out of a conversation is a local record, so a
    // filter that exempted local records the way the hunt filter must would
    // never hide anything at all. The exemption above is not "records are
    // sacred" — it is that a local record answers the HUNT's question with
    // silence, and silence is not a no. It answers this one out loud, on
    // `originThreadId`, or not at all.
    const threadAnswer = threadAnswerFor(threadFilter, task)
    if (threadFilterHides(threadAnswer, task.lane)) {
      threadHidden += 1
      continue
    }
    if (threadAnswer === 'this-thread') threadMatched += 1
    const card = cardForTask(task, now, input.threadStatusById, input.backgroundTasksById)
    // A record whose queue answered without naming its item is SURFACED in the
    // lane it is already in — never quietly removed. The run happened; the
    // reader is the one who gets to decide what that means.
    const owningGroup = readableGroupForRecord(task, groups)
    if (owningGroup !== null) card.missingReason = missingReasonFor(owningGroup, queue.state)
    if (card.lane === 'todo') localTodo.push(card)
    lanes[card.lane].push(card)
  }

  return {
    state: stateFor(queue, groups),
    reason: queue.available ? null : trimmedOrNull(queue.reason),
    groups: groups.map(({ answered: _answered, ...group }) => group),
    localTodo,
    lanes,
    hunts: buildHunts(input.loops, now),
    filter: filter === null ? null : { ...filter, approximate: true, matched, hidden },
    threadFilter:
      threadFilter === null
        ? null
        : { ...threadFilter, matched: threadMatched, hidden: threadHidden },
  }
}
