// What a gesture on a board card MEANS (loops-on-the-board, Phase 6). DOM-free
// and IPC-free, like board-model.ts beside it: this file decides which loop a
// card's write addresses, what a claim's four outcomes do to the card, and
// whether a gated card's approve control can be pressed. kanban-board.ts calls
// the CLI and appends elements; every `if` about an outcome lives here.
//
// THE MODEL ALREADY DECIDED THE STATE. Nothing below recomputes a lane, an
// amber flag or a blocked reason — those come off BoardCard, which read them
// off the CLI. What is decided here is strictly what the CLI's ANSWER means for
// the gesture the user just made, which is a question the model never sees.
//
// TWO RULES THIS FILE ENFORCES:
//
//  - A CLAIM THAT DID NOT TAKE THE ITEM RETURNS THE CARD, CARRYING WHY. The
//    card never settles in Doing on an answer that was not `claimed`, and the
//    reason it comes back with is the CLI's own line, verbatim — never a
//    generic "claim failed", which is exactly the sentence that would hide
//    `item 1533 is held by '@someone' on the queue`.
//  - LOSING A RACE IS NOT A FAILURE. `empty` is a quiet queue and `lost` is
//    another engineer's run getting there first; both exit 0 in the CLI and
//    both read as information here. Only `refused` is red.

import { withoutCommandHint } from '../../shared/command-hint'
import type {
  LoopClaimResult,
  LoopFileResult,
  LoopQueueItem,
  LoopQueueSnapshot,
  LoopStatusRow,
  LoopUnclaimResult,
  LoopsSnapshot,
  TaskLane,
  TaskSummary,
} from '../../shared/ipc-contract'
import { approvalFor } from '../loops/loops-panel-model'
import {
  APPROVAL_BLOCKED_REASON,
  isMirroredTask,
  queueItemExternalKey,
  type BoardCard,
  type BoardQueueGroup,
} from './board-model'

/** The loop a card's `loop <verb> --loop <n>` addresses, or why there is none. */
export interface CardLoop {
  loop: string | null
  /** Why no loop could be named, in the user's terms, or null. */
  reason: string | null
}

/**
 * Which loop a write about this card names.
 *
 * THE ITEM'S OWN MARKER FIRST, because that is the loop that filed it and the
 * loop whose budget and gate the write is subject to. A queue read can return
 * an item whose marker is empty (a person's issue, filed by hand), and then the
 * queue itself is the answer — but only when exactly one loop points at it. Two
 * loops on one list (this repo's `find` and `fix` both read
 * `dev/plan-flow`) is a genuine ambiguity, and picking the first one
 * would be the board inventing a fact the queue never reported.
 */
export function resolveCardLoop(card: BoardCard, groups: readonly BoardQueueGroup[]): CardLoop {
  if (card.loop !== null && card.loop.length > 0) return { loop: card.loop, reason: null }
  const group = groups.find((candidate) => candidate.key === card.queueKey) ?? null
  if (group === null) return { loop: null, reason: 'this card belongs to no queue' }
  if (group.loops.length === 1) return { loop: group.loops[0]!, reason: null }
  if (group.loops.length === 0) return { loop: null, reason: `no loop reads ${group.label}` }
  return {
    loop: null,
    reason: `${group.loops.join(' and ')} both read ${group.label}, and this item names neither`,
  }
}

// ── Claiming (Task 6.3 / 6.4) ────────────────────────────────────────────

/** A one-line message for the notification surface. */
export interface ClaimNotice {
  title: string
  body: string
  level: 'info' | 'error'
}

/** What the CLI's answer means for the card the user just dragged. */
export interface ClaimOutcome {
  /** True only for `claimed` — the one answer that materializes a run record. */
  claimed: boolean
  /** Where the card settles. Doing only when the item was actually taken. */
  lane: TaskLane
  /**
   * The line the card carries back with it, verbatim from the CLI, or null.
   *
   * IT RIDES THE CARD, not just a toast. A toast is gone in five seconds and
   * the card is still sitting in Todo with no explanation of why the drag did
   * nothing — the silent snap-back that #1193 already fixed once for the local
   * lane write, arriving here through a different door.
   */
  note: string | null
  notice: ClaimNotice | null
}

/** The reason to show when the CLI answered without giving one of its own. */
const CLAIM_FALLBACK: Record<LoopClaimResult['status'], string> = {
  claimed: '',
  empty: 'the queue had nothing claimable',
  lost: 'another run took it first',
  refused: 'the claim was refused',
}

