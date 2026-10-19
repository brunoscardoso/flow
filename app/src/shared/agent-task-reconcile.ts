// What an assistant's ID-ADDRESSED task protocol means for the board
// (thread-tasklist, Phase 3b).
//
// Pure, exactly like `todo-reconcile` beside it: no DOM, no IPC, no store. Given
// the cards a thread has already been mirrored into and ONE call the assistant
// just made, this decides — and only decides.
//
// ── WHY THIS IS A SECOND MODEL AND NOT A SECOND MODE OF THE FIRST ───────────
//
// `todo-reconcile` mirrors a whole-list write: every call carries the assistant's
// ENTIRE list, which is what makes "a card the payload did not name" a meaningful
// phrase and what its one rule — a dropped todo is KEPT — is built on.
//
// This protocol is the opposite shape. One call creates one task and the id comes
// back in the answer; later calls name that id and change one thing about it. A
// call naming task 3 says NOTHING WHATSOEVER about tasks 1, 2 and 4 — so a payload
// here is not a list at all, and running it through a whole-list diff would report
// every other card as un-named on every single call. That is not a spelling
// difference between two tools; it is a different question with a different
// answer, and one function pretending to answer both would hide precisely that.
//
// So the two models share what is genuinely one idea and nothing else:
//
//   SHARED — the lane vocabulary (`TodoLane`, which is `TaskLane` minus `blocked`),
//   the state→lane mapping (`laneForStatus`), and the user-visible refusal
//   sentences that mean the same thing in both. All of them come from
//   `todo-reconcile` by import; none is copied, because a second copy of the rule
//   that amber is reserved is a second copy that can drift.
//
//   SEPARATE — the card shape and the decision union. A card here MUST carry the
//   assistant's own id (there is no fallback to matching on wording, and there
//   must not be one: two tasks may legitimately share a subject). And this union
//   has a `remove`, which `todo-reconcile` deliberately does not and must never
//   gain: its whole guarantee is that a caller cannot delete a card on its say-so,
//   and that guarantee is enforced by the absence of the word from its vocabulary.
//
// ── THE ONE RULE THIS FILE ENFORCES ─────────────────────────────────────────
//
//   A CARD LEAVES THE BOARD ONLY WHEN SOMEBODY SAYS SO, AND THIS PROTOCOL HAS A
//   WAY TO SAY IT.
//
// The churn rule is not weakened here — it is finally given the signal it always
// lacked. A task that stops being mentioned is still kept, because silence is
// still not news. What is new is that the assistant can state a deletion
// outright, and a stated deletion is somebody saying so. NOTHING ELSE REACHES
// THAT PATH: not a completed task (that is Done, and Done is a column, not an
// exit), not a task the assistant stopped updating, not an unreadable payload.
//
// ── WHAT "LEAVES" MEANS, AND WHY IT IS NOT A DELETE ─────────────────────────
//
// This model says `remove`; it does not say `destroy`. The applying layer takes a
// removed card OFF THE BOARD while keeping the row — see the mirror, which
// archives. By the time an assistant deletes its task, the card may have been
// reworded, moved, opened, or had a conversation attached to it by a person, and
// none of that is the assistant's to erase. Archiving also keeps the mirror's
// memory of the id intact, so a later call naming it again updates the record
// that exists instead of filing a second one.
//
// ── AND THE COMPLETED CASE, SAID OUT LOUD ───────────────────────────────────
//
// `completed` is Done. `deleted` is gone. NOTHING IS BLOCKED — amber belongs to
// work behind an approval gate, and an assistant knows nothing about it. The
// return type of `laneForStatus` is what enforces that, and it
// is imported rather than re-implemented so the reservation cannot be reopened
// here by accident.

import type { TaskLane } from './ipc-contract'
import {
  laneForStatus,
  NOT_READABLE,
  NOTHING_TO_READ,
  NO_WORDING,
  UNKNOWN_STATE,
  type TodoLane,
  type TodoStatus,
} from './todo-reconcile'

/**
 * A card this thread has already been mirrored into by THIS protocol.
 *
 * `taskId` is required, and that is the whole difference from the todo model's
 * card. There, identity is derived from wording and a card may arrive without a
 * recorded key; here the assistant issues an id and that id is the only identity
 * — a card whose id is unknown is not this pass's business, and the applying
 * layer must not hand one over hoping the wording will match.
 */
