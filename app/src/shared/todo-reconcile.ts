// What an agent's todo list MEANS for the board (thread-tasklist, Phase 2).
//
// Pure: no DOM, no IPC, no store. Given the cards a thread has already been
// mirrored into and one todo payload the agent just sent, this decides — and
// only decides. Nothing here writes anything; Phase 3 applies what comes back.
//
// WHY IT LIVES IN `shared` AND NOT BESIDE THE BOARD (Phase 3). It was written
// next to the renderer's other task modules, on the reasonable assumption that
// the board would be its reader. Its actual reader turned out to be the main
// process — the mirror runs where the tool payloads are recorded, which is
// nowhere near a DOM — and the two are SEPARATE TypeScript PROJECTS: the main
// project's `include` lists `src/main`, `src/preload` and `src/shared`, and
// pointedly not `src/renderer`. So an import across that line is not a matter
// of taste that a reviewer might wave through; it is main reaching into a
// project it was deliberately not given, and it drags a renderer path into a
// build configured without the DOM.
//
// Moving it was the alternative to duplicating it, and duplicating the ONE
// rule this file exists to enforce — into a second copy that no test would
// notice drifting — is the worst of the three options by a distance. `shared`
// is in both projects by construction, which is exactly what it is for, and
// this module was already eligible: its only import is the contract's
// `TaskLane`, and it has never touched a DOM, an IPC channel or a store.
//
// THE ONE RULE THIS FILE ENFORCES:
//
//   A DROPPED TODO IS KEPT, NOT DELETED.
//
// Agent todo lists are rewritten constantly — very often the entire list, every
// turn. `[A,B,C]` followed by `[A,D]` is not "B and C are finished"; it is an
// agent reorganising its own notes, and NOBODY SAID B AND C WERE DONE. So a
// todo the payload stopped naming yields a `keep`: the card stays on the board,
// in the lane it is already in, with the wording it already has.
//
// The rule is enforced by the TYPE, not by discipline: there is no `remove`
// decision in this module's vocabulary at all. A caller cannot delete a card on
// this model's say-so, because this model has no way to say it. `keep` is a
// decision rather than a silence for the same reason — an exhaustive switch in
// the applying layer must NAME the case where nothing happens, so the day
// somebody adds a fourth action the compiler asks them what a dropped todo
// means instead of letting it fall through a default.
//
// It inherits board-model.ts's discipline verbatim, because the failure it was
// written to prevent is the same one:
//
//  - Nothing is computed that the payload did not report. No lane is inferred
//    from a previous render, no status is assumed for a todo that did not carry
//    one, and a fact the payload does not hold is left absent rather than
//    guessed at.
//  - A LIST NOBODY COULD READ AND AN EMPTY LIST ARE DIFFERENT ANSWERS. An empty
//    `todos` array is the agent saying "my list is clear" and produces zero
//    decisions with no reason; a payload that would not parse produces zero
//    decisions WITH a reason and — this is the part that matters — no `keep`
//    entries either. Absence proves nothing about a list nobody could read, so
//    this model will not report a card as "not on the agent's list" on the
//    strength of a list it never saw. (The cards survive regardless: see the
//    rule above. Nothing here can remove one.)
//  - NEVER A PARTIAL LIST. One unreadable entry refuses the WHOLE payload. Half
//    an agent's list mirrored onto a board looks exactly like a complete one,
//    and a reader has no way to tell that the other half went missing — which
//    makes silently dropping entries strictly worse than refusing with a reason.
//  - AMBER IS RESERVED, AND A TODO IS NEVER IT. `blocked` is spent on the state
//    that wants a human — an item behind the approval gate — and an agent's todo
//    is not that. `TodoLane` is `TaskLane`
//    minus `blocked` precisely so no future edit here can reach the colour by
//    accident; a caller that wants to put a mirrored card in Blocked has to do
//    it somewhere that is not this file.
//
// ── THE IDENTITY, AND THE TRADE IT COSTS (Task 2.1) ─────────────────────────
//
// Agent todos carry no id. Nothing in the payload is a handle: not a key, not a
// uuid, not anything the agent promises to keep stable between turns. So the
// identity has to be DERIVED, and the choice is a real trade with a real loser.
//
// WHAT WAS CHOSEN: the todo's own wording, normalized — whitespace collapsed,
// trimmed, lowercased. Exactly `huntKey`'s normalization in board-model.ts, and
// chosen for the same reason it was chosen there: a sentence somebody typed is
// the only thing about it that is stable, and they will not reproduce their own
// spacing or capitalization when they type it again.
//
// WHAT WAS REJECTED: the ordinal — the todo's position in the list. It survives
// a reword, which is the thing content-identity cannot do, and it fails on the
// far more common event: an agent inserting one todo at the top re-numbers every
// todo below it, so a single insert would reword the entire board at once. A
// key that breaks on the common case to survive the rare one is the wrong trade.
//
// WHAT THE CHOICE COSTS, STATED PLAINLY: **A REWORDED TODO GETS A SECOND CARD.**
// When the agent changes "fix the login bug" to "fix the login redirect bug",
// this model sees one key it has never met (an `add`) and one key the payload no
// longer names (a `keep`). It cannot tell that apart from "the agent finished
// thinking about one thing and started another", because at the level of the
// data THOSE TWO EVENTS ARE IDENTICAL. This is not solved here and is not
// pretended to be.
//
// WHAT IS DONE ABOUT IT INSTEAD: the reader is told. `rewordSuspected` is set
// whenever one pass produced both an add and a keep, which is the exact and only
// observable shape a reword has. It is a SHAPE, NOT A FINDING — it is just as
// true when an agent genuinely dropped one todo and added an unrelated one — and
// it is named `suspected` so nothing downstream can mistake it for knowledge.
// What it buys is that the ambiguity is visible at the moment it happens, to a
// person who can look at the two cards and say which it was, rather than
// surfacing days later as a board with two cards about one job and no
// explanation of where the second came from.
//
// THE SECOND HALF OF THE IDENTITY IS THE CARD'S. A previously mirrored card
// matches a todo when their keys are equal, so the card needs a key too, and
// there are two ways it can have one. If the applying layer recorded the key it
// mirrored the card under, it passes that back and the match is exact — that key
// records what the todo ACTUALLY SAID at mirror time, which is the truth the
// agent will be compared against. If it did not, the key is derived from the
// card's current title through the same one function. The fallback is honest but
// weaker, and its weakness is worth naming: a person who renames a mirrored card
// has changed its derived key, so the agent's next unchanged payload will read
// as a new todo and add a second card. Which of the two is in play is decided in
// exactly one place (`keyForCard`), never at a call site.

