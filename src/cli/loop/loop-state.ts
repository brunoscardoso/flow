/**
 * The loop state store — `flow/loops/state.json`.
 *
 * One file answers "is this loop stopped right now": global and per-loop pauses,
 * plus how the last recorded run ended. Every invariant lives HERE, in code, so
 * no prompt has to restate it (allowed-pattern #14).
 *
 * WHAT PHASE 6 TOOK OUT OF IT: the consecutive-failure breaker, the run
 * budget's start stamp, and the single pipeline lock. Claude Code owns the run's
 * process now (`claude --bg`), so what is running is `claude agents`' answer and
 * a claim whose run has died is named by `stuck-claims.ts`. What stayed is the
 * run-slot allocator — see the slots section for why a checkout allocator had
 * nowhere else to go.
 *
 * THIS LOCK GUARDS ONE MACHINE AGAINST ITSELF, AND NOTHING MORE. `flow/` is a
 * per-machine symlink into each engineer's own vault, so nothing written here is
 * visible to anyone else: five engineers running five agents hold five separate
 * pauses and slots that cannot see one another. What stops two of them working the same
 * task is the claim on the QUEUE — the assignee and the `in-progress` label,
 * re-read after writing (`queue-backend.ts`, `claimHeld`). Do not add a fact
 * here that other people need to see; it will be invisible to them.
 *
 * The same applies to a pause: it stops the loops on THIS machine. A pause the
 * whole team must respect belongs in the committed directive.
 *
 * PURE CORE, THIN I/O. The transforms (`withLoopPause`, `withRunOutcome`, …)
 * take a state value and a `now` in epoch milliseconds
 * and return a NEW state; they never touch the clock or the filesystem. That is
 * what makes TTL expiry provable without sleeping, and what keeps two readers of
 * the same state from disagreeing about time.
 *
 * WRITES ARE ATOMIC AND UNIQUELY NAMED. A fixed `.tmp` sibling caused a live
 * ENOENT storm in this repo when two writers raced — one renamed the temp file
 * out from under the other. The temp name carries the pid AND a per-process
 * counter, and is unlinked on failure, so concurrent writers never share a name
 * and a crashed write never leaves a partial `state.json` behind.
 *
 * READS REFUSE RATHER THAN FORGET. A missing file is an empty store — a project
 * that has never beaten. But corrupt JSON, an unknown version or a malformed
 * record THROWS, because the fail-soft alternative silently reports "nothing is
 * paused" and restarts loops nobody re-authorized.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock, type FileLockLimits } from './file-lock.js';
import { LOOPS_DIRNAME } from './directive-parser.js';
import { DEFAULT_MAX_CONCURRENT_RUNS, LOOP_STATE_VERSION } from './types.js';
import type {
  LoopRunOutcome,
  LoopLockRecord,
  LoopPauseRecord,
  LoopRecord,
  LoopState,
} from './types.js';

/** Filename of the state store inside `<flowDir>/loops/`. */
export const LOOP_STATE_FILENAME = 'state.json';

/** Absolute path of the loop state file for a flow directory. */
export function loopStatePath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, LOOP_STATE_FILENAME);
}

/** A store with nothing recorded — what a project that has never beaten has. */
export function emptyLoopState(): LoopState {
  return { version: LOOP_STATE_VERSION, loops: {} };
}

/**
 * One loop's record, defaulted. Absence and "nothing has happened yet" read the
 * same, so no caller has to distinguish a missing key from a zero counter.
 */
export function loopRecord(state: LoopState, loop: string): LoopRecord {
  return state.loops[loop] ?? {};
}

/** Replace one loop's record, leaving every other loop untouched. */
function withLoopRecord(state: LoopState, loop: string, record: LoopRecord): LoopState {
  return { ...state, loops: { ...state.loops, [loop]: record } };
}

// ── serialization (deterministic) ────────────────────────
//
// Fixed key order, loops sorted by name, no clock: the same state always
// serializes to byte-identical output, so a write that changes nothing produces
// no diff and a state file stays reviewable in git history.

function orderPause(pause: LoopPauseRecord): LoopPauseRecord {
  const ordered: LoopPauseRecord = { reason: pause.reason, since: pause.since };
  if (pause.until !== undefined) ordered.until = pause.until;
  return ordered;
}