export interface MirroredTaskCard {
  /** The card's own id in whatever store holds it. Opaque here. */
  id: string
  /** The card's current wording. */
  title: string
  /** The lane the card is in NOW — including `blocked`, if a person moved it. */
  lane: TaskLane
  /** The assistant's own id for this task, as it issued it. */
  taskId: string
}

/**
 * One call, as it was recorded — discriminated by WHAT IT MEANT, not by what it
 * was called.
 *
 * WHAT IT IS TOLD, NOT WHAT IT GOES LOOKING FOR — the same line `todo-reconcile`
 * draws. This module never inspects a tool name, never asks which tool sent a
 * payload and never searches a thread for one. Which names mean "task protocol"
 * is the mirror's question and is answered there; a parser that also decided what
 * to parse would be two jobs in one file and the second would have no tests.
 */
export type AgentTaskCall =
  | {
      kind: 'create'
      /** The payload the assistant sent. */
      inputJson: string | null | undefined
      /**
       * The tool's own answer — REQUIRED HERE, because the id is only in it.
       *
       * The create payload carries a subject and a description and NO ID: the
       * assistant asks for a task and is TOLD what it is called. Everything this
       * protocol does afterwards is addressed to that id, so a create whose
       * answer nobody kept is a task that can never be matched again.
       */
      outputJson: string | null | undefined
    }
  | {
      kind: 'update'
      /** The payload the assistant sent — the id is in here. */
      inputJson: string | null | undefined
      /** The tool's own answer, consulted only to catch a refusal. */
      outputJson?: string | null | undefined
    }

/** A task with no card yet: the applying layer should create one. */
export interface AgentTaskAdd {
  action: 'add'
  taskId: string
  title: string
  /**
   * The lane the card should end up in.
   *
   * A create is always `todo` — the protocol has no way to create a task that is
   * already running. It can be something else only on the adopted-update path
   * below, where the assistant named a state while naming a task nobody saw
   * created.
   */
  lane: TodoLane
  /** The assistant's own account of the work, when it gave one. */
  description: string | null
}

/**
 * A task whose card already exists.
 *
 * Carries both sides and a `changed` flag over the pair, exactly like the todo
 * model's update, and for the same reason: the applying layer can skip a write
 * that would change nothing without re-deriving the comparison.
 *
 * IT REPORTS, IT DOES NOT RESOLVE. `previousLane` may be `blocked` while `lane`
 * is `doing`; who wins that is the store-owning layer's call, not this file's.
 */
export interface AgentTaskUpdate {
  action: 'update'
  taskId: string
  cardId: string
  title: string
  lane: TodoLane
  previousTitle: string
  previousLane: TaskLane
  /** True when the call's wording or lane differs from the card's. */
  changed: boolean
}

/**
 * THE DECISION THE OTHER MODEL CANNOT MAKE. The assistant stated a deletion, and
 * a stated deletion is the only thing that reaches this action — see the header.
 * What the applying layer DOES with it is deliberately not spelled `delete`:
 * `remove` means "off the board", and the row's fate belongs to the layer that
 * owns rows.
 */
export interface AgentTaskRemove {
  action: 'remove'
  taskId: string
  cardId: string
  title: string
}

/**
 * A readable call this model deliberately declined to act on.
 *
 * A DECISION, NOT A SILENCE — the same discipline as the todo model's `keep`. An
 * exhaustive switch in the applying layer has to name the case where nothing
 * happens, so the day a sixth action appears the compiler asks what it means
 * instead of letting it fall through a default. The `reason` is for a developer
 * counting a pass, never for a screen.
 */
export interface AgentTaskIgnore {
  action: 'ignore'
  taskId: string
  reason: string
}

export type AgentTaskDecision =
  | AgentTaskAdd
  | AgentTaskUpdate
  | AgentTaskRemove
  | AgentTaskIgnore

/**
 * Everything one pass concluded.
 *
 * ONE DECISION AT MOST, AND THAT IS THE PROTOCOL'S SHAPE SHOWING THROUGH. A call
 * names exactly one task, so a list of decisions would imply this model can say
 * something about tasks the call did not name — which is the exact confusion the
 * whole-list diff would have introduced.
 *
 * `decision` non-null implies `reason` null, and vice versa. A call nobody could
 * read produces a reason and no decision; a call that was read produces a
 * decision — possibly an `ignore`, which is a decision about a task, not a
 * failure to read one.
 */
export interface AgentTaskReconcile {
  decision: AgentTaskDecision | null
  /** Why nothing was decided, in the reader's terms, or null. */
  reason: string | null
}