/**
 * Whether the claim on this card is THIS installation's own.
 *
 * The one comparison the stable owner exists to make (review finding H1). Before
 * it, every claim the board made carried a fresh `run-<ts>-<pid>`, so a card's
 * own holder was a name this window had never seen and could not recognise —
 * which is how "Someone else has this item" ended up being said about the user's
 * own claim. `heldBy` is set by the model only when the queue says claimed and
 * this machine has no local record of it, so it is precisely the case that used
 * to be unreadable.
 *
 * An UNKNOWN owner (the channel is missing, or an older build minted nothing)
 * answers false: a board that cannot name itself must not claim a stranger's
 * item as its own, and the pre-existing reading is the safe one.
 */
export function heldByThisInstallation(card: BoardCard, owner: string | null): boolean {
  if (card.heldBy === null || owner === null) return false
  return card.heldBy.trim() === owner.trim() && owner.trim().length > 0
}

/**
 * Read one `loop claim` answer.
 *
 * `card.heldBy` is what separates a refusal about SOMEBODY ELSE from a refusal
 * about the queue's rules. It is set by the model when the queue says claimed
 * and this machine has no record of the claim, so a refusal on such a card is
 * another engineer holding it — the same thing `lost` reports, one moment
 * earlier — and it reads as information, not as a fault. That test is a model
 * field, deliberately: sniffing the CLI's prose for a `@login` would be a
 * second reader of a sentence the model already turned into a fact.
 *
 * ...UNLESS THE HOLDER IS US. With a durable owner the board can tell its own
 * claim from a stranger's, and the sentence that finding H1 called actively
 * wrong — "Someone else has this item", about the item this very window is
 * holding — is now the one case that never reaches it. A refusal on a card we
 * hold is a refusal about the queue's rules, so it gets the ordinary error and
 * the CLI's own reason, which is the sentence that can actually be acted on.
 */
/** Moved to shared so main can apply the same display rule; re-exported for existing callers. */
export { withoutCommandHint }

/**
 * A CLI reason, made fit for a person to read.
 *
 * WHY THIS IS MORE THAN `withoutCommandHint`. That helper only strips a
 * backticked invocation, which is what an OPERATIONAL refusal carries ("held by
 * '@rival' … release it with `…`"). A DIAGNOSTIC refusal carries something
 * else entirely: `loop enable` on a directive with a typo answers with an
 * absolute path AND the whole frontmatter vocabulary —
 *
 *   /Users/…/loops/broken.md: unknown frontmatter key 'quee' — expected one of
 *   loop, engine, paused, mission, scope, slice, queue, repo, path, label,
 *   topic, max_open_issues, max_run_minutes, max_concurrent_runs, needs_approval
 *
 * — which is exactly right in a terminal and is a wall of internals in a toast
 * (forbidden pattern #12). The substance a reader can act on is "one of its
 * settings is misspelled"; the path and the key list are for whoever opens the
 * file, and the raw text still goes to the console for them.
 *
 * DISPLAY ONLY, like its sibling: nothing that decides behaviour reads this.
 */
