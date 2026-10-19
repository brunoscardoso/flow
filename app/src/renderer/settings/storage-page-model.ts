/**
 * THE STORAGE PAGE, DECIDED — every sentence it prints and every press it
 * allows, with no DOM anywhere near it.
 *
 * WHAT THIS PAGE IS ABOUT. Files on disk that belong to a conversation. That
 * sentence is the whole vocabulary: there is no object here to name, no
 * container to introduce, and nothing a reader has to learn before the page is
 * useful. The surface it replaces called the same rows "copies of the project",
 * which asked a person to hold a second noun in their head in order to read a
 * list of conversations — so the word is gone, and a test below fails if it
 * comes back (`storage-page-model.test.ts`).
 *
 * WHY A MODEL FILE AND NOT A VIEW. The renderer's tests run under a node
 * environment with no DOM, which is exactly the constraint that keeps a surface
 * honest: everything that can be WRONG — a state, a refusal, a count, a
 * sentence — lives here where a test can read it, and `storage-page.ts` is left
 * with nothing but elements and listeners.
 *
 * NOTHING HERE DELETES, and nothing here decides what deletion means. The three
 * states, the freeable rule and the two hard refusals are Phase 1's
 * (`../threads/storage-rows`), imported rather than restated; this file adds
 * the page's own layer on top of them — the titles, the facts, the header and
 * the one refusal that is the page's own policy rather than a fact about a row.
 *
 * NO PATH CROSSES THIS FILE (forbidden-pattern #12). The wire deliberately
 * carries no field a renderer could print, and nothing below invents one.
 */

import type {
  ThreadWorktreeEntry,
  ThreadWorktreeInventory,
} from '../../shared/ipc-contract'
import {
  ageLabel,
  freeRefusal,
  freeable,
  sizeLabel,
  storageRowState,
  type StorageRowState,
} from '../threads/storage-rows'

/**
 * How a row reads at a glance.
 *
 * ONE MARK PER ROW, in the same shape the conversation list uses for the same
 * idea: a rule at the head of the row, never a badge and never a word. It is a
 * tone rather than a colour because the palette decides colours and this file
 * decides meaning.
 *
 * IT IS NOT `isolationMark`'s MARK, and the reason is structural rather than a
 * preference: that one is decided from `worktreePath` and `originLoop`, and
 * neither field crosses this wire — an inventory entry is a conversation, a
 * branch and a state by design. Every row on this page belongs to a
 * conversation that is already kept apart, so "is it apart" would say the same
 * thing on every row and answer nothing. The mark says the thing that actually
 * differs: how much attention this row wants.
 */
export type StorageTone = 'working' | 'landed' | 'orphaned'

/** Whether the free action can be pressed, and — when it cannot — why not. */
export interface FreeAction {
  enabled: boolean
  /** A sentence, never a code and never a remedy to type. Null when enabled. */
  reason: string | null
}

/** One conversation's files, ready to render. */
export interface StorageRowView {
  /** The key every action is addressed by. NEVER rendered. */
  id: string
  state: StorageRowState
  tone: StorageTone
  /** The conversation's name, or the plain line for a row that has none. */
  title: string
  /** False when no conversation answers to this row any more. */
  hasConversation: boolean
  /** Size and when it was last used, already in words. Either may be absent. */
  facts: string[]
  /** The sentence under the title: what this state means for these files. */
  detail: string
  free: FreeAction
  /**
   * True when NO CONVERSATION RECORD backs this row.
   *
   * A TYPED FACT, NOT A READING OF `detail`. Freeing a row nothing claims is
   * the one call that cannot look its subject up from a conversation, so it has
   * to be told which project to look in; keying that on display copy would
   * break silently the day somebody rewords a sentence.
   */
  unclaimed: boolean
}

/** A conversation whose first turn has not named it yet. */
const UNTITLED = 'Untitled conversation'

/** What a row calls itself when the conversation behind it is gone. */
const NO_CONVERSATION = 'A conversation that no longer exists'