// ── The reasons ─────────────────────────────────────────────────────────
//
// NAMED CONSTANTS WITH ONE WRITER, for the reason `todo-reconcile` gives: the
// tests assert on these exact values and a sentence reworded inline would unhook
// the assertions from what ships. Four of them are imported from there rather
// than restated, because "the assistant sent nothing to read" means the same
// thing whichever protocol failed to say it.
//
// All of them obey forbidden-pattern #12 — no command, no path, no config key and
// no field name out of anybody's payload. They describe what went wrong in terms
// of the thing on screen, because that is all a reader has to work with.

/** The answer came back without anything that could identify the task. */
export const NO_TASK_IDENTITY = "the assistant's new task came back with no way to identify it"
/** The call named no task to change. */
export const NO_TASK_NAMED = "the assistant's change named no task"
/** The tool said it did not do what was asked. */
export const CHANGE_REFUSED = "the assistant's change did not go through"
/** A change arrived for a task this board never saw created, carrying no wording. */
export const TASK_NEVER_SEEN = 'the assistant changed a task this list never saw'

// ── Reading the payloads ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse, tolerating a payload that was stored as a bare string.
 *
 * Everything the recorder writes goes through a stringify, so an answer that was
 * plain text arrives here as a quoted JSON string and parses to a string. A
 * payload that will not parse at all is handed back verbatim rather than refused
 * here, so the callers — which want different things from a broken input and a
 * plain sentence — can each decide.
 */
function parseLoosely(json: string | null | undefined): { value: unknown; readable: boolean } {
  if (typeof json !== 'string' || json.trim().length === 0) {
    return { value: null, readable: false }
  }
  try {
    return { value: JSON.parse(json), readable: true }
  } catch {
    return { value: json, readable: false }
  }
}

/**
 * The plain text an answer amounts to, or null.
 *
 * THREE SHAPES, BECAUSE THE LIVE TOOL AND ITS DOCUMENTATION DISAGREE and a reader
 * validated against only one of them parses nothing the day it meets the other
 * (allowed-pattern #11). A recorded answer may be a bare sentence, or a list of
 * content blocks each carrying text; the third shape — a structured object — is
 * read by `taskIdFromAnswer` instead, which prefers it when it is there.
 */
function plainTextOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const block of value) {
      if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}

/**
 * The id a "task created" answer names, or null.
 *
 * DECLARED FIRST, OBSERVED SECOND. The agent SDK declares this answer as an
 * object carrying the new task and its id, and that shape is checked first
 * because it is the one the protocol promises. What the live harness ACTUALLY
 * records is a sentence — `Task #1 created successfully: <the subject>` — with the
 * id spelled after a hash and nothing structured anywhere in it. Both are
 * accepted: reading only the documented one would mirror nothing at all today,
 * and reading only the observed one would break the day the tool starts keeping
 * its own promise.
 *
 * The FIRST hash wins, deliberately: a subject may itself contain one (real
 * recorded traffic includes `Task #7 created successfully: Fix #2: escape purge
 * LIKE metacharacters`), and the id is always the one before the prose.
 *
 * Returns null rather than guessing when neither shape yields an id — a create
 * nobody can identify is refused, because the alternative is a card that every
 * later call fails to find and quietly duplicates.
 */
export function taskIdFromAnswer(outputJson: string | null | undefined): string | null {
  const { value } = parseLoosely(outputJson)
  if (value === null) return null
  if (isRecord(value)) {
    const task = value.task
    if (isRecord(task) && typeof task.id === 'string' && task.id.trim().length > 0) {
      return task.id.trim()
    }
  }
  const text = plainTextOf(value)
  if (text === null) return null
  const match = /#([A-Za-z0-9_-]+)/.exec(text)
  return match === null ? null : match[1]
}

/**
 * True only when the answer STATES that the change did not happen.
 *
 * Absence is not failure. The live harness answers a change with a sentence and
 * no verdict at all, so anything this function cannot read is treated as fine —
 * the call's own recorded status is the real gate and the mirror checks it before
 * ever getting here. This catches the one case that would otherwise slip through:
 * a documented structured answer that says outright it refused.
 */
function answerDeclaresFailure(outputJson: string | null | undefined): boolean {
  const { value, readable } = parseLoosely(outputJson)
  if (!readable || !isRecord(value)) return false
  return value.success === false
}

/** A trimmed string, or null for anything that is not usable wording. */
function wordingOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** What one `create` call amounted to. */
export interface ParsedTaskCreate {
  taskId: string
  title: string
  description: string | null
}