export function forReader(reason: string): string {
  const cleaned = withoutCommandHint(reason)
    // A path — absolute or relative, POSIX or Windows — down to the file it
    // names.
    //
    // BOTH SEPARATORS, because one of them made this rule a no-op on a whole
    // platform. The '/'-only version collapsed `/tmp/…/loops/broken.md` and let
    // `C:\Users\devuser\…\loops\broken.md` through verbatim, so the loops panel
    // rendered an absolute path plus the parser's vocabulary — exactly what
    // forbidden-pattern #12 forbids — while every macOS and Linux run looked
    // clean. Caught by this repo's own hygiene spec, running on Windows for the
    // first time.
    // The leading segment is optional-and-separatorless so a RELATIVE path is
    // eaten whole: `loops/broken.md` used to keep its first segment and render
    // as "loopsits settings", because the pattern demanded a separator before
    // every segment. A bare `broken.md` still matches nothing — one filename is
    // not a path, and collapsing it would swallow ordinary prose.
    .replace(/(?:[A-Za-z]:)?[^\s:\\/]*(?:[\\/][^\s:\\/]+)+\.(?:md|jsonl|json)/g, 'its settings')
    // The vocabulary dump the parser appends when it refuses a key.
    .replace(/\s*[—-]?\s*expected one of [^.]*/gi, '')
    // A BRACKETED HANDOVER, which is the third shape a command arrives in and
    // the one neither rule above catches. `loop next` refuses a capped
    // instruction with "… stop here and let a person look at what is already in
    // the list (to carry on after looking: loop resume --loop find --focus
    // 'x')" — no backticks and no `planflow-ai`, just a parenthetical whose
    // whole content is an invocation. Anchored on the flags rather than on the
    // words: a parenthetical naming a `--flag` is a command by construction,
    // and one that names none is ordinary prose and is left alone.
    .replace(/\s*\([^()]*--[^()]*\)/g, '')
    // The same handover without the brackets, introduced by a colon: "… — to
    // carry on: loop resume --loop find". Only the tail from the colon goes,
    // and only when what follows it carries a flag.
    .replace(/\s*[—:-]\s*[^:.]*\s--[a-z][^.]*$/i, '')
    // Two paths named in one sentence ("at <a> or <b>", the refusal for a
    // directive that is in neither home) collapse to one phrase: the reader is
    // told the same thing twice otherwise.
    .replace(/its settings(?:\s+or\s+its settings)+/g, 'its settings')
    // A leading "its settings: " reads better as a sentence about the file.
    .replace(/^its settings:\s*/i, 'Its settings file has a problem — ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([—-])\s*$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : reason
}

/**
 * What a user-visible string may never carry (forbidden pattern #12), as a list
 * this file can actually test a sentence against.
 *
 * DUPLICATED BY VALUE FROM `ui-text-hygiene.test.ts`, and deliberately not
 * imported from it: that file is the RULE, stated as a test, and production code
 * importing its constants would make the rule and the thing it judges one
 * object. Two independent statements of the same list is the point — if they
 * ever disagree, the test is right.
 */
const COMMAND_TOKENS = ['planflow-ai', 'loops/', '.md', 'paused:', '--']

/**
 * An absolute path, anywhere in a sentence — the shape `forReader` cannot fix.
 *
 * IT ONLY COLLAPSES PATHS TO A FILE (`…/broken.md` → "its settings"), because a
 * file is a thing a reader can be told about. A DIRECTORY carries no extension
 * to anchor on, and one arrives whenever a whole loops folder cannot be listed:
 *
 *   /Users/…/T/flow-ux-proj-Ab12/loops: unreadable (EACCES: permission denied…)
 *
 * — rendered verbatim on the Loops screen, which is forbidden pattern #12 in
 * its plainest form. `COMMAND_TOKENS` walked straight past it: there is no
 * `planflow-ai`, no flag, no `.md`, and `loops/` needs a trailing slash the
 * path does not have. So the guard tests the SHAPE as well as the vocabulary.
 */
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)\/[^\s/][^\s]*/

/**
 * A CLI sentence a person may actually be shown, or the app's own words instead.
 *
 * WHY A GUARD AND NOT JUST `forReader`. Relaying another tool's prose is a bet
 * that every sentence it can produce is fit for a GUI, and that bet has now been
 * lost twice — once on a directive path, once on a frontmatter dump. `loop file`
 * can refuse with a third shape neither of those taught us ("file requires
 * --loop <name>"), and the honest reading of forbidden pattern #12 is that a
 * relay is safe only when the result contains no invocation at all. So the
 * cleaned line is CHECKED, and a line still carrying a command, a path or a
 * config key is dropped for a sentence written here.
 *
 * NOTHING IS LOST TO THE ENGINEER: every caller logs the raw line to the console
 * as well, which is where the flag names and the absolute paths are useful.
 *
 * DISPLAY ONLY, like both helpers above — nothing that decides behaviour reads
 * this, and no caller may branch on which of the two sentences came back.
 */
export function relayed(reason: string | null, fallback: string): string {
  if (reason === null) return fallback
  const cleaned = forReader(reason).trim()
  if (cleaned.length === 0) return fallback
  if (COMMAND_TOKENS.some((token) => cleaned.includes(token))) return fallback
  return ABSOLUTE_PATH_PATTERN.test(cleaned) ? fallback : cleaned
}