function orderLock(lock: LoopLockRecord): LoopLockRecord {
  const ordered: LoopLockRecord = {
    owner: lock.owner,
    slot: lock.slot,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
  };
  // The aim MUST round-trip. Every verb after the gate runs in its own process
  // and reads the lock back off disk; a focus dropped here exists only inside
  // the process that set it, so the cap it feeds could never fire and the run's
  // log line would say the run was aimed at nothing.
  if (lock.focus !== undefined) ordered.focus = lock.focus;
  // The PULL MUST ROUND-TRIP for the same reason, and it is the whole mechanism
  // (#1625): the gate stamps it in one process and `loop worktree` reads it back
  // in another.
  if (lock.pulled !== undefined) ordered.pulled = lock.pulled;
  return ordered;
}

function orderRecord(record: LoopRecord): LoopRecord {
  const ordered: LoopRecord = {};
  if (record.pause !== undefined) ordered.pause = orderPause(record.pause);
  // Ordered by slot so the file is byte-stable for the same held set — a state
  // file that reshuffles on every write is one nobody can diff.
  if (record.locks !== undefined && record.locks.length > 0) {
    ordered.locks = [...record.locks].sort((a, b) => a.slot - b.slot).map(orderLock);
  }
  if (record.lastOutcome !== undefined) ordered.lastOutcome = record.lastOutcome;
  if (record.lastRunAt !== undefined) ordered.lastRunAt = record.lastRunAt;
  return ordered;
}

