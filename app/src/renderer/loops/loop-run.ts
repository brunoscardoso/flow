// The ONE place a "run this loop now" press is turned into something that can
// be performed. DOM-free and IPC-free, like every model beside it: given a
// loop's status row, the whole snapshot and what a person typed into the screen,
// it decides whether the press can succeed, what write has to happen first, what
// message starts the run and what the thread it runs in is called.
//
// WHY THIS EXISTS AT ALL. Every surface the loops have ever had could stop a
// loop, switch a loop and re-point a loop, and none of them could START one — a
// control centre whose only verbs are "off" and "later". The user's own sentence
// looking at the last of them: "a configuration screen, where the user can
// literally for example, give the input of the find before click to run".
//
// A RUN IS A CHAT, WHICH IS THE WHOLE TRICK. There is no "start a run" IPC and
// there must not be one: a loop run IS an agent session — the heartbeat daemon
// runs `/agent-loop <name>` in one (src/cli/daemon/loop-task.ts), and the gate
// (`planflow-ai loop next`) is a step the agent takes INSIDE it, not a way in
// from outside. The app already runs agent sessions in threads, so a run started
// here is a thread created, named, opened and sent the loop's own slash command
// — the same three calls the board's "Start with" field has always made
// (kanban-board.ts `#afterCreate`/`#startTask`). Nothing here spawns a process,
// and nothing here is a second way to start an agent.
//
// THE ARGUMENT IS THE CONTRACT, verbatim from `.claude/commands/agent-loop.md`:
// the FIRST argument is a loop's name and everything after it is a focus for
// THAT ONE RUN, passed to the gate as `--focus`, stamped on the run's lock and
// written onto the run-log line. So the screen's text box is that argument, and
// a run aimed by hand reads back later exactly like one that was not.
//
// ONE RUN AND A STANDING INSTRUCTION ARE DIFFERENT THINGS, and the split is the
// decision this file exists to hold:
//
//   · `/agent-loop <name> <aim>` is ONE RUN. It changes no setting. The gate it
//     opens does start (or carry on) a hunt under that sentence as a side
//     effect, but at whatever cap the store already holds — the command line has
//     no `--cap` and cannot have one.
//   · `loop resume --loop <n> --focus <text> --cap <n>` is the STANDING
//     INSTRUCTION: the sentence a producer keeps filing against and the guard
//     rail it stops at. It is the only verb that can set a cap.
//
// So THE CAP BELONGS TO THE STANDING INSTRUCTION, and Run performs one run. The
// two meet in exactly one place: when the boxes on screen no longer describe the
// hunt the store holds, the standing instruction is written FIRST and the run
// then opens under the same sentence — because a run started against a sentence
// the store has never heard of would file at the CLI's default cap, silently
// ignoring the number the person just typed. When the boxes already match, Run
// writes nothing at all, which is what keeps a hunt at 7 of 20 from being reset
// to 0 by somebody pressing Run to watch it work.

