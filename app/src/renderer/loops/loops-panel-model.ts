// Pure model for the agent-loops panel (agent-loops, Phase 7). DOM-free and
// IPC-free: given a LoopsSnapshot and a clock, it produces the rows the panel
// draws — dot state, one detail line, one control — plus the rolled-up digest
// line. Every decision the panel makes lives HERE; the render layer only
// appends elements.
//
// THE PANEL IS A VIEW, and this file is where that stops being a slogan:
//
//  - Nothing is computed that the CLI did not report. No loop's state is
//    inferred from a previous render, no count is derived by subtracting one
//    field from another, and a fact the snapshot does not carry is shown as
//    unknown rather than guessed (an unreadable queue is "queue unreadable",
//    never "0 open").
//  - Every control names the scope the CLI will actually act on. A loop stopped
//    by the GLOBAL pause resumes globally, because a per-loop resume would only
//    lift that loop's own pause and leave the global pause standing — a button
//    that looks like it worked and did nothing.
//  - A loop paused in its DIRECTIVE FILE gets its OWN control, addressing its
//    own scope. That pause is versioned intent rather than state.json, and it
//    used to have no control at all: the panel showed a dead button reading
//    "edit the directive to resume", which handed the reader a file to open in
//    an app whose whole job is to do that for them (forbidden pattern #12).
//    The CLI now has a verb that rewrites the directive's own pause, so the
//    control is real — and it is a SEPARATE control on a SEPARATE scope,
//    because a directive pause and a runtime pause are two different facts and
//    one press must never quietly clear both.
//
// COLOUR: the dot reuses the board's state vocabulary (idle / active / paused)
// and AMBER IS RESERVED — `attention` is true only for items awaiting approval,
// the state that wants a human. Everything else is the resting palette.