import type { TaskLane } from './ipc-contract'

/**
 * The lanes a mirrored todo can be in.
 *
 * `TaskLane` MINUS `blocked`, expressed as a type so the reservation is enforced
 * by the compiler rather than by a comment somebody has to remember. Amber
 * belongs to the approval gate; an agent's todo is not that,
 * and a future edit to `laneForStatus` that tried to reach it would not build.
 */
export type TodoLane = Exclude<TaskLane, 'blocked'>

/**
 * The three states a todo payload may carry, and the only three.
 *
 * A payload naming any other state refuses in full rather than falling back to
 * `todo` — see `UNKNOWN_STATE`. A guessed lane is a card in the wrong column
 * that nothing on screen marks as a guess.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * A card this thread has already been mirrored into, as the applying layer holds
 * it. Structural on purpose: this module never imports the store's record type,
 * so the store may grow whatever fields it likes without this file caring.
 */
export interface MirroredCard {
  /** The card's own id in whatever store holds it. Opaque here. */
  id: string
  /** The card's current wording. */
  title: string
  /** The lane the card is in NOW — including `blocked`, if a person moved it. */
  lane: TaskLane
  /**
   * The identity key this card was mirrored under, when the applying layer kept
   * it. Absent means "derive it from the title" — weaker, and the header says
   * exactly how it is weaker.
   */
  key?: string | null
}

/** A todo the payload named, once it has been read and keyed. */
export interface ParsedTodo {
  key: string
  /** The agent's own wording, verbatim — never normalized for display. */
  title: string
  lane: TodoLane
}

/** A todo with no matching card: the applying layer should create one. */
export interface TodoAdd {
  action: 'add'
  key: string
  title: string
  lane: TodoLane
}

/**
 * A todo whose card already exists.
 *
 * Carries BOTH sides — what the payload says and what the card currently says —
 * and a `changed` flag over the pair, so the applying layer can skip a write
 * that would change nothing without re-deriving the comparison itself.
 *
 * IT REPORTS, IT DOES NOT RESOLVE. `previousLane` can be `blocked` (a person
 * moved the card there by hand) while `lane` is `todo` (the agent still calls it
 * pending), and this model deliberately does not decide who wins that: both
 * facts are on the decision, and the layer that owns the store owns the answer.
 * Deciding it here would be this file computing something no payload reported.
 */