/**
 * THE REFUSAL. Said once, here, and never softened anywhere else.
 *
 * It is the sentence the ledger asked before it went ahead anyway — and on this
 * page it is the answer rather than the question. The header promises that
 * nothing holding work that exists nowhere else is ever removed whatever is
 * pressed, and a promise with an override beside it is not a promise. There is
 * deliberately no force, no "I understand", no second click that gets past it
 * (forbidden-pattern #15): the way to free one of these is to save the work,
 * which is the outcome the person wanted in the first place.
 */
const HOLDS_WORK =
  'This still holds work that exists nowhere else. Letting it go throws that away for good.'

// ── One row ────────────────────────────────────────────────────────────────

/**
 * Whether the free action can be pressed at all, and the sentence when it
 * cannot.
 *
 * THREE LAYERS, IN THIS ORDER, and the order is the design:
 *
 *  1. Phase 1's two hard stops — a turn in flight, and files that are already
 *     gone. Those are facts about the row, so they are asked first and their
 *     wording is imported rather than restated.
 *  2. Anything still `working`. The state's own definition is "leave it alone",
 *     and a page that draws that state and then offers the button anyway is
 *     drawing a warning it does not mean.
 *  3. A row whose conversation is gone but whose files still hold something
 *     nobody saved. This one is NOT covered by the state — drift is asked about
 *     before anything else, so it reads as `orphaned` — and it is precisely the
 *     row where losing the work would be least recoverable, because nothing
 *     else in Flow will ever mention it again.
 */
export function freeAction(entry: ThreadWorktreeEntry): FreeAction {
  if (!freeable(entry)) {
    return { enabled: false, reason: freeRefusal(entry) }
  }
  if (storageRowState(entry) === 'working') {
    return { enabled: false, reason: workingReason(entry) }
  }
  if (entry.changedFiles > 0) {
    return { enabled: false, reason: HOLDS_WORK }
  }
  return { enabled: true, reason: null }
}

/** Why a `working` row is left alone — the specific thing it is holding. */
function workingReason(entry: ThreadWorktreeEntry): string {
  if (entry.changedFiles > 0) return HOLDS_WORK
  // SAVED, BUT NOT WHERE IT WAS GOING. These commits are not lost by freeing
  // the files — they are on the branch. They are still not landed, and the
  // header's promise is about unlanded work rather than about unsaved work, so
  // this row waits too. The sentence says where they are so the reader is not
  // left thinking something is missing.
  return `${changes(entry.aheadCommits)} here ${entry.aheadCommits === 1 ? 'has' : 'have'} not reached the branch this conversation was cut from. ${entry.aheadCommits === 1 ? 'It is' : 'They are'} safe on its own branch, and these files stay until it lands.`
}

/** One entry, as a row. */
export function storageRowView(entry: ThreadWorktreeEntry): StorageRowView {
  const state = storageRowState(entry)
  return {
    id: entry.threadId,
    state,
    tone: state,
    title: rowTitle(entry),
    hasConversation: entry.threadTitle !== null && entry.threadTitle.trim() !== '',
    facts: rowFacts(entry),
    detail: rowDetail(entry, state),
    free: freeAction(entry),
    unclaimed: entry.drift === 'abandoned' || entry.drift === 'dead-record',
  }
}

/** Every row, in the order the page shows them. */
export function storageRows(inventory: ThreadWorktreeInventory): StorageRowView[] {
  return inventory.entries.map(storageRowView)
}

function rowTitle(entry: ThreadWorktreeEntry): string {
  const title = entry.threadTitle?.trim() ?? ''
  if (title === '') {
    // A ROW WITH NO CONVERSATION IS NOT AN UNTITLED ONE. The first is a pairing
    // that broke; the second is a conversation that has not spoken yet. They
    // read the same if both say "Untitled", and only one of them can be freed
    // without a thought.
    return entry.drift === 'abandoned' || entry.drift === 'dead-record'
      ? NO_CONVERSATION
      : UNTITLED
  }
  return entry.archived ? `${title} (archived)` : title
}

