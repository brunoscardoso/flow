// The mirror — an agent's todo list becomes cards on the board (thread-tasklist,
// Phase 3).
//
// It sits downstream of the recording the app already does. `StreamBridge`
// persists every tool use with its thread and its payload; this module is handed
// what was just recorded, decides what it means (`todo-reconcile`, which is pure
// and decides nothing about storage), and applies the result through the task
// service's existing creation path. It adds NO capture of its own: nothing here
// reads the tool-call table, subscribes to a stream, or polls for payloads.
//
// ── WHICH TOOL NAMES (Task 3.1), AND HOW THAT WAS ESTABLISHED ───────────────
//
// One name: the todo-list write. That is not a guess, and the checking is worth
// recording because the phase before this one had to assume it.
//
// The agent SDK the app actually depends on ships generated JSON-schema types
// for every tool input, and the todo-list write's input is declared there as an
// object carrying a `todos` array whose entries are `content` plus a `status` of
// exactly `pending` / `in_progress` / `completed` (a third field, the present-
// continuous wording used for a spinner, is carried and ignored here — a payload
// may always say more than a reader needs). That is the shape `parseTodoPayload`
// was written against, field for field and value for value, so the parser is
// confirmed rather than merely plausible.
//
// AND A FINDING THAT MATTERS MORE THAN THE CONFIRMATION. The same SDK declares a
// SECOND, newer task protocol — separate create / update / get / list tools —
// and in real recorded traffic it is the one being used: a live profile's
// several thousand recorded tool uses contain many of those and NOT ONE
// todo-list write. So the honest statement of where this feature stands is that
// its parser is right and its supply may be empty, depending on which protocol
// the assistant on the other end happens to use.
//
// ── THE SECOND PROTOCOL, NOW MIRRORED TOO (Phase 3b) ────────────────────────
//
// THE SECOND PROTOCOL IS A DIFFERENT KIND OF THING, not merely a different
// spelling. The todo-list write sends THE WHOLE LIST EVERY TIME, which is the
// premise the whole-list reconcile model rests on: "a card the payload did not
// name" is only a meaningful phrase when the payload was supposed to name
// everything. The newer tools are incremental and id-addressed — one call creates
// one task and gets an id back, later calls name that id — so a call naming three
// tasks says nothing whatsoever about a fourth. Feeding those through a whole-list
// diff would make every single call look like an assistant that had just dropped
// its entire list, which is precisely the churn this feature was built to
// prevent.
//
// So it got the second model that was owed rather than a coat of paint on the
// first: `agent-task-reconcile`, keyed on the id the assistant is handed, with
// its own answer to what a deletion means. TWO MODELS, TWO PARSERS, ONE HOOK —
// the routing below is the only place that knows there are two, and it routes on
// a tool name and a moment, never by sniffing a payload to see which shape it
// looks like.
//
// AND THEY ARE FILED WHERE THE OTHER CANNOT REACH. Both mirrors key their cards
// on the thread that produced them, so the two key spaces are kept apart by a
// marker that one of them cannot physically produce — see `mirrorTaskExternalKey`
// for why that is structural rather than lucky. Each mirror asks for its own
// cards through its own reader, and is handed null for the other's.
//
// ── THE MOMENT EACH ONE LISTENS AT, AND WHY THEY DIFFER ─────────────────────
//
// The bridge announces a tool call twice: once when it is recorded, once when it
// settles (see `ToolCallObservation`). The two mirrors want different moments,
// and the reason is in the protocols rather than in anybody's preference.
//
//  - THE TODO LIST IS ANSWERED BY THE PAYLOAD IT SENT. Everything the whole-list
//    model needs is in the input, so it reads at the first moment — the cards
//    appear while the assistant is still mid-turn, exactly as before.
//  - THE ID-ADDRESSED CREATE IS A QUESTION. Its payload carries a subject and a
//    description and NO ID; the assistant is TOLD what its task is called. That
//    identity — the one every later call is addressed to — exists only in the
//    answer, so this mirror must read at the second moment or it cannot key a
//    card at all. Reading the change calls at the same moment costs nothing and
//    buys the verdict: a call that was denied, interrupted or failed never
//    reaches the board, which is right for a protocol where one call is one
//    fact rather than a fresh copy of the whole truth.
//
// SILENTLY IS THE SPECIFICATION, NOT AN OVERSIGHT. Nearly every tool an
// assistant uses is not a todo list, so a mirror that remarked on the ones it
// skipped would narrate a warning per file read. `isMirroredToolName` is the
// only gate, and a name that fails it produces no card, no log line and no
// event.
//
// ONE SET, ONE READER. The names live here as a single frozen set rather than in
// a config key or beside each call site, because "which tools mean todos" is a
// fact about the assistant's protocol, not a preference a project could hold a
// different opinion about — and a second reader of it is a second place to
// forget when the protocol moves (allowed-pattern #14).