/** What one `update` call amounted to. */
export interface ParsedTaskUpdate {
  taskId: string
  /** New wording, when the call carried any. */
  title: string | null
  /** The lane the named state means, or null for a call that named no state. */
  lane: TodoLane | null
  /** The assistant stated a deletion — the one signal that removes a card. */
  deleted: boolean
}

/**
 * A read that produced a value, or a read that produced a reason. Never both.
 *
 * Tagged rather than leaning on a nullable field, so the compiler — not a
 * convention every caller has to remember — is what stops a refusal being read as
 * a result.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function refuse<T>(reason: string): ParseResult<T> {
  return { ok: false, reason }
}

/**
 * Read one task-creation call.
 *
 * BOTH HALVES ARE REQUIRED and they carry different halves of the truth: the
 * wording is in what the assistant sent, the identity is in what it was told
 * back. Neither alone makes a card that can be found again.
 */
export function parseTaskCreate(
  inputJson: string | null | undefined,
  outputJson: string | null | undefined,
): ParseResult<ParsedTaskCreate> {
  const { value, readable } = parseLoosely(inputJson)
  if (value === null) return refuse(NOTHING_TO_READ)
  if (!readable) return refuse(NOT_READABLE)
  if (!isRecord(value)) return refuse(NOT_READABLE)

  const title = wordingOf(value.subject)
  if (title === null) return refuse(NO_WORDING)

  const taskId = taskIdFromAnswer(outputJson)
  if (taskId === null) return refuse(NO_TASK_IDENTITY)

  return { ok: true, value: { taskId, title, description: wordingOf(value.description) } }
}

/**
 * Read one task-change call.
 *
 * EVERY FIELD BUT THE ID IS OPTIONAL, and that is the protocol working as
 * designed rather than a payload arriving half-built: a change that carries only
 * a state is the commonest call there is. A state this board has no column for
 * refuses the whole call — a guessed lane is a card in the wrong column with
 * nothing on screen marking it as a guess — and `deleted` is read here, before
 * the lanes, because it is not a lane at all.
 */
export function parseTaskUpdate(
  inputJson: string | null | undefined,
): ParseResult<ParsedTaskUpdate> {
  const { value, readable } = parseLoosely(inputJson)
  if (value === null) return refuse(NOTHING_TO_READ)
  if (!readable) return refuse(NOT_READABLE)
  if (!isRecord(value)) return refuse(NOT_READABLE)

  const taskId = wordingOf(value.taskId)
  if (taskId === null) return refuse(NO_TASK_NAMED)

  // Wording is optional, but wording that is present and empty is not "no
  // wording given" — it is a rename to nothing, and a nameless card is worse
  // than an unchanged one.
  if (value.subject !== undefined && wordingOf(value.subject) === null) {
    return refuse(NO_WORDING)
  }
  const title = wordingOf(value.subject)

  const status = value.status
  if (status === undefined || status === null) {
    return { ok: true, value: { taskId, title, lane: null, deleted: false } }
  }
  // THE ONE SIGNAL THAT TAKES A CARD OFF THE BOARD, read before anything else
  // can interpret it as a state. It is not in `TodoStatus` and must never be
  // added to it: that type is the vocabulary of lanes, and this is an exit.
  if (status === 'deleted') {
    return { ok: true, value: { taskId, title, lane: null, deleted: true } }
  }
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
    return refuse(UNKNOWN_STATE)
  }
  const known: TodoStatus = status
  return { ok: true, value: { taskId, title, lane: laneForStatus(known), deleted: false } }
}

// ── The decision ────────────────────────────────────────────────────────

export interface AgentTaskReconcileInput {
  /** The cards this thread has already been mirrored into by this protocol. */
  cards: MirroredTaskCard[]
  /** The one call the assistant just made, exactly as it was recorded. */
  call: AgentTaskCall
}

/**
 * Decide what one task-protocol call means for the cards a thread already has.
 *
 * Pure: the same cards and the same call always produce the same decision, which
 * is what makes the deletion rule testable without a store, a thread or a DOM.
 *
 * THE WHOLE ALGORITHM IS FOUR SENTENCES:
 *
 *   A creation adds a card under the id it was given.
 *   A change to an id we know updates that card.
 *   A change that states a deletion removes that card.
 *   A change to an id we never saw adds a card if it brought wording, and is
 *     ignored if it did not.
 *
 * Every card the call did not name is untouched, and is not reported at all —
 * unlike the whole-list model, where saying nothing about a card IS a statement.
 */
