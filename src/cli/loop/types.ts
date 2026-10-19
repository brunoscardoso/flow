/**
 * Type vocabulary for the agent-loop system.
 *
 * A LOOP is a mission plus the state it runs against. Its direction lives in a
 * versioned directive file (`flow/loops/<name>.md`, parsed by
 * directive-parser.ts); whether it may run right now lives in one state file
 * (`flow/loops/state.json`, owned by loop-state.ts). Every other loop module
 * imports its vocabulary from HERE, so no second definition of a queue kind or
 * a verdict can drift into existence.
 *
 * Pure types and constants — no I/O, no clock, no model call. The verbs built
 * on top stay deterministic (the guard-classify precedent): judgment belongs to
 * the agent, invariants belong to the CLI.
 */

// ── directive vocabulary ─────────────────────────────────

/**
 * What a loop DOES with a queue.
 *
 * - `producer` — hunts within its scope slice and FILES findings
 * - `consumer` — claims filed items and drains them (directly, or by advancing
 *   the project's own pipeline one stage per run)
 */
export type LoopEngine = 'producer' | 'consumer';

/** Every engine, for validation and refusal messages. */
export const LOOP_ENGINES: readonly LoopEngine[] = ['producer', 'consumer'];

/** Whether a value is a known engine. */
export function isLoopEngine(value: string): value is LoopEngine {
  return (LOOP_ENGINES as readonly string[]).includes(value);
}

/**
 * Where a loop's queue physically lives. The backends (Phase 2) sit behind one
 * interface; the directive only names which one.
 */
export type LoopQueueKind = 'github' | 'ledger';

/** Every queue kind, for validation and refusal messages. */
export const LOOP_QUEUE_KINDS: readonly LoopQueueKind[] = ['github', 'ledger'];

/** Whether a value is a known queue kind. */
export function isLoopQueueKind(value: string): value is LoopQueueKind {
  return (LOOP_QUEUE_KINDS as readonly string[]).includes(value);
}

/**
 * How a producer chooses what to look at this run.
 *
 * - `changed` — files touched since that loop's last run (the default)
 * - `rotate` — a moving window over the scope, so a quiet repo still gets swept
 * - `full` — the whole scope every run
 */
export type LoopSlice = 'changed' | 'rotate' | 'full';

/** Every slice mode, for validation and refusal messages. */
export const LOOP_SLICES: readonly LoopSlice[] = ['changed', 'rotate', 'full'];

/** Whether a value is a known slice mode. */
export function isLoopSlice(value: string): value is LoopSlice {
  return (LOOP_SLICES as readonly string[]).includes(value);
}

/** Slice used when a directive does not name one. */
export const DEFAULT_LOOP_SLICE: LoopSlice = 'changed';

/**
 * Run budget in minutes when a directive does not name one. A run wraps at
 * the next stage or task boundary once the budget is spent — it never abandons
 * work mid-task.
 */
export const DEFAULT_MAX_RUN_MINUTES = 25;

/**
 * Concurrent runs when a directive does not name one.
 *
 * ONE, so silence means exactly what it has always meant: a loop runs once at a
 * time and a second run is turned away. Concurrency costs a git worktree per
 * slot and is a deliberate choice about a machine's capacity, which is not
 * something to infer from a directive that never mentions it.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1;

/**
 * Ceiling on `max_concurrent_runs`.
 *
 * Each slot is a full checkout on disk and a run's worth of CPU; past a few
 * dozen the bottleneck stops being the loop and starts being the machine. The
 * limit exists to make a typo (`max_concurrent_runs: 500`) a refusal rather
 * than five hundred worktrees — it is a safety backstop, not a working ceiling.
 */
export const MAX_CONCURRENT_RUNS_LIMIT = 25;

/**
 * Open-item cap when a directive does not name one.
 *
 * A default is supplied ON PURPOSE, unlike `mission`: an absent cap would mean
 * an UNCAPPED producer filing unattended, and the safe reading of silence is a
 * conservative bound, not "no bound". A directive that wants a different cap
 * says so; one that says nothing gets the same cap the seed directives use.
 */
export const DEFAULT_MAX_OPEN_ISSUES = 8;

/** Ledger path used when `queue: ledger` and the directive names no `path`. */
export const DEFAULT_LEDGER_PATH = 'flow/loops/queue.jsonl';

