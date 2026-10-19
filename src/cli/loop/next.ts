/**
 * The gate that opens every run — the pure half of `loop next`.
 *
 * A run asks one question ("may I run, and on what?") and gets one answer, so
 * the run prompt never has to be told to check a pause or a cap: by the time it
 * reads this verdict, both have already been checked in code (allowed-pattern
 * #14).
 *
 * WHAT PHASE 6 TOOK OUT OF IT. This gate used to also count the breaker's
 * failures, size a run budget and hold the pipeline's single lock — three
 * answers to "is this loop healthy, and should it still be running". None of
 * them is ours to give any more: a run is a Claude Code background agent, so
 * `claude agents` says what is running, `stuck-claims.ts` says whose claim
 * belongs to a run that died, and the agent's own session ends the run.
 *
 * PURE, AND THAT IS THE POINT. `evaluateNext` is a function of (directive,
 * state, queue snapshot, pull note, owner, clock) and nothing else — no
 * filesystem, no network, no model call (the guard-classify precedent). Identical
 * inputs therefore produce a byte-identical result, which is exactly what the
 * determinism test asserts. Every side effect — the pull, the queue read — lives
 * in `commands/loop.ts`.
 *
 * THE ORDER OF THE CHECKS IS THE CONTRACT:
 *
 *   1. the directive's own `paused: true` — steering by commit outranks
 *      everything, because it is the one signal that survives a lost state file
 *   2. the machine-local pause (`loop pause`, global or per-loop)
 *   3. the queue's shape — a producer at its cap and a consumer with nothing
 *      claimable both `skip`; a quiet repo is not a broken loop
 *   4. only then a run slot is taken, and the verdict is `proceed`
 *
 * A `skip` OR A PAUSE TAKES NO SLOT AND WRITES NO STATE. Asking whether you may
 * run must never be the thing that changes the answer for whoever asks next.
 *
 * THE SLOT IS NOT A SCHEDULER. It hands this run a git checkout nobody else is
 * using — see `loop-state.ts`'s slots section for why that one allocator
 * outlived the engine around it.
 */

import { acquireLoopLock, effectivePause, lockHeldBy, liveLocks, oldestLock } from './loop-state.js';
import { capRefusal } from './queue-backend.js';
import type { QueueCounts } from './queue-backend.js';
import type {
  LoopDirective,
  LoopGateVerdict,
  LoopLockRecord,
  LoopQueueKind,
  LoopState,
  LoopStopCondition,
} from './types.js';

/** Margin added to a loop's slot TTL beyond its nominal run length. */
export const LOCK_TTL_MARGIN_MINUTES = 5;

/**
 * A loop's slot TTL: its nominal run length plus a margin for wrap-up.
 *
 * `max_run_minutes` NO LONGER ENFORCES ANYTHING (Phase 6 deleted the run
 * budget) — the run lives in a Claude Code session and that session's end is the
 * end. It survives as the one honest input to this: how long a checkout should
 * stay reserved before a run that died stops holding it.
 */
export function lockTtlMs(maxRunMinutes: number): number {
  return (maxRunMinutes + LOCK_TTL_MARGIN_MINUTES) * 60 * 1000;
}

/**
 * What the `git pull` at the top of a run did.
 *
 * A failed pull NEVER aborts the run — a network hiccup must not silence a
 * loop — but it is always recorded, because work done on a stale checkout is
 * the kind of thing whose explanation has to still be there in the morning.
 */
export interface PullNote {
  /** Whether a pull was attempted at all (`--no-pull` sets this false). */
  attempted: boolean;
  /** Whether it succeeded. False when it was not attempted. */
  ok: boolean;
  /** One line: why it was skipped, or what it failed with. Empty on success. */
  note: string;
}

/** A pull that was deliberately not attempted. */
export function skippedPull(reason: string): PullNote {
  return { attempted: false, ok: false, note: reason };
}

/** The queue snapshot the gate reasons over. */
export interface QueueSnapshot {
  kind: LoopQueueKind;
  /** Where it lives — a repo-relative ledger path, or `owner/name`. */
  location: string;
  counts: QueueCounts;
  /** Fingerprints already known for this loop, open AND closed. */
  fingerprints: string[];
}

/** Everything `evaluateNext` reads. */
export interface NextInput {
  directive: LoopDirective;
  state: LoopState;
  queue: QueueSnapshot;
  pull: PullNote;
  /** Who this run is — carried onto everything the run then does. */
  owner: string;
  /**
   * What a person aimed THIS run at, already normalized. Echoed back in the
   * result so the run can see what it was aimed at.
   */
  focus?: string;
  /** Epoch milliseconds. Injected, never read from the clock in here. */
  now: number;
}