/** Serialize state deterministically — 2-space JSON with a trailing newline. */
export function serializeLoopState(state: LoopState): string {
  const ordered: Record<string, unknown> = { version: LOOP_STATE_VERSION };
  if (state.globalPause !== undefined) ordered.globalPause = orderPause(state.globalPause);
  const loops: Record<string, LoopRecord> = {};
  for (const name of Object.keys(state.loops).sort()) {
    loops[name] = orderRecord(state.loops[name]);
  }
  ordered.loops = loops;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ── parsing (strict) ─────────────────────────────────────

/** Throw a refusal naming the state file. */
function refuse(source: string, reason: string): never {
  throw new Error(`${source}: ${reason}`);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty ISO-parseable timestamp string. */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function parsePause(raw: unknown, source: string, where: string): LoopPauseRecord {
  if (!isRecordObject(raw)) refuse(source, `malformed pause for ${where}`);
  if (typeof raw.reason !== 'string' || raw.reason.length === 0) {
    refuse(source, `pause for ${where} has no reason`);
  }
  if (!isTimestamp(raw.since)) {
    refuse(source, `pause for ${where} has a malformed 'since'`);
  }
  const pause: LoopPauseRecord = { reason: raw.reason, since: raw.since };
  // A malformed `until` is kept as-is rather than refused: `effectivePause`
  // reads an unparseable expiry as "no expiry", which holds the pause. Dropping
  // it here would be the one failure mode a pause must not have.
  if (typeof raw.until === 'string' && raw.until.length > 0) pause.until = raw.until;
  return pause;
}

function parseLock(raw: unknown, source: string, where: string): LoopLockRecord {
  if (!isRecordObject(raw)) refuse(source, `malformed lock for ${where}`);
  if (typeof raw.owner !== 'string' || raw.owner.length === 0) {
    refuse(source, `lock for ${where} has no owner`);
  }
  if (!isTimestamp(raw.acquiredAt) || !isTimestamp(raw.expiresAt)) {
    refuse(source, `lock for ${where} has malformed timestamps`);
  }
  // A LOCK WRITTEN BEFORE SLOTS EXISTED IS SLOT 1. That is not a guess: there
  // was exactly one lock per loop and exactly one worktree for it to mean, and
  // slot 1 still resolves to that same checkout.
  const slot = raw.slot === undefined ? 1 : raw.slot;
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1) {
    refuse(source, `lock for ${where} has a malformed slot`);
  }
  const lock: LoopLockRecord = {
    owner: raw.owner,
    slot,
    acquiredAt: raw.acquiredAt,
    expiresAt: raw.expiresAt,
  };
  if (typeof raw.focus === 'string' && raw.focus.length > 0) lock.focus = raw.focus;
  // BOTH HALVES OR NEITHER. A stamp naming a time but no branch cannot say
  // whether it covers the base a resolve is asking about, and a resolve that
  // guessed would skip a fetch it owed (#1584's guarantee, quietly untrue).
  const pulled = raw.pulled;
  if (
    isRecordObject(pulled) &&
    typeof pulled.at === 'string' &&
    pulled.at.length > 0 &&
    typeof pulled.base === 'string' &&
    pulled.base.length > 0
  ) {
    lock.pulled = { at: pulled.at, base: pulled.base };
  }
  return lock;
}

function parseRecord(raw: unknown, source: string, loop: string): LoopRecord {
  if (!isRecordObject(raw)) refuse(source, `malformed record for loop '${loop}'`);
  // `consecutiveFailures` IS READ AND DISCARDED. Phase 6 deleted the breaker it
  // counted for; a state file written by an older CLI still carries the number,
  // and refusing it would make this CLI unable to read its own history.
  const record: LoopRecord = {};
  if (raw.pause !== undefined) record.pause = parsePause(raw.pause, source, `loop '${loop}'`);
  // BOTH SHAPES READ. `lock` is what every state file written before slots
  // carries, and a machine that rolls back to an older CLI must still find its
  // loop's checkout taken rather than free. `locks` wins when both are present.
  if (Array.isArray(raw.locks)) {
    const locks = raw.locks.map((entry) => parseLock(entry, source, `loop '${loop}'`));
    const slots = new Set(locks.map((entry) => entry.slot));
    if (slots.size !== locks.length) {
      refuse(source, `loop '${loop}' has two locks on one slot`);
    }
    if (locks.length > 0) record.locks = locks;
  } else if (raw.locks !== undefined) {
    refuse(source, `loop '${loop}' has a malformed locks list`);
  } else if (raw.lock !== undefined) {
    record.locks = [parseLock(raw.lock, source, `loop '${loop}'`)];
  }
  if (raw.lastOutcome === 'success' || raw.lastOutcome === 'failure') {
    record.lastOutcome = raw.lastOutcome;
  } else if (raw.lastOutcome !== undefined) {
    refuse(source, `loop '${loop}' has an unknown lastOutcome '${String(raw.lastOutcome)}'`);
  }
  if (raw.lastRunAt !== undefined) {
    if (!isTimestamp(raw.lastRunAt)) refuse(source, `loop '${loop}' has a malformed lastRunAt`);
    record.lastRunAt = raw.lastRunAt;
  }
  return record;
}

/**
 * Parse state file content strictly. Corrupt JSON, an unknown version or any
 * malformed record throws — see the module header on why this one store does
 * not fail soft.
 */
export function parseLoopState(content: string, source = 'state.json'): LoopState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    refuse(source, 'unreadable state — invalid JSON');
  }
  if (!isRecordObject(parsed)) {
    refuse(source, 'unreadable state — expected a JSON object');
  }
  if (parsed.version !== LOOP_STATE_VERSION) {
    refuse(
      source,
      `unsupported state version '${String(parsed.version)}' — expected ${LOOP_STATE_VERSION}`,
    );
  }
  const state: LoopState = emptyLoopState();
  if (parsed.globalPause !== undefined) {
    state.globalPause = parsePause(parsed.globalPause, source, 'all loops');
  }
  if (parsed.loops !== undefined) {
    if (!isRecordObject(parsed.loops)) refuse(source, "'loops' is not an object");
    for (const loop of Object.keys(parsed.loops)) {
      state.loops[loop] = parseRecord(parsed.loops[loop], source, loop);
    }
  }
  return state;
}

// ── file I/O (atomic, uniquely named) ────────────────────

/**
 * Write a file atomically — THE one implementation, in utils/atomic-write.ts.
 *
 * It also explains why the plain rename this used to do could not write here at
 * all while the Flow IDE was open: on Windows, renaming over a path another
 * process holds open fails with EPERM.
 */
const atomicWrite = atomicWriteFile;

// ── inter-process mutual exclusion (#1662) ───────────────
//
// `atomicWrite` prevents torn files, NOT lost updates: two processes that each
// read → transform → write still finish with whichever write landed last, and
// the other's slot or pause silently erased. Two runs of one loop overlap by
// design (`max_concurrent_runs`), and a terminal `/agent-loop` overlaps them
// too, so concurrent verbs are the normal case, not the rare one. This advisory
// file lock makes the whole read→transform→write cycle exclusive between
// processes; it guards ONE MACHINE against itself, exactly like the store it
// protects (see the module header).

