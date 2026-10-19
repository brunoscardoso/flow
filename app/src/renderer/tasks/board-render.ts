// The board's render plan (loops-on-the-board, Phase 6). DOM-free: it turns the
// BoardModel into the exact list of columns, group headings, banners, chips and
// empty states kanban-board.ts appends — and nothing more.
//
// THIS FILE DECIDES NOTHING ABOUT THE WORK. Which lane a card is in, whether it
// is amber, why it is blocked, which chip names its origin and which queue it
// belongs to are all read off the model, which read them off the CLI. What is
// decided here is layout: when a heading is worth drawing, which line goes in
// the banner, and what an empty column says.
//
// THE EMPTY COLUMN IS THE WHOLE POINT OF THE BANNER RULES (NFR-2). "Nothing
// here yet" is an ANSWER — it says the backlog is clear — and printing it over
// a read that failed is the exact lie this feature was asked to stop telling.
// So: a lane whose read failed renders a banner carrying the CLI's own reason
// and NEVER an empty state, and a project with no list at all says so in its
// own words with a way to fix it, rather than borrowing the sentence that means
// "you are done".

import type { LoopInstructionStatus, LoopsSnapshot, TaskLane } from '../../shared/ipc-contract'
import { cardApproval, type CardApproval } from './board-actions'
import { huntControlFor, type HuntControl } from '../loops/hunt-instruction'
// Shared with the loops panel: the same failure, the same sentence, one place.
import { queueFailureSentence } from '../loops/queue-failure'
import type { BoardCard, BoardHunt, BoardModel } from './board-model'
import { BOARD_LANES } from './board-view'

/** One small label on a card. `title` is the hover text, or null for none. */
export interface BoardChip {
  text: string
  title: string | null
  /** Amber — reserved, and only ever copied from the card's own `attention`. */
  attention: boolean
  /**
   * A MARK rather than a fact, when set.
   *
   * The row's facts give way when the card is narrow — they are prose, and each
   * carries its full text in a title. A mark is one glyph that IS its whole
   * meaning, so it must not shrink; saying which is which here keeps the DOM
   * layer from having to recognise a chip by its own text.
   */
  mark?: 'auto'
}

export interface BoardCardPlan {
  card: BoardCard
  chips: BoardChip[]
  /**
   * A line the BOARD attached to this card — today only a refused claim's
   * reason, riding the card back to Todo (Task 6.3). Distinct from the chips,
   * which all come from the model.
   */
  note: string | null
  /** The approve control, or null when the card is not behind the gate. */
  approve: CardApproval | null
  /**
   * Whether this card can be dragged.
   *
   * Every card can: a local record drags between lanes (today's behaviour) and
   * a queue item drags into Doing to claim it. A card that could not be dragged
   * would be a card whose only affordance is a right-click menu it does not
   * have, so there is no false case yet — the flag exists so the DOM layer
   * never has to ask why.
   */
  draggable: boolean
}

/** One block of cards inside a lane, with an optional heading. */
export interface BoardSectionPlan {
  /** The queue group's key, or null for the section holding local records. */
  key: string | null
  /** The heading, or null when the lane draws one undivided list. */
  label: string | null
  cards: BoardCardPlan[]
  /** This group's own failure, verbatim from the CLI, or null. */
  note: string | null
}

/** What a lane says when it has no cards at all. */
export interface BoardEmptyPlan {
  text: string
  /** The affordance to offer beside it, or null. */
  action: 'set-up-task-list' | null
}

/** A visible failure at the top of a lane — never a substitute for its cards. */
export interface BoardBannerPlan {
  /** The CLI's own reason, verbatim, or the fallback when it gave none. */
  text: string
}

/**
 * One producer's hunt, drawn at the top of Doing (Task 7.1).
 *
 * The words are decided HERE and the facts are decided in the model — the same
 * split every other plan on this page follows. `filedLabel` joins two numbers
 * the store already holds; `detail` joins segments the model already computed;
 * `statusLabel` glosses the CLI's own status word without replacing it.
 */