import type { TaskStore } from '../store/task-store'
import type { ThreadStore } from '../store/thread-store'
import type { ToolCallObservation } from '../agent/stream-bridge'
import {
  reconcileAgentTask,
  type AgentTaskCall,
  type MirroredTaskCard,
} from '../../shared/agent-task-reconcile'
import { reconcileTodos, type MirroredCard } from '../../shared/todo-reconcile'
import {
  createTaskFromAgentTask,
  createTaskFromAgentTodo,
  mirrorKeyForCard,
  mirrorTaskIdForCard,
} from './task-service'

/**
 * The tool names whose payloads carry a todo list this board can mirror.
 *
 * Frozen, and checked through `isMirroredToolName` rather than read directly, so
 * the membership test cannot be reimplemented slightly differently by a caller
 * (case-insensitively, say) somewhere this file can't see.
 */
const MIRRORED_TOOL_NAMES: ReadonlySet<string> = new Set(['TodoWrite'])

/**
 * The tool names of the id-addressed protocol, and WHAT EACH ONE MEANS.
 *
 * A map rather than a set, because the two names do not mean the same thing to
 * the model that reads them: one is a creation whose identity is in its answer,
 * the other is a change addressed to an identity already issued. Translating the
 * name into that meaning HERE is what keeps `agent-task-reconcile` from ever
 * having to know a tool's name — the same line its sibling parser draws.
 *
 * The protocol's other two tools (a read of one task and a read of the whole
 * list) are absent on purpose: they change nothing, so mirroring them would
 * either be a no-op or a second, weaker source of truth about the same tasks.
 */
const AGENT_TASK_TOOL_KINDS: ReadonlyMap<string, AgentTaskCall['kind']> = new Map([
  ['TaskCreate', 'create'],
  ['TaskUpdate', 'update'],
])

/**
 * Does this tool's payload carry a todo list?
 *
 * EXACT MATCH, DELIBERATELY. A fuzzy test — lowercasing, or accepting any name
 * containing "todo" — would hand an unknown tool's payload to a parser written
 * for a known one, and the failure that produces is not a refusal but a board
 * with somebody's machine scratch on it. A tool named differently is a tool this
 * module has not been told about, which is the same thing as a tool it must not
 * read.
 */
export function isMirroredToolName(toolName: string): boolean {
  return MIRRORED_TOOL_NAMES.has(toolName)
}

/**
 * What this tool means in the id-addressed protocol, or null for a tool that is
 * not part of it.
 *
 * EXACT MATCH, for the same reason its sibling insists on one, and one extra: the
 * two protocols' names are near neighbours in every listing an assistant sees. A
 * fuzzy test that accepted anything containing "task" would hand a change payload
 * to the creation reader and file a card under an id that came out of somebody
 * else's sentence.
 */
export function agentTaskCallKind(toolName: string): AgentTaskCall['kind'] | null {
  return AGENT_TASK_TOOL_KINDS.get(toolName) ?? null
}

// ── Applying the decisions (Task 3.3) ───────────────────────────────────

export interface TodoMirrorDeps {
  taskStore: TaskStore
  threadStore: ThreadStore
}

/** What one mirror pass did, for logging and for the tests to assert on. */
export interface TodoMirrorResult {
  added: number
  updated: number
  kept: number
  /** Why nothing was mirrored, in the reader's terms, or null. */
  reason: string | null
  /** The pass produced both an add and a keep — see `todo-reconcile`. */
  rewordSuspected: boolean
}

const NOTHING: TodoMirrorResult = {
  added: 0,
  updated: 0,
  kept: 0,
  reason: null,
  rewordSuspected: false,
}

/**
 * Mirror one recorded tool call onto the board, if it is one that carries todos.
 *
 * SYNCHRONOUS AND THROWING — on purpose, and read `mirrorTodosSafely` before
 * calling this directly. This is the body; the guarantee that a failure here
 * never reaches the turn is a separate, single wrapper, so that the rule and the
 * work are not tangled together and the rule cannot be half-applied.
 */