export interface TodoUpdate {
  action: 'update'
  key: string
  cardId: string
  title: string
  lane: TodoLane
  previousTitle: string
  previousLane: TaskLane
  /** True when the payload's wording or lane differs from the card's. */
  changed: boolean
}

/**
 * A card the payload did not name — THE POINT OF THIS WHOLE MODULE.
 *
 * It is a decision, not an omission, so that a `switch` over `action` in the
 * applying layer has to say out loud that nothing happens here. The card keeps
 * its lane and its wording; this entry exists only so the pass can be counted
 * and explained.
 */
export interface TodoKeep {
  action: 'keep'
  key: string
  cardId: string
  title: string
  lane: TaskLane
}

export type TodoDecision = TodoAdd | TodoUpdate | TodoKeep

/** Everything one reconcile pass concluded. */
export interface TodoReconcile {
  /**
   * Add / update / keep, in a stable order: the payload's own order first (adds
   * and updates as the agent listed them), then the kept cards in the order they
   * were passed in. An order derived some other way is an order that can
   * disagree with the list it came from.
   */
  decisions: TodoDecision[]
  /**
   * Why nothing was decided, in the reader's terms, or null.
   *
   * Non-null implies `decisions` is empty, and empty `decisions` with a null
   * reason means the agent's list was read and had nothing on it. The two never
   * collapse — that distinction is half of what this module is for.
   */
  reason: string | null
  /**
   * One pass produced both an add and a keep — the observable shape of a reword.
   *
   * A SHAPE, NOT A FINDING. See the header: an agent that reworded one todo and
   * an agent that dropped one todo and added another produce byte-identical
   * payloads, and this flag is true for both. It says "these two cards may be
   * one job"; it never says they are.
   */
  rewordSuspected: boolean
}

// ── The reasons ─────────────────────────────────────────────────────────
//
// NAMED CONSTANTS WITH ONE WRITER, because they are user-visible and a second
// reader needs them: the tests assert on these exact values, and a sentence
// reworded inline would silently unhook the assertions from what ships.
//
// Every one of them obeys forbidden-pattern #12 — no command, no file path, no
// config key, and no field name out of anybody's payload. They describe what
// went wrong in terms of the thing on screen (an assistant, a task, a list),
// because that is all the reader has to work with and none of the rest is
// something they could act on.

/** There was no payload at all. */
export const NOTHING_TO_READ = 'the assistant sent nothing to read'
/** The payload was not readable as structured data. */
export const NOT_READABLE = "the assistant's note could not be read"
/** It read, but carried no list of tasks. */
export const NO_LIST = "the assistant's note carried no task list"
/** An entry in the list was not a task. */
export const ENTRY_NOT_A_TASK = "one of the assistant's tasks could not be read"
/** An entry carried no wording — nothing to put on a card. */
export const NO_WORDING = "one of the assistant's tasks had no wording"
/** An entry carried a state this board has no column for. */
export const UNKNOWN_STATE = 'the assistant marked a task with a state this list does not use'
/** Two entries share one identity, so neither can be told from the other. */
export const SAME_TASK_TWICE = 'the assistant listed the same task twice'

// ── Identity ────────────────────────────────────────────────────────────

/**
 * A todo's identity: its own wording, normalized.
 *
 * THE SAME NORMALIZATION AS `huntKey`, and duplicated by value rather than
 * imported, because the two are the same idea applied to different data and
 * neither owns the other. Whitespace collapses, ends are trimmed, case is
 * dropped — an agent that re-indents its list or capitalizes a word differently
 * has not written a different todo, and treating it as one would churn the board
 * on a difference nobody can see.
 *
 * Returns an empty string for wording that normalizes to nothing. Callers refuse
 * such an entry rather than keying it, because every empty todo would otherwise
 * share one identity and collapse into a single card.
 */