/** A live critical section is milliseconds; a lock this old belongs to a dead process. */
const STATE_LOCK_LIMITS: FileLockLimits = { staleMs: 10_000, waitMs: 10_000, retryMs: 25 };

/**
 * Run `fn` holding the store's advisory inter-process lock — `withFileLock`
 * over `state.json.lock`. Re-entrant within a process (a verb that already
 * holds the lock may call `mutateLoopState`); a stale lock is taken over, so a
 * crashed verb cannot wedge every later one; waiting out `STATE_LOCK_LIMITS`
 * throws rather than proceeding unguarded.
 */
export function withLoopStateLock<T>(flowDir: string, fn: () => T): T {
  return withFileLock(`${loopStatePath(flowDir)}.lock`, STATE_LOCK_LIMITS, fn);
}

/**
 * Read the state store, applying expiry (`now`) so a caller never sees a pause
 * that has already run out. A missing file yields an empty store; a corrupt one
 * throws.
 */
export function readLoopState(flowDir: string, now: number = Date.now()): LoopState {
  const filePath = loopStatePath(flowDir);
  if (!existsSync(filePath)) return emptyLoopState();
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`${filePath}: unreadable (${(error as Error).message})`);
  }
  if (content.trim().length === 0) return emptyLoopState();
  return expireLoopState(parseLoopState(content, filePath), now);
}

/** Write the state store atomically, creating `flow/loops/` when absent. */
export function writeLoopState(flowDir: string, state: LoopState): void {
  atomicWrite(loopStatePath(flowDir), serializeLoopState(state));
}

/**
 * Read → transform → write in one call, holding the inter-process lock across
 * all three (#1662) — the read another process's write lands between is fresh
 * again on the next acquire, so no verb overwrites a pause it never saw. The
 * transform is the pure half; this is the only place a mutation touches disk,
 * so every write goes through the same atomic path. Returns the state as
 * written.
 */
export function mutateLoopState(
  flowDir: string,
  transform: (state: LoopState, now: number) => LoopState,
  now: number = Date.now(),
): LoopState {
  return withLoopStateLock(flowDir, () => {
    const next = transform(readLoopState(flowDir, now), now);
    writeLoopState(flowDir, next);
    return next;
  });
}

// ── time helpers ─────────────────────────────────────────

/** Epoch milliseconds → the ISO form stored on disk. */
export function toIso(now: number): string {
  return new Date(now).toISOString();
}

/**
 * An ISO timestamp → epoch milliseconds, or null when it cannot be read.
 * Unreadable is NEVER "in the past": an expiry nobody can parse must not expire
 * the thing it guards.
 */