export function mirrorTodoToolCall(
  deps: TodoMirrorDeps,
  input: { threadId: string; toolName: string; inputJson: string | null },
): TodoMirrorResult {
  // The gate, and the whole of it. Every other tool an assistant uses leaves
  // here without a trace.
  if (!isMirroredToolName(input.toolName)) return NOTHING

  // The thread is how the mirror learns which project's board to write to, and
  // a payload from a thread that no longer exists has no board to go to. Not a
  // failure — a turn whose thread was deleted mid-flight is a real race, and
  // the right response to it is to do nothing quietly.
  const thread = deps.threadStore.getThread(input.threadId)
  if (!thread) return NOTHING

  const cards = mirroredCardsFor(deps.taskStore, thread.projectRoot, input.threadId)
  const result = reconcileTodos({ cards, inputJson: input.inputJson })
  if (result.reason !== null) {
    // A payload nobody could read. The cards stay exactly as they are — the
    // reconcile returned no keeps precisely so that this branch cannot be
    // mistaken for "the assistant's list is now empty".
    return { ...NOTHING, reason: result.reason }
  }

  let added = 0
  let updated = 0
  let kept = 0

  for (const decision of result.decisions) {
    switch (decision.action) {
      case 'add': {
        const { task, created } = createTaskFromAgentTodo(deps, {
          projectRoot: thread.projectRoot,
          originThreadId: input.threadId,
          key: decision.key,
          title: decision.title,
        })
        // The decision's lane is part of its contract, and a created card
        // starts in `todo` — right for the ordinary add, wrong when the FIRST
        // payload naming this key already carries a non-pending status (the
        // turn's last write first names it completed, no later payload repeats
        // the key). Applied only when it differs, exactly as the agent-task
        // add path does, so the ordinary case writes once (#1707).
        if (created && decision.lane !== 'todo') {
          deps.taskStore.updateTask(task.id, { lane: decision.lane }, { activity: false })
        }
        // `created` false means the dedup found the record already there — a
        // card this pass did not know about, most often one that was archived
        // and so was never offered to the reconcile. Counting it as an add
        // would report work that did not happen.
        if (created) added += 1
        break
      }
      case 'update': {
        if (!decision.changed) break
        const patch = updatePatchFor(
          decision.previousLane,
          decision.title,
          decision.lane,
          decision.previousTitle,
        )
        if (patch === null) break
        // #1192: THE ASSISTANT IS NOT THE USER. Every lane on the board sorts
        // by `updated_at`, so bumping it here would yank a card to the top of
        // its column each time an assistant resent its list — under the hand of
        // somebody reaching for a different card, on a board whose cards carry
        // one-click writes. The mirror is background bookkeeping and sorts like
        // it.
        deps.taskStore.updateTask(decision.cardId, patch, { activity: false })
        updated += 1
        break
      }
      case 'keep':
        // THE CASE THAT DOES NOTHING, NAMED OUT LOUD. The assistant's list did
        // not mention this card and that is not news about the work — so the
        // card keeps its lane, its wording and its place. It is spelled out as
        // a branch rather than left to a `default` so that the day a fourth
        // decision appears, the compiler asks what it means here instead of
        // quietly routing it through the do-nothing path.
        kept += 1
        break
    }
  }

  return { added, updated, kept, reason: null, rewordSuspected: result.rewordSuspected }
}

/**
 * The patch a lane change deserves, or null for one it must not make.
 *
 * AMBER IS A PERSON'S ANSWER AND THE ASSISTANT DOES NOT GET TO OVERRULE IT. A
 * card sits in Blocked because somebody put it there — a tripped breaker, an
 * approval gate, a human decision that the work is waiting on something. The
 * assistant that listed the todo cannot know any of that; from inside the
 * conversation the item simply still looks pending. So a mirrored update may
 * change the WORDING of a blocked card but never moves it out of the lane, and
 * the person who parked it there is the only one who takes it out.
 *
 * `todo-reconcile` deliberately declined to decide this — it hands over both the
 * card's current lane and the assistant's, and says the layer owning the store
 * owns the answer. This is that answer.
 *
 * NULL WHEN NOTHING SURVIVES THE REFUSAL (#1706). A change that names only a
 * state leaves a BLOCKED card with nothing to apply — the lane is refused here
 * and the wording is the card's own — so the write is skipped rather than made
 * and thrown away. Without this, a parked card would take an identical-content
 * UPDATE plus a board-change event on every list resend, indefinitely. The
 * guard lives here, in the one function both mirror paths already share
 * (allowed-pattern #14), so neither path can drift from the other.
 */