export function todoKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The key a previously mirrored card matches on — the recorded one if there is
 * one, otherwise derived from the title.
 *
 * ONE CODE PATH, not a choice made at call sites (allowed-pattern #14). Which
 * branch is taken changes what a rename does to the board, and a rule that
 * important cannot be re-decided by each caller from memory.
 */
function keyForCard(card: MirroredCard): string {
  const recorded = card.key
  if (typeof recorded === 'string') {
    const trimmed = recorded.trim()
    if (trimmed.length > 0) return trimmed
  }
  return todoKey(card.title)
}

// ── Lanes (Task 2.3) ────────────────────────────────────────────────────

/**
 * The lane a todo's state means.
 *
 * A COMPLETED TODO GOES TO DONE, NOT AWAY. That is the churn rule seen from the
 * other side: the agent finishing something is the one case where it is safe to
 * say what happened to the work, and what happened is that it was done — so the
 * card moves to the column that says so and stays there for the person to see.
 * Deleting it would erase the only evidence the work existed.
 *
 * The return type forbids `blocked`, and that is the enforcement: there is no
 * state an agent can put on a todo that reaches amber, and none can be added
 * here without changing the signature and reading the header first.
 */
export function laneForStatus(status: TodoStatus): TodoLane {
  switch (status) {
    case 'pending':
      return 'todo'
    case 'in_progress':
      return 'doing'
    case 'completed':
      return 'done'
  }
}

// ── Parsing (Task 2.4) ──────────────────────────────────────────────────

/** A read that produced a list, or a read that produced a reason. Never both. */
export interface TodoParse {
  todos: ParsedTodo[]
  reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(reason: string): TodoParse {
  return { todos: [], reason }
}

/**
 * Read one todo payload.
 *
 * WHAT IT IS TOLD, NOT WHAT IT GOES LOOKING FOR. The caller hands over the
 * payload string; this function never asks which tool sent it, never inspects a
 * tool name, and never searches a thread for one. Which tool calls are worth
 * mirroring is Phase 3's question and is answered there — a parser that also
 * decided what to parse would be two jobs in one place, and the second one would
 * be invisible to every test written for the first.
 *
 * THE SHAPE IT ACCEPTS IS ONE SHAPE: an object carrying a `todos` array, each
 * entry an object with wording and one of the three states. Anything else
 * refuses. The alternative — sniffing for a list under any plausible key, or
 * treating a bare array as a list of todos — is guessing at what an unknown tool
 * meant, and a wrong guess here puts a machine's internal scratch onto a
 * person's board with no way to tell it apart from their own work.
 *
 * TWO ENTRIES SHARING ONE IDENTITY REFUSE THE WHOLE PAYLOAD. Folding them would
 * require choosing whose state survives when they disagree ("fix the bug"
 * pending and "fix the bug" completed are one key and two answers), and choosing
 * is the move this file does not make. Refusing loses the pass; folding loses
 * the pass AND says nothing about it.
 */
export function parseTodoPayload(inputJson: string | null | undefined): TodoParse {
  if (typeof inputJson !== 'string' || inputJson.trim().length === 0) {
    return refuse(NOTHING_TO_READ)
  }
  let raw: unknown
  try {
    raw = JSON.parse(inputJson)
  } catch {
    // The only thing swallowed is the parser's own message, which names byte
    // offsets in a string the reader never saw. The failure itself is reported.
    return refuse(NOT_READABLE)
  }
  if (!isRecord(raw)) return refuse(NO_LIST)
  const list = raw.todos
  if (!Array.isArray(list)) return refuse(NO_LIST)

  const todos: ParsedTodo[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isRecord(entry)) return refuse(ENTRY_NOT_A_TASK)
    const content = entry.content
    if (typeof content !== 'string') return refuse(NO_WORDING)
    const key = todoKey(content)
    // Wording that normalizes to nothing has no identity, and every such entry
    // would share the one empty key — so this is the duplicate problem arriving
    // early, refused for the same reason.
    if (key.length === 0) return refuse(NO_WORDING)
    const status = entry.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return refuse(UNKNOWN_STATE)
    }
    if (seen.has(key)) return refuse(SAME_TASK_TWICE)
    seen.add(key)
    // The agent's own wording, untouched. The normalization is an identity, not
    // a display: a card reading `fix the login bug` when the agent wrote `Fix
    // the login bug` would be this module editing somebody's prose to make its
    // own bookkeeping easier.
    todos.push({ key, title: content.trim(), lane: laneForStatus(status) })
  }
  return { todos, reason: null }
}

// ── The diff (Task 2.2) ─────────────────────────────────────────────────