/** The queue half of the verdict, as the run sees it. */
export interface NextQueueReport {
  kind: LoopQueueKind;
  location: string;
  open: number;
  closed: number;
  claimed: number;
  awaitingApproval: number;
  parked: number;
  claimable: number;
  maxOpenIssues: number;
  /** Whether filing is refused right now. */
  capReached: boolean;
}

/** The single JSON verdict a run opens with. */
export interface NextResult {
  verdict: LoopGateVerdict;
  /** One line, always non-empty — printable verbatim in a log or a panel. */
  reason: string;
  loop: string;
  engine: string;
  mission: string;
  /** `## Direction` prose, verbatim. Empty when the directive has none. */
  direction: string;
  /** `## Rules` prose, verbatim. Empty when the directive has none. */
  rules: string;
  slice: string;
  scope: string[];
  /**
   * The run id every later verb in this run carries — and EMPTY on any gated
   * verdict, because a gated run is not a run and nothing should be recorded
   * under its name (#1575).
   */
  owner: string;
  /** What this run was aimed at, when a person aimed it. Empty otherwise. */
  focus: string;
  /**
   * HOW THE STANDING HUNT ENDS, in one sentence — empty when this run has no
   * hunt behind it.
   *
   * REPORTED RATHER THAN ENFORCED, for the one rule the CLI cannot decide. The
   * backstop and the clock are arithmetic and `loop file` refuses on both; a
   * `custom` rule is a sentence somebody wrote, and only the agent reading this
   * line can judge whether it has come true. When it has, the run says so with
   * `loop finish --rule-met` — which is why the rule has to reach the run as
   * prose, and why this field exists at all.
   */
  huntStop: string;
  maxRunMinutes: number;
  /**
   * ISO instant this gate opened the run. Empty on a gated verdict.
   *
   * IT IS THE GATE'S OWN CLOCK NOW, not a lock's `acquiredAt` — there is no
   * lock. `max_run_minutes` is reported beside it and enforced by nothing here:
   * the run lives in a Claude Code session, and that session's end is the end.
   */
  runStartedAt: string;
  /**
   * What is stopping this run, from the closed vocabulary — `none` when
   * nothing is. A run keeps working until this says otherwise; it is what a
   * run reports back on its own record, so "why did it stop" can be counted
   * rather than read.
   */
  stopCondition: LoopStopCondition;
  /** The slot this run holds, or null when it took none. */
  lock: LoopLockRecord | null;
  queue: NextQueueReport;
  /** Known fingerprints for this loop, sorted — the dedup memory, handed over. */
  fingerprints: string[];
  pull: PullNote;
  generatedAt: string;
}

/** The verdict plus the state to persist (only when a slot was taken). */
export interface NextEvaluation {
  result: NextResult;
  /** State as it should be written. Identical to the input when unchanged. */
  state: LoopState;
  /** Whether `state` differs from the input and must be persisted. */
  stateChanged: boolean;
}

/**
 * The queue report, built once and shared by every verdict branch.
 *
 * `capReached` IS A PRODUCER'S FACT ONLY (#1585). `counts.open` changes meaning
 * by engine — `scopeQuery` deliberately drops the loop filter for a consumer,
 * because "a consumer's queue is the queue" — so comparing it against
 * `max_open_issues` asks the wrong question for a consumer: the cap counts the
 * loop's OWN open items, and a consumer files none. Reported unfiltered it read
 * `28/20 · capReached: true` for a loop that had filed nothing and could not be
 * blocked. `queueStop` below already applies the cap only to a producer; this is
 * the same rule at the reporting seam, which was the one consumer of the widened
 * number.
 */
function queueReport(
  queue: QueueSnapshot,
  maxOpenIssues: number,
  engine: LoopDirective['engine'],
): NextQueueReport {
  return {
    kind: queue.kind,
    location: queue.location,
    open: queue.counts.open,
    closed: queue.counts.closed,
    claimed: queue.counts.claimed,
    awaitingApproval: queue.counts.awaitingApproval,
    parked: queue.counts.parked,
    claimable: queue.counts.claimable,
    maxOpenIssues,
    capReached: engine === 'producer' && capRefusal(queue.counts.open, maxOpenIssues) !== null,
  };
}

/** A queue-shaped reason to stop, named from the closed stop vocabulary. */
interface QueueStop {
  condition: LoopStopCondition;
  reason: string;
}