function updatePatchFor(
  previousLane: MirroredCard['lane'],
  title: string,
  lane: MirroredCard['lane'],
  previousTitle: string,
): { title: string; lane?: MirroredCard['lane'] } | null {
  if (previousLane === 'blocked') {
    return title === previousTitle ? null : { title }
  }
  return { title, lane }
}

/**
 * The cards this thread has already been mirrored into.
 *
 * INCLUDES ARCHIVED ONES, and that is the point of passing the flag. An
 * archived mirrored card is still a record of that todo; leaving it out would
 * make the next payload naming it look like a todo nobody had ever seen, and
 * the mirror would file a second card for work already on the board — the exact
 * duplicate this feature is supposed to avoid. It stays archived either way:
 * nothing in the update path touches `archived`.
 *
 * Each card carries the key it was ACTUALLY mirrored under, recovered from the
 * stored key rather than re-derived from the title. That is the strong half of
 * `todo-reconcile`'s identity contract, and it is what lets a person rename a
 * mirrored card without the assistant's next unchanged list treating it as a
 * new todo and adding a second one.
 */
function mirroredCardsFor(
  taskStore: TaskStore,
  projectRoot: string,
  threadId: string,
): MirroredCard[] {
  const cards: MirroredCard[] = []
  for (const task of taskStore.listTasks(projectRoot, { includeArchived: true })) {
    // BOTH CHECKS, NOT EITHER. The provenance column says the thread produced
    // this card; the key prefix says it was produced by THE MIRROR rather than
    // by some other thing this thread may come to create. A card failing either
    // one is somebody's own task and is not this pass's business.
    if (task.originThreadId !== threadId) continue
    const key = mirrorKeyForCard(threadId, task.externalKey)
    if (key === null) continue
    cards.push({ id: task.id, title: task.title, lane: task.lane, key })
  }
  return cards
}

// ── Applying the id-addressed protocol's decisions (Phase 3b) ───────────

/** What one id-addressed pass did, for logging and for the tests to assert on. */
export interface AgentTaskMirrorResult {
  added: number
  updated: number
  /** Cards taken OFF THE BOARD because the assistant stated a deletion. */
  removed: number
  /** Readable calls this pass deliberately did nothing about. */
  ignored: number
  /** Why nothing was mirrored, in the reader's terms, or null. */
  reason: string | null
}

const NOTHING_MIRRORED: AgentTaskMirrorResult = {
  added: 0,
  updated: 0,
  removed: 0,
  ignored: 0,
  reason: null,
}

/**
 * Mirror one settled call of the id-addressed protocol onto the board.
 *
 * SYNCHRONOUS AND THROWING, exactly like its sibling, and wrapped by
 * `mirrorAgentTaskSafely` for exactly the same reason: the rule that a mirror
 * failure never fails a turn is one wrapper, not a try per call site.
 *
 * IT TAKES THE ANSWER AS WELL AS THE PAYLOAD, which is the whole difference in
 * this signature and the reason the bridge announces a second moment at all.
 */