export interface BoardHuntPlan {
  hunt: BoardHunt
  /** `filed 7/20` — the clickable count (Task 7.2). */
  filedLabel: string
  /** Hover text for the count, naming what clicking it does. */
  filedTitle: string
  /** Whether clicking the count can filter at all — see `huntFilterFor`. */
  filterable: boolean
  /** The second line: which loops, status, quiet runs, age — ' · '-joined. */
  detail: string
  /**
   * The resume control, or null when the hunt is running (Task 7.5).
   *
   * BUILT IN loops/hunt-instruction.ts, the one code path that turns a hunt
   * sentence into a CLI call — so the day a second surface offers this, the two
   * cannot produce different instructions from the same words.
   */
  resume: HuntControl | null
}

/** The hunts block in a lane, with the reason nobody could say when there is one. */
export interface BoardHuntsPlan {
  cards: BoardHuntPlan[]
  /** The CLI's own reason the instruction store would not read, or null. */
  note: string | null
}

export interface BoardLanePlan {
  lane: TaskLane
  label: string
  /**
   * The model's own count for the lane — never re-derived from the sections.
   *
   * HUNTS ARE NOT COUNTED. The number over a column counts the work in it, and a
   * hunt is not work: it is the standing sentence the work is filed against.
   * Counting it would make Doing claim one more piece of work than it holds.
   */
  count: number
  banner: BoardBannerPlan | null
  /** The hunts drawn above this lane's cards — Doing only, else null. */
  hunts: BoardHuntsPlan | null
  sections: BoardSectionPlan[]
  /** Non-null ONLY when the lane has no cards. */
  empty: BoardEmptyPlan | null
}

/**
 * ONE LINE OF the bar above the columns, while a filter is on (Task 7.2, and the
 * thread filter that reuses it in Phase 4).
 *
 * EVERY LINE SAYS ITS CAVEAT IN THE VISIBLE TEXT, not only in a tooltip. The
 * board is showing fewer cards than it holds, and the thing the reader has to
 * carry while reading it — that the hunt filter can only be approximate, that
 * the thread filter left work in flight alone — is a fact about what happened to
 * the board, not a footnote.
 *
 * ONE SHAPE FOR BOTH FILTERS, because the bar is one grammar: what the board is
 * narrowed to, the caveat, the count, and the way out. A second shape would let
 * the two filters drift into two grammars in the same strip.
 */
export interface BoardFilterPlan {
  /** `Filed by: <hunt sentence>` / `In this conversation: <title>`. */
  text: string
  /** The caveat, stated. */
  note: string
  /** `3 cards` / `Nothing matched` — the count, in the reader's terms. */
  countLabel: string
  clearLabel: string
}

export interface BoardRenderPlan {
  /** The active hunt filter's line, or null when no hunt filter is on. */
  filter: BoardFilterPlan | null
  /**
   * The active thread filter's line, or null when the board is not narrowed to a
   * conversation. Null is the whole of FR-7: no line, and no card was tested.
   *
   * BOTH LINES CAN BE PRESENT. They are two questions, not two modes, and each
   * reports what IT removed — the model counts one reason per card so the two
   * numbers sum to the cards that actually left. The way out is offered ONCE, by
   * the DOM layer, and it clears every filter in force: two "Show everything"
   * buttons that each show only some of everything would be the lie this whole
   * bar exists to prevent.
   */
  threadFilter: BoardFilterPlan | null
  lanes: BoardLanePlan[]
}

/** What the board says when a read failed and said nothing about why. */
export const UNREADABLE_FALLBACK = "Couldn't read this project's task list."


/** The empty state for a project that has no list — not the same as an empty one. */
export const NO_LIST_TEXT = 'No task list configured'

/** The affordance's label, named once so the DOM layer cannot reword it. */
export const SET_UP_LIST_LABEL = 'Set up a task list'

/**
 * What "set up a task list" actually means, in the project's own vocabulary.
 *
 * IT NAMES THE FILE, because that is where a list comes from — a directive in
 * `loops/<name>.md`, versioned intent that `planflow-ai init` seeds paused. The
 * button explains rather than writes: the app does not author directives (the
 * CLI owns that file), and a button that silently created one would be the app
 * writing a queue store directly, which is the one thing this whole boundary
 * exists to prevent.
 */