/**
 * A parsed, VALIDATED directive — the whole of what a loop is pointed at.
 *
 * Every field here is either present in the file or a documented default;
 * nothing is optional-because-unparsed. `directive-parser.ts` is the only
 * producer of this shape, and it refuses rather than guessing (an unparseable
 * directive must not run with a default mission).
 */
export interface LoopDirective {
  /** Loop name — matches its filename (`flow/loops/<loop>.md`). */
  loop: string;
  /** Which engine runs this loop's runs. */
  engine: LoopEngine;
  /** Directive-level pause — steering by commit, independent of `state.json`. */
  paused: boolean;
  /** What this loop is for, in one line. Required; never defaulted. */
  mission: string;
  /** Paths the loop may work within. Empty means the whole repo. */
  scope: string[];
  /** How a producer chooses what to look at this run. */
  slice: LoopSlice;
  /** Which queue backend holds this loop's items. */
  queue: LoopQueueKind;
  /** `owner/name` — required when `queue: github`. */
  repo?: string;
  /** Ledger file path — set (defaulted) only when `queue: ledger`. */
  path?: string;
  /** Queue label applied to filed items, when the backend has labels. */
  label?: string;
  /**
   * The AREA this loop is pointed at right now — `topic:` in the directive.
   *
   * Distinct from `label`, which is provenance (which machine filed this): a
   * topic answers "where is this loop working", rides onto every item it files,
   * and is re-pointed by a commit like the mission is. Absent when the directive
   * names none, and a directive that names none behaves exactly as before.
   */
  topic?: string;
  /** Cap on simultaneously open items before filing refuses. */
  maxOpenIssues: number;
  /** Run budget in minutes. */
  maxRunMinutes: number;
  /**
   * How many runs of this loop may run at once — one run slot each.
   *
   * DEFAULTS TO 1, which is the behaviour every existing directive already has:
   * a second run is `locked` and stops. Raising it lets a second terminal (or a
   * cron run landing while someone is working interactively) take the next slot
   * and drain the same queue in parallel — safely, because the two exclusions
   * that matter are enforced elsewhere and neither is the loop lock: each slot
   * gets its OWN git worktree, and the queue's per-item claim stops two runs
   * taking the same work.
   *
   * What it does NOT parallelize is the project's pipeline. `flow/` is one vault
   * symlink and `STATE.md` carries no run key, so the single pipeline lock still
   * admits exactly one consumer at a time — a second concurrent run does direct
   * fixes and waits for the machinery.
   */
  maxConcurrentRuns: number;
  /** Whether filed items start behind an approval gate. */
  needsApproval: boolean;
  /** `## Direction` prose, trimmed. Empty when the section is absent. */
  direction: string;
  /** `## Rules` prose, trimmed. Empty when the section is absent. */
  rules: string;
}

// ── gate vocabulary ──────────────────────────────────────

/**
 * The four answers to "may this loop run right now".
 *
 * - `proceed` — nothing blocks it
 * - `skip` — nothing to do this run (a quiet repo is not a broken loop)
 * - `paused` — a global or per-loop pause is in force
 * - `locked` — another run holds the loop lock, or the pipeline lock is taken
 */
export type LoopGateVerdict = 'proceed' | 'skip' | 'paused' | 'locked';

/** Every verdict, for validation and exhaustiveness. */
export const LOOP_GATE_VERDICTS: readonly LoopGateVerdict[] = [
  'proceed',
  'skip',
  'paused',
  'locked',
];

/** Whether a value is a known gate verdict. */
export function isLoopGateVerdict(value: string): value is LoopGateVerdict {
  return (LOOP_GATE_VERDICTS as readonly string[]).includes(value);
}

/**
 * One gate decision: a verdict plus a non-empty human reason. The reason is
 * always populated — including for `proceed` — so a run log line reads the
 * same whichever way the gate went.
 */
export interface LoopGateDecision {
  verdict: LoopGateVerdict;
  /** One line, always non-empty, surfaceable verbatim. */
  reason: string;
}