export function claimOutcome(
  card: BoardCard,
  result: LoopClaimResult,
  owner: string | null = null,
): ClaimOutcome {
  const raw = result.reason !== null && result.reason.trim().length > 0 ? result.reason.trim() : null
  const reason = raw === null ? null : withoutCommandHint(raw)
  if (result.status === 'claimed') {
    return { claimed: true, lane: 'doing', note: null, notice: null }
  }
  const note = reason ?? CLAIM_FALLBACK[result.status]
  if (result.status === 'empty') {
    return {
      claimed: false,
      lane: 'todo',
      note,
      notice: { title: 'Nothing to claim', body: note, level: 'info' },
    }
  }
  const mine = heldByThisInstallation(card, owner)
  // `lost` is the CLI's own word for another run getting there first, and it is
  // about the claim just attempted rather than the one on the card — so it says
  // "someone else" even on a card we appear to hold.
  if (result.status === 'lost' || (card.heldBy !== null && !mine)) {
    return {
      claimed: false,
      lane: 'todo',
      note,
      notice: { title: 'Someone else has this item', body: note, level: 'info' },
    }
  }
  return {
    claimed: false,
    lane: 'todo',
    note,
    notice: { title: "Couldn't claim this item", body: note, level: 'error' },
  }
}

// ── Releasing: the claim's other half (review finding H1) ────────────────

/**
 * The Release control on a card THIS installation is holding.
 *
 * WHY IT EXISTS. A claim that lands while its local record does not leaves the
 * item held on the queue with nothing on this machine pointing at it. The claim
 * is honest and must not be silently undone — but the user has to be able to
 * undo it deliberately, and until now the only way was `planflow-ai loop
 * unclaim` in a terminal the app never mentions.
 *
 * NULL FOR EVERY OTHER CARD, and that is the safety rule: a stranger's claim
 * gets no control at all (the CLI would refuse it anyway, but a button that
 * exists only to be refused is a button that invites the attempt), and a card
 * with a local record is not in this state — Doing/Blocked/Done move by lane,
 * not by release.
 *
 * Disabled-with-a-reason when nothing names the loop, exactly as `cardApproval`
 * does: a control that cannot say what it would act on says so, carrying the
 * CLI command that would do it by hand.
 */
export interface CardRelease {
  /** The `--loop` the write carries, or null when nothing named one. */
  loop: string | null
  /** The `--id` the write carries — always known: it came from `loop list`. */
  id: string
  label: string
  actionable: boolean
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
}

export function cardRelease(
  card: BoardCard,
  groups: readonly BoardQueueGroup[],
  owner: string | null,
): CardRelease | null {
  if (card.itemId === null) return null
  if (!heldByThisInstallation(card, owner)) return null
  const id = card.itemId
  const { loop, reason } = resolveCardLoop(card, groups)
  if (loop === null) {
    return {
      loop: null,
      id,
      label: 'Release',
      actionable: false,
      // NO COMMAND IN A SENTENCE A PERSON READS. A disabled control's job is to
      // say what is wrong, in the terms of the thing on screen — pasting a
      // terminal invocation hands the reader the app's own internals and asks
      // them to finish the job by hand.
      blockedReason: reason ?? "Flow can't tell which list this item belongs to, so it can't release it from here.",
    }
  }
  return { loop, id, label: 'Release', actionable: true, blockedReason: null }
}

/** What a `loop unclaim` answer means for the card the user pressed. */
export function releaseNotice(title: string, result: LoopUnclaimResult): ClaimNotice {
  const subject = title.trim().length > 0 ? title.trim() : 'The item'
  if (!result.ok) {
    return {
      title: "Couldn't release this item",
      // The CLI's own line, verbatim — the same rule the claim path follows.
      body: result.reason ?? `${subject} is still held on the queue.`,
      level: 'error',
    }
  }
  // RELEASING WHAT NOBODY HELD IS SUCCESS, says the CLI, and the surface has to
  // say the same thing without claiming it undid something it did not.
  if (!result.wasClaimed) {
    return {
      title: 'Nothing to release',
      body: `${subject} was not claimed on the queue.`,
      level: 'info',
    }
  }
  return {
    title: 'Released',
    body: `${subject} is back on the list for anyone — or any loop — to claim.`,
    level: 'info',
  }
}

// ── The run record a claim materializes (Task 6.6 / D3, FR-7) ────────────

/**
 * The facts `tasks:createFromQueueItem` needs, minus the project root the
 * caller adds. Field names are the channel's, so the board forwards rather than
 * translates.
 */