export const SET_UP_LIST_HINT =
  'A task list is where this project keeps the work agents pick up — either issues on its ' +
  'GitHub repo, or a list kept locally. Flow normally sets one up when it first opens a ' +
  'project, so seeing this usually means that did not finish. Setting up again is safe: it ' +
  'never overwrites a list you already have, and nothing starts running on its own until you ' +
  'say so.'

/** The heading for Todo cards that belong to no queue — a person's own list. */
export const LOCAL_SECTION_LABEL = 'Not on a list'

/** Today's sentence for an empty Todo. Unchanged: it still means "clear". */
const TODO_EMPTY_TEXT = 'Nothing here yet'

/** Today's mark for the other lanes. */
const LANE_EMPTY_TEXT = '—'

/** The lane's display name — the one in BOARD_LANES, never a second spelling. */
export function laneLabel(lane: TaskLane): string {
  return BOARD_LANES.find((entry) => entry.key === lane)?.label ?? lane
}

/**
 * A card's chips, in reading order: where it came from, why it is stuck, who
 * has it, whether its item left the list, how old it is.
 *
 * EVERY ONE IS A FIELD OFF THE MODEL. Absent stays absent — a card whose group
 * never named a queue kind gets no origin chip rather than a guessed one, which
 * is the same rule the model applied when it left `origin` null.
 */
export function cardChips(card: BoardCard, owner: string | null = null): BoardChip[] {
  const chips: BoardChip[] = []
  // BEFORE ANYTHING ELSE, BECAUSE IT IS ABOUT THE READER. A card whose agent
  // stopped to ask something is waiting on THIS person — the one fact on the
  // card that is a call to act — so it leads, amber, in the reader's own terms.
  // (The lane-sync has already moved it to Blocked; this is the word for why.)
  if (card.threadStatus === 'needs-decision') {
    chips.push({
      text: 'Needs your input',
      title: 'The agent asked you something and is waiting for your answer.',
      attention: true,
    })
  }
  // FIRST, BECAUSE IT IS ABOUT WHAT HAPPENS NEXT. The other chips say where a
  // card came from and how old it is; this one says the loop will take it, and
  // a person scanning a column for what ▶ is about to do should not have to
  // open each card to find out.
  //
  // A GLYPH, NOT A PHRASE. The meta row is 150px and already holds two facts
  // and a control; "▶ auto" pushed it over and every chip on the card
  // ellipsised down to "▶ … · … · jus…". The mark is the same arrow that is on
  // the button it describes, its meaning is in the tooltip, and it does not
  // shrink — a marker that can be truncated to nothing is not a marker.
  if (card.autoFix) {
    chips.push({
      text: '▶',
      title: 'Pressing ▶ on Todo will work this card in its own chat.',
      attention: false,
      mark: 'auto',
    })
  }
  if (card.origin !== null) {
    chips.push({ text: card.origin, title: `Filed by: ${card.origin}`, attention: false })
  }
  if (card.blockedReason !== null) {
    // The card's own amber, copied — never a second decision about colour.
    chips.push({ text: card.blockedReason, title: card.blockedReason, attention: card.attention })
  }
  if (card.heldBy !== null) {
    // WHOSE CLAIM IT IS DECIDES THE SENTENCE. `heldBy` is set only when the
    // queue says claimed and this machine has no record of it — which since
    // H1 is precisely the shape of a claim this installation made and failed
    // to record. Printing the raw `flow-ide-<hex>` there would name the reader
    // as a stranger who took their own card; the truthful line says they hold
    // it and points at the Release control sitting beside this chip.
    const mine = owner !== null && card.heldBy === owner
    chips.push({
      text: mine ? 'held by you' : `held by ${card.heldBy}`,
      // Not amber either way: another engineer's run is the system working,
      // and your own unrecorded claim has a control, which is not the same as
      // wanting a human's attention.
      title: mine
        ? 'You hold this item on the queue, but Flow has no record of the run — Release to let it go'
        : `${card.heldBy} holds this item on the queue`,
      attention: false,
    })
  }
  if (card.missingReason !== null) {
    chips.push({ text: card.missingReason, title: card.missingReason, attention: false })
  }
  if (card.ageLabel !== null) {
    chips.push({ text: card.ageLabel, title: null, attention: false })
  }
  return chips
}