export function mirrorAgentTaskToolCall(
  deps: TodoMirrorDeps,
  input: {
    threadId: string
    toolName: string
    inputJson: string | null
    outputJson: string | null
  },
): AgentTaskMirrorResult {
  const kind = agentTaskCallKind(input.toolName)
  if (kind === null) return NOTHING_MIRRORED

  // Same as the todo path: a payload from a thread that no longer exists has no
  // board to go to, and a turn whose thread was deleted mid-flight is a real
  // race whose right answer is to do nothing quietly.
  const thread = deps.threadStore.getThread(input.threadId)
  if (!thread) return NOTHING_MIRRORED

  const cards = mirroredTaskCardsFor(deps.taskStore, thread.projectRoot, input.threadId)
  const call: AgentTaskCall =
    kind === 'create'
      ? { kind: 'create', inputJson: input.inputJson, outputJson: input.outputJson }
      : { kind: 'update', inputJson: input.inputJson, outputJson: input.outputJson }
  const { decision, reason } = reconcileAgentTask({ cards, call })
  if (decision === null) return { ...NOTHING_MIRRORED, reason }

  switch (decision.action) {
    case 'add': {
      const { task, created } = createTaskFromAgentTask(deps, {
        projectRoot: thread.projectRoot,
        originThreadId: input.threadId,
        taskId: decision.taskId,
        title: decision.title,
        description: decision.description,
      })
      // A created card starts in `todo`, which is right for a creation and not
      // always right for the other path that reaches here — a change to a task
      // nobody saw created may name a state as it arrives. Applied only when it
      // differs, so the ordinary case writes once.
      if (created && decision.lane !== 'todo') {
        deps.taskStore.updateTask(task.id, { lane: decision.lane }, { activity: false })
      }
      // `created` false means the dedup found the record already there — most
      // often an archived card this pass was not offered. Counting it as an add
      // would report work that did not happen.
      return { ...NOTHING_MIRRORED, added: created ? 1 : 0, updated: created ? 0 : 1 }
    }
    case 'update': {
      if (!decision.changed) return NOTHING_MIRRORED
      // The contentless-patch skip (a blocked card whose wording is unchanged)
      // lives inside `updatePatchFor`, shared with the whole-list path (#1706).
      const patch = updatePatchFor(
        decision.previousLane,
        decision.title,
        decision.lane,
        decision.previousTitle,
      )
      if (patch === null) return NOTHING_MIRRORED
      // #1192, unchanged and for the same reason: the assistant is not the user,
      // and background bookkeeping does not reorder somebody's board.
      deps.taskStore.updateTask(decision.cardId, patch, { activity: false })
      return { ...NOTHING_MIRRORED, updated: 1 }
    }
    case 'remove': {
      // ARCHIVED, NEVER DELETED. The assistant said the task is gone and that is
      // enough to take the card off the board — it is not enough to destroy a
      // row somebody may have reworded, moved, or attached a conversation to.
      // Keeping it also keeps this mirror's memory of the id, so a later call
      // naming it again finds the record instead of filing a second one.
      deps.taskStore.updateTask(decision.cardId, { archived: true }, { activity: false })
      return { ...NOTHING_MIRRORED, removed: 1 }
    }
    case 'ignore':
      // THE CASE THAT DOES NOTHING, NAMED OUT LOUD — the same discipline as the
      // todo model's `keep`. Spelled as a branch rather than left to a `default`
      // so the day a fifth decision appears the compiler asks what it means here.
      return { ...NOTHING_MIRRORED, ignored: 1 }
  }
}

/**
 * The cards this thread has already been mirrored into BY THIS PROTOCOL.
 *
 * Includes archived ones, for the reason its sibling gives and one more: this
 * mirror archives a card when the assistant deletes its task, so leaving them out
 * would make a later call naming that id look like a task nobody had ever seen —
 * and file a second card for work already recorded and put away.
 *
 * Each card carries the assistant's own id, recovered from the stored key. There
 * is NO FALLBACK to matching on wording here, unlike the todo model: an id is
 * either recorded or it is not, and guessing from a title would let a person's
 * rename hand their card to whichever task happened to share its subject.
 */
function mirroredTaskCardsFor(
  taskStore: TaskStore,
  projectRoot: string,
  threadId: string,
): MirroredTaskCard[] {
  const cards: MirroredTaskCard[] = []
  for (const task of taskStore.listTasks(projectRoot, { includeArchived: true })) {
    // BOTH CHECKS, NOT EITHER — provenance says the thread produced this card,
    // the key says this protocol's mirror produced it. A card failing either is
    // somebody's own task, or the other mirror's, and is not this pass's
    // business.
    if (task.originThreadId !== threadId) continue
    const taskId = mirrorTaskIdForCard(threadId, task.externalKey)
    if (taskId === null) continue
    cards.push({ id: task.id, title: task.title, lane: task.lane, taskId })
  }
  return cards
}

// ── Never blocking, never failing a turn (Task 3.4) ─────────────────────
//
// The mirror hangs off the path that records tool calls, and that path is the
// assistant's turn. Two things follow, and they are different promises kept by
// different mechanisms — which is why they are two functions and not one.
//
//  1. IT MUST NOT MAKE THE TURN WAIT. The recording happens while the assistant
//     is mid-message and the renderer is waiting on the events that follow it.
//     Board writes are somebody else's business and are deferred off the stack
//     so the bridge can finish emitting first.
//  2. A FAILURE MUST NOT BECOME THE TURN'S FAILURE. If the board write throws —
//     a locked database, a task deleted underneath the pass — the assistant's
//     work is unaffected and the person should hear about their turn, not about
//     the bookkeeping behind it. Surfacing it would report a broken turn that
//     was not broken, which is worse than the missing card by a wide margin.
//
// The failure is LOGGED AND DROPPED, not swallowed: nothing here is silent to a
// developer reading the console, only to the user reading the thread. That is
// the line forbidden-pattern #2 draws, and it is on the correct side of it.