export interface RunRecordFacts {
  externalKey?: string
  itemId?: string
  url?: string
  title: string
  body?: string
  queueKind?: string
}

/**
 * The raw queue item behind a card, out of the snapshot the board already read.
 *
 * THE BOARD HAS THE ITEM; IT JUST STOPPED CARRYING IT. `BoardCard` deliberately
 * holds only what a card RENDERS, and a run record wants one more thing — the
 * item's body, which is the description the record seeds its thread and brief
 * from. Rather than widen the model's card for a fact no card draws, the item
 * is looked up again in the same snapshot, by the group's own loops and the
 * card's own id. No fetch, no second read: this is the answer already in hand.
 *
 * Two loops on one queue return the same item twice; the first match is that
 * item, not a choice between two.
 */
export function queueItemFor(
  snapshot: LoopQueueSnapshot,
  group: BoardQueueGroup,
  itemId: string,
): LoopQueueItem | null {
  for (const row of snapshot.loops) {
    if (!group.loops.includes(row.loop)) continue
    const found = row.items?.find((item) => item.id === itemId) ?? null
    if (found !== null) return found
  }
  return null
}

/**
 * What to record for a claimed card, or null when there is genuinely nothing to
 * record it under.
 *
 * THE JOIN KEY LEADS, and that is a change from the first cut, which preferred
 * the item's URL because it was "what the backend published". The board's join
 * (`recordFor`) tries `queueItemExternalKey(location, id)` FIRST and the URL
 * only after, so a record stored under the URL alone is a record the join finds
 * by its second index at best — and for a ledger item, whose `<path>#<id>` key
 * parses as no issue reference at all, the URL route recorded nothing whatever.
 * Both strings travel here: the key to be joined on, the URL to be opened.
 *
 * NULL IS THE HONEST ANSWER, NOT AN EMPTY REQUEST. A queue that named no
 * location and an item with no link leave nothing that could identify the run
 * later, and the board says so — the claim still stands.
 */
export function runRecordFacts(
  card: BoardCard,
  group: BoardQueueGroup | null,
  item: LoopQueueItem | null,
): RunRecordFacts | null {
  if (card.itemId === null) return null
  const key = queueItemExternalKey(group?.location ?? null, card.itemId)
  if (key === null && card.url === null) return null
  return {
    ...(key === null ? {} : { externalKey: key }),
    itemId: card.itemId,
    ...(card.url === null ? {} : { url: card.url }),
    // The item's own title when the snapshot still holds it, else the card's —
    // they are the same string, and the card's is the one that survives a
    // snapshot that has already moved on.
    title: item?.title ?? card.title,
    ...(item === null || item.body.length === 0 ? {} : { body: item.body }),
    // Which store answered, verbatim. The source a record carries is decided in
    // main from this word — not here, where it would be a second decision about
    // one fact.
    ...(group?.kind === null || group?.kind === undefined ? {} : { queueKind: group.kind }),
  }
}

/**
 * How far a claimed item's run record got before something failed.
 *
 *  - `unrecordable` — the queue named no link and no location, so there is
 *    nothing to record the run UNDER. Nothing was written and nothing will be.
 *  - `not-created`  — `tasks:createFromQueueItem` threw. No record exists.
 *  - `not-moved`    — the record EXISTS; only the follow-up lane write failed.
 */
export type RunRecordFailure = 'unrecordable' | 'not-created' | 'not-moved'

/**
 * The notice for a claim whose record did not fully land (review finding L2).
 *
 * `not-moved` USED TO WEAR `not-created`'S SENTENCE. One `try` spanned the
 * create and the lane move, so a record that was created and then failed to
 * move told the user "Claimed, with no local record" — about a record sitting
 * in Todo where they could see it. The two failures differ in the only way that
 * matters to the reader: after `not-created` there is nothing on this machine
 * and the claim needs re-driving; after `not-moved` the run is recorded, the
 * card is one drag from where it belongs, and the next drag fixes it by itself
 * (`card.taskId` is non-null now, so the drop routes to the local lane write).
 *
 * `unrecordable` is the quiet one — nothing failed, the queue simply published
 * nothing to file the run under — so it is `info` where the other two are
 * `error`. THE CLAIM STANDS IN ALL THREE: the item is held on the queue either
 * way, and none of these sentences may suggest the drag did nothing.
 */