export interface BoardRenderInput {
  /** The status snapshot, for the approve control's target. */
  loops?: LoopsSnapshot | null
  /** Board-attached lines per card key — a refused claim's reason (Task 6.3). */
  notes?: ReadonlyMap<string, string>
  /**
   * This installation's durable claim owner (`flow-ide-<hex>`), or null.
   *
   * The chip needs it for one reason: `heldBy` is set only when the queue says
   * claimed and this machine has NO record of it — which, since review finding
   * H1, is exactly the shape of a claim this installation made and failed to
   * record. Printing the raw id there would tell the reader a stranger called
   * `flow-ide-3f2a9c1b7e04` took their card, when the honest sentence is that
   * they hold it themselves and the Release control beside it will let go.
   */
  owner?: string | null
}

function planCard(
  card: BoardCard,
  model: BoardModel,
  input: BoardRenderInput,
): BoardCardPlan {
  return {
    card,
    chips: cardChips(card, input.owner ?? null),
    note: input.notes?.get(card.key) ?? null,
    approve: cardApproval(card, model.groups, input.loops ?? null),
    draggable: true,
  }
}

/**
 * The banner line for a lane whose read failed, or null.
 *
 * SNAPSHOT REASON FIRST, then the first group that gave one, then the fallback.
 * The order matters: a snapshot-level reason ("bundled CLI unavailable")
 * explains the whole board, while a group's reason explains one list — and a
 * failure with no sentence at all still gets a banner, because the alternative
 * is the empty Todo this rule exists to forbid.
 */
function bannerFor(model: BoardModel): BoardBannerPlan | null {
  if (model.state !== 'unreadable') return null
  const named = model.groups.find((group) => !group.readable && group.reasonKind !== undefined)
  const groupReason =
    queueFailureSentence(named?.reasonKind, named?.location ?? null) ??
    model.groups.find((group) => !group.readable && group.reason !== null)?.reason
  return { text: model.reason ?? groupReason ?? UNREADABLE_FALLBACK }
}

/**
 * Todo's sections: one per queue, then the cards belonging to no queue.
 *
 * HEADINGS ONLY WHEN THERE IS SOMETHING TO TELL APART. One queue is one list,
 * and putting a heading over the only list on the board names something the
 * reader can already see. Two are two lists, and an unheaded merge of them
 * would invite exactly the mistake the model's per-queue grouping exists to
 * prevent — reading somebody else's backlog as your own.
 *
 * An unreadable group KEEPS ITS SECTION even with no cards, carrying its own
 * reason. That is the per-list half of NFR-2: a board where one of two queues
 * failed must not render as a board with one queue.
 */
function todoSections(
  model: BoardModel,
  input: BoardRenderInput,
  headings: boolean,
  banner: BoardBannerPlan | null,
): BoardSectionPlan[] {
  const sections: BoardSectionPlan[] = []
  for (const group of model.groups) {
    const reason = group.readable
      ? null
      : (queueFailureSentence(group.reasonKind, group.location) ??
        group.reason ??
        UNREADABLE_FALLBACK)
    // SAID ONCE. In the whole-board `unreadable` state the banner has already
    // promoted one group's reason (or the fallback both paths reach on their
    // own), and #renderLane draws banner and note both — so the identical
    // sentence stacked twice and read as two problems (#1790), which is the
    // rule huntsFor states for its own note. Only the REPEAT goes: a second
    // list that failed differently still says so, because that note is the one
    // place its failure is stated.
    const note = reason !== null && reason === banner?.text ? null : reason
    if (group.todo.length === 0 && note === null) continue
    sections.push({
      key: group.key,
      label: headings ? group.label : null,
      cards: group.todo.map((card) => planCard(card, model, input)),
      note,
    })
  }
  if (model.localTodo.length > 0) {
    sections.push({
      key: null,
      // The local cards get a heading only when they sit beside a named list —
      // otherwise "Not on a list" is a distinction with nothing on its far side.
      //
      // BESIDE MEANS RENDERED, NOT CONFIGURED. The loop above skips every
      // readable group with nothing in it, so two configured-but-empty lists
      // render no queue section at all; keying off `model.groups.length` counted
      // the lists a project HAS and drew the contrast against sections that were
      // never there (#1789). `sections` at this point is exactly the queue
      // sections that survived that skip, which is the far side the comment
      // means.
      label: headings && sections.length > 0 ? LOCAL_SECTION_LABEL : null,
      cards: model.localTodo.map((card) => planCard(card, model, input)),
      note: null,
    })
  }
  return sections
}