/**
 * The two facts that make a list of fifteen actionable rather than merely long.
 *
 * BOTH ARE OMITTED RATHER THAN GUESSED — Phase 1's labels already refuse to
 * invent a "0 KB" or a "just now" out of an unreadable field, and this simply
 * drops what they decline to answer instead of printing a blank.
 */
function rowFacts(entry: ThreadWorktreeEntry): string[] {
  const facts: string[] = []
  const size = sizeLabel(entry.diskKb)
  if (size !== null) facts.push(size)
  const age = ageLabel(entry.lastActiveAt)
  if (age !== null) facts.push(age)
  return facts
}

/**
 * What this row's state means for these files, in one sentence.
 *
 * WHERE THE NINE STATES WENT. The ledger printed a two-word label AND a
 * sentence; the label is what asked a reader to learn a taxonomy, so only the
 * sentence survives. The nuance the labels carried is all still here — unsaved
 * files and unlanded commits say different things — it is simply told rather
 * than named.
 */
function rowDetail(entry: ThreadWorktreeEntry, state: StorageRowState): string {
  if (entry.drift === 'dead-record') {
    return 'Nothing is here any more — this is a leftover note about files that have already gone. Clearing it frees nothing and loses nothing.'
  }
  if (entry.drift === 'gone') {
    // Phase 1 already owns this sentence, and one wording for one fact is how
    // two surfaces avoid disagreeing about the same row.
    return freeRefusal(entry) ?? ''
  }
  if (entry.drift === 'abandoned') {
    return entry.changedFiles > 0
      ? `The conversation these belonged to is gone, and ${files(entry.changedFiles)} here nobody saved. Nothing else in Flow will ever mention them again.`
      : 'The conversation these belonged to is gone, but the files are still taking up room.'
  }
  if (entry.busy) {
    return freeRefusal(entry) ?? ''
  }
  if (state === 'working') {
    return workingReason(entry)
  }
  if (entry.onBase) {
    return 'This conversation works on its branch directly, so everything it did is already there. These files are only taking up room now.'
  }
  if (entry.branch === null || entry.branch === '') {
    return 'Nothing was ever changed here, and there is nothing to lose by letting it go.'
  }
  return 'Everything this conversation did has reached its branch. These files are only taking up room now.'
}

// ── The page's own header ──────────────────────────────────────────────────

/** What the page says about itself before any row is read. */
export interface StorageHeader {
  /** `N of <cap> · <total size>` — the number first, because it is the reason
   *  somebody opened this. The size is omitted when nothing could be measured. */
  line: string
  /** The promise under it. Two clauses, both load-bearing. */
  note: string
  /** The one line a page with no rows shows instead of an empty list. */
  empty: string | null
}

/**
 * THE PROMISE. Both halves are the reason this page can be read quickly.
 *
 * The first says a person does not have to come here — Flow already frees what
 * has landed as it lands, so an untended project does not grow forever. The
 * second is what makes the first safe to believe: the automatic behaviour and
 * every button on this page obey the same rule, so "it cleans up on its own" is
 * never a sentence somebody reads just before losing an afternoon's work.
 */
const HEADER_NOTE =
  'Flow frees these on its own as work lands. Nothing holding work that exists nowhere else is ever removed, whatever you press here.'

/** What a project with nothing on disk says instead of an empty list. */
const NOTHING_HELD =
  'No conversation in this project is keeping files of its own right now. One starts keeping them the first time it is asked to change something.'

/** What the page says when the project could not be read at all. */
export const STORAGE_UNREADABLE =
  'Flow couldn’t read what this project is holding on disk. Nothing has been changed.'

/** The page's own name, used by its heading and by the door that opens it. */
export const STORAGE_PAGE_TITLE = 'Files kept for conversations'