export function runRecordNotice(
  title: string,
  failure: RunRecordFailure,
  message?: string,
): ClaimNotice {
  const subject = title.trim().length > 0 ? title.trim() : 'The item'
  const because = message === undefined || message.trim().length === 0 ? '' : ` — ${message.trim()}`
  if (failure === 'unrecordable') {
    return {
      title: 'Claimed, with no local record',
      body: `${subject} is yours on the queue, but its list names no link or location to record it under.`,
      level: 'info',
    }
  }
  if (failure === 'not-created') {
    return {
      title: 'Claimed, with no local record',
      body: `${subject} is yours on the queue, but Flow could not record the run${because}.`,
      level: 'error',
    }
  }
  return {
    title: 'Claimed, but the card stayed in Todo',
    body: `${subject} is yours on the queue and Flow recorded the run — it just could not move the card${because}. Drag it to Doing to finish.`,
    level: 'error',
  }
}

// ── Sharing: a thread's task onto the shared list (Phase 5, Task 5.2) ────

/**
 * The Share control on a card an assistant mirrored out of a conversation.
 *
 * WHAT THIS FEATURE PROMISED AND WHAT THIS CONTROL IS. A mirrored card is a
 * LOCAL record of something said in a chat: nobody else can see it, no producer
 * will pick it up, and the plan's hardest constraint is that it stays that way
 * unless a person says otherwise — "a conversation never files to the team's
 * list as a side effect". This is the "otherwise": one press, on one card, by a
 * person looking at it. There is no other path from a conversation to a shared
 * queue anywhere in this app, and there must not be.
 *
 * NULL FOR EVERY OTHER CARD, and each exclusion is a different sentence:
 *
 *  - A QUEUE ITEM is already on the list this control exists to put things on.
 *  - AN IMPORTED ISSUE came from a tracker and is on that tracker's list already.
 *  - A CARD A PERSON TYPED is out of scope on purpose: `isMirroredTask` is the
 *    test, not "has no external key". Widening this to every local card is a
 *    reasonable future ask, and it is a different one — it would put a control
 *    that writes to a shared repo on cards that have never been near an agent.
 *  - A CARD OUTSIDE TODO is work this project has already started (or finished),
 *    and sharing it would invite a second person to claim what somebody here is
 *    doing. It is also the lane rule that keeps the local card's disappearance
 *    honest: the card leaves the board when it is shared (see `shareOutcome`),
 *    and a card in flight may never leave the board.
 *
 * THE TARGET IS THE BOARD'S, NOT THE CARD'S, which is the whole difference from
 * `resolveCardLoop`. That function asks which loop a write about an EXISTING
 * item addresses and reads the item's own marker; a mirrored card is on no list
 * at all — that is what is being fixed — so it carries no marker to read, and
 * the question becomes which list this project shares to. One queue with one
 * loop is an answer; anything else is a choice this file may not make for the
 * user, and it says so in a disabled control rather than picking (the same rule,
 * and the same shape of reason, `resolveCardLoop` applies to its own ambiguity).
 */
export interface CardShare {
  /** The loop whose list the item goes on, or null when nothing named one. */
  loop: string | null
  /** What the list is called, for the sentence the control shows. */
  listLabel: string | null
  label: string
  actionable: boolean
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
}

/** The control's word. One verb, and it is the user's word, not the CLI's. */
export const SHARE_LABEL = 'Share'

/**
 * The reason a project with no readable list cannot share yet.
 *
 * NO PATH AND NO COMMAND (forbidden pattern #12): the reader cannot act on the
 * name of a directive file, and the app sets lists up itself elsewhere. What is
 * said is the consequence — there is nowhere for this to go.
 */
const NO_LIST_REASON = 'This project has no shared list yet, so there is nowhere to put this.'

/**
 * What to CALL a list in a sentence a person reads.
 *
 * A LEDGER LOCATION IS A PATH, AND A PATH IS EXACTLY WHAT THIS MUST NOT PRINT.
 * `BoardQueueGroup.label` is the location verbatim — right for a GitHub queue,
 * where `acme/widgets` is the repo's actual name and the thing a reader would
 * type themselves, and wrong for the project's own list, whose location is a
 * file inside the repo (forbidden pattern #12). The panel settled this rule
 * first, for its own rows (`queueLabelFor` in loops-settings-model); the phrase
 * differs here because these strings are SENTENCES rather than row labels, and
 * "is on This project · queue now" is not one.
 *
 * A kind nobody reported falls back to the group's own label, which is then the
 * best name anybody has: a queue that named no kind named no ledger either.
 */