/**
 * What a hunt's status word MEANS, in a reader's terms.
 *
 * THE CLI'S WORD IS KEPT AND GLOSSED, never replaced. The five ways a hunt can
 * be over are five different things the CLI is careful not to collapse into
 * "inactive" — a person's decision, a hunt finding nothing left, the backstop
 * firing while there may well be more, a clock running out, and the hunt's own
 * written rule coming true — and a reader deciding whether to go and look
 * themselves needs to know which. `active` has no gloss because it is the
 * resting state: a running hunt is what the card already says.
 */
const HUNT_STATUS_GLOSS: Record<LoopInstructionStatus, string | null> = {
  active: null,
  stopped: 'stopped — somebody ended this hunt',
  dry: 'dry — two runs in a row found nothing new',
  capped: 'capped — it filed its limit and is waiting for a person to look',
  elapsed: 'time is up — it ran for as long as it was given',
  met: 'done — the rule it was given came true',
}

/**
 * A hunt still running, or one somebody has finished with.
 *
 * `active` IS THE ONLY WORD FOR IN FLIGHT. The other three — `stopped`, `dry`,
 * `capped` — are three ways of being over, and a reader deciding what to do next
 * needs the same answer from all of them.
 */
export function huntFinished(hunt: BoardHunt): boolean {
  return hunt.status !== 'active'
}

/**
 * The hunts drawn above a lane's cards, or null when there is nothing to draw.
 *
 * A FINISHED HUNT MOVES TO DONE, and that is the whole reason this takes a lane.
 * It used to draw every hunt in Doing whatever its status, so ending one either
 * left it sitting in the in-flight column wearing a "stopped" gloss, or — if it
 * was removed from the store — took it off the board entirely, with nothing to
 * show for the work it did. Neither is what finishing something looks like.
 *
 * The failure NOTE stays with Doing: "nobody could read the hunts" is not a
 * finished hunt, and repeating it in two columns would read as two problems.
 */
function huntsFor(
  model: BoardModel,
  input: BoardRenderInput,
  lane: TaskLane,
): BoardHuntsPlan | null {
  if (lane !== 'doing' && lane !== 'done') return null
  const note = lane === 'doing' ? model.hunts.reason : null
  const cards = model.hunts.cards.filter((hunt) =>
    lane === 'done' ? huntFinished(hunt) : !huntFinished(hunt),
  )
  if (cards.length === 0 && note === null) return null
  return { cards: cards.map((hunt) => planHunt(hunt, input)), note }
}

function planHunt(hunt: BoardHunt, input: BoardRenderInput): BoardHuntPlan {
  const gloss = HUNT_STATUS_GLOSS[hunt.status]
  const segments = [
    // WHICH LOOPS, PLURAL AND UNMERGED. The store names no owner, so a hunt with
    // two producers reporting it genuinely belongs to both of them.
    hunt.loops.join(' + '),
    gloss,
    // Reported, not derived: the store counts these, and a hunt one quiet run
    // from dry is exactly the moment a person might want to steer it.
    hunt.quietRuns > 0 ? `${hunt.quietRuns} quiet ${hunt.quietRuns === 1 ? 'run' : 'runs'}` : null,
    hunt.ageLabel === null ? null : `since ${hunt.ageLabel}`,
  ].filter((segment): segment is string => segment !== null && segment.length > 0)
  const filterable = hunt.loops.length > 0
  return {
    hunt,
    filedLabel: `filed ${hunt.filed}/${hunt.cap}`,
    // Present-but-dead carries the REASON (#1769), like the resume control
    // beside it — a disabled count must not promise the click it will not take.
    filedTitle: filterable ? HUNT_FILTER_HINT : HUNT_FILTER_DEAD,
    filterable,
    detail: segments.join(' · '),
    resume: huntControlFor(hunt, input.loops ?? null),
  }
}