import { MAX_HUNT_TEXT_LENGTH } from './hunt-limits'
// The instruction's identity, exactly as the CLI computes it: `instructionKey`
// in src/cli/loop/instructions.ts collapses whitespace and trims, and
// `startInstruction` normalizes the stored text the same way. Two surfaces
// normalizing differently is precisely how one hunt becomes two, which is why
// this is imported rather than written a second time.
import { normalizeHuntText } from './hunt-instruction'
import { relayed } from '../tasks/board-actions'
import { nextRunKey } from '../../shared/loop-run-key'
import type { LoopInstruction, LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

/** What a person typed into one loop's card before pressing Run. */
export interface LoopRunFields {
  /** What this run should look for, or work through. Empty means "as usual". */
  aim: string
  /**
   * The guard rail, for a loop that hunts — null for one that does not.
   *
   * Null is not "no cap": it is "this loop has no hunt to cap". A consumer works
   * through a list somebody else filled, and a number bounding how much it may
   * ADD to that list would be a setting about a thing it never does.
   */
  cap: number | null
}

/** The standing-instruction write a Run performs first, when it has to. */
export interface LoopRunWrite {
  /** The `--loop`. Never empty: an empty one is the CLI's GLOBAL scope. */
  loop: string
  /** The `--focus`, normalized once, here. */
  focus: string
  /** The `--cap` — the whole reason this write exists. */
  cap: number
}

/** Everything pressing Run performs, in the order it performs it. */
export interface LoopRunPlan {
  loop: string
  /** The standing instruction to write before the run opens, or null. */
  write: LoopRunWrite | null
  /**
   * The thread's first message: the loop's own slash command, exactly as a
   * person would type it.
   *
   * DATA, NOT COPY. It is handed to `threads:sendMessage` and never rendered as
   * a sentence, which is why this file is not part of the hygiene sweep's source
   * scan and why this field is not collected by it.
   */
  message: string
  /**
   * The sentence this run was pointed at, normalized — '' when it has none.
   *
   * CARRIED SO THE RUN CAN BE NAMED AND FOUND AGAIN. It is written onto the
   * run's thread, which is how the board's card for the same hunt finds the
   * conversation it is happening in.
   */
  aim: string
  /** What to call the thread when no key could be minted. Never a command. */
  threadTitle: string
}

/** The Run control on one loop's card. */
export interface LoopRunControl {
  label: string
  actionable: boolean
  /** What pressing it will actually do, in full. */
  title: string
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
  /** What to perform, or null when it cannot be pressed. */
  plan: LoopRunPlan | null
}

/** The words on the press. One place, every caller. */
export const RUN_LABEL = 'Run now'

/** How much of an aim fits in a thread's name before it stops being a name. */
const TITLE_AIM_LIMIT = 60

/**
 * The standing hunt this loop is showing, or null.
 *
 * THE NEWEST ONE, which is the only ordering the store gives us that means
 * anything to a reader: `since` is the instant the sentence was first typed, so
 * the last one typed is the one the person is most likely still thinking about.
 * A loop reports EVERY hunt in the project (the store keys them by text and
 * records no owner), so this is a display choice and is deliberately not
 * described as "this loop's hunt".
 */
export function standingHuntFor(row: LoopStatusRow): LoopInstruction | null {
  const hunts = row.instructions ?? []
  let newest: LoopInstruction | null = null
  for (const hunt of hunts) {
    if (newest === null || Date.parse(hunt.since) > Date.parse(newest.since)) newest = hunt
  }
  return newest
}

/** The hunt the store holds for exactly this sentence, or null. */
export function huntMatching(row: LoopStatusRow, aim: string): LoopInstruction | null {
  const key = normalizeHuntText(aim).toLowerCase()
  if (key.length === 0) return null
  return (row.instructions ?? []).find((hunt) => normalizeHuntText(hunt.text).toLowerCase() === key) ?? null
}

/**
 * Why this loop cannot be started right now, or null.
 *
 * THE GATE'S OWN REFUSALS, ANSWERED BEFORE THE ROUND TRIP. `planflow-ai loop
 * next` is the first thing an `/agent-loop` run does, and it answers anything
 * other than `proceed` by ending the run having changed nothing. Every state
 * below is one of those answers, and offering a live Run for any of them would
 * spend a thread, a session and a person's attention to be told something the
 * snapshot on screen already knew.
 *
 * SO IT REFUSES, AND IT DOES NOT QUIETLY FIX ANYTHING. A Run that turned a
 * switched-off loop on would change a setting that travels with the repo and
 * decides what happens on everybody's machine while nobody is watching — a
 * consequence no button labelled "Run now" can carry. The switch that changes it
 * is one control away on the same card, so the refusal costs a click and never
 * surprises anyone.
 */
export function runBlockedReason(
  row: LoopStatusRow,
  snapshot: LoopsSnapshot,
  fields: LoopRunFields,
): string | null {
  if (row.directivePaused === undefined) {
    return 'Its own settings could not be read, so it cannot be started until that is sorted out.'
  }
  if (row.directivePaused) {
    return `${row.loop} is switched off. Turn it on with the switch beside it and it can be started.`
  }
  if (snapshot.globalPause !== null) {
    return 'Everything is stopped right now. Start everything again and this can run.'
  }
  if (row.pause !== null) {
    const reason = row.pause.reason.trim()
    const stopped = reason.length === 0 ? `${row.loop} is stopped right now` : `${row.loop} is stopped right now — ${reason}`
    return `${stopped}. Start it again and it can run.`
  }
  const aim = normalizeHuntText(fields.aim)
  if (aim.length > MAX_HUNT_TEXT_LENGTH) {
    // The limit, not the flag it belongs to: a reader can shorten a sentence and
    // can do nothing at all with an argument name. Refused here rather than at
    // the gate, which would answer the same thing one spawn later.
    return `That is ${String(aim.length)} characters, longer than the ${String(MAX_HUNT_TEXT_LENGTH)} a single aim can carry. Shorten it.`
  }
  if (fields.cap !== null && (!Number.isInteger(fields.cap) || fields.cap <= 0)) {
    return 'The number of finds to stop after has to be a whole number above zero.'
  }
  return null
}

/**
 * What pressing Run performs, or null when it cannot be pressed.
 *
 * THE WRITE IS COMPUTED, NEVER ASSUMED. It happens when — and only when — the
 * boxes on screen describe a hunt the store does not already hold at that cap,
 * because that is exactly the case where starting the run alone would file under
 * the CLI's default guard rail instead of the person's. Pressing Run twice
 * without touching anything therefore writes once and then never again.
 */
export function planLoopRun(row: LoopStatusRow, fields: LoopRunFields): LoopRunPlan {
  const aim = normalizeHuntText(fields.aim)
  const cap = fields.cap
  const held = huntMatching(row, aim)
  const needsWrite = cap !== null && aim.length > 0 && (held === null || held.cap !== cap)
  return {
    loop: row.loop,
    write: needsWrite && cap !== null ? { loop: row.loop, focus: aim, cap } : null,
    message: aim.length === 0 ? `/agent-loop ${row.loop}` : `/agent-loop ${row.loop} ${aim}`,
    aim,
    threadTitle: threadTitleFor(row.loop, aim),
  }
}

/**
 * What to call the run's thread when it has no key.
 *
 * NAMED AT CREATION, not left to the summarizer. A title supplied to
 * `threads:create` is never clobbered by the auto-titler (it only rewrites the
 * default ones), so the run stays findable in the sidebar from the second it
 * starts — which is the point of running it somewhere a person can watch.
 *
 * THE FALLBACK, NOT THE NAME. A run is normally called by its key — `TOL-001 ·
 * tenant ids` (see `runTitle`) — which needs to know what other runs this
 * project has had, and so cannot be computed by a pure planner. This is what a
 * run is called when that read failed: still short, still findable, just
 * anonymous.
 */
export function threadTitleFor(loop: string, aim: string): string {
  const trimmed = normalizeHuntText(aim)
  if (trimmed.length === 0) return `${loop} run`
  const short =
    trimmed.length <= TITLE_AIM_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_AIM_LIMIT - 1).trimEnd()}…`
  return `${loop} · ${short}`
}

/** The one field of a thread the key mint reads. */
export interface KeyedThread {
  originKey: string | null
}

/**
 * Mint the next run key from EVERY key this project has ever handed out.
 *
 * THE VISIBLE THREAD LIST IS THE WRONG DENOMINATOR (#1708). `nextRunKey`
 * counts from the highest key it is handed, and its contract says a deleted
 * run's thread must not hand its number to the next run — but the screen's
 * own list excludes archived threads, so archiving the highest-numbered run's
 * thread re-minted its number on the next press: two runs answering to one
 * key, run-log lines and origin-key lookups included. The mint therefore reads
 * the archived-inclusive list, fetched fresh at press time.
 *
 * FALLS BACK TO THE VISIBLE LIST when that read fails: a mint that may reuse
 * an archived number beats a press that starts no run at all. A hard-deleted
 * thread's key is still invisible to both lists — closing that residual hole
 * takes a persisted high-water mark deletion cannot lower, which is a store
 * contract of its own, not this fix.
 */
export async function mintRunKey(
  projectName: string,
  listAllThreads: () => Promise<readonly KeyedThread[]>,
  visibleThreads: readonly KeyedThread[],
): Promise<string> {
  const threads = await listAllThreads().catch(() => visibleThreads)
  return nextRunKey(
    projectName,
    threads.map((t) => t.originKey ?? ''),
  )
}

/**
 * The whole consequence of the press, in one sentence.
 *
 * SAID, NOT DISCOVERED. Three things can happen and the label names one, so the
 * other two are spelled out: a chat opens and starts working, a guard rail may
 * be set, and — the one nobody would guess — writing a guard rail over a hunt
 * that already has findings starts its count again at zero. That last is the
 * CLI's deliberate design (`loop resume --focus` stops the instruction and
 * starts it again, which is what "I looked, carry on" means), and it would be
 * alarming to meet unannounced.
 */
export function runConsequence(row: LoopStatusRow, plan: LoopRunPlan, fields: LoopRunFields): string {
  const aim = normalizeHuntText(fields.aim)
  const opening =
    aim.length === 0
      ? `Starts ${row.loop} in a new chat you can watch, doing what it always does.`
      : `Starts ${row.loop} in a new chat you can watch, looking at that first.`
  if (plan.write === null) return opening
  const held = huntMatching(row, aim)
  const restart =
    held !== null && held.filed > 0
      ? ` Its count of ${String(held.filed)} starts again at 0.`
      : ''
  return `${opening} It will stop after ${String(plan.write.cap)} finds so you can look.${restart}`
}

/** The Run control for one loop's card, blocked reason and all. */
export function runControlFor(
  row: LoopStatusRow,
  snapshot: LoopsSnapshot,
  fields: LoopRunFields,
): LoopRunControl {
  const blocked = runBlockedReason(row, snapshot, fields)
  if (blocked !== null) {
    // PRESENT-BUT-DEAD, CARRYING THE REASON — the rule every control on these
    // surfaces follows. An absent Run reads as "this loop cannot be run"; a
    // disabled one with a sentence on it reads as what it is.
    return { label: RUN_LABEL, actionable: false, title: blocked, blockedReason: blocked, plan: null }
  }
  const plan = planLoopRun(row, fields)
  return {
    label: RUN_LABEL,
    actionable: true,
    title: runConsequence(row, plan, fields),
    blockedReason: null,
    plan,
  }
}

/**
 * What to say when a run could not be started, and why.
 *
 * THROUGH THE GUARD, NOT JUST THE CLEANER — the rule the modal's refusal text
 * already followed. `forReader` collapses the path a failure names and drops the
 * vocabulary after it, but relaying another process's prose is a bet that every
 * sentence it can produce is fit for a GUI, and the CLI loses that bet often
 * enough (`point requires --queue <github|ledger>`) that the cleaned line is
 * CHECKED and dropped for our own when it still carries an invocation. The raw
 * text goes to the console at the call site, which is where flags are useful.
 */
export function runStartError(loop: string, detail: string | null): string {
  const why = relayed(detail, '')
  const base = `Couldn’t start ${loop}`
  return why.length === 0 ? `${base}.` : `${base} — ${why}`
}

/** What to say when the guard rail could not be written, so nothing was started. */
export function runWriteError(loop: string, detail: string | null): string {
  const why = relayed(detail, '')
  const base = `Couldn’t set what ${loop} should look for, so nothing was started`
  return why.length === 0 ? `${base}.` : `${base} — ${why}`
}