export function shareListName(group: BoardQueueGroup): string {
  if (group.kind === 'ledger') return "this project's own list"
  return group.label
}

export function cardShare(
  card: BoardCard,
  task: TaskSummary | null,
  groups: readonly BoardQueueGroup[],
): CardShare | null {
  if (task === null || card.itemId !== null) return null
  if (!isMirroredTask(task)) return null
  if (card.lane !== 'todo') return null
  const usable = groups.filter((group) => group.location !== null)
  if (usable.length === 0) {
    return { loop: null, listLabel: null, label: SHARE_LABEL, actionable: false, blockedReason: NO_LIST_REASON }
  }
  if (usable.length > 1) {
    return {
      loop: null,
      listLabel: null,
      label: SHARE_LABEL,
      actionable: false,
      blockedReason: `This project keeps more than one list — ${usable
        .map((group) => shareListName(group))
        .join(' and ')} — and nothing says which one this belongs on.`,
    }
  }
  const group = usable[0]!
  const listLabel = shareListName(group)
  if (group.loops.length === 0) {
    return {
      loop: null,
      listLabel,
      label: SHARE_LABEL,
      actionable: false,
      blockedReason: `No loop reads ${listLabel}, so nothing here can add to it.`,
    }
  }
  if (group.loops.length > 1) {
    // TWO PRODUCERS ON ONE LIST IS A REAL AMBIGUITY, not a tie to break. Each
    // one files under its own directive — its own labels, its own topic, its own
    // cap — so the two presses would produce two differently-tagged items, and
    // picking the first would be the board deciding which producer's work this
    // is on the user's behalf.
    return {
      loop: null,
      listLabel,
      label: SHARE_LABEL,
      actionable: false,
      blockedReason: `${group.loops.join(' and ')} both keep ${listLabel}, and nothing says which should carry this.`,
    }
  }
  return {
    loop: group.loops[0]!,
    listLabel,
    label: SHARE_LABEL,
    actionable: true,
    blockedReason: null,
  }
}

/**
 * What the CLI's answer to a share means for the card the user pressed.
 *
 * THE JUDGEMENT CALL THIS PHASE OWNED, SETTLED HERE: on a share that landed, the
 * local card LEAVES THE BOARD (it is archived), and the shared list's own item
 * becomes the card. Nothing joins, nothing is rewritten, and the work is drawn
 * exactly once.
 *
 * The alternatives, and why not:
 *
 *  - LEAVE THE LOCAL CARD AS IT IS. The next queue read returns the item that
 *    was just filed, and the board draws it in the list's own Todo section — so
 *    the same piece of work is on screen twice, in two sections, under two
 *    identities, and dragging one of them does nothing to the other. This is the
 *    failure the whole question exists to prevent.
 *  - JOIN THEM, by writing the queue item's key or URL onto the local record.
 *    The board really does have that join (`queueItemExternalKey` →
 *    `owner/repo#123`, plus a by-URL index), and it is the right machinery for
 *    an item a run RECORDED. It is the wrong one here for two reasons. The key
 *    is not free: a mirrored card's `externalKey` IS its identity to the mirror
 *    (`mirroredCardsFor` recovers the todo's key out of it), so overwriting it
 *    would make the next payload from that conversation look like a todo nobody
 *    had ever seen and file a SECOND card for the same work — the duplicate this
 *    decision is meant to prevent, arriving through the back door. And the URL
 *    half only works for a backend that publishes one, so a ledger list would
 *    join nothing and draw twice anyway.
 *  - DELETE THE LOCAL CARD. It is the only option that loses something real:
 *    the record carries which conversation produced this work, and deleting it
 *    throws that away at the exact moment the work becomes somebody else's
 *    problem. Archiving keeps the row, the provenance and the mirror's identity
 *    — the assistant can go on reconciling it, and the card can come back.
 *
 * A SHARE THAT DID NOT LAND CHANGES NOTHING. `archive` is false for every
 * refusal, so the card stays exactly where it was, carrying the reason — the
 * same rule a refused claim follows, for the same reason: a card that silently
 * snaps back reads as a missed gesture rather than a refusal.
 *
 * `duplicate` ARCHIVES TOO, and that is not a slip. It means the backend's dedup
 * recognised this work as already on the list, which is the state the press was
 * asking for; leaving the local card would draw the same work twice on the
 * strength of a distinction the user does not care about.
 */