/**
 * What clicking a hunt's filed count promises — and what it does not.
 *
 * IT SAYS "APPROXIMATE" IN THE HOVER TEXT, because the link it would need does
 * not exist: no filed item points back at an instruction (`file()` writes a loop
 * marker, a fingerprint and the directive's labels; the hunt's text appears in
 * none of them). The filter is the closest honest thing — this loop's own
 * filings, under this loop's topic — and a control that implied exactness would
 * be inventing the lineage the CLI went out of its way to document as absent.
 */
export const HUNT_FILTER_HINT =
  'Show what this loop filed — approximate: filings carry the loop and its topic, not the hunt'

/** The dead count's reason (#1769): no loop reported the hunt, so there is no
 *  loop whose filings a filter could show. */
export const HUNT_FILTER_DEAD = 'No loop reported this hunt, so its filings cannot be shown'

/**
 * The way out of every filter, named once.
 *
 * ONE CONTROL, WHATEVER IS IN FORCE. Two filters can narrow the board at the
 * same time, and a control that cleared only one of them while saying "show
 * everything" would be the bar lying about its own offer. The words are the
 * promise: press it and the board is the whole board again.
 */
export const CLEAR_FILTERS_LABEL = 'Show everything'

/** The sentence the filter bar carries. Said out loud, not hidden in a tooltip. */
export const HUNT_FILTER_APPROXIMATE_NOTE =
  'approximate — filings record the loop and its topic, never which hunt asked for them'

/**
 * What the filter bar says it did.
 *
 * TWO POPULATIONS, AND THE OLD COPY ONLY KNEW ONE. Since review finding H2 a
 * filter narrows the window and never the records, so "matched" and "on the
 * board" stopped being the same set: a hunt can match nothing while the board
 * still visibly holds every card the reader has work in flight on. The old
 * `matched === 0 → "Nothing on the board matched"` then read as a broken
 * filter sitting over a board full of cards.
 *
 * So zero is still a sentence rather than a number, but it is now a sentence
 * about the HUNT ("this loop has filed nothing that is still on the list"),
 * and what the filter actually removed is reported as its own count instead of
 * being left for the reader to infer from a board that did not change much.
 */
export function filterCountLabel(matched: number, hidden: number): string {
  const cards = (n: number): string => `${n} card${n === 1 ? '' : 's'}`
  const head = matched === 0 ? 'Nothing this loop filed is still on the list' : cards(matched)
  return hidden === 0 ? head : `${head} · ${cards(hidden)} hidden`
}

/**
 * What the board is narrowed to, when it is narrowed to a conversation.
 *
 * IT NAMES THE THREAD, because "this conversation" is a pronoun and the board is
 * not always the surface the reader is looking at when they read it. When the
 * signal named a thread without naming its title, the bar says so in its own
 * words rather than inventing one or printing an id at a person.
 */
export function threadFilterText(label: string | null): string {
  const named = label === null ? null : label.trim()
  return named === null || named.length === 0
    ? 'In this conversation'
    : `In this conversation: ${named}`
}

/**
 * The caveat the thread filter's line carries.
 *
 * SAID OUT LOUD, because the board is deliberately NOT showing only this
 * conversation's cards, and a reader who expected it to would otherwise read
 * another thread's card in Doing as the filter being broken. It is the promise
 * H2 made, restated where its consequence is visible: work already begun stays.
 */
export const THREAD_FILTER_KEPT_NOTE =
  'work already started stays, whichever conversation it came from'

/**
 * What the thread filter's line says it did.
 *
 * ZERO IS A SENTENCE ABOUT THE CONVERSATION, on the same rule as the hunt's:
 * "0 cards" over a board still full of other work reads as a broken filter, so
 * the empty answer says whose emptiness it is. The hidden count is the other
 * half — the reader is told how much of Todo went with the question rather than
 * left to notice that it did.
 */
export function threadFilterCountLabel(matched: number, hidden: number): string {
  const cards = (n: number): string => `${n} card${n === 1 ? '' : 's'}`
  const head = matched === 0 ? 'Nothing on the board came from this conversation' : cards(matched)
  return hidden === 0 ? head : `${head} · ${cards(hidden)} hidden`
}