/**
 * Why a run stopped taking new work — a CLOSED vocabulary, never free text.
 *
 * A run keeps working until one of these holds; "I did one item" is not on the
 * list, which is the whole point (a producer that filed three findings and a
 * consumer that fixed one issue both halted with nothing stopping them). The
 * words are fixed so the run log can be counted rather than read:
 *
 * - `cap` — the queue is as full as its directive allows; there is nowhere to
 *   put another finding
 * - `empty` — nothing left to claim (a quiet queue is not a broken loop)
 * - `budget` — the run's minutes are spent, so no NEW work may be taken
 * - `none` — nothing is stopping this run
 */
export type LoopStopCondition = 'cap' | 'empty' | 'budget' | 'none';

/** Every stop condition, for validation and exhaustiveness. */
export const LOOP_STOP_CONDITIONS: readonly LoopStopCondition[] = [
  'cap',
  'empty',
  'budget',
  'none',
];

/** Whether a value is a known stop condition. */
export function isLoopStopCondition(value: string): value is LoopStopCondition {
  return (LOOP_STOP_CONDITIONS as readonly string[]).includes(value);
}

// ── state vocabulary ─────────────────────────────────────

/**
 * A pause in force. Its PRESENCE is the pause — there is no `paused: false`
 * record, so "not paused" has exactly one representation (absence) and cannot
 * be half-said by a stale flag.
 */
export interface LoopPauseRecord {
  /** Why the pause was set. Always non-empty. */
  reason: string;
  /** ISO timestamp the pause was set at. */
  since: string;
  /**
   * ISO timestamp the pause self-expires at, when it has one. An absent
   * `until` is a pause that holds until someone resumes it; a MALFORMED
   * `until` is treated the same way, because dropping a pause we cannot read
   * would restart loops nobody re-authorized.
   */
  until?: string;
}

/**
 * A held run slot.
 *
 * WHAT THIS IS AFTER PHASE 6, and it is narrower than it was: a git-checkout
 * allocator. It no longer feeds a breaker, sizes a run budget or serializes the
 * project pipeline — all three went with the engine, because Claude Code owns
 * the run's process now. What it still does is hand each concurrent run of a
 * loop a checkout of its own, and NOTHING in Claude Code allocates git
 * worktrees: two runs sharing one working tree race on `git checkout` and the
 * losing one's commits land on someone else's branch (forbidden-pattern #11).
 * That guarantee had no re-homing, so this stayed.
 *
 * The TTL is what keeps a crashed run from wedging its loop's checkout forever.
 */
export interface LoopLockRecord {
  /** Who holds it — the run id, recorded so a release can be checked. */
  owner: string;
  /**
   * Which run slot this lock occupies — 1-based, and 1 is the historical one.
   *
   * THE SLOT IS THE CHECKOUT. A loop may run `max_concurrent_runs` runs at once
   * and each needs a checkout of its own; the slot number is what resolves to
   * that checkout (`loopWorktreePath`), so holding a slot and owning a worktree
   * are the same fact rather than two that have to be kept in agreement.
   *
   * Slot 1 keeps the original path and the original `loop/<name>` branch, so a
   * loop that never runs concurrently behaves exactly as it did.
   */
  slot: number;
  /** ISO timestamp the lock was acquired at. */
  acquiredAt: string;
  /** ISO timestamp the lock stops being held at. */
  expiresAt: string;
  /**
   * What THIS run was aimed at, when a person aimed it (`/run <name> <text>`,
   * `loop next --focus`).
   *
   * IT LIVES ON THE LOCK SO IT CANNOT BE LOST. A person aims a run once, at the
   * gate, and everything after that — `loop file`'s instruction cap, the run's
   * own log line — has to know what it was aimed at. Asking the run to re-type
   * it on every later verb would make the record of hand-steering depend on the
   * run remembering it was steered: prompt convention standing in for an
   * invariant, which is the drift allowed-pattern #14 exists to stop.
   *
   * It NARROWS, never widens: the directive still decides mission, scope, queue
   * and gates. Absent on every run nobody aimed, which is most of them.
   */
  focus?: string;
  /**
   * When THIS run's gate pulled the main checkout, and the branch it pulled.
   *
   * ONE REMOTE ROUND TRIP PER RUN (#1625). A loop worktree is a *linked*
   * worktree: `git rev-parse --git-common-dir` in it points at the main repo's
   * `.git`, so `refs/remotes/origin/*` is the SAME ref store the gate's
   * `git pull --ff-only` just updated. Every `loop worktree` resolve
   * nevertheless re-ran `git fetch origin <base>` inside the worktree — ~1s
   * here, a measured 2.7s on the reporter's machine, all negotiation and zero
   * new objects.
   *
   * THE BRANCH IS PART OF THE FACT. A pull of `main` says nothing about
   * `release/x`, so a resolve whose base differs fetches as it always did —
   * skipping on the strength of the wrong branch is how #1584's guarantee (the
   * checkout a run works in is current) would quietly become untrue.
   *
   * Absent when the pull was skipped (`--no-pull`) or failed, which reads as
   * "nothing was brought current".
   */
  pulled?: { at: string; base: string };
}