export interface ShareOutcome {
  /** True when the work is on the shared list now — filed, or already there. */
  onTheList: boolean
  /** Whether the local record should leave the board. Never true on a refusal. */
  archive: boolean
  /** The line the card carries back with it, or null when it is leaving. */
  note: string | null
  notice: ClaimNotice
}

export function shareOutcome(
  title: string,
  listLabel: string | null,
  result: LoopFileResult,
): ShareOutcome {
  const subject = title.trim().length > 0 ? title.trim() : 'This'
  const list = listLabel === null || listLabel.trim().length === 0 ? 'the shared list' : listLabel.trim()
  if (!result.ok) {
    const body = relayed(result.reason, `${subject} could not be added to ${list}.`)
    return {
      onTheList: false,
      archive: false,
      note: body,
      notice: { title: "Couldn't share this", body, level: 'error' },
    }
  }
  if (result.status === 'duplicate') {
    return {
      onTheList: true,
      archive: true,
      note: null,
      notice: {
        title: 'Already on the list',
        body: `${subject} was already on ${list}, so nothing was added.`,
        level: 'info',
      },
    }
  }
  // `filed`, and the unreadable-report case with it: the write exited cleanly,
  // so the work is on the list, and the one thing not known is which of the two
  // successes it was. The sentence says what is certain.
  return {
    onTheList: true,
    archive: true,
    note: null,
    notice: {
      title: 'Shared',
      body: `${subject} is on ${list} now — anyone, or any loop, can pick it up.`,
      level: 'info',
    },
  }
}

// ── Approving (Task 6.5) ─────────────────────────────────────────────────

/**
 * The approve control on ONE blocked card.
 *
 * The panel's `LoopApproval` shape, per card rather than per loop: same field
 * names, same rule — a control that cannot name what it would act on renders
 * DISABLED with the CLI command as its reason, instead of silently no-oping or
 * disappearing. The count is gone because a card is one item.
 */
export interface CardApproval {
  /** The `--loop` the write carries, or null when nothing named one. */
  loop: string | null
  /** The `--id` the write carries — always known: it came from `loop list`. */
  id: string
  label: string
  actionable: boolean
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
}

function statusRowFor(loops: LoopsSnapshot | null, loop: string): LoopStatusRow | null {
  if (loops === null || !loops.available) return null
  return loops.loops.find((row) => row.loop === loop) ?? null
}

/**
 * The approve control for a card, or null when the card is not behind the gate.
 *
 * WHY THIS IS ACTIONABLE WHERE THE PANEL'S IS NOT. `approvalFor` refuses to
 * offer a press when `loop status` reports a COUNT but no ids, because the
 * panel approves a loop's whole waiting set and cannot name one of them. A card
 * is one item and its id came from `loop list` — the read that names every item
 * it returns — so the missing half the panel degrades over is not missing here.
 * The panel's verdict is still consulted rather than ignored: when it can name
 * ids and this card's id is not among them, the row and the list disagree about
 * one item, and a control that would write on a disagreement is a control that
 * decides which read was right. It renders, disabled, saying so.
 */
export function cardApproval(
  card: BoardCard,
  groups: readonly BoardQueueGroup[],
  loops: LoopsSnapshot | null,
): CardApproval | null {
  if (card.itemId === null) return null
  if (card.blockedReason !== APPROVAL_BLOCKED_REASON) return null
  const id = card.itemId
  const { loop, reason } = resolveCardLoop(card, groups)
  if (loop === null) {
    return {
      loop: null,
      id,
      label: 'Approve',
      actionable: false,
      // See `cardRelease` — the reason names what is wrong, never a command.
      blockedReason: reason ?? "Flow can't tell which list this item belongs to, so it can't approve it from here.",
    }
  }
  const row = statusRowFor(loops, loop)
  const panel = row === null ? null : approvalFor(row)
  if (panel !== null && panel.actionable && !panel.ids.includes(id)) {
    return {
      loop,
      id,
      label: 'Approve',
      actionable: false,
      blockedReason:
        'This item is not listed as waiting for approval right now — the board and the loop disagree. Refresh and try again.',
    }
  }
  return { loop, id, label: 'Approve', actionable: true, blockedReason: null }
}