export function reconcileAgentTask(input: AgentTaskReconcileInput): AgentTaskReconcile {
  const byTaskId = new Map<string, MirroredTaskCard>()
  for (const card of input.cards) {
    // First mention wins, matching the todo model's join index: two cards on one
    // id is a store-level anomaly, and picking the later one would make the
    // decision depend on the order the cards were listed in.
    if (!byTaskId.has(card.taskId)) byTaskId.set(card.taskId, card)
  }

  if (input.call.kind === 'create') {
    const parsed = parseTaskCreate(input.call.inputJson, input.call.outputJson)
    if (!parsed.ok) return { decision: null, reason: parsed.reason }
    const create = parsed.value
    const existing = byTaskId.get(create.taskId)
    if (existing !== undefined) {
      // The same creation seen twice — a replayed turn, a resumed session. The
      // card exists under this id, so this is a change to it and not a second
      // card. Treating it as an add would rely on the store's dedup to save the
      // board, which is a guarantee this model would rather state itself.
      return { decision: updateFor(existing, create.title, null), reason: null }
    }
    return {
      decision: {
        action: 'add',
        taskId: create.taskId,
        title: create.title,
        lane: 'todo',
        description: create.description,
      },
      reason: null,
    }
  }

  if (answerDeclaresFailure(input.call.outputJson)) {
    return { decision: null, reason: CHANGE_REFUSED }
  }

  const parsed = parseTaskUpdate(input.call.inputJson)
  if (!parsed.ok) return { decision: null, reason: parsed.reason }
  const update = parsed.value
  const card = byTaskId.get(update.taskId)

  if (card === undefined) {
    // AN ID NOBODY SAW CREATED IS NORMAL, NOT AN ERROR. The app may have begun
    // recording partway through a conversation, or the creation may have been
    // interrupted before its answer arrived. So it is handled on its merits: a
    // change that brought its own wording is enough to file a card from, and a
    // change that brought only a state is not — a card named after an internal
    // id would be machine scratch on somebody's board, and a deletion for a card
    // that was never there is already satisfied.
    if (update.deleted || update.title === null) {
      return {
        decision: { action: 'ignore', taskId: update.taskId, reason: TASK_NEVER_SEEN },
        reason: null,
      }
    }
    return {
      decision: {
        action: 'add',
        taskId: update.taskId,
        title: update.title,
        lane: update.lane ?? 'todo',
        description: null,
      },
      reason: null,
    }
  }

  if (update.deleted) {
    return {
      decision: { action: 'remove', taskId: card.taskId, cardId: card.id, title: card.title },
      reason: null,
    }
  }

  return { decision: updateFor(card, update.title, update.lane), reason: null }
}

/**
 * The update decision for a card, given what the call did and did not say.
 *
 * A FIELD THE CALL DID NOT MENTION KEEPS THE CARD'S OWN VALUE. This protocol
 * sends one field at a time — a change carrying only a state must not blank the
 * wording, and a change carrying only wording must not move the card. Absence
 * here means "unchanged", which is the exact opposite of what absence means in
 * the whole-list model, and it is decided in ONE place for that reason.
 */
function updateFor(
  card: MirroredTaskCard,
  title: string | null,
  lane: TodoLane | null,
): AgentTaskUpdate {
  const nextTitle = title ?? card.title
  // A card a person parked in `blocked` has no todo-lane equivalent, so a call
  // that named no state leaves the lane alone by reporting the card's own lane
  // back as unchanged rather than inventing one for it.
  const nextLane = lane ?? laneOf(card)
  return {
    action: 'update',
    taskId: card.taskId,
    cardId: card.id,
    title: nextTitle,
    lane: nextLane,
    previousTitle: card.title,
    previousLane: card.lane,
    changed: card.title !== nextTitle || card.lane !== nextLane,
  }
}

/**
 * The card's current lane expressed in the vocabulary a decision may carry.
 *
 * `blocked` has no member in `TodoLane` — that is the reservation, enforced by the
 * type — so a blocked card whose call named no state reports `todo`, and the
 * decision comes back `changed`. THAT IS SAFE AND IT IS NOT AN ACCIDENT: the
 * applying layer is the one that knows amber is a person's answer, and it already
 * refuses to move a blocked card out of its lane. Deciding it here would be this
 * model resolving a conflict it is documented not to resolve.
 */
function laneOf(card: MirroredTaskCard): TodoLane {
  return card.lane === 'blocked' ? 'todo' : card.lane
}