/** The thread filter's line, or null when the board is not narrowed to one. */
function threadFilterPlanFor(model: BoardModel): BoardFilterPlan | null {
  const filter = model.threadFilter
  if (filter === null) return null
  return {
    text: threadFilterText(filter.label),
    note: THREAD_FILTER_KEPT_NOTE,
    countLabel: threadFilterCountLabel(filter.matched, filter.hidden),
    // The same words as the hunt's, because it is the same way out: one control,
    // and it means everything.
    clearLabel: CLEAR_FILTERS_LABEL,
  }
}

/** The filter bar, or null when the board is showing everything. */
function filterPlanFor(model: BoardModel): BoardFilterPlan | null {
  const filter = model.filter
  if (filter === null) return null
  return {
    text: `Filed by: ${filter.label}`,
    note: HUNT_FILTER_APPROXIMATE_NOTE,
    // ZERO IS A SENTENCE, NOT A NUMBER. "0 cards" over a board the reader just
    // narrowed reads as a broken filter; naming it as the filter's own answer
    // says the loop has filed nothing that is still on the list.
    countLabel: filterCountLabel(filter.matched, filter.hidden),
    clearLabel: CLEAR_FILTERS_LABEL,
  }
}

function emptyFor(
  lane: TaskLane,
  model: BoardModel,
  hasCards: boolean,
  banner: BoardBannerPlan | null,
  noted: boolean,
): BoardEmptyPlan | null {
  if (hasCards) return null
  // A FAILED READ NEVER GETS AN EMPTY STATE. The banner is the answer; adding
  // "Nothing here yet" underneath would put the lie back, one line lower.
  if (banner !== null) return null
  // The per-list half of the same rule (#1757): in the partial state the
  // failed list's section note is the answer, and it must not carry an empty
  // state beneath it either.
  if (noted) return null
  if (lane !== 'todo') return { text: LANE_EMPTY_TEXT, action: null }
  if (model.state === 'no-list-configured') {
    return { text: NO_LIST_TEXT, action: 'set-up-task-list' }
  }
  return { text: TODO_EMPTY_TEXT, action: null }
}

/**
 * The whole board, from the model. Pure: the same model and the same notes
 * always produce the same plan, so every rule above is testable with no DOM.
 */
export function planBoardRender(model: BoardModel, input: BoardRenderInput = {}): BoardRenderPlan {
  const banner = bannerFor(model)
  // Headings are a property of the BOARD, not of a lane: two queues means every
  // reader has to be told which list they are looking at, in Todo and nowhere
  // else — the other three lanes hold Flow's own records, which belong to the
  // run that made them rather than to a list.
  const headings = model.groups.length > 1
  const lanes: BoardLanePlan[] = BOARD_LANES.map(({ key, label }) => {
    const cards = model.lanes[key]
    // DOING WHILE IT RUNS, DONE ONCE IT IS OVER — never a fifth column, and
    // never the same hunt in two places.
    const hunts = huntsFor(model, input, key)
    const sections =
      key === 'todo'
        ? todoSections(model, input, headings, banner)
        : cards.length === 0
          ? []
          : [
              {
                key: null,
                label: null,
                cards: cards.map((card) => planCard(card, model, input)),
                note: null,
              },
            ]
    const laneBanner = key === 'todo' ? banner : null
    // THE COUNT IS WHAT THE LANE DRAWS. It used to be `cards.length` straight
    // off the model, on the grounds that the two were the same number and
    // deriving it twice is how they stop being — and then the Remote column
    // made them different: a remote item nobody has taken on is in
    // `model.lanes.todo` (it is claimable work) but is drawn in its own column,
    // so Todo read "2" over an empty list. The rule that survives is the one
    // that was always meant: ONE derivation, taken from the sections, so the
    // badge cannot disagree with the cards under it.
    const drawn = sections.reduce((total, section) => total + section.cards.length, 0)
    return {
      lane: key,
      label,
      count: drawn,
      banner: laneBanner,
      hunts,
      sections,
      // A lane holding a hunt is not an empty lane. "—" under a running producer
      // would say Doing is idle while the card above it says it is hunting.
      empty: emptyFor(
        key,
        model,
        drawn > 0 || hunts !== null,
        laneBanner,
        sections.some((section) => section.note !== null),
      ),
    }
  })
  return { filter: filterPlanFor(model), threadFilter: threadFilterPlanFor(model), lanes }
}