/** Defers work off the current stack. Injectable so tests need no timers. */
export type MirrorScheduler = (run: () => void) => void

/**
 * Mirror, and never throw. Returns what the pass did, or nulls out on failure.
 *
 * ONE WRAPPER, NOT A TRY PER CALL SITE (allowed-pattern #14). "A mirror failure
 * never fails a turn" is an invariant, and an invariant enforced by every caller
 * remembering to wrap is an invariant that lasts until the first caller who
 * doesn't.
 */
export function mirrorTodosSafely(
  deps: TodoMirrorDeps,
  input: { threadId: string; toolName: string; inputJson: string | null },
): TodoMirrorResult {
  try {
    return mirrorTodoToolCall(deps, input)
  } catch (error) {
    console.error('[todo-mirror] Failed to mirror an assistant task list:', error)
    return NOTHING
  }
}

/**
 * Mirror one id-addressed call, and never throw.
 *
 * A SECOND WRAPPER RATHER THAN A SECOND TRY INSIDE ONE, because the two passes
 * report different things and a shared wrapper would have to erase the difference
 * to have one return type. The invariant is identical and is still stated once
 * per pass, which is the part allowed-pattern #14 is about.
 */
export function mirrorAgentTaskSafely(
  deps: TodoMirrorDeps,
  input: {
    threadId: string
    toolName: string
    inputJson: string | null
    outputJson: string | null
  },
): AgentTaskMirrorResult {
  try {
    return mirrorAgentTaskToolCall(deps, input)
  } catch (error) {
    console.error('[todo-mirror] Failed to mirror an assistant task change:', error)
    return NOTHING_MIRRORED
  }
}

/** One announcement from the bridge, with the thread it belongs to. */
export type MirrorObservation = { threadId: string } & ToolCallObservation

/**
 * The hook the agent layer calls for every tool use it announces.
 *
 * ONE HOOK FOR BOTH PROTOCOLS (Phase 3b). A second hook would be a second answer
 * to "who is watching the assistant's tool calls", and the two would drift the
 * first time somebody wired one of them somewhere new. This routes instead: a
 * tool name and a moment decide which mirror runs, and a call that matches
 * neither leaves without a trace — SILENTLY, which is still the specification.
 *
 * Shaped as a factory returning a plain callback, exactly like the task
 * service's other agent hooks: the agent layer stays ignorant of stores and
 * boards, and receives a function it can call without knowing what is behind it.
 *
 * The scheduler defaults to `setImmediate` — a full turn of the event loop, not
 * a microtask, because a microtask would still run before the bridge yields and
 * would put a synchronous database write back in front of the events the
 * renderer is waiting for. Tests pass a scheduler that runs inline, so nothing
 * has to wait on a timer to assert on a card.
 */
export function makeTodoMirror(
  deps: TodoMirrorDeps,
  schedule: MirrorScheduler = (run) => {
    setImmediate(run)
  },
): (observation: MirrorObservation) => void {
  return (observation) => {
    // Every gate runs BEFORE the deferral, so the overwhelming majority of tool
    // uses — every file read, every command — cost one lookup and never schedule
    // anything at all.
    if (observation.phase === 'recorded') {
      // The whole-list write, read from what the assistant SENT: everything the
      // model needs is in the payload, so the cards appear mid-turn.
      if (!isMirroredToolName(observation.toolName)) return
      const { threadId, toolName, inputJson } = observation
      schedule(() => {
        mirrorTodosSafely(deps, { threadId, toolName, inputJson })
      })
      return
    }

    if (agentTaskCallKind(observation.toolName) === null) return
    // ONLY A CALL THAT SUCCEEDED. In this protocol one call is one fact, so a
    // creation that was denied and a change that failed are facts that never
    // happened — mirroring them would put a task on the board that the
    // assistant's own list does not have. (The whole-list write needs no such
    // check: its next payload restates everything either way.)
    if (observation.status !== 'success') return
    const { threadId, toolName, inputJson, outputJson } = observation
    schedule(() => {
      mirrorAgentTaskSafely(deps, { threadId, toolName, inputJson, outputJson })
    })
  }
}