/** Everything the reconcile reads. Dependency-injected: no globals, no clock. */
export interface TodoReconcileInput {
  /** The cards this thread has already been mirrored into. */
  cards: MirroredCard[]
  /** The payload the agent just sent, exactly as it was recorded. */
  inputJson: string | null | undefined
}

/**
 * Decide what one todo payload means for the cards a thread already has.
 *
 * Pure: the same cards and the same payload always produce the same decisions,
 * which is what makes the churn rule testable without a store, a thread or a DOM.
 *
 * THE WHOLE ALGORITHM IS THREE SENTENCES:
 *
 *   A todo whose key matches a card updates that card.
 *   A todo whose key matches nothing adds a card.
 *   A card no todo matched is KEPT.
 *
 * There is no fourth sentence, and the missing fourth sentence is the feature.
 */
export function reconcileTodos(input: TodoReconcileInput): TodoReconcile {
  const parsed = parseTodoPayload(input.inputJson)
  if (parsed.reason !== null) {
    // NO DECISIONS AND NO KEEPS. The cards survive — nothing in this module can
    // remove one — but they are not reported as "kept", because a keep is a
    // statement that a list the agent DID send left this card out, and no list
    // was read here. Reporting keeps off an unread payload would be exactly the
    // empty-list lie board-model.ts refuses when a queue read fails.
    return { decisions: [], reason: parsed.reason, rewordSuspected: false }
  }

  // First mention wins, matching board-model's join index: two cards on one key
  // is a store-level anomaly, and picking the later one arbitrarily would make
  // the diff depend on the order the cards were listed in.
  const byKey = new Map<string, MirroredCard>()
  for (const { key, card } of cardsWithKeys(input.cards)) {
    // An empty key is indexed under nothing, so it can never be matched — and
    // no parsed todo carries one anyway, since `parseTodoPayload` refuses
    // wording that normalizes away. Such a card therefore falls through to the
    // keep pass every single time, which is the safe end of the only two ways
    // to be wrong about a card nobody can identify.
    if (key.length === 0) continue
    if (!byKey.has(key)) byKey.set(key, card)
  }

  const decisions: TodoDecision[] = []
  /**
   * The cards a todo matched, BY ID AND NOT BY KEY.
   *
   * By key looks equivalent and is not: two cards sharing one key (the anomaly
   * the index above resolves first-wins) would both count as matched, so the
   * loser would receive no decision at all — neither updated nor kept, just
   * absent from the pass with nothing saying so. Every card gets exactly one
   * decision, and this set is what guarantees it.
   */
  const claimed = new Set<string>()
  let added = 0

  for (const todo of parsed.todos) {
    const card = byKey.get(todo.key)
    if (card === undefined) {
      decisions.push({ action: 'add', key: todo.key, title: todo.title, lane: todo.lane })
      added += 1
      continue
    }
    claimed.add(card.id)
    decisions.push({
      action: 'update',
      key: todo.key,
      cardId: card.id,
      title: todo.title,
      lane: todo.lane,
      previousTitle: card.title,
      previousLane: card.lane,
      changed: card.title !== todo.title || card.lane !== todo.lane,
    })
  }

  let kept = 0
  for (const { key, card } of cardsWithKeys(input.cards)) {
    if (claimed.has(card.id)) continue
    // THE RULE. The payload did not name this card, and that is all that is
    // known: the agent may have finished thinking about it, reworded it, or
    // simply written a shorter list this turn. None of those is "delete it".
    decisions.push({ action: 'keep', key, cardId: card.id, title: card.title, lane: card.lane })
    kept += 1
  }

  return {
    decisions,
    reason: null,
    // Both, or it says nothing. One add with nothing dropped is a new todo; one
    // keep with nothing added is a shorter list. Only the pair is ambiguous.
    rewordSuspected: added > 0 && kept > 0,
  }
}

/**
 * The cards paired with the keys they match on, in the order given.
 *
 * Walked twice by `reconcileTodos` (once to index, once to find the unmatched),
 * and keyed HERE both times so the two walks cannot disagree about what a card's
 * identity is — the failure mode being a card that indexes under one key and is
 * looked up under another, which would report an update and a keep for one card.
 */
function cardsWithKeys(cards: MirroredCard[]): Array<{ key: string; card: MirroredCard }> {
  return cards.map((card) => ({ key: keyForCard(card), card }))
}