import type { LoopDigest, LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

/** The dot vocabulary, shared with the board's module cards. */
export type LoopDotState = 'idle' | 'active' | 'paused'

/**
 * WHICH PAUSE a control writes — the one distinction this whole file turns on.
 *
 * `runtime` is state.json: "stopped for now", set by anyone, lifted by a resume,
 * gone when the reason expires. `directive` is the loop's own committed intent:
 * it travels with the repo and no resume touches it.
 *
 * They are two facts, so they are two writes and two channels. A control that
 * lifted both at once would let one press undo a decision somebody deliberately
 * committed, in the same motion that cleared a five-minute stop.
 */
export type LoopControlScope = 'runtime' | 'directive'

/** What a row's button does, and to what. */
export interface LoopControl {
  action: 'pause' | 'resume'
  /** Button label (also its accessible name). */
  label: string
  /** The glyph the design sheet specifies: ⏸ to stop, ▶ to start. */
  glyph: string
  /**
   * The `--loop` the CLI call must carry. Empty string means the GLOBAL scope —
   * the CLI's own reading of a missing `--loop`, and the only thing that lifts
   * a global pause. A `directive`-scope control is never empty: there is no
   * project-wide directive to switch.
   */
  loop: string
  /** Which of the two pauses this press writes. Decides the channel. */
  scope: LoopControlScope
  /** True when no CLI write can change this state. */
  disabled: boolean
  /** Why it is disabled, or null. Shown as the button's title. */
  disabledReason: string | null
}

/**
 * The approve affordance for a row that has items waiting on a human.
 *
 * `actionable` is false when the snapshot reports a COUNT but no ids — today's
 * `loop status` does exactly that, and `loop approve` needs an `--id`. The
 * affordance still renders, because "2 items are waiting for you" is the thing
 * the reader needs to know; it just says where to go instead of offering a
 * button that cannot name its target. The app will not open the queue itself to
 * find the ids: that would be a second reader of the store, which is the one
 * thing this panel is not allowed to become.
 */
export interface LoopApproval {
  count: number
  label: string
  /** The ids `loop approve --id` would be called with, in the CLI's order. */
  ids: string[]
  actionable: boolean
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
}

/** One rendered row. */
export interface LoopRow {
  loop: string
  /**
   * The area the loop is pointed at right now, or null when its directive names
   * none — `find [codemap]`, the same bracket `loop status --human` prints.
   *
   * Taken STRAIGHT off the snapshot's `topic`. The panel does not read the
   * directive, does not fall back to the engine, and does not invent a word for
   * a loop that never chose one: a loop with no topic renders as its name
   * alone, exactly as it did before topics existed.
   */
  topic: string | null
  dot: LoopDotState
  /** Amber: an item waiting on a human. Nothing else. */
  attention: boolean
  /** The directive's mission line, or null. Used as the row's title. */
  mission: string | null
  /** The single stage word: hunting / working / paused / idle. */
  stage: string
  /** The whole second line — stage, queue, approvals, age — ' · '-joined. */
  detail: string
  control: LoopControl
  /** The approve affordance, or null when nothing is waiting on a human. */
  approval: LoopApproval | null
  /**
   * The CLI's own fail-soft reason for this loop, verbatim, or null. A row that
   * could not read its directive or its queue is still a row — the loop exists
   * and the reader has to see that it is broken, not that it is missing.
   */
  error: string | null
}

// The panel's own whole-panel model (`LoopsViewModel` / `buildLoopsViewModel`)
// is GONE with the panel. The screen builds its cards from `buildRow` and
// `digestLineFor` below — the parts that were always about a loop rather than
// about the panel's layout — and nothing else read the rest.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Coarse relative age. Deliberately one unit: this line is scanned, not read,
 * and "4m ago" answers the only question it is asked ("is this thing alive?").
 * Returns null for a missing or unparseable timestamp — absent stays absent.
 */
export function relativeAge(iso: string | undefined, now: number): string | null {
  if (iso === undefined || iso.length === 0) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const delta = now - then
  if (delta < MINUTE_MS) return 'just now'
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`
  return `${Math.floor(delta / DAY_MS)}d ago`
}

/** The slots still held at `now`. An expired lock is not a live run. */
export function heldSlots(row: LoopStatusRow, now: number): number {
  return (row.locks ?? []).filter((lock) => {
    const expires = Date.parse(lock.expiresAt)
    // An unparseable expiry is treated as held: the CLI wrote the lock, and
    // guessing it away would paint a running run as idle.
    return Number.isNaN(expires) || expires > now
  }).length
}

/** Whether any run is live. */
function lockHeld(row: LoopStatusRow, now: number): boolean {
  return heldSlots(row, now) > 0
}

/**
 * The dot, in precedence order. A pause outranks a live lock because the lock is
 * the beat that is finishing.
 *
 * THERE IS NO `tripped` ANY MORE. It came first here, off the consecutive-
 * failure breaker, and the breaker went with the supervision layer
 * (loops-native-runtime, Phase 6): nothing counts failures, so nothing can trip.
 * A branch that can never be true is a colour the panel promises and can never
 * paint.
 */
export function dotStateFor(row: LoopStatusRow, now: number): LoopDotState {
  if (row.pause !== null || row.directivePaused === true) return 'paused'
  if (lockHeld(row, now)) return 'active'
  return 'idle'
}

/** The stage word. `hunting` vs `working` is whether an item is in hand. */
function stageFor(row: LoopStatusRow, dot: LoopDotState, now: number): string {
  if (dot === 'paused') {
    const reason = row.pause?.reason.trim() ?? ''
    if (reason.length > 0) return `paused — ${reason}`
    // "Switched off" rather than a word about where the pause is written: the
    // reader is told what is true of the loop, not which store holds it.
    return row.directivePaused === true ? 'switched off' : 'paused'
  }
  if (dot === 'active') {
    const word = (row.queue?.claimed ?? 0) > 0 ? 'working' : 'hunting'
    // TWO RUNS LOOK EXACTLY LIKE ONE WITHOUT THIS. A loop with
    // `max_concurrent_runs` above 1 can have several slots in flight, each in
    // its own checkout, and "working" alone cannot tell a person whether the
    // loop is at capacity or has room for the next beat.
    const slots = heldSlots(row, now)
    return slots > 1 ? `${word} ×${String(slots)}` : word
  }
  return 'idle'
}

/** The `N/M open` segment, or the honest admission that nobody could read it. */
function queueSegment(row: LoopStatusRow): string | null {
  if (row.queue === null) return row.queueError === undefined ? null : 'queue unreadable'
  const { open, maxOpenIssues, capReached } = row.queue
  const base = maxOpenIssues > 0 ? `${open}/${maxOpenIssues} open` : `${open} open`
  return capReached ? `${base} (cap)` : base
}

/** `needs approval ×2`, or null. One of the two things allowed to go amber. */
function approvalSegment(row: LoopStatusRow): string | null {
  const waiting = row.queue?.awaitingApproval ?? 0
  return waiting > 0 ? `needs approval ×${waiting}` : null
}

/**
 * The control that switches one loop in its DIRECTIVE — its committed answer to
 * "should this loop run at all", never its "not right now".
 *
 * ITS OWN SCOPE, ON PURPOSE. Pressing it writes the directive's pause and
 * nothing else: a loop that is also stopped in state.json stays stopped, and a
 * loop nobody stopped stays running. The two facts are reported separately
 * everywhere they are shown, precisely so this press cannot be mistaken for
 * clearing both.
 */
export function directiveControlFor(row: LoopStatusRow): LoopControl {
  const off = row.directivePaused === true
  return {
    action: off ? 'resume' : 'pause',
    // The words of a switch, not of a stopwatch: this is the setting a person
    // changes once and leaves, and "Pause" would read as the five-minute kind.
    label: off ? `Turn on ${row.loop}` : `Turn off ${row.loop}`,
    glyph: off ? '▶' : '⏸',
    loop: row.loop,
    scope: 'directive',
    disabled: false,
    disabledReason: null,
  }
}

/** The control, and the scope it must address to actually do anything. */
export function controlFor(row: LoopStatusRow): LoopControl {
  // A loop switched off in its DIRECTIVE and stopped by nothing else: the only
  // press that changes anything is the directive's own, so that is the control
  // this row gets. It used to be a dead button carrying the file to edit.
  if (row.directivePaused === true && row.pause === null) {
    return directiveControlFor(row)
  }
  if (row.pause !== null) {
    const global = row.pause.scope === 'global'
    return {
      action: 'resume',
      label: global ? 'Resume all loops' : 'Resume',
      glyph: '▶',
      // Global scope, or the CLI lifts this loop's own pause and leaves the
      // project-wide pause exactly where it was.
      loop: global ? '' : row.loop,
      scope: 'runtime',
      disabled: false,
      disabledReason: null,
    }
  }
  return {
    action: 'pause',
    label: 'Pause',
    glyph: '⏸',
    loop: row.loop,
    scope: 'runtime',
    disabled: false,
    disabledReason: null,
  }
}

/** The approve affordance, or null when nothing is gated. */
export function approvalFor(row: LoopStatusRow): LoopApproval | null {
  const count = row.queue?.awaitingApproval ?? 0
  if (count === 0) return null
  const ids = row.awaitingApprovalIds ?? []
  return {
    count,
    label: count === 1 ? 'Approve 1 item' : `Approve ${count} items`,
    ids,
    actionable: ids.length > 0,
    blockedReason:
      ids.length > 0
        ? null
        : // NO COMMAND IN A SENTENCE A PERSON READS. This says what the reader
          // can see and act on — the count is known, the items are not — rather
          // than handing them a terminal invocation to finish the job by hand.
          `${count === 1 ? 'This item is' : 'These items are'} waiting for approval, but the loop did not name ${count === 1 ? 'it' : 'them'} — open the item on its list to approve.`,
  }
}

/** Build one row. */
export function buildRow(row: LoopStatusRow, now: number): LoopRow {
  const dot = dotStateFor(row, now)
  const approvals = approvalSegment(row)
  // ONE STAGE WORD, TWO READERS. The row's `stage` field and the first segment
  // of `detail` are the same sentence, so they are the same computation — a
  // second `stageFor` call re-walks the lock list (`heldSlots` parses every
  // expiry) for an answer already in hand, and leaves two sites to edit when
  // the wording changes (#1627).
  const stage = stageFor(row, dot, now)
  const segments = [
    stage,
    queueSegment(row),
    approvals,
    relativeAge(row.lastRunAt, now),
  ].filter((segment): segment is string => segment !== null && segment.length > 0)

  // VERBATIM, and only one: two reasons on one line is a paragraph, and the
  // directive failing to parse is why the queue could not be read anyway.
  const error = row.directiveError ?? row.queueError ?? null

  return {
    loop: row.loop,
    topic: row.topic !== undefined && row.topic.trim().length > 0 ? row.topic.trim() : null,
    dot,
    // The only two amber states, per the design sheet.
    attention: approvals !== null,
    mission: row.mission !== undefined && row.mission.trim().length > 0 ? row.mission.trim() : null,
    stage,
    detail: segments.join(' · '),
    control: controlFor(row),
    approval: approvalFor(row),
    error,
  }
}

/** `last 8h` / `last 45m` / `last 3d` — the window the digest actually covers. */
export function digestWindowLabel(digest: LoopDigest): string {
  const since = digest.since === undefined ? Number.NaN : Date.parse(digest.since)
  const until = digest.until === undefined ? Number.NaN : Date.parse(digest.until)
  if (Number.isNaN(since) || Number.isNaN(until) || until < since) return 'so far'
  const span = until - since
  if (span < HOUR_MS) return `last ${Math.max(1, Math.round(span / MINUTE_MS))}m`
  if (span < DAY_MS) return `last ${Math.max(1, Math.round(span / HOUR_MS))}h`
  return `last ${Math.max(1, Math.round(span / DAY_MS))}d`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * The roll-up under the rows: `last 8h: 6 filed · 4 fixed · 1 breaker trip`.
 *
 * `breaker trip` IS HISTORY, and the only breaker word left on this screen. The
 * breaker itself is gone; the append-only run log still holds the trips that
 * really happened, and a segment at zero is dropped, so a project that never
 * tripped one never sees the word.
 *
 * The window is the digest's OWN since→until span, not a fixed "8h" — the CLI
 * rolls up whatever the beat log holds, and printing a window it did not
 * measure would be a caption that contradicts its own numbers.
 *
 * A zero segment is dropped, because a line of zeros says less than a shorter
 * line. All-zero (or no entries at all) yields null and the panel omits it.
 */
export function digestLineFor(digest: LoopDigest | null): string | null {
  if (digest === null || digest.entries === 0) return null
  const parts: string[] = []
  if (digest.filed > 0) parts.push(`${digest.filed} filed`)
  if (digest.closed > 0) parts.push(`${digest.closed} fixed`)
  if (digest.breakerTrips > 0) parts.push(plural(digest.breakerTrips, 'breaker trip'))
  if (digest.approvals > 0) parts.push(plural(digest.approvals, 'approval'))
  if (parts.length === 0) return null
  return `${digestWindowLabel(digest)}: ${parts.join(' · ')}`
}

// ── The board's header strip (loops-on-the-board, Phase 7, Task 7.3) ─────
//
// The panel shrank to this, and then to less. Everything a loop's ROW used to
// say now lives on the board — the queue is Todo, the gate is Blocked, the hunt
// is a card in Doing — and everything about a loop's LIFE now lives on the
// Loops screen: whether it is on, whether everything is stopped, what it is
// looking for, and the press that starts one.
//
// SO THE STRIP IS ONE THING NOW, not a row of them. It used to spell its state
// out across the header as loose parts — a bare "▶ Resume all", then the
// sentence "All loops paused — …", then the word "Loops" — three controls'
// worth of visual weight for one subject, reading as a control panel bolted to
// the top of a board about TASKS.
//
// They are one press-shaped card instead: a glyph, the name, the live state
// under it, and the project switch at its trailing edge. Same facts, same
// single write, one object — and a person who wants more than "is it running"
// opens the screen, which is what the card is for.
//
// THE CONTROL IS THE SCREEN'S OWN SWITCH, not a runtime pause of its own
// (loops-pause-all-unify): `control` is built by `projectSwitchFor`, the exact
// function the Loops screen's "Turn them all off"/"Turn them all on" already
// used — a directive write, one `setDirectivePaused` call per reachable loop,
// the committed fact a headless run and a person both read the same way. A
// board press and a screen press now write the identical thing.
//
// The per-loop switches are NOT here and never come back. They said something
// true — "resuming above will not start it" — in a vocabulary the reader has no
// reason to own; the screen has room to explain the consequence instead.

/** The cycle log, relative to the project root — where the runs are written. */
export const CYCLE_LOG_RELPATH = 'flow/loops/runs.jsonl'

/** The one way into the loops screen, from the strip. */
export interface LoopsStripOpen {
  /** Button label (also its accessible name). */
  label: string
  /** What pressing it is for — never a file, a key or a command. */
  title: string
}

/** What the one card above the board's columns shows. */
export interface LoopsStrip {
  /** The press that opens the screen — the card's body. */
  open: LoopsStripOpen
  /**
   * The line under the name: what the loops are doing right now, in a sentence
   * a person who has never met a loop can still read.
   */
  state: string
  /** The pause-all / resume-all press. Now a directive write, like `projectSwitchFor`. */
  control: ProjectSwitch
  /** One-line fail-soft notice (no CLI, a refusal, a timeout), or null. */
  notice: string | null
}

/**
 * The words on the press that opens the loops screen. One place, both call sites.
 *
 * WHAT IT OPENS CHANGED AND SO DID THIS SENTENCE. It used to promise a modal
 * that explained and switched; the screen behind it can also START a loop, and a
 * way in that does not say so leaves the one thing people asked for undiscovered
 * behind a button they read as "settings".
 */
export const LOOPS_OPEN: LoopsStripOpen = {
  label: 'Loops',
  title: 'See what the loops are, change what they look for, and start one now',
}

/**
 * How many loops nothing is currently stopping.
 *
 * "RUNNING" MEANS "NOT STOPPED", not "has a run in flight this second". A loop
 * spends most of its life between beats, and a card that reported only the loops
 * holding a lock right now would read `0 of 2 running` on a perfectly healthy
 * project — a control disagreeing with the thing it controls. So the count
 * answers "how many of these will pick work up on their own", which is the
 * question a person glancing at a board is asking.
 *
 * THREE STATES, NOT TWO, exactly as the screen's cards read them:
 * `directivePaused` is ABSENT when the settings could not be read at all, and
 * such a loop cannot run — the CLI's own gate throws long before it reaches the
 * pause check. `!== true` would have folded that into "running", which is the
 * one thing certainly false about it.
 */
export function runningCountFor(snapshot: LoopsSnapshot): number {
  return snapshot.loops.filter(
    (row) => row.directivePaused === false && row.pause === null,
  ).length
}

/**
 * The card's second line.
 *
 * THE GLOBAL PAUSE OUTRANKS THE COUNT, and cannot be shown beside it: a
 * project-wide stop would be buried by "1 of 2 running" and CONTRADICTED by it,
 * since a globally paused project has loops that are switched on and going
 * nowhere. One sentence, and it is the one that decides what happens next.
 */
export function stateLineFor(snapshot: LoopsSnapshot): string {
  const pause = snapshot.globalPause
  if (pause !== null) {
    const reason = pause.reason.trim()
    return reason.length === 0 ? 'All paused' : `All paused — ${reason}`
  }
  const total = snapshot.loops.length
  if (total === 0) return 'No loops in this project yet'
  const running = runningCountFor(snapshot)
  if (running === 0) return `None of the ${total} are running`
  return `${running} of ${total} running`
}

/**
 * The card, from one snapshot. Pure: same snapshot always renders identically.
 *
 * A SNAPSHOT NOBODY HAS STILL GETS A CARD — present, its press dead, carrying
 * the reason. The panel's rule: a control that cannot succeed says so instead of
 * disappearing, because an absent control reads as "this project has no loops"
 * and an unreadable one is not that. The door stays too: the screen is where a
 * reader finds out what went wrong and what a loop even is.
 */
export function buildLoopsStrip(snapshot: LoopsSnapshot | null): LoopsStrip {
  if (snapshot === null || !snapshot.available) {
    const reason = snapshot?.reason ?? 'loops unavailable'
    return {
      open: LOOPS_OPEN,
      state: "Couldn't read the loops here",
      control: {
        action: 'pause',
        label: 'Turn them all off',
        glyph: '⏸',
        loop: '',
        scope: 'directive',
        disabled: true,
        disabledReason: reason,
        loops: [],
      },
      notice: reason,
    }
  }
  return {
    open: LOOPS_OPEN,
    state: stateLineFor(snapshot),
    control: projectSwitchFor(snapshot),
    notice: null,
  }
}

// ── The project-wide switch ───────────────────────────────────────────────
//
// Moved here from loops-screen-model.ts (Phase 1, loops-pause-all-unify): the
// board's own global control needs the exact same reachable-loops computation
// the Loops screen already had, and allowed-pattern #14 says that computation
// lives in one place, not two. loops-screen-model.ts re-exports both names so
// its existing importers keep resolving without edits.

/**
 * The label on the press that switches every loop at once, and what it writes.
 *
 * A DIRECTIVE WRITE, LIKE THE PER-LOOP SWITCH BESIDE IT — the screen used to
 * carry a runtime pause here ("Pause all"), which wrote a separate store that
 * only this app and the CLI's scheduler could see: a person stopped the loops
 * in one place and the file they are committed in went on saying they were
 * running. One fact, one file, one press — so a person and an agent change it
 * the same way, and a checkout carries the answer.
 */
export interface ProjectSwitch extends LoopControl {
  /** The loops the press writes, in the order it writes them. */
  loops: string[]
}

/** The switch over every loop this project has. */
export function projectSwitchFor(snapshot: LoopsSnapshot): ProjectSwitch {
  // A loop nothing could read is a loop no write can reach, so it is not one of
  // the loops this press claims to switch.
  const reachable = snapshot.loops.filter((row) => row.directivePaused !== undefined)
  const anyOff = reachable.some((row) => row.directivePaused === true)
  const loops = reachable
    .filter((row) => (anyOff ? row.directivePaused === true : row.directivePaused === false))
    .map((row) => row.loop)
  return {
    action: anyOff ? 'resume' : 'pause',
    label: anyOff ? 'Turn them all on' : 'Turn them all off',
    glyph: anyOff ? '▶' : '⏸',
    // Empty because this control is not addressed to ONE loop; `loops` is what
    // the press actually writes, and the view reads that rather than this.
    loop: '',
    scope: 'directive',
    disabled: loops.length === 0,
    disabledReason:
      loops.length === 0 ? 'There is nothing here Flow can switch on or off.' : null,
    loops,
  }
}

/**
 * What pressing the project switch actually does, in plain language — the
 * hover text for BOTH controls that write it (the board strip and the Loops
 * screen), one place per allowed-pattern #14.
 *
 * NAMES THE CONSEQUENCE, NEVER THE MECHANISM (allowed-pattern #12): no
 * `setDirectivePaused`, no `--loop`, no file path. What a person needs to know
 * before pressing is that this is the committed answer — the one a headless
 * run and a teammate's checkout both read — not a five-minute stop.
 */
export function switchConsequenceFor(action: 'pause' | 'resume'): string {
  return action === 'pause'
    ? 'Switches every loop off in its committed file — every machine and every run sees this.'
    : 'Switches every loop on in its committed file — every machine and every run sees this.'
}

/**
 * The write orchestration a global switch performs — sequential, one
 * `setDirectivePaused` call per loop, caught per write, nothing rolled back.
 *
 * THE SAME SHAPE `#switchEveryLoop` HAS ALWAYS HAD, extracted so both the
 * Loops screen and the board's strip call it instead of each keeping its own
 * copy of the loop (allowed-pattern #14). The write function is INJECTED
 * rather than reached for on `window.flow` directly, so this is testable
 * without a DOM or an IPC mock — the caller shapes its own
 * `setDirectivePaused` (and its own IPC-error formatting) into this signature.
 *
 * NOTHING IS ROLLED BACK. A rejection on loop three leaves loops one and two
 * switched — undoing them would be a write nobody asked for, against a file
 * the loop itself may already have read.
 */
export async function switchLoops(
  loops: string[],
  paused: boolean,
  deps: {
    setDirectivePaused: (args: {
      loop: string
      paused: boolean
    }) => Promise<{ ok: boolean; reason?: string | null }>
  },
): Promise<{ refused: string[] }> {
  const refused: string[] = []
  for (const loop of loops) {
    // Caught per write: one rejection must neither stop the loop nor silently
    // abandon the writes still queued behind it.
    const result = await deps
      .setDirectivePaused({ loop, paused })
      .catch((error: unknown): { ok: boolean; reason?: string | null } => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
    if (!result.ok) refused.push(loop)
  }
  return { refused }
}

/**
 * Whether a poll tick may spend anything (#1640). A tick that fires while the
 * window is hidden or the loops pane is display:none'd spawns a CLI process and
 * two `gh` API round trips per loop to paint pixels nobody can see — from app
 * launch to quit, that was ~720 GitHub requests an hour from an idle IDE. The
 * rule lives here, DOM-free, so it is pinned by a test: poll only what someone
 * can actually see. The wake-up refresh on becoming visible is the view's job.
 */
export function shouldPollLoops(state: { documentHidden: boolean; paneVisible: boolean }): boolean {
  return !state.documentHidden && state.paneVisible
}

// ── THE LOOP ──────────────────────────────────────────────────────────────
//
// One loop, two states, one button. In the user's own words: "we will not have
// that kind of 'run two loops'. The fixed loop will be start and stop."
//
// WHAT CHANGED AND WHY IT IS SMALLER NOW. The board's control used to be "turn
// them all on / off" — a project-wide switch over every loop of every kind,
// which is a sentence about the SYSTEM rather than about anything a person
// wants. And it had to be project-wide, because the other kind of loop (the one
// that hunts) was also a standing switch somebody had to remember. Hunts are
// created with the work that prompts them now (hunt-config.ts) and end by their
// own rule, so there is exactly one standing loop left: the one that works
// through the list. That is "the loop", and it has two states.
//
// STOPPING ITSELF IS THE POINT. "If there are no issues in the to-do anymore or
// in doing, the loop will stop." The gate does that (`loop next
// --stop-when-empty`) by writing a STATE pause, so the reason it stopped is
// readable and a press of play lifts it — see `loopBarFor`'s two-store note.

/** Which loop is "the loop", or why there is not one. */
export type TheLoop =
  | { ok: true; row: LoopStatusRow }
  | { ok: false; reason: string }

/**
 * The one standing loop: the consumer that works through this project's list.
 *
 * SEVERAL CONSUMERS IS NOT A QUESTION THE BOARD ASKS. Unlike a hunt — where the
 * person creating the work is the one who knows which producer should look — a
 * project with two drainers has a configuration question, and the board's one
 * button cannot mean two things. It names the ambiguity and sends the reader to
 * the screen where loops are configured.
 */
export function theLoopIn(snapshot: LoopsSnapshot): TheLoop {
  const consumers = snapshot.loops.filter(
    (row) => row.engine === 'consumer' && row.directiveError === undefined,
  )
  const first = consumers[0]
  if (consumers.length === 1 && first !== undefined) return { ok: true, row: first }
  if (consumers.length === 0) return { ok: false, reason: 'No loop in this project yet' }
  return { ok: false, reason: 'More than one loop works this list — open Loops to pick' }
}

/** Everything stopping the loop right now, in the order a press has to clear it. */
export interface LoopBar {
  /** The name on the status press. */
  label: string
  /** What it is doing, in a sentence a person who has never met a loop can read. */
  state: string
  /** True when a press should START it; false when a press should STOP it. */
  start: boolean
  /** The loop the press writes. Empty when there is nothing to write. */
  loop: string
  /** True when its `paused:` line says off — a press has to clear that too. */
  directivePaused: boolean
  /** True when a state pause is in force — the gate's own switch-off, or a person's. */
  statePaused: boolean
  disabled: boolean
  /** Why it cannot be pressed, or null. */
  disabledReason: string | null
  /** What pressing it will do, for the tooltip. Never a command. */
  title: string
}

/**
 * The board's loop control, from one snapshot. Pure.
 *
 * TWO STORES, ONE BUTTON, and this is the whole subtlety. A loop can be stopped
 * two ways: its committed `paused:` line (the team's intent, in git) and a state
 * pause (this machine, right now). The gate's automatic switch-off writes the
 * SECOND, deliberately — a machine must not commit — and the seeded directives
 * ship with the FIRST set. So a press of play has to clear whichever of them is
 * in force, and a press of stop writes only the state pause: stopping for the
 * afternoon should not turn up in `git log`.
 *
 * `state` says WHICH, because "off" and "off because it finished" are different
 * facts and only the second means the work is done.
 */
export function loopBarFor(snapshot: LoopsSnapshot | null): LoopBar {
  const off = (reason: string, state = "Couldn't read the loop here"): LoopBar => ({
    label: 'Loop',
    state,
    start: true,
    loop: '',
    directivePaused: false,
    statePaused: false,
    disabled: true,
    disabledReason: reason,
    title: reason,
  })
  if (snapshot === null || !snapshot.available) {
    return off(snapshot?.reason ?? 'loops unavailable')
  }
  const found = theLoopIn(snapshot)
  if (!found.ok) return off(found.reason, found.reason)

  const row = found.row
  const directivePaused = row.directivePaused === true
  const statePaused = row.pause !== null
  const globalPause = snapshot.globalPause
  const stopped = directivePaused || statePaused || globalPause !== null
  // The state pause carries the reason the gate wrote — "nothing left in the
  // list" — and that sentence is the most useful thing on this whole row, so it
  // outranks the plain "Off".
  const pauseReason = (row.pause?.reason ?? '').trim()
  const state = globalPause !== null
    ? 'Off — everything is paused'
    : !stopped
      ? 'Running'
      : pauseReason.length > 0
        ? `Off — ${pauseReason}`
        : 'Off'
  return {
    label: 'Loop',
    state,
    start: stopped,
    loop: row.loop,
    directivePaused,
    statePaused,
    disabled: globalPause !== null,
    disabledReason:
      globalPause === null ? null : 'Every loop in this project is paused — open Loops to lift it',
    title: stopped
      ? 'Start the loop — it works through the list until there is nothing left, then stops'
      : 'Stop the loop — it finishes what it is on and takes nothing new',
  }
}