/**
 * Whether the queue's SHAPE means there is nothing to do, and why.
 *
 * A producer at its cap has nowhere to put what it finds, so hunting is wasted
 * work — and reporting the cap here is what stops it filing blind. A consumer
 * with nothing claimable and nothing in flight has an empty in-tray. Neither is
 * a failure: both are `skip`.
 *
 * The condition is returned ALONGSIDE the prose rather than re-derived from it:
 * a reader that had to match on the reason text would break the first time the
 * wording changed.
 */
function queueStop(directive: LoopDirective, counts: QueueCounts): QueueStop | null {
  if (directive.engine === 'producer') {
    const cap = capRefusal(counts.open, directive.maxOpenIssues);
    return cap === null ? null : { condition: 'cap', reason: cap };
  }
  if (counts.claimable === 0 && counts.claimed === 0) {
    return {
      condition: 'empty',
      reason: `nothing claimable in loop '${directive.loop}' — a quiet queue is not a broken loop`,
    };
  }
  return null;
}

/** The refusal a paused directive prints — one wording, two readers. */
function directivePauseReason(loop: string): string {
  return `loop '${loop}' is paused by its directive`;
}

/** The refusal a full slot table prints — one wording, two readers. */
function lockedReason(loop: string, incumbent: LoopLockRecord): string {
  return `loop '${loop}' has no free run slot — '${incumbent.owner}' holds one until ${incumbent.expiresAt}`;
}

/** The refusal a machine-local pause prints — one wording, two readers. */
function statePauseReason(loop: string, scope: 'global' | 'loop', reason: string): string {
  return scope === 'global'
    ? `all loops are paused — ${reason}`
    : `loop '${loop}' is paused — ${reason}`;
}

/** A refusal this gate can reach without the queue or the checkout. */
export interface LocalRefusal {
  verdict: LoopGateVerdict;
  reason: string;
}

/**
 * Whether this gate is CERTAIN to refuse from local reads alone — and why.
 *
 * WHAT IT IS FOR: deciding whether the run's opening `git pull` is worth paying
 * for. That pull costs a network round trip (~3.7s measured on a no-op), and an
 * idle loop paid it forever for a verdict that never looked at the checkout
 * (#1626). The pull's stated purpose is that "a run that PROCEEDS reasons over
 * the checkout it is about to work in"; a run that is going to be refused works
 * on no checkout at all.
 *
 * IT MIRRORS STEPS 1 AND 2, AND NOTHING ELSE — the same pure functions, over
 * the same `state` and the same `now` the evaluation will use, so the two cannot
 * disagree about policy. Deliberately NOT included: the queue's shape (`skip`
 * for a spent cap or an empty in-tray) needs a backend read, which sits
 * downstream of a pull that has already happened.
 *
 * ONE DIRECTION IS SAFE AND THE OTHER IS NOT, so this is conservative by
 * construction: a `null` here only costs a pull the run was already paying for,
 * while a refusal claimed for a gate that then proceeds would put a run to work
 * on a checkout nobody brought current.
 *
 * SAFE TO ASK BEFORE THE PULL. Loop state lives under `flow/`, which plan-flow's
 * own gitignore block excludes from every project it initializes — a pause is
 * machine-local runtime state and has never travelled through git. No pull can
 * change the answer this reads.
 */
export function localRefusal(
  directive: LoopDirective,
  state: LoopState,
  owner: string,
  now: number,
): LocalRefusal | null {
  if (directive.paused) {
    return { verdict: 'paused', reason: directivePauseReason(directive.loop) };
  }
  const pause = effectivePause(state, directive.loop, now);
  if (pause !== null) {
    return {
      verdict: 'paused',
      reason: statePauseReason(directive.loop, pause.scope, pause.record.reason),
    };
  }
  // A FULL SLOT TABLE, with the same re-entrancy exception the acquire has: a
  // run re-opening the gate mid-run must not be locked out by the slot it is
  // itself holding.
  const live = liveLocks(state, directive.loop, now);
  const free = live.length < Math.max(1, directive.maxConcurrentRuns);
  if (free || lockHeldBy(state, directive.loop, owner, now) !== undefined) return null;
  const incumbent = oldestLock(state, directive.loop, now);
  return incumbent === undefined
    ? null
    : { verdict: 'locked', reason: lockedReason(directive.loop, incumbent) };
}