/**
 * The longest focus that is still a focus.
 *
 * Long enough for a sentence naming a surface and what to look at; short enough
 * that a whole directive cannot be smuggled onto the command line, which is the
 * shape that would quietly replace the committed mission instead of narrowing
 * it.
 */
export const MAX_FOCUS_LENGTH = 200;

/**
 * Read a person's aim into the one form every surface stores, or `undefined`
 * when they aimed at nothing.
 *
 * Whitespace collapses — a focus arrives as free text off a command line, and
 * newlines in a JSONL log line are the one thing an append-only store cannot
 * survive. Over-length REFUSES rather than truncating: half a sentence is a
 * different instruction from the one that was typed.
 */
/**
 * The tag a focused run files under — its FIRST WORD, and nothing cleverer.
 *
 * A category has to be predictable before it is useful: a person types
 * `/run improve blueprint ui, keep it clean` and must be able to guess, without
 * reading this file, that everything it files is findable under `blueprint`.
 * Any rule that weighed the whole sentence would produce a tag they could not
 * predict and therefore could not search for later — which is the entire point
 * of tagging it.
 *
 * So: first word, slugified, or nothing. "Resuming a category" needs no verb and
 * no store — it is typing the same first word again, or asking the queue for
 * that label.
 */
export function focusTag(focus: string | undefined): string | undefined {
  if (focus === undefined) return undefined;
  const first = focus.trim().split(/\s+/)[0] ?? '';
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // A word that survives as nothing (punctuation, an emoji) is not a category,
  // and a label the queue would reject is worse than no label at all.
  return slug.length === 0 || slug.length > 50 ? undefined : slug;
}

export function normalizeFocus(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_FOCUS_LENGTH) {
    throw new Error(
      `--focus is ${String(value.length)} characters — keep it under ${String(MAX_FOCUS_LENGTH)}; a beat's mission belongs in its directive, not on the command line`,
    );
  }
  return value;
}

/** How a finished run ended — recorded as history, counted by nothing. */
export type LoopRunOutcome = 'success' | 'failure';

/**
 * Per-loop state. A loop with nothing recorded has no entry at all; readers use
 * `loopRecord()` rather than indexing, so absence and zero read the same.
 */
export interface LoopRecord {
  /** Per-loop pause, when one is in force. */
  pause?: LoopPauseRecord;
  /**
   * The slots this loop's running runs hold, one per occupied slot.
   *
   * Read through `liveLocks` / `lockHeldBy` rather than indexed: an EXPIRED lock
   * is still in this list until something rewrites the file, and treating it as
   * held is how a crashed run would wedge its loop's checkout past the TTL.
   */
  locks?: LoopLockRecord[];
  /** How the most recent recorded run ended. */
  lastOutcome?: LoopRunOutcome;
  /** ISO timestamp of the most recent recorded run outcome. */
  lastRunAt?: string;
}

/** Schema version of `flow/loops/state.json`. */
export const LOOP_STATE_VERSION = 1;

/**
 * The whole state store.
 *
 * `globalPause` stops every loop; a per-loop record stops one, remembers how its
 * last run ended, and holds the run slots that decide which checkout each run
 * works in. It no longer answers "is this loop healthy" — the breaker that did
 * went with Phase 6, along with the single pipeline lock.
 */
export interface LoopState {
  version: number;
  /** Pause covering every loop, when one is in force. */
  globalPause?: LoopPauseRecord;
  /** Per-loop records, keyed by loop name. */
  loops: Record<string, LoopRecord>;
}