export function storageHeader(inventory: ThreadWorktreeInventory): StorageHeader {
  const total = inventory.usage.total
  const size = sizeLabel(totalDiskKb(inventory))
  return {
    line: `${String(total)} of ${String(inventory.usage.cap)}${size === null ? '' : ` · ${size}`}`,
    note: HEADER_NOTE,
    empty: inventory.entries.length === 0 ? NOTHING_HELD : null,
  }
}

/**
 * Everything measurable, added up — or null when nothing was measurable.
 *
 * NULL IS NOT ZERO. A project whose sizes could not be read has an unknown
 * total, and "0 MB" is a number a person would act on. One readable row is
 * enough to print a total, which is honest in the other direction too: the
 * figure is what Flow could see, and it is never larger than the truth.
 */
function totalDiskKb(inventory: ThreadWorktreeInventory): number | null {
  let sum: number | null = null
  for (const entry of inventory.entries) {
    const kb = entry.diskKb
    if (kb === null || !Number.isFinite(kb) || kb < 0) continue
    sum = (sum ?? 0) + kb
  }
  return sum
}

// ── The one bulk control ───────────────────────────────────────────────────

/** What the page's single bulk control says, and whether it can be pressed. */
export interface BulkFreeControl {
  /** FIXED role words plus a count. Never a conversation's name. */
  text: string
  enabled: boolean
  /** Why it is off — null when it is on. */
  blockedReason: string | null
}

/**
 * The rows a bulk press acts on.
 *
 * EVERYTHING THAT HAS LANDED, AND NOTHING ELSE. Not "everything freeable" — an
 * orphaned row is freeable and is still a decision somebody should make one at
 * a time, because a conversation disappearing is the kind of thing a person
 * wants to look at before agreeing it is fine.
 */
export function landedRows(rows: readonly StorageRowView[]): StorageRowView[] {
  return rows.filter((row) => row.state === 'landed' && row.free.enabled)
}

/**
 * The control.
 *
 * ITS WORDS NEVER CHANGE THEIR MEANING, only their count. The ledger's button
 * had to rewrite itself to warn about what a hand-made selection contained;
 * this one cannot contain anything dangerous, by construction, so it says the
 * same thing every time and the count is the only variable.
 */
export function bulkFreeControl(rows: readonly StorageRowView[]): BulkFreeControl {
  const landed = landedRows(rows)
  if (landed.length === 0) {
    return {
      text: 'Free what has landed',
      enabled: false,
      blockedReason:
        rows.length === 0
          ? null
          : 'Nothing here has landed yet. Flow frees these the moment their work does.',
    }
  }
  return {
    text: `Free what has landed — ${String(landed.length)}`,
    enabled: true,
    blockedReason: null,
  }
}

// ── What happened ──────────────────────────────────────────────────────────

/**
 * What the page says after a press.
 *
 * IT NAMES WHAT SURVIVED, not how many rows were touched. "Their branches keep
 * the record" is the sentence that stops a person wondering, an hour later,
 * whether they threw something away — and the kept case says WHY rather than
 * reporting a failure, because a row that grew work while the page was open is
 * the rule working exactly as promised.
 */
export function freeSummary(freed: number, kept: number): string {
  if (freed === 0 && kept === 0) return 'Nothing was removed.'
  if (kept === 0) {
    return freed === 1
      ? 'One conversation’s files are gone. Its branch keeps the record of what it did.'
      : `${String(freed)} conversations’ files are gone. Their branches keep the record of what they did.`
  }
  if (freed === 0) {
    return kept === 1
      ? 'That one was kept — something about it changed while this page was open.'
      : `Those ${String(kept)} were kept — something about them changed while this page was open.`
  }
  return `${String(freed)} gone, ${String(kept)} kept. The ones that stayed changed while this page was open.`
}

/** What the page says when the call itself failed. */
export const FREE_FAILED = 'Flow couldn’t remove those files. Everything is where it was.'

// ── Small shared shapes ────────────────────────────────────────────────────

function files(count: number): string {
  return count === 1 ? '1 file' : `${String(count)} files`
}

function changes(count: number): string {
  return count === 1 ? '1 saved change' : `${String(count)} saved changes`
}