/** Evaluate the gate. */
export function evaluateNext(input: NextInput): NextEvaluation {
  const { directive, state, queue, owner, now } = input;
  const report = queueReport(queue, directive.maxOpenIssues, directive.engine);
  const fingerprints = [...queue.fingerprints].sort();

  const base = {
    loop: directive.loop,
    engine: directive.engine,
    mission: directive.mission,
    direction: directive.direction,
    rules: directive.rules,
    slice: directive.slice,
    scope: [...directive.scope],
    focus: input.focus ?? '',
    // The gate cannot read the instruction store — it is pure over its input —
    // so the prose is stamped by `runNext` once the hunt has actually started.
    // Empty here means "this run has no standing hunt", which is the truth for
    // every consumer and for a producer nobody aimed.
    huntStop: '',
    maxRunMinutes: directive.maxRunMinutes,
    queue: report,
    fingerprints,
    pull: input.pull,
    generatedAt: toIsoInstant(now),
  };

  /**
   * A verdict that writes no state — AND CARRIES NO OWNER. A gated verdict
   * means "you got nothing", and an owner threaded on regardless reads exactly
   * like the owner a caller carries through the rest of its run, so everything
   * recorded under it is mis-attributed (#1575, hit live on an `/agent-loop fix`
   * run that read the owner out of a second gate call without checking its
   * verdict).
   */
  const gated = (
    verdict: LoopGateVerdict,
    reason: string,
    stopCondition: LoopStopCondition = 'none',
  ): NextEvaluation => ({
    result: { verdict, reason, ...base, owner: '', runStartedAt: '', stopCondition, lock: null },
    state,
    stateChanged: false,
  });

  // 1. The directive's own pause — steering by commit, and the one signal that
  //    survives a state file being lost or reset.
  // 2. Then the machine-local pause, then a full slot table. All three live in
  //    `localRefusal`, so the pre-pull check and this one cannot drift apart.
  const refusal = localRefusal(directive, state, owner, now);
  if (refusal !== null) return gated(refusal.verdict, refusal.reason);

  // 3. The queue's shape.
  const stop = queueStop(directive, queue.counts);
  if (stop !== null) return gated('skip', stop.reason, stop.condition);

  // 4. Take a slot. `localRefusal` already found one free (or ours), so the
  //    failure branch is defensive — but it is a real branch, not a cast.
  //
  //    RE-ENTRY IS ASKED BEFORE THE ACQUIRE, not inferred after it. The obvious
  //    shortcut — compare the returned `acquiredAt` against `now` — is a clock
  //    comparison standing in for a fact the state already holds, and it reads
  //    two runs acquiring in the same millisecond as one run re-entering.
  const reentrant = lockHeldBy(state, directive.loop, owner, now) !== undefined;
  const attempt = acquireLoopLock(
    state,
    directive.loop,
    owner,
    lockTtlMs(directive.maxRunMinutes),
    now,
    input.focus,
    directive.maxConcurrentRuns,
  );
  if (!attempt.acquired) {
    return gated('locked', lockedReason(directive.loop, attempt.lock));
  }

  return {
    result: {
      verdict: 'proceed',
      // A RE-ENTERING RUN IS SAID SO. It kept the slot and the start stamp it
      // already had, and a reason claiming it just started would be a second
      // opinion about the one thing this verdict is for.
      reason: reentrant
        ? `loop '${directive.loop}' re-entered by '${owner}'`
        : `loop '${directive.loop}' may run`,
      ...base,
      owner,
      // THE STAMP IS THE SLOT'S. A fresh run's `acquiredAt` is this instant; a
      // re-entering run keeps the stamp it started with, so its clock does not
      // restart just because it asked the gate again.
      runStartedAt: attempt.lock.acquiredAt,
      stopCondition: 'none',
      lock: attempt.lock,
    },
    state: attempt.state,
    stateChanged: true,
  };
}

/** Epoch milliseconds → the ISO form every surface prints. */
function toIsoInstant(now: number): string {
  return new Date(now).toISOString();
}

/**
 * The pause in force for a loop, in the shape every reporting surface prints.
 * Exported here rather than re-derived per surface so the panel and the CLI say
 * the same thing about the same pause.
 */
export interface PauseReport {
  scope: 'global' | 'loop';
  reason: string;
  since: string;
  until?: string;
}

/** The pause report for a loop, or null when it is not paused. */
export function pauseReport(state: LoopState, loop: string, now: number): PauseReport | null {
  const pause = effectivePause(state, loop, now);
  if (pause === null) return null;
  const report: PauseReport = {
    scope: pause.scope,
    reason: pause.record.reason,
    since: pause.record.since,
  };
  if (pause.record.until !== undefined) report.until = pause.record.until;
  return report;
}