function fromIso(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── pause (global and per-loop, self-expiring) ───────────
//
// A pause's PRESENCE is the pause, and an `until` self-expires ON READ so a
// forgotten temporary pause does not stop the loops forever. Expiry is
// evaluated against the injected `now`, never `Date.now()` inside the logic.

/** What a caller supplies when setting a pause. */
export interface PauseInput {
  /** Why — always recorded, and surfaced wherever the pause is reported. */
  reason: string;
  /** Optional epoch-ms expiry. Absent means "until someone resumes it". */
  until?: number;
}

/** Build a pause record from an input and the current clock. */
function makePause(input: PauseInput, now: number): LoopPauseRecord {
  const pause: LoopPauseRecord = { reason: input.reason, since: toIso(now) };
  if (input.until !== undefined) pause.until = toIso(input.until);
  return pause;
}

/**
 * Whether a pause has run out. An absent or unparseable `until` is NOT expired
 * — the pause holds, which is the safe direction for a gate nobody is watching.
 */
export function isPauseExpired(pause: LoopPauseRecord, now: number): boolean {
  const until = fromIso(pause.until);
  return until !== null && until <= now;
}

/** Whether a lock has run out. An unparseable `expiresAt` counts as expired. */
export function isLockExpired(lock: LoopLockRecord, now: number): boolean {
  const expiresAt = fromIso(lock.expiresAt);
  // A lock whose expiry cannot be read is treated as EXPIRED — the opposite of
  // the pause rule, and for the same reason: the safe direction for a lock is
  // releasing it, because a lock that can never expire wedges its loop forever.
  return expiresAt === null || expiresAt <= now;
}

/**
 * Drop every pause and lock that has run out, as of `now`. Applied on read, so
 * no caller ever sees an expired record and no caller has to remember to check.
 */
export function expireLoopState(state: LoopState, now: number): LoopState {
  const next: LoopState = { version: LOOP_STATE_VERSION, loops: {} };
  if (state.globalPause !== undefined && !isPauseExpired(state.globalPause, now)) {
    next.globalPause = state.globalPause;
  }
  for (const [loop, record] of Object.entries(state.loops)) {
    const kept: LoopRecord = {};
    if (record.pause !== undefined && !isPauseExpired(record.pause, now)) kept.pause = record.pause;
    const live = (record.locks ?? []).filter((lock) => !isLockExpired(lock, now));
    if (live.length > 0) kept.locks = live;
    if (record.lastOutcome !== undefined) kept.lastOutcome = record.lastOutcome;
    if (record.lastRunAt !== undefined) kept.lastRunAt = record.lastRunAt;
    next.loops[loop] = kept;
  }
  return next;
}

/** Set the global pause — every loop stops until it is cleared or expires. */
export function withGlobalPause(state: LoopState, input: PauseInput, now: number): LoopState {
  return { ...state, globalPause: makePause(input, now) };
}

/** Clear the global pause. A no-op when none is set. */
export function withoutGlobalPause(state: LoopState): LoopState {
  const next = { ...state };
  delete next.globalPause;
  return next;
}

/** Set one loop's pause. */
export function withLoopPause(
  state: LoopState,
  loop: string,
  input: PauseInput,
  now: number,
): LoopState {
  return withLoopRecord(state, loop, { ...loopRecord(state, loop), pause: makePause(input, now) });
}

/** Clear one loop's pause. A no-op when none is set. */
export function withoutLoopPause(state: LoopState, loop: string): LoopState {
  const record = { ...loopRecord(state, loop) };
  delete record.pause;
  return withLoopRecord(state, loop, record);
}

/** Which pause is stopping a loop — the global one takes precedence. */
export interface EffectivePause {
  /** `global` stops every loop; `loop` stops only this one. */
  scope: 'global' | 'loop';
  record: LoopPauseRecord;
}

/**
 * The pause in force for a loop as of `now`, or null when it may run.
 *
 * Expired pauses are skipped here as well as in `expireLoopState`, so this
 * answer is correct even when handed a state value that was never read through
 * the store (a test fixture, an IPC payload).
 */
export function effectivePause(
  state: LoopState,
  loop: string,
  now: number,
): EffectivePause | null {
  if (state.globalPause !== undefined && !isPauseExpired(state.globalPause, now)) {
    return { scope: 'global', record: state.globalPause };
  }
  const pause = loopRecord(state, loop).pause;
  if (pause !== undefined && !isPauseExpired(pause, now)) {
    return { scope: 'loop', record: pause };
  }
  return null;
}

// ── run slots (a checkout allocator, not a scheduler) ────
//
// WHAT SURVIVED PHASE 6, AND WHY. Every other lock in this file went: the
// breaker's counter, the run budget's start stamp, and the single pipeline lock
// that serialized `/discovery-plan → /create-plan → /execute-plan`. All three
// answered questions Claude Code now answers — what is running, how long it has
// run, and whether it is still alive (`claude agents`, `stuck-claims.ts`).
//
// This one answers a question Claude Code does not: WHICH GIT CHECKOUT a run
// works in. A loop may run `max_concurrent_runs` runs at once and each needs a
// worktree of its own — two runs sharing one tree race on `git checkout` and the
// losing one's commits land on someone else's branch (forbidden-pattern #11,
// observed live in this repo twice). Nothing in a background-agent runtime
// allocates git worktrees, so this allocator had nowhere to be re-homed to and
// stayed. It grants a slot and nothing else: no failure counting, no budget, no
// gate on the project's pipeline.
//
// The TTL is how a crashed run's checkout comes back: an expired lock is not
// held, so a run that died without releasing cannot wedge its loop forever.

/** The outcome of a lock attempt: the (possibly unchanged) state plus who holds it. */
export interface LockAttempt {
  /** State to persist. Unchanged when the attempt failed. */
  state: LoopState;
  /** Whether the caller now holds the lock. */
  acquired: boolean;
  /** The lock as it stands — the caller's when acquired, the incumbent's when not. */
  lock: LoopLockRecord;
}

function makeLock(
  owner: string,
  slot: number,
  ttlMs: number,
  now: number,
  focus?: string,
): LoopLockRecord {
  return {
    owner,
    slot,
    acquiredAt: toIso(now),
    expiresAt: toIso(now + ttlMs),
    ...(focus === undefined ? {} : { focus }),
  };
}

/**
 * The locks a loop actually holds right now, lowest slot first.
 *
 * EXPIRY IS EVALUATED ON READ, not on write. A run that crashed leaves its lock
 * in the file until something rewrites it, so "what is in the list" and "what is
 * held" are different questions and only this one is ever asked.
 */
export function liveLocks(state: LoopState, loop: string, now: number): LoopLockRecord[] {
  return (loopRecord(state, loop).locks ?? [])
    .filter((lock) => !isLockExpired(lock, now))
    .sort((a, b) => a.slot - b.slot);
}

/** The live lock `owner` holds on this loop, when it holds one. */
export function lockHeldBy(
  state: LoopState,
  loop: string,
  owner: string,
  now: number,
): LoopLockRecord | undefined {
  return liveLocks(state, loop, now).find((lock) => lock.owner === owner);
}

/**
 * The lock that answers "is this loop running, and who is holding it", for a
 * caller that is not itself holding one.
 *
 * The OLDEST live lock, because that is the run closest to wrapping up and so
 * the one a person waiting on this loop is waiting for. With a single slot this
 * is the only lock there is, which is what it has always reported.
 */
export function oldestLock(
  state: LoopState,
  loop: string,
  now: number,
): LoopLockRecord | undefined {
  return liveLocks(state, loop, now).sort(
    (a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt),
  )[0];
}

/**
 * The lowest unoccupied slot, or null when every slot is taken.
 *
 * LOWEST RATHER THAN NEXT: slot 1 is the original worktree and the original
 * `loop/<name>` branch, so a loop that usually runs alone keeps landing in the
 * same checkout instead of drifting up through slot numbers as runs come and
 * go. Only genuine concurrency ever reaches slot 2.
 */
export function freeSlot(
  state: LoopState,
  loop: string,
  now: number,
  maxConcurrentRuns: number,
): number | null {
  const taken = new Set(liveLocks(state, loop, now).map((lock) => lock.slot));
  for (let slot = 1; slot <= Math.max(1, maxConcurrentRuns); slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/** Replace a loop's lock list, dropping the key entirely when nothing is held. */
function withLocks(state: LoopState, loop: string, locks: LoopLockRecord[]): LoopState {
  const record = { ...loopRecord(state, loop) };
  if (locks.length === 0) delete record.locks;
  else record.locks = [...locks].sort((a, b) => a.slot - b.slot);
  return withLoopRecord(state, loop, record);
}

/**
 * Attempt to take a loop's lock.
 *
 * A live lock held by someone else refuses. A live lock held by the SAME owner
 * is re-entrant and extends the TTL — a run that re-enters the gate must not
 * deadlock against itself. An expired lock is taken over, which is the whole
 * point of the TTL.
 *
 * A RE-ENTRANT ACQUIRE KEEPS THE ORIGINAL `acquiredAt`. The stamp answers "when
 * did this run start", which every surface reporting the run reads; re-entering
 * the gate does not restart the run. Only `expiresAt` moves, which is all the
 * TTL extension ever meant.
 */
export function acquireLoopLock(
  state: LoopState,
  loop: string,
  owner: string,
  ttlMs: number,
  now: number,
  focus?: string,
  maxConcurrentRuns: number = DEFAULT_MAX_CONCURRENT_RUNS,
): LockAttempt {
  const live = liveLocks(state, loop, now);
  const held = live.find((lock) => lock.owner === owner);

  // RE-ENTRY IS BY OWNER, AND IT KEEPS THE SLOT. A run re-opening the gate
  // after a checkpoint must land back in the checkout it left work in, so the
  // slot it already holds is the one it gets — never the lowest free one.
  if (held !== undefined) {
    // A RE-ENTRY KEEPS THE AIM IT WAS GIVEN. A run re-opens the gate mid-run
    // without repeating the words a person typed once, and a re-entry that
    // silently dropped the focus would leave the run-log line saying the run
    // was aimed at nothing. A NEW focus still wins — re-aiming is a deliberate
    // act, and it is recorded as the aim the run actually ended on.
    const lock = {
      ...makeLock(owner, held.slot, ttlMs, now, focus ?? held.focus),
      acquiredAt: held.acquiredAt,
    };
    const rest = live.filter((entry) => entry.owner !== owner);
    return { state: withLocks(state, loop, [...rest, lock]), acquired: true, lock };
  }

  const slot = freeSlot(state, loop, now, maxConcurrentRuns);
  if (slot === null) {
    // EVERY SLOT TAKEN. The incumbent reported is the oldest — the run a person
    // waiting on this loop will see finish first.
    return { state, acquired: false, lock: live[0] as LoopLockRecord };
  }
  const lock = makeLock(owner, slot, ttlMs, now, focus);
  return { state: withLocks(state, loop, [...live, lock]), acquired: true, lock };
}

/**
 * Release a loop's locks. When `owner` is given, only that run's lock goes and
 * a lock held by someone ELSE is left alone — a run may only release its own,
 * so a late finisher cannot unlock the run that took over from it. Without an
 * owner every slot is cleared, which is what a person resetting a loop means.
 *
 * EXPIRED LOCKS ARE NOT PRUNED HERE. `acquireLoopLock` rebuilds the list from
 * the LIVE ones, so a dead run's record is dropped the next time any run takes
 * a slot; doing it here too would need a clock this function has never taken,
 * and every reader evaluates expiry anyway.
 */
export function releaseLoopLock(state: LoopState, loop: string, owner?: string): LoopState {
  const existing = loopRecord(state, loop).locks;
  if (existing === undefined || existing.length === 0) return state;
  const kept = owner === undefined ? [] : existing.filter((lock) => lock.owner !== owner);
  if (kept.length === existing.length) return state;
  return withLocks(state, loop, kept);
}

// ── run outcome (history, not a breaker) ─────────────────

/**
 * Record how a run ended.
 *
 * WHAT IT NO LONGER DOES: count. This used to be `recordRunOutcome`, and its
 * real job was feeding the breaker's consecutive-failure counter — the thing
 * that stopped a loop the unattended scheduler kept re-running. That scheduler
 * is gone (Phase 5 removed the daemon's loop task), so counting failures now
 * protects nobody, and a counter that trips nothing is worse than none: it
 * still has to be reset, explained and kept true.
 *
 * The two facts a person actually reads off `loop status` — how the last run
 * ended and when — stay, because `loop log --record` still writes them and the
 * Loops panel still renders them.
 */
export function withRunOutcome(
  state: LoopState,
  loop: string,
  outcome: LoopRunOutcome,
  now: number,
): LoopState {
  return withLoopRecord(state, loop, {
    ...loopRecord(state, loop),
    lastOutcome: outcome,
    lastRunAt: toIso(now),
  });
}

// ── the awaiting-approval policy ─────────────────────────
//
// RELOCATED HERE IN PHASE 6, from the deleted `pipeline-state.ts`. Escalation is
// a PAUSE — it writes the same per-loop record `loop pause` writes — so it
// belongs beside the pause transforms rather than in a module about stages. The
// stage annotation went with the pipeline: nothing supervises a run's stage any
// more, and a label derived from a supervisor that no longer exists would be a
// sentence the file could no longer stand behind.

/** The reason word every awaiting-approval pause carries. */
export const AWAITING_APPROVAL = 'awaiting-approval';

/** The one line an escalated run is paused and reported with. */
export function escalationReason(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length === 0 ? AWAITING_APPROVAL : `${AWAITING_APPROVAL} — ${trimmed}`;
}

/**
 * Pause a loop for a human decision — an autopilot high-risk pause, or a
 * guarded-autopilot escalation.
 *
 * A HUMAN GATE IS NOT A FAILURE. It sets a pause and touches nothing else; the
 * claimed item stays claimed, because releasing it would hand a half-finished
 * piece of work to whoever started the next run while a person was still
 * looking at it.
 */
export function applyEscalation(
  state: LoopState,
  loop: string,
  detail: string,
  now: number,
): LoopState {
  return withLoopPause(state, loop, { reason: escalationReason(detail) }, now);
}

/** The prompt body an escalation writes, in the heartbeat prompt's own shape. */
export function escalationPromptTail(loop: string, detail: string): string {
  return [
    `loop: ${loop}`,
    `reason: ${detail.trim().length === 0 ? AWAITING_APPROVAL : detail.trim()}`,
    '',
    'The loop is paused and its item stays claimed. Approve or redirect the work,',
    `then resume with: planflow-ai loop resume --loop ${loop} --detail "<why>"`,
  ].join('\n');
}
