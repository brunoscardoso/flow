/**
 * Loop CLI command — `planflow-ai loop <verb>`.
 *
 * THE SINGLE CODE PATH every caller uses. A cron-spawned run, an interactive
 * `/loop` session and the IDE panel are indistinguishable from here: they all
 * send the same argv and read the same JSON back, so a pause set in the panel
 * is the same pause a headless run on another machine obeys, and no prompt has
 * to restate an invariant the CLI already enforces (allowed-pattern #14).
 *
 * `guard classify` is the exact contract precedent:
 *
 *   - Success: the result JSON via `process.stdout.write`, exit 0.
 *   - Refusal: ONE `loop refused: <reason>` line via the repo logger (which
 *     routes through console.log — allowed-pattern #15), exit code 1, nothing
 *     else written and nothing persisted.
 *   - No model call ever enters a verb. The judgment stays in the agent; what
 *     lives here is the machinery the judgment is allowed to act through.
 *
 * `--human` RENDERS THE SAME RESULT OBJECT. It is a second FORMATTER, never a
 * second computation: `/agent-loop <name>` (Phase 6) must not be able to see a
 * different verdict from the one a headless run sees, and the only way to
 * guarantee that is for both to come from one value.
 *
 * ORDINARY OUTCOMES ARE NOT FAILURES. A duplicate finding, an empty queue and a
 * gated run all exit 0 with a status in the JSON — a producer re-finding a
 * known problem is the system working, and a cron job that reports failure on a
 * quiet night is a cron job people mute.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { error as logError } from '../utils/logger.js';
import {
  appendRunLogEntry,
  RUN_LOG_KINDS,
  digestRunLog,
  readRunLog,
  type RunDigest,
  type RunLogEntry,
  type RunLogKind,
  isRunLogKind,
  isRunKind,
  RUN_KIND,
} from '../loop/run-log.js';
import { writePrompt } from '../daemon/prompt-manager.js';
import {
  appendClassification,
  isWorkVerdict,
  readClassifications,
  requireVerdict,
  WORK_VERDICTS,
  type ClassificationRecord,
} from '../loop/classify.js';
import { FileLockTimeoutError, withFileLock, type FileLockLimits } from '../loop/file-lock.js';
import { LOOPS_DIRNAME, TRACKED_LOOPS_DIRNAME, readLoopDirective } from '../loop/directive-parser.js';
import { setDirectivePaused, setDirectiveQueue, setDirectiveCap, setDirectiveProse } from '../loop/directive-writer.js';
import { LedgerQueueBackend } from '../loop/ledger-queue.js';
import { GithubQueueBackend, ghKindOf, type GhFailureKind } from '../loop/github-queue.js';
import { claimedPlan, deriveStage, readPipelineInput } from '../loop/pipeline-state.js';
import {
  evaluateNext,
  localRefusal,
  lockTtlMs,
  pauseReport,
  skippedPull,
  type NextEvaluation,
  type NextResult,
  type PauseReport,
  type PullNote,
} from '../loop/next.js';
import {
  isLoopRef,
  mergeEvidenceRefusal,
  mergeRefusal,
  normalizeRef,
  prRefusal,
  pushRefusal,
} from '../loop/push-guard.js';
import { defaultBaseBranch, pruneWorktree, resolveWorktree, type WorktreePrune, type WorktreeResolution } from '../loop/worktree.js';
import { canonicalStoreRoot } from '../loop/store-root.js';
import { detectCliStaleness } from '../loop/cli-staleness.js';
import { getPackageRoot } from '../utils/files.js';
import { QUIET_CHILD_STDIO } from '../utils/child-stdio.js';
import { flagOrStdin } from '../utils/flag-or-stdin.js';
import {
  applyEscalation,
  loopRecord,
  escalationPromptTail,
  escalationReason,
  liveLocks,
  lockHeldBy,
  mutateLoopState,
  oldestLock,
  readLoopState,
  releaseLoopLock,
  toIso,
  withGlobalPause,
  withLoopPause,
  withLoopStateLock,
  withoutGlobalPause,
  withoutLoopPause,
  withRunOutcome,
  writeLoopState,
} from '../loop/loop-state.js';
import {
  abandonedClaims,
  countItems,
  scopeItemsToLoop,
  StatusPageCache,
  engineWorkBlocker,
  heldClaims,
  isQueueCloseReason,
  QueueReadSession,
  type AbandonedClaim,
  type CloseEvidence,
  type LoopQueueBackend,
  type QueueItem,
  type QueueItemState,
} from '../loop/queue-backend.js';
import { ForeignItemStore, foreignItemsPath, foreignKey } from '../loop/foreign-items.js';
import {
  claimBindings,
  parseLiveRuns,
  runOwner,
  stuckClaims,
  stuckClaimsPhrase,
  type LiveRuns,
  type StuckClaim,
} from '../loop/stuck-claims.js';
import {
  isLoopStopCondition,
  LOOP_QUEUE_KINDS,
  LOOP_STOP_CONDITIONS,
  normalizeFocus,
} from '../loop/types.js';
import {
  DEFAULT_INSTRUCTION_CAP,
  INSTRUCTION_STOP_KINDS,
  describeInstructionStop,
  findInstruction,
  instructionStopReached,
  isInstructionStopKind,
  meetInstruction,
  resolveInstructionStop,
  instructionsPath,
  readInstructions,
  readInstructionsResult,
  recordInstructionRun,
  startInstruction,
  forgetInstruction,
  instructionKey,
  stopInstruction,
  writeInstructions,
} from '../loop/instructions.js';
import type {
  Instruction,
  InstructionsRead,
  InstructionStop,
  InstructionStore,
} from '../loop/instructions.js';
import type {
  LoopDirective,
  LoopLockRecord,
  LoopQueueKind,
  LoopState,
  LoopStopCondition,
} from '../loop/types.js';

/** Prefix every refusal line carries — never doubled. */
const LOOP_REFUSED_PREFIX = 'loop refused:';

/** Every verb this command answers to. */
export const LOOP_VERBS = [
  'next',
  'file',
  'claim',
  'adopt',
  'rework',
  'unclaim',
  'plan',
  'classify',
  'close',
  'approve',
  'escalate',
  'worktree',
  'push',
  'merge',
  'pause',
  'resume',
  'enable',
  'disable',
  'finish',
  'forget',
  'point',
  'describe',
  'status',
  'list',
  'log',
] as const;

/** One of the verbs. */
export type LoopVerb = (typeof LOOP_VERBS)[number];

/** Whether a value is a known verb. */
export function isLoopVerb(value: string): value is LoopVerb {
  return (LOOP_VERBS as readonly string[]).includes(value);
}

/** How long the run-opening `git pull` may take. */
export const PULL_TIMEOUT_MS = 60_000;

/** How many run-log lines `loop log` returns when no `--limit` is given. */
export const DEFAULT_LOG_LIMIT = 20;

/** Longest a soft-failure note is kept — a git error can be a page long. */
const NOTE_MAX_LENGTH = 200;

/** Every option the verb family reads. */
export interface LoopCommandOptions {
  /** Project root. `flow/` is resolved under it. */
  target: string;
  /** Which loop. Required by next/file/claim/close/approve; a filter elsewhere. */
  loop?: string;
  /** Run id recorded on locks and claims. Defaulted per invocation when absent. */
  owner?: string;
  /**
   * The Claude Code session this run lives in, when the dispatcher knows it.
   *
   * Recorded INSIDE the owner (`runOwner`), not beside it — see `stuck-claims.ts`
   * for why one identity is safer than two. What it buys is the answer to "a run
   * died and nothing told me": a claim whose session is absent from the live
   * background agents is a claim nobody is working. Absent leaves the owner
   * exactly as it was, so nothing about a run without one changes.
   */
  session?: string;
  /**
   * A snapshot of the agents running for this root, as JSON (`status`).
   *
   * AN INPUT, NEVER A SPAWN. `loop status` is a read: it does not shell out to
   * discover what is running, it is TOLD — by the dispatcher that already had to
   * read the list to do its own job. Absent means "nobody said", which reports
   * no claim as stuck rather than all of them.
   */
  liveRuns?: string;
  /** Queue item id (claim/adopt/close/approve). */
  id?: string;
  /** Finding title (file). */
  title?: string;
  /** Finding body prose (file). */
  body?: string;
  /** The file the finding is primarily about (file). */
  file?: string;
  /** Extra comma-separated labels (file). */
  labels?: string;
  /**
   * The plan whose pipeline this run is advancing (`plan`). Absent CLEARS the
   * record — one flag, both directions, so a run never needs a second verb to
   * say it is finished with a pipeline.
   */
  plan?: string;
  /**
   * Which store a loop reads its work from (`point`): `github` or `ledger`.
   *
   * Named after the directive field it writes, like `--state` is named after
   * the item field it filters — one word for one thing, whether a person is
   * reading the file or writing the flag.
   */
  queue?: string;
  /** `owner/name` — the repo a `point --queue github` reads (point). */
  repo?: string;
  /**
   * The ledger file a `point --queue ledger` reads (point). Omitted leaves the
   * loop on the file it already reads, or on the documented default when it
   * has none — an unmentioned field is not a field to throw away.
   */
  path?: string;
  /** Close reason: done|wontfix|duplicate (close). */
  reason?: string;
  /** Written reason (close/pause/resume; required by adopt). */
  detail?: string;
  /** Captured evidence JSON (close). Falls back to stdin when piped. */
  evidence?: string;
  /** Pause expiry: an ISO timestamp or `+<n>[mhd]`. */
  until?: string;
  /** How many run-log lines to return (log). */
  limit?: string;
  /**
   * Which slice of the queue to read (`list`): `open`, `closed` or `all`.
   *
   * Named `state` after the item field it filters, so a reader of the output
   * and a writer of the flag are using one word for one thing.
   */
  state?: string;
  /**
   * Comma-separated item ids this run has already passed over (`claim`) — it is
   * handed the next one instead of the same head again.
   */
  skip?: string;
  /**
   * Which run slot to act on (`worktree`). Normally left absent — the slot is
   * derived from the `--owner`'s lock, so a run cannot end up in a checkout it
   * does not hold. Naming it explicitly is for a PERSON cleaning up a slot whose
   * run is gone.
   */
  slot?: string;
  /**
   * `log`: the run record to append, as JSON (`-` reads stdin).
   * `classify`: the bare flag, which is why the value is optional — `true` is
   * "record mode" and a string is a payload. One flag name, two verbs, no
   * second spelling for a caller to get wrong.
   */
  record?: string | boolean;
  /** The big/small judgment (classify). */
  verdict?: string;
  /** Prune the loop's worktree instead of resolving it (worktree). */
  prune?: boolean;
  /** Commander sets this false for `--no-create` (worktree). */
  create?: boolean;
  /**
   * What a person aimed this run at (next). Narrows attention WITHIN the
   * directive's mission and scope; it can never widen either, change the queue,
   * or skip a gate. Stamped on the lock, so the run's log line carries it.
   */
  focus?: string;
  /**
   * Every hunt, rather than one (`forget`).
   *
   * REQUIRED TO MEAN ALL. A `forget` with neither `--focus` nor this refuses
   * instead of guessing — the two readings of a bare `loop forget --loop find`
   * are "forget nothing" and "forget everything", and one of them cannot be
   * taken back.
   */
  all?: boolean;
  /**
   * Whether THIS filed task waits for a human before any run may work it
   * (file). Overrides the directive's default — approval belongs to the task,
   * not to the loop that filed it.
   */
  needsApproval?: boolean;
  /** Cap for a producer instruction (next). Defaults to `DEFAULT_INSTRUCTION_CAP`. */
  cap?: string;
  /** The branch a push writes (push). Must be inside the `loop/*` carve-out. */
  branch?: string;
  /** Remote to push to (push). Defaults to `origin`. */
  remote?: string;
  /** Base branch a pull request targets (push --pr). Defaults to `main`. */
  base?: string;
  /** Open a pull request after the push (push). */
  pr?: boolean;
  /** Render the compact human form of the SAME result object. */
  human?: boolean;
  /** Commander sets this false for `--no-pull`. */
  pull?: boolean;
  /** `describe`: the loop's `## Direction` prose. Empty string removes it. */
  direction?: string;
  /** `describe`: the loop's `## Rules` prose. Empty string removes it. */
  rules?: string;
  /**
   * `describe`: the directive's `max_open_issues` — the one stop a loop keeps
   * by default. NOT `--cap`, which `next` already spends on an instruction's
   * filing limit; the flag carries the directive key's own name so neither verb
   * has to explain which cap it means.
   */
  maxOpen?: string;
  /**
   * `resume --focus`: how the hunt being started ENDS — `findings`, `duration`
   * or `custom`. Absent leaves the hunt on the backstop alone, which is what
   * every hunt written before stop rules has and must keep having.
   */
  stopKind?: string;
  /** `resume --focus --stop-kind duration`: hours, measured from now. */
  stopHours?: string;
  /** `resume --focus --stop-kind custom`: the sentence the agent judges. */
  stopRule?: string;
  /**
   * `finish`: the hunt's own custom rule came true, so record `met` rather than
   * a person's `stopped`. A flag rather than a second verb because the two
   * differ only in whose judgment ended the hunt.
   */
  ruleMet?: boolean;
  /**
   * `next`: switch the loop OFF when the gate finds its queue empty.
   *
   * OPT-IN, AND THE ONLY THING THAT MAKES THE GATE WRITE ON A REFUSAL. The
   * gate's standing rule is that asking whether you may run never changes the
   * answer for whoever asks next (#1578) — a rule that exists because the gate
   * once erased a person's cap as a side effect of being asked. This is the
   * one documented exception, and it is a flag rather than a default for
   * exactly that reason: every existing caller behaves as it always did, and a
   * caller that wants a loop to end itself has to say so.
   *
   * What it writes is a STATE pause, not a directive one: the committed
   * intent — what this loop is for, whether the team wants it at all — is
   * untouched, and pressing play lifts it.
   */
  stopWhenEmpty?: boolean;
}

/** Minimal exec surface: run a binary with argv in a cwd, return stdout. */
export type LoopExec = (file: string, args: readonly string[], cwd: string) => string;

/** The default exec — `execFileSync`, so no shell quoting can ever be wrong. */
export const defaultLoopExec: LoopExec = (file, args, cwd) =>
  execFileSync(file, [...args], {
    encoding: 'utf-8',
    cwd,
    timeout: PULL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // QUIET BY DEFAULT (#1798) — this family had the same leak the worktree one
    // did: `loop worktree` printed git's checkout chatter, and the per-checkout
    // owner-stamp read printed a `fatal:` about `--worktree`, both immediately
    // before their own success lines. The stamp read's `catch` returns null by
    // design; its noise belonged nowhere.
    stdio: [...QUIET_CHILD_STDIO],
  });

/**
 * Injected collaborators. Production passes none; tests pass a fake exec and a
 * fixed clock, so no test ever shells out to git and no test has to sleep
 * (the Phase 1/2 convention — injection, never a PATH stub).
 */
export interface LoopRuntime {
  exec?: LoopExec;
  clock?: () => number;
}

/**
 * Normalize any thrown error into a single `loop refused: <reason>` line.
 * Errors already carrying the prefix pass through untouched.
 */
function toRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(LOOP_REFUSED_PREFIX)) {
    return message;
  }
  return `${LOOP_REFUSED_PREFIX} ${message}`;
}

/** Collapse a multi-line tool failure into one bounded, printable line. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > NOTE_MAX_LENGTH
    ? `${collapsed.slice(0, NOTE_MAX_LENGTH - 1)}…`
    : collapsed;
}

// `readStdin`/`flagOrStdin` moved to `../utils/flag-or-stdin.js` (#loop-fix-6)
// so `worktree.ts` can share the same `-` sentinel instead of growing its own.

/** Parse a JSON payload from a flag, refusing with the flag's name. */
function parseJsonArg(raw: string, what: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`missing ${what} — pass it as JSON`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`malformed ${what} JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** The `flow/` directory for a target — anchored to the shared repo root
 *  (`canonicalStoreRoot`), so every worktree reads and writes one ledger. */
function flowDirOf(options: LoopCommandOptions): string {
  return join(canonicalStoreRoot(options.target), 'flow');
}

/** The loop name a verb requires, refusing by name when absent. */
function requireLoop(options: LoopCommandOptions, verb: string): string {
  const loop = options.loop?.trim() ?? '';
  if (loop.length === 0) {
    throw new Error(`${verb} requires --loop <name>`);
  }
  return loop;
}

/** A required flag's value. */
function requireFlag(value: string | undefined, flag: string, verb: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new Error(`${verb} requires ${flag}`);
  }
  return trimmed;
}

/**
 * The run id. A caller that has one (the daemon, a resuming run) passes it;
 * one that does not gets a UNIQUE id rather than a shared constant, because two
 * runs sharing an owner would both pass the re-entrant lock check and run at
 * once — the exact race the lock exists to prevent.
 *
 * THE SESSION RIDES INSIDE IT when the caller named one. A generated owner is
 * the only place the binding can be made — a `--owner` a caller spelled itself
 * is passed through untouched, because it is the SAME string that opened the
 * run's lock and every later verb (`close`, `plan`, `unclaim`) compares against
 * it for equality. Rewriting it here would silently make a run fail to
 * authorize against its own claim.
 */
function resolveOwner(options: LoopCommandOptions, now: number): string {
  const owner = options.owner?.trim() ?? '';
  if (owner.length > 0) return owner;
  return runOwner(`run-${toIso(now).replace(/[-:.]/g, '')}-${process.pid}`, options.session);
}

/** A queue backend plus where it lives, for reporting. */
interface OpenQueue {
  backend: LoopQueueBackend;
  /** Repo-relative ledger path, or `owner/name` for GitHub. */
  location: string;
}

/**
 * Open the directive's queue. The directive parser has already guaranteed the
 * shape (a `github` directive has a validated `repo`, a `ledger` one a path),
 * so this never has to guess at a layout.
 *
 * THE ENGINE IS THREADED FROM THE DIRECTIVE, in ONE place, and it is what tells a
 * backend whether the caller drains this queue or only files into it. Every verb
 * opens its queue here, so no verb can end up with a backend that has a different
 * opinion about which items are workable — and no backend has to guess the answer
 * from a loop's name.
 *
 * `session` is the OPT-IN half, and only a read-only REPORT ever passes one: it
 * lets the backends this verb opens for its several rows share one round trip
 * per distinct read (`QueueReadSession`). A verb that writes says nothing and
 * therefore reads the store fresh every time, which is the only correct
 * behaviour for a caller whose own write may have changed the answer.
 */
function openQueue(
  options: LoopCommandOptions,
  directive: LoopDirective,
  clock: () => number,
  verb: string,
  session?: QueueReadSession,
): OpenQueue {
  // What this loop knows about items it did not file — the claim it cannot write
  // into someone's issue body, and the record that it already handled one.
  const local = new ForeignItemStore(foreignItemsPath(flowDirOf(options)));
  if (directive.queue === 'github') {
    const repo = directive.repo ?? '';
    return {
      backend: new GithubQueueBackend({
        repo,
        clock,
        engine: directive.engine,
        local,
        ...(session === undefined ? {} : { session }),
      }),
      location: repo,
    };
  }
  // Anchored to the shared repo root, not the caller's cwd (#7's sibling — see
  // `canonicalStoreRoot`). An explicit directive `path:` is still honored: an
  // absolute one is taken verbatim, a relative one resolves against the same
  // canonical root every worktree shares, so the queue is one file.
  const relative = directive.path ?? join('flow', LOOPS_DIRNAME, 'queue.jsonl');
  const filePath = isAbsolute(relative) ? relative : resolve(canonicalStoreRoot(options.target), relative);
  return {
    backend: new LedgerQueueBackend(filePath, clock, `cli:loop ${verb}`, directive.engine, local),
    location: relative,
  };
}

/** Every fingerprint this loop already knows, open AND closed, deduped + sorted. */
function knownFingerprints(items: readonly QueueItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.fingerprint.length > 0) seen.add(item.fingerprint);
  }
  return [...seen].sort();
}

/**
 * One pull at a time per checkout (#1663). Concurrent pulls share
 * `.git/FETCH_HEAD` — one process's fetch rewrites it while another's merge
 * step reads it, and the reader dies with `fatal: Cannot fast-forward to
 * multiple branches.` The daemon fires every scheduled gate on the same tick
 * and a terminal `/agent-loop` overlaps them, all in one main checkout, so the
 * collision recurs at every synchronized beat. The wait is sized for a real
 * pull (~4s measured no-op), the stale threshold for a hung one.
 */
const PULL_LOCK_LIMITS: FileLockLimits = { staleMs: 120_000, waitMs: 60_000, retryMs: 100 };

/** Where a checkout's pull lock lives — a sibling of the loop state store. */
function pullLockPath(options: LoopCommandOptions): string {
  return join(flowDirOf(options), LOOPS_DIRNAME, 'pull.lock');
}

/**
 * The `git pull --ff-only` every run opens with — serialized per checkout
 * (#1663), so gates that overlap on one checkout wait on each other's pull
 * instead of corrupting it. The second gate's own pull then fast-forwards over
 * a checkout the first already brought current, which is the single-flight
 * freshness #1625 wanted, paid for with one cheap `Already up to date`.
 *
 * FAILS SOFT AND RECORDS. A loop that cannot reach its remote still has work it
 * can do on the checkout it has; aborting the run would let one network hiccup
 * silence a loop for an hour. The note travels in the verdict so the staleness
 * is visible rather than inferred. A pull lock waited out is the same shape: a
 * benign skip note, never a git fatal that reads like repo corruption.
 */
function pullCheckout(options: LoopCommandOptions, exec: LoopExec): PullNote {
  if (options.pull === false) {
    return skippedPull('pull skipped (--no-pull)');
  }
  try {
    return withFileLock(pullLockPath(options), PULL_LOCK_LIMITS, () => {
      try {
        exec('git', ['pull', '--ff-only'], options.target);
        return { attempted: true, ok: true, note: '' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { attempted: true, ok: false, note: `git pull failed: ${oneLine(message)}` };
      }
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      return skippedPull("pull skipped (another gate's pull held this checkout past the wait)");
    }
    throw error;
  }
}

/**
 * The slot whose aim belongs to the run making this call.
 *
 * A run's OWN slot when it holds one, and the oldest live one otherwise. The
 * fallback is what preserves the guarantee the single-slot version got for
 * free: a run that spells a different `--owner` holds nothing under that name
 * and lands on the loop's oldest run, so misnaming yourself can only ever read
 * someone else's aim, never invent one.
 */
function runLock(
  state: LoopState,
  loop: string,
  owner: string | undefined,
  now: number,
): LoopLockRecord | undefined {
  const own = owner === undefined ? undefined : lockHeldBy(state, loop, owner, now);
  return own ?? oldestLock(state, loop, now);
}

/**
 * Refuse a verb that is a PERSON's decision while a run holds the loop.
 *
 * THIS IS WHAT "A BEAT CANNOT ADOPT" IS MADE OF. Saying so in the prompt would
 * be advice; a run that has read a refusal explaining how a human adopts an
 * item is one plausible next command away from adopting it itself, and the
 * whole value of the rule is that it does not bend under a good-sounding
 * argument. So the gate is structural: `loop next` takes a run slot and holds it
 * for the run's whole life, and while a slot is held this verb refuses. A run
 * therefore cannot reach adoption during the only time it exists.
 *
 * THE SLOT, NOT THE `--owner` FLAG: a check keyed on a flag is a check the
 * caller chooses the answer to. An expired slot does not count — `readLoopState`
 * expires it, the loop is nobody's, and a person is not made to wait out a run
 * that already ended.
 */
function requireNoRun(
  options: LoopCommandOptions,
  directive: LoopDirective,
  verb: string,
  now: number,
): void {
  // ANY slot being held blocks this, not just a full loop: `loop adopt` is a
  // person's decision, and one run running is enough for it to collide with a
  // run in progress. The oldest holder is named because it is the one whose
  // ending a person is waiting for.
  const lock = oldestLock(readLoopState(flowDirOf(options), now), directive.loop, now);
  if (lock === undefined) return;
  throw new Error(
    `loop '${directive.loop}' is running — run '${lock.owner}' holds it until ${lock.expiresAt}, and \`loop ${verb}\` is a person's decision, never a run's. Try it once the run has ended (\`loop status\`), or stop the loop first (\`loop pause\`).`,
  );
}

// ── the verbs ────────────────────────────────────────────

/**
 * The `--stop-*` trio as one stop rule, or undefined when none was named.
 *
 * REFUSES EVERY HALF-STATED FORM. `--stop-hours` without `--stop-kind
 * duration` is somebody who meant to bound a hunt by time and did not, and a
 * flag that is silently ignored is the worst possible answer to that — the hunt
 * runs unbounded and the person believes it will stop tonight.
 *
 * For `findings` the number is `--cap`, which is why nothing is read here: the
 * store keeps ONE number for how many findings end a hunt (see InstructionStop),
 * and a `--stop-findings` beside `--cap` would be the second one.
 */
function parseInstructionStop(
  options: LoopCommandOptions,
  now: string,
): InstructionStop | undefined {
  const kind = options.stopKind?.trim();
  const hoursGiven = options.stopHours !== undefined;
  const ruleGiven = options.stopRule !== undefined;
  if (kind === undefined || kind.length === 0) {
    if (hoursGiven || ruleGiven) {
      throw new Error(
        '--stop-hours/--stop-rule need --stop-kind <findings|duration|custom> — a hunt will not be bounded by a flag nobody asked it to read',
      );
    }
    return undefined;
  }
  if (!isInstructionStopKind(kind)) {
    throw new Error(
      `--stop-kind must be one of ${INSTRUCTION_STOP_KINDS.join('|')} — got '${kind}'`,
    );
  }
  if (kind === 'findings') {
    if (hoursGiven || ruleGiven) {
      throw new Error(
        "--stop-kind findings takes neither --stop-hours nor --stop-rule — the number is --cap",
      );
    }
    return resolveInstructionStop({ kind: 'findings' }, now);
  }
  if (kind === 'duration') {
    if (ruleGiven) throw new Error('--stop-kind duration takes --stop-hours, not --stop-rule');
    if (options.stopHours === undefined) {
      throw new Error('--stop-kind duration needs --stop-hours <n>');
    }
    const hours = Number(options.stopHours);
    return resolveInstructionStop({ kind: 'duration', hours }, now);
  }
  if (hoursGiven) throw new Error('--stop-kind custom takes --stop-rule, not --stop-hours');
  if (options.stopRule === undefined) {
    throw new Error('--stop-kind custom needs --stop-rule <text>');
  }
  return resolveInstructionStop({ kind: 'custom', rule: options.stopRule }, now);
}

/**
 * Switch a loop off because its list is empty, and say so in the verdict.
 *
 * IDEMPOTENT BY CONSTRUCTION: a loop already paused never reaches here (the
 * gate refuses it as `paused` before it can read the queue), so this cannot
 * overwrite a pause a person set with one the machine wrote.
 */
function stopEmptyLoop(
  flowDir: string,
  loop: string,
  result: NextResult,
  now: number,
): NextResult {
  const reason = 'nothing left in the list — switched off until there is work again';
  mutateLoopState(flowDir, (state) => withLoopPause(state, loop, { reason }, now), now);
  appendRunLogEntry(flowDir, { ts: toIso(now), kind: 'pause', loop, reason });
  // The verdict stays `skip` — nothing ran — and the reason gains what was done
  // about it, so a log line says both halves without a reader inferring one.
  return { ...result, reason: `${result.reason}; loop switched off — ${reason}` };
}

/** `--cap` as a positive integer, or the default when it was not passed. */
function parseInstructionCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INSTRUCTION_CAP;
  const cap = Number.parseInt(raw, 10);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error(`--cap must be a positive integer — got '${String(raw)}'`);
  }
  return cap;
}

/**
 * Say — once per process, on stderr — when the RUNNING build is behind
 * origin/main (#1651). stderr because stdout is the JSON contract a run
 * parses; fail-soft because a staleness notice must never break a verb.
 *
 * Deliberately NOT through `runtime.exec`: that ledger records what the RUN
 * did to its checkout, and this probe is the binary introspecting itself —
 * recording it there would make every exec-sequence assertion about a verb
 * carry an unrelated line. Memoized so one process asks git once, however
 * many verbs it serves.
 */
let cliStalenessSaid = false;
function warnIfCliStale(): void {
  if (cliStalenessSaid) return;
  cliStalenessSaid = true;
  try {
    const warning = detectCliStaleness(getPackageRoot(), (file, args, cwd) =>
      execFileSync(file, [...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    if (warning !== null) process.stderr.write(`${warning}\n`);
  } catch {
    // Silence — the notice is a courtesy, never a failure mode.
  }
}

/**
 * `loop next` — the gate that opens every run.
 *
 * WHAT IT STOPPED DOING IN PHASE 6: counting the breaker's failures, sizing a
 * run budget, and holding the project pipeline's single lock. A run is a Claude
 * Code background agent now, so the process is Claude Code's to own. What it
 * still does is answer "may I run, and on what?", and take the run slot that
 * decides which git checkout this run works in.
 */
function runNext(options: LoopCommandOptions, runtime: Required<LoopRuntime>): NextResult {
  warnIfCliStale();
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'next');
  const directive = readLoopDirective(flowDir, loop);

  // BEFORE the pull and before the gate: an over-long focus is a refusal, and a
  // refusal must not arrive after a checkout has already been moved.
  const focus = normalizeFocus(options.focus);

  // The cap is VALIDATED here — before the pull and before the gate — because an
  // unusable `--cap` is a refusal about the command line. The instruction store
  // itself is written further down, and only for a run that proceeds (#1578).
  const instructionCap =
    focus !== undefined && directive.engine === 'producer'
      ? parseInstructionCap(options.cap)
      : undefined;

  // The pull happens BEFORE the gate is read, so a run that proceeds reasons
  // over the checkout it is about to work in — not the one it woke up on.
  //
  // BUT ONLY FOR A RUN THAT COULD PROCEED (#1626). Both pauses are decidable
  // from `state.json` and the directive — two local file reads — so an idle loop
  // used to pay a full network round trip (~3.7s measured) per run, forever, to
  // be told something the checkout was never asked about. `localRefusal` answers
  // that question from the same pure function the evaluation below uses, over
  // the same `state` and `now`, and errs toward pulling: a `null` costs one pull
  // the run was paying for anyway.
  //
  // `flow/` is excluded by plan-flow's own gitignore block, so loop state has
  // never travelled through git and no pull can change what it says.
  const now = runtime.clock();
  const owner = resolveOwner(options, now);
  const refusedLocally = localRefusal(directive, readLoopState(flowDir, now), owner, now);
  const pull =
    refusedLocally === null
      ? pullCheckout(options, runtime.exec)
      : skippedPull(`pull skipped (${refusedLocally.verdict}) — no checkout is needed to refuse`);

  const { backend, location } = openQueue(options, directive, runtime.clock, 'next');
  // ONE remote read per gate pass (#1635): `count()` would repeat the identical
  // `state: 'all'` query this list already made, so the counts are folded from
  // the very items it returned.
  const items = backend.list({ state: 'all', loop: directive.loop });
  const counts = countItems(items);

  // READ → EVALUATE → WRITE IN ONE CRITICAL SECTION (#1662). The pull and the
  // queue list above take seconds, and gates overlap by construction. Evaluating
  // the snapshot taken before that window and writing the result erased any slot
  // a concurrent verb took in between — mutual exclusion collapsing into
  // last-write-wins. So the state the verdict is computed from is re-read HERE,
  // under the store's inter-process lock, with the write in the same hold;
  // `evaluateNext` is pure, so re-running it over fresh state is the delta
  // re-applied, not a second opinion.
  const evaluation: NextEvaluation = withLoopStateLock(flowDir, () => {
    const freshNow = runtime.clock();
    const result = evaluateNext({
      directive,
      state: readLoopState(flowDir, freshNow),
      queue: { kind: backend.kind, location, counts, fingerprints: knownFingerprints(items) },
      pull,
      owner,
      now: freshNow,
      ...(focus === undefined ? {} : { focus }),
    });
    // WHAT THIS RUN ALREADY BROUGHT CURRENT, stamped on the slot it just took
    // (#1625). The worktree shares this checkout's ref store, so a resolve inside
    // this run's window can ff-merge the ref this pull updated instead of
    // re-negotiating with the remote for it. Only on a pull that actually
    // succeeded: a skipped or failed one brought nothing current, and a stamp
    // claiming otherwise is the freshness lie #1584 exists to prevent.
    if (result.stateChanged) {
      const held = result.state.loops[directive.loop]?.locks?.find((lock) => lock.owner === owner);
      if (held !== undefined && pull.attempted && pull.ok) {
        held.pulled = { at: toIso(freshNow), base: checkoutBase(runtime.exec, options.target) };
      }
      writeLoopState(flowDir, result.state);
    }
    return result;
  });

  // A GATED VERDICT LEAVES NO TRACE. Nothing below runs for one — not the
  // instruction store — because asking whether you may run must never change
  // the answer for whoever asks next.
  //
  // THE ONE EXCEPTION, AND THE CALLER HAS TO ASK FOR IT: `--stop-when-empty`
  // turns "there is nothing left to do" into the loop switching itself off,
  // which is what a person means by "run until the list is empty". Narrow on
  // purpose — only the `empty` condition, only on a `skip`, and only a state
  // pause a press of play lifts. A `cap`, a `locked` or a failed queue read
  // writes nothing: those are reasons to wait, not reasons to be over.
  if (evaluation.result.verdict !== 'proceed') {
    if (options.stopWhenEmpty === true && evaluation.result.stopCondition === 'empty') {
      return stopEmptyLoop(flowDir, directive.loop, evaluation.result, now);
    }
    return evaluation.result;
  }

  // A TYPED INSTRUCTION STARTS OR RESUMES A HUNT. Retyping the same sentence
  // means "carry on" — the count, and therefore the cap, survive the run that
  // filed against them. A producer with no instruction just runs its directive,
  // as it always did.
  //
  // WRITTEN ONLY ON `proceed`, and that placement is the fix for #1578: this
  // used to run before the gate, so a run refused as paused/skip still rewrote
  // the store — erasing a cap with no person involved.
  if (instructionCap !== undefined && focus !== undefined) {
    const started = startInstruction(readInstructions(flowDir), focus, toIso(runtime.clock()), instructionCap);
    writeInstructions(flowDir, started.store);
    // THE RULE REACHES THE RUN AS PROSE. A `custom` stop is a sentence only the
    // agent can judge, so the gate's own output is where it has to appear —
    // there is no other channel between the store and the session.
    return { ...evaluation.result, huntStop: describeInstructionStop(started.instruction) };
  }

  return evaluation.result;
}

/** The outcome of `loop classify`. */
export interface ClassifyVerbResult {
  status: 'recorded' | 'ok';
  loop: string;
  id: string;
  verdict: string;
  /** The whole record, so a caller sees who decided and why. */
  record: ClassificationRecord;
}

/**
 * `loop classify` — record the big/small verdict, or read the one in force.
 *
 * THE JUDGMENT IS THE AGENT'S. Nothing here inspects the item's title, diff or
 * complexity: a verdict needs the item READ, which is a model's job, and no
 * model call ever enters a verb. What the CLI enforces is that a verdict EXISTS
 * — a read with none recorded refuses — because "we never decided whether this
 * was big" is the failure mode that turns a quick fix into an unplanned rewrite.
 *
 * IT NO LONGER TAKES A LOCK. Recording `big` used to seize the single pipeline
 * lock, so that exactly one consumer at a time could be inside
 * `/discovery-plan → /create-plan → /execute-plan`. Phase 6 removed it with the
 * rest of the engine: a run is a Claude Code background agent scoped to one
 * project root, so what may run at once is what a person dispatched, and a TTL
 * in `state.json` guessing at it was a second, worse answer.
 */
function runClassify(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): ClassifyVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'classify');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'classify');
  const records = readClassifications(flowDir);
  const now = runtime.clock();

  if (options.record === undefined) {
    const record = requireVerdict(records, directive.loop, id);
    return {
      status: 'ok',
      loop: directive.loop,
      id,
      verdict: record.verdict,
      record,
    };
  }

  const verdict = requireFlag(options.verdict, `--verdict <${WORK_VERDICTS.join('|')}>`, 'classify');
  if (!isWorkVerdict(verdict)) {
    throw new Error(`unknown verdict '${verdict}' — expected ${WORK_VERDICTS.join('|')}`);
  }

  // Classify what you claimed: an item nobody has is not being worked, and an
  // item someone else has is not yours to route.
  const { backend } = openQueue(options, directive, runtime.clock, 'classify');
  const item = backend.byId(id, directive.loop);
  if (item === null) {
    throw new Error(`no item '${id}' in loop '${directive.loop}'`);
  }
  const owner = options.owner?.trim();
  if (owner !== undefined && owner.length > 0 && item.claimedBy !== undefined && item.claimedBy !== owner) {
    throw new Error(`item ${id} is claimed by '${item.claimedBy}' — '${owner}' cannot classify it`);
  }

  const record: ClassificationRecord = {
    ts: toIso(now),
    loop: directive.loop,
    id,
    verdict,
    ...(owner === undefined || owner.length === 0 ? {} : { owner }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  };
  appendClassification(flowDir, record);

  return { status: 'recorded', loop: directive.loop, id, verdict, record };
}

/** The outcome of `loop escalate`. */
export interface EscalateVerbResult {
  status: 'awaiting-approval';
  loop: string;
  reason: string;
  /** The item that stays claimed, when one was named. */
  id?: string;
  /** Where the prompt a human answers was written. */
  promptPath: string;
  at: string;
}

/**
 * `loop escalate` — an autopilot high-risk pause or a guarded escalation.
 *
 * A HUMAN GATE IS NOT A FAILURE. The loop pauses with `awaiting-approval`, the
 * prompt goes into the mechanism the session-start behaviour already reads
 * (`flow/.heartbeat-prompt.md`), and the claimed item STAYS claimed — releasing
 * it would hand half-finished work to the next run while a person was still
 * looking at it.
 */
async function runEscalate(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): Promise<EscalateVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'escalate');
  const directive = readLoopDirective(flowDir, loop);
  const detail = requireFlag(options.detail ?? options.reason, '--detail <why>', 'escalate');
  const now = runtime.clock();
  mutateLoopState(flowDir, (state, mutationNow) => applyEscalation(state, directive.loop, detail, mutationNow), now);

  // The existing prompt writer, reused rather than re-implemented: one file
  // shape, one archive path, one thing a session start knows how to find.
  await writePrompt(
    `loop ${directive.loop}`,
    escalationPromptTail(directive.loop, detail),
    '',
    flowDir,
  );

  appendRunLogEntry(flowDir, {
    ts: toIso(now),
    kind: 'pause',
    loop: directive.loop,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    reason: escalationReason(detail),
  });

  return {
    status: 'awaiting-approval',
    loop: directive.loop,
    reason: escalationReason(detail),
    ...(options.id === undefined ? {} : { id: options.id }),
    promptPath: join(flowDir, '.heartbeat-prompt.md'),
    at: toIso(now),
  };
}

/**
 * Which slot this `loop worktree` call is about.
 *
 * THE OWNER'S LOCK DECIDES, not a flag the run passes. A run holds exactly one
 * slot and that slot IS its checkout, so deriving the path from the lock makes
 * the two the same fact rather than two that have to agree (allowed-pattern
 * #14) — a run cannot land in a sibling's worktree by spelling a number wrong,
 * because it never spells one.
 *
 * `--slot` overrides, for the case the lock cannot answer: a person pruning the
 * checkout of a run that has already ended.
 */
function worktreeSlot(
  options: LoopCommandOptions,
  flowDir: string,
  loop: string,
  now: number,
): number {
  const raw = options.slot?.trim();
  if (raw !== undefined && raw.length > 0) {
    if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
      throw new Error(`malformed --slot '${raw}' — expected a run slot of 1 or more`);
    }
    return Number.parseInt(raw, 10);
  }
  // AN UNNAMED CALLER CANNOT BE GIVEN A SLOT BY DEFAULT once a loop has more
  // than one. Falling back to slot 1 would hand a run working in slot 2 the
  // checkout slot 1's run is committing in — forbidden-pattern #11, reintroduced
  // by an omitted flag. A single-slot loop has nothing to be ambiguous about, so
  // it keeps answering exactly as it always has.
  if (options.owner === undefined) {
    const slots = readLoopDirective(flowDir, loop).maxConcurrentRuns;
    if (slots > 1) {
      throw new Error(
        `loop '${loop}' can run ${String(slots)} runs at once, so a worktree cannot be resolved without knowing which one is asking — pass the \`--owner\` from \`loop next\`, or \`--slot <n>\` to name a checkout directly`,
      );
    }
    return 1;
  }
  const held = lockHeldBy(readLoopState(flowDir, now), loop, options.owner, now);
  if (held === undefined) {
    // NO FALLBACK TO SLOT 1 (#1742). An owner whose lock expired mid-session
    // used to be answered with slot 1's path — the checkout a fresh gate may
    // already have handed to a sibling run, whose work the caller's next
    // `git reset --hard` then destroyed. The slot IS the lock; without a live
    // lock there is no slot to answer with.
    throw new Error(
      `run '${options.owner}' holds no live slot on loop '${loop}' — its lock expired or was released. Open the gate again (\`planflow-ai loop next --loop ${loop}\`) and resolve with the owner it answers, or name a checkout directly with \`--slot <n>\``,
    );
  }
  return held.slot;
}

/** The outcome of `loop worktree`. */
export type WorktreeVerbResult =
  | ({ status: 'ready' | 'created' | 'absent' } & WorktreeResolution)
  | ({ status: 'pruned' | 'absent' } & WorktreePrune);

/**
 * `loop worktree` — resolve a loop's checkout, creating it on first use, or
 * prune it.
 *
 * Resolving is what makes forbidden-pattern #11 structural rather than
 * aspirational: a headless run and an interactive terminal ask the same
 * question and get the same path, so two consumers never end up running
 * `git checkout` against one shared working tree.
 */
function runWorktree(options: LoopCommandOptions, runtime: Required<LoopRuntime>): WorktreeVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'worktree');
  // Read the directive first: a worktree for a loop that does not exist is a
  // directory nobody will ever clean up.
  readLoopDirective(flowDir, loop);
  const slot = worktreeSlot(options, flowDir, loop, runtime.clock());
  const input = { exec: runtime.exec, repoRoot: options.target, loop, slot };

  if (options.prune === true) {
    return pruneWorktree(input);
  }
  const base = defaultBase(runtime.exec, options.target);
  return resolveWorktree({
    ...input,
    base,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(alreadyPulled(options, runtime, loop, base) ? { fetch: false } : {}),
    ...(options.create === false ? { create: false } : {}),
  });
}

/**
 * Whether THIS run's gate already brought `base` current (#1625).
 *
 * The worktree shares the main checkout's ref store, so when the gate's
 * `git pull --ff-only` succeeded this run, `origin/<base>` is already the ref a
 * refresh would fetch — and the fetch is ~1s of pure negotiation for nothing. A
 * run's wake-up resolves more than once (the prompts tell it to re-enter the
 * gate), so this is paid several times per run.
 *
 * EVERY CONDITION IS A REASON TO STILL FETCH, and the default is to fetch:
 *
 *   - no `--owner` → this is a person at a terminal, not a run inside a window
 *   - no lock held by that owner → nothing establishes a window at all
 *   - the lock EXPIRED → the window closed; a pull from a dead run proves
 *     nothing about now
 *   - a different base → a pull of `main` says nothing about `release/x`
 *
 * Fail-soft: an unreadable state file reads as "no window", which is the
 * behaviour before this existed.
 */
function alreadyPulled(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  loop: string,
  base: string,
): boolean {
  const owner = options.owner?.trim() ?? '';
  if (owner.length === 0) return false;
  try {
    const now = runtime.clock();
    const state = readLoopState(flowDirOf(options), now);
    const held = state.loops[loop]?.locks?.find((lock) => lock.owner === owner);
    if (held?.pulled === undefined) return false;
    if (held.pulled.base !== base) return false;
    return Date.parse(held.expiresAt) > Number(now);
  } catch {
    // Sanctioned fail-soft: without a readable window there is no evidence to
    // skip on, and fetching is the direction that cannot be wrong.
    return false;
  }
}

/**
 * The branch the gate's pull just brought current (#1625) — the MAIN checkout's
 * current branch, i.e. whatever `pullCheckout` pulled. `main` when the checkout
 * is unreadable or detached, matching the repo's convention. This names what a
 * pull DID; the base a worktree refreshes to is `defaultBase`, never this.
 */
function checkoutBase(exec: LoopExec, target: string): string {
  try {
    const branch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], target).trim();
    return branch.length === 0 || branch === 'HEAD' ? 'main' : branch;
  } catch {
    return 'main';
  }
}

/**
 * The base branch a loop's worktree refreshes to (#1754) — the REPOSITORY'S
 * default branch, never the main checkout's incidental HEAD. The rule itself
 * lives with the worktrees, because a thread's checkout has to answer the same
 * question the same way (allowed-pattern #14).
 */
function defaultBase(exec: LoopExec, target: string): string {
  return defaultBaseBranch(exec, target);
}

/** The outcome of `loop push`. */
export interface PushVerbResult {
  status: 'pushed';
  loop: string;
  branch: string;
  remote: string;
  /** The PR that was opened, when one was asked for. */
  pr?: { url: string; base: string };
}

/**
 * The pull-request body, with the closing reference the backlog actually drains
 * through.
 *
 * `Closes #<n>` IS THE MECHANISM. A loop may not close an issue a person opened
 * — that is their record, and resolving someone's report for them is the
 * mutation this whole layer refuses. But a pull request that SAYS it closes the
 * issue makes GitHub do it on merge, in the user's own repo, attributed to the
 * change that actually fixed it. So the one place the loop writes the reference
 * is the body of its OWN pull request, where writing anything is unremarkable.
 *
 * Only for `queue: github`, where an id is an issue number; a ledger id means
 * nothing to GitHub. Never doubled — a body that already carries the reference is
 * left exactly as the run wrote it.
 */
export function pullRequestBody(body: string, id: string | undefined, queue: string): string {
  const issue = id?.trim() ?? '';
  if (queue !== 'github' || issue.length === 0) return body;
  const reference = `Closes #${issue}`;
  if (new RegExp(`(?:closes|fixes|resolves)\\s+#${issue}\\b`, 'i').test(body)) return body;
  return body.trim().length === 0 ? reference : `${body.trimEnd()}\n\n${reference}`;
}

/**
 * `loop push` — the ONE seam a loop's work leaves through.
 *
 * The carve-out is checked BEFORE anything is executed (`push-guard.ts` owns
 * the rule), so a refused push has run no git at all: no `--dry-run` that
 * already wrote, no half-open PR. That ordering is the whole reason this is a
 * verb rather than a note in a run prompt — a prompt can be talked out of a
 * rule, an early return cannot.
 */
async function runPush(options: LoopCommandOptions, runtime: Required<LoopRuntime>): Promise<PushVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'push');
  const directive = readLoopDirective(flowDir, loop);
  const branch = options.branch?.trim() ?? '';
  const remote = options.remote?.trim() ?? 'origin';
  const base = options.base?.trim() ?? 'main';

  // A NON-LOOP BRANCH IS OWNED ONLY IN AN ITEM CONTEXT (D3, FR-8, and the
  // guardrail the loop.test.ts push suite enforces). A consumer publishing on
  // `feat/<ticket>` for the item it holds (`--id`) is declaring it owns that
  // branch — push is where ownership is recorded, and `loop merge` is where it
  // is enforced. WITHOUT an `--id` there is no item to own a branch FOR, so a
  // bare `loop push --branch feat/anything` stays refused exactly as before:
  // that is what keeps a loop from pushing to a colleague's feature branch. A
  // `loop/*` branch needs none of this — its name still says who owns it — and a
  // trunk name is refused by the guard whatever is passed.
  const ownedBranch =
    options.id !== undefined && !isLoopRef(normalizeRef(branch)) ? branch : null;

  const refusal = pushRefusal(branch, ownedBranch);
  if (refusal !== null) {
    throw new Error(refusal);
  }
  if (options.pr === true) {
    const prProblem = prRefusal(branch, base, ownedBranch);
    if (prProblem !== null) {
      throw new Error(prProblem);
    }
  }

  // Record ownership before the network act, keyed by backend+id like the rest
  // of the store, so `loop merge` reads back who owns this branch.
  if (ownedBranch !== null && options.id !== undefined) {
    new ForeignItemStore(foreignItemsPath(flowDir)).append({
      ts: toIso(runtime.clock()),
      backend: directive.queue,
      id: options.id,
      loop: directive.loop,
      event: 'branched',
      branch: ownedBranch,
    });
  }

  runtime.exec('git', ['push', '--set-upstream', remote, branch], options.target);

  const result: PushVerbResult = { status: 'pushed', loop: directive.loop, branch, remote };
  if (options.pr === true) {
    const title = options.title?.trim() ?? `${directive.loop}: ${branch}`;
    const body = pullRequestBody(await flagOrStdin(options.body), options.id, directive.queue);
    const url = runtime
      .exec(
        'gh',
        ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body],
        options.target,
      )
      .trim();
    result.pr = { url, base };

    // THE RECORD THAT MAKES A STRANDED PULL REQUEST CHECKABLE. Opening one is
    // half of landing an item; the run log is where the other half is proven to
    // have happened, and without this entry "did anyone merge it" is a question
    // only GitHub could answer and nothing ever asked.
    appendRunLogEntry(flowDir, {
      ts: toIso(runtime.clock()),
      kind: 'push',
      loop: directive.loop,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...(options.id === undefined ? {} : { item: options.id }),
      reason: `pull request opened for ${branch}${options.id === undefined ? '' : ` (item ${options.id})`} — ${url}`,
    });
  }
  return result;
}

/** The pull request a merge acts on, as `gh` resolved it. */
interface ResolvedPullRequest {
  number: string;
  /** The branch the pull request really proposes — the ref this verb validates. */
  head: string;
  /** GitHub's own state (`OPEN` / `MERGED` / `CLOSED`), upper-cased. */
  state: string;
  url: string;
}

/**
 * Read `gh pr view --json` defensively (allowed-pattern #11) — the fields are
 * requested by name, but a missing head or number is refused rather than guessed
 * at, because both are what the merge is about to be authorized against.
 */
function parsePullRequest(stdout: string, branch: string): ResolvedPullRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().length === 0 ? '{}' : stdout);
  } catch {
    throw new Error(`gh pr view returned unparseable JSON for '${branch}'`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gh pr view returned no pull request for '${branch}'`);
  }
  const record = parsed as Record<string, unknown>;
  const head = typeof record.headRefName === 'string' ? record.headRefName : '';
  const number =
    typeof record.number === 'number'
      ? String(record.number)
      : typeof record.number === 'string'
        ? record.number
        : '';
  if (head.length === 0 || number.length === 0) {
    throw new Error(`gh pr view returned no pull request for '${branch}'`);
  }
  return {
    number,
    head,
    state: (typeof record.state === 'string' ? record.state : '').toUpperCase(),
    url: typeof record.url === 'string' ? record.url : '',
  };
}

/**
 * Run one `gh` command, turning a failure into ONE bounded refusal line.
 *
 * `gh` fails at length — a protected-branch rejection is a paragraph, and an
 * unauthenticated one is a paragraph with a URL in it. The refusal contract is a
 * single line, so the collapse happens here rather than at the point where a
 * page of stderr has already been printed.
 */
function ghOrRefuse(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  args: readonly string[],
  what: string,
): string {
  try {
    return runtime.exec('gh', args, options.target);
  } catch (error) {
    throw new Error(
      `${what} failed: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/** The outcome of `loop merge`. */
export interface MergeVerbResult {
  status: 'merged';
  loop: string;
  /** The queue item whose fix this landed. */
  id: string;
  branch: string;
  pr: { number: string; url: string };
  /** The evidence the merge was gated on, echoed so the proof is in the output. */
  evidence: CloseEvidence;
  /** The item after the merge was recorded on it. */
  item: QueueItem;
  /**
   * Where the record went and what closes the issue, when the item was filed by
   * a person and therefore took no comment. Absent otherwise.
   */
  note?: string;
  at: string;
}

/**
 * `loop merge` — land the branch this loop pushed, and record what landed it.
 *
 * THE LARGEST THING A LOOP MAY DO UNATTENDED, so it is the shortest leash in the
 * feature. Four gates run BEFORE anything is executed, in this order, and every
 * one of them refuses with a single line having run no command at all:
 *
 *   1. THE BRANCH is inside this loop's OWN namespace (`mergeRefusal`). Not the
 *      carve-out — the namespace. `loop/other/12` is another loop's work, and a
 *      human's branch is not even close.
 *   2. THE EVIDENCE clears the merge bar (`mergeEvidenceRefusal`): a typecheck, a
 *      build and the targeted tests, every recorded command exited 0. Prose is
 *      refused here exactly as it is by `close`.
 *   3. THE LOOP MAY WORK THE ITEM (`engineWorkBlocker`). A consumer drains the
 *      queue, so it may land a fix for anything in it; a producer still may not.
 *      What a person's item does NOT get is the merge comment — the record goes
 *      into local state and the issue closes on the pull request's `Closes #<n>`.
 *   4. THE CLAIM IS THIS BEAT'S, mirroring `close`: a late finisher must not land
 *      work the run that took over from it is still doing.
 *
 * THEN, AND ONLY THEN, the network — and even there the branch is checked a
 * second time against the ref `gh` says the pull request actually proposes. The
 * first check is on a string the caller handed in; this one is on the resolved
 * head, which is the thing that would really be merged.
 *
 * NOT REACHABLE FROM `close`, and `close` is not reachable from here. Landing
 * the branch and settling the item are two decisions with two gates, and a merge
 * that closed on its own would let the close's evidence rule be skipped by
 * merging instead.
 *
 * NOT BUDGET-GATED, for the reason `close` is not: it finishes work already in
 * hand, and a run that pushed a branch and then could not land it has left the
 * job exactly as half-done as before this verb existed.
 */
async function runMerge(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): Promise<MergeVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'merge');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'merge');
  const branch = options.branch?.trim() ?? '';
  const owner = options.owner?.trim() === '' ? undefined : options.owner?.trim();

  // OWNERSHIP OF A NON-LOOP BRANCH COMES FROM THE STORE, NOT THE NAME (C-2). The
  // record's own `loop` must be THIS loop, or the branch it names is not ours to
  // merge — that guard is what stops one loop landing another's `feat/*`. A
  // `loop/*` head does not need it: `mergeRefusal` still reads its owner from the
  // name, and `ownedBranch` stays null.
  const ownershipRecord = new ForeignItemStore(foreignItemsPath(flowDir))
    .snapshot()
    .get(foreignKey(directive.queue, id));
  const ownedBranch =
    ownershipRecord?.loop === directive.loop ? (ownershipRecord?.branch ?? null) : null;

  const headProblem = mergeRefusal(branch, directive.loop, ownedBranch);
  if (headProblem !== null) {
    throw new Error(headProblem);
  }
  const evidence = parseEvidence(await flagOrStdin(options.evidence));
  const evidenceProblem = mergeEvidenceRefusal(evidence);
  if (evidenceProblem !== null) {
    throw new Error(evidenceProblem);
  }

  // The item is read across the WHOLE queue rather than this loop's slice: an
  // item filed by a person carries no loop, so a scoped read would answer "no
  // such item" where the honest answer is "that one is not yours".
  const { backend } = openQueue(options, directive, runtime.clock, 'merge');
  const item = backend.byId(id);
  if (item === null) {
    throw new Error(`no item '${id}' in the queue`);
  }
  const foreign = engineWorkBlocker(directive.engine, item, 'merge', directive.loop);
  if (foreign !== null) {
    throw new Error(foreign);
  }
  if (item.claimedBy !== undefined && owner !== undefined && item.claimedBy !== owner) {
    throw new Error(`item ${item.id} is claimed by '${item.claimedBy}' — '${owner}' cannot merge it`);
  }
  // An item settled as `wontfix` or `duplicate` is a decision NOT to do the
  // work; landing a branch for it would overrule that decision silently. A
  // `done` close is the ordinary case and passes — closing and merging are
  // separate acts, and either order is legitimate.
  if (item.state === 'closed' && item.closeReason !== undefined && item.closeReason !== 'done') {
    throw new Error(
      `item ${item.id} was closed as '${item.closeReason}' — landing a branch for it would overrule that decision`,
    );
  }

  const pr = parsePullRequest(
    ghOrRefuse(
      options,
      runtime,
      ['pr', 'view', branch, '--json', 'number,headRefName,state,url'],
      `gh pr view ${branch}`,
    ),
    branch,
  );
  if (pr.state !== 'OPEN') {
    throw new Error(
      `pull request #${pr.number} for '${branch}' is ${pr.state.toLowerCase() || 'unreadable'} — only an open pull request can be merged`,
    );
  }
  // The RESOLVED head, re-checked. Everything above validated a string the
  // caller wrote; this validates the ref that would actually land, so a branch
  // name that resolves to somebody else's pull request stops here.
  if (normalizeRef(pr.head) !== normalizeRef(branch)) {
    throw new Error(
      `pull request #${pr.number} proposes '${pr.head}', not '${branch}' — a loop merges only the branch it pushed`,
    );
  }
  const resolvedProblem = mergeRefusal(pr.head, directive.loop, ownedBranch);
  if (resolvedProblem !== null) {
    throw new Error(resolvedProblem);
  }

  // Squash, because one landed commit per item is what makes the history line
  // up with the queue. No `--delete-branch`: the push carve-out refuses a branch
  // deletion outright, and merging is not the place to acquire that power.
  ghOrRefuse(options, runtime, ['pr', 'merge', pr.number, '--squash'], `gh pr merge ${pr.number}`);

  const now = runtime.clock();
  // Past the gates, the evidence is known to exist — it is what got here.
  const landed = evidence as CloseEvidence;
  const recorded = backend.recordMerge({
    id: item.id,
    loop: directive.loop,
    ...(owner === undefined ? {} : { owner }),
    branch,
    pr: { number: pr.number, url: pr.url },
    evidence: landed,
  });
  if (recorded.status === 'refused') {
    throw new Error(recorded.reason);
  }

  // The one line in the run log that says a loop changed the default branch.
  appendRunLogEntry(flowDir, {
    ts: toIso(now),
    kind: 'merge',
    loop: directive.loop,
    ...(owner === undefined ? {} : { owner }),
    item: item.id,
    reason: `item ${item.id} merged — ${branch} via PR #${pr.number}`,
  });

  return {
    status: 'merged',
    loop: directive.loop,
    id: item.id,
    branch,
    pr: { number: pr.number, url: pr.url },
    evidence: landed,
    item: recorded.item,
    ...(recorded.note === undefined ? {} : { note: recorded.note }),
    at: toIso(now),
  };
}

/** The outcome of `loop file`. `duplicate` is an ordinary result, not an error. */
export interface FileVerbResult {
  status: 'filed' | 'duplicate';
  loop: string;
  item: QueueItem;
}

/** `loop file` — file a finding, subject to dedup and the cap. */
/**
 * Refuse to file once this run's instruction has reached its stop rule.
 *
 * ENFORCED HERE RATHER THAN ASKED OF THE PROMPT: a guard rail only the prompt
 * honours is a guard rail that drifts (allowed-pattern #14). An instruction that
 * has stopped takes no NEW work; everything already in hand still finishes. It
 * is the ONLY thing standing between `loop file` and an unbounded hunt — the run
 * budget that used to sit beside it went with Phase 6.
 *
 * TWO RULES, ONE PLACE. The backstop and the clock are both asked through
 * `instructionStopReached`, so "when does this hunt stop filing" is answered
 * identically here, in `recordInstructionRun`, and by every surface that reads
 * the store. A `custom` rule is deliberately NOT enforced here: judging a
 * sentence is the agent's job, and it reports the verdict with `loop finish
 * --rule-met`, which the `status !== 'active'` check below then honours.
 */
function requireInstructionRoom(
  options: LoopCommandOptions,
  flowDir: string,
  loop: string,
  now: number,
): void {
  const aim = runLock(readLoopState(flowDir, now), loop, options.owner, now)?.focus;
  if (aim === undefined) return;
  const instruction = findInstruction(readInstructions(flowDir), aim);
  if (instruction === undefined) return;

  const carryOn = `to carry on after looking: loop resume --loop <loop> --focus '${instruction.text}'`;
  // The AGENT's verdict, already recorded. Checked first because a hunt whose
  // own rule came true has finished for a reason the person wrote down, and
  // reporting it as "out of room" would name the backstop instead.
  if (instruction.status === 'met' && instruction.stop?.kind === 'custom') {
    throw new Error(
      `instruction '${instruction.text}' has finished — its own rule came true ('${instruction.stop.rule}'). Stop here and let a person look at what is in the list (${carryOn})`,
    );
  }
  const reached = instructionStopReached(instruction, toIso(now));
  if (reached === null) return;
  if (reached === 'elapsed') {
    const stop = instruction.stop;
    const window = stop?.kind === 'duration' ? `${String(stop.hours)}h, ended ${stop.until}` : 'its window';
    throw new Error(
      `instruction '${instruction.text}' has run out its time (${window}) after filing ${String(instruction.filed)} — stop here and let a person look at what is in the list (${carryOn})`,
    );
  }
  throw new Error(
    `instruction '${instruction.text}' has filed ${String(instruction.filed)} of ${String(instruction.cap)} — stop here and let a person look at what is already in the list (${carryOn})`,
  );
}

async function runFile(options: LoopCommandOptions, runtime: Required<LoopRuntime>): Promise<FileVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'file');
  const directive = readLoopDirective(flowDir, loop);
  const title = requireFlag(options.title, '--title <text>', 'file');
  // BEFORE the queue is touched: a refused file has written nothing at all.
  requireInstructionRoom(options, flowDir, directive.loop, runtime.clock());
  const { backend } = openQueue(options, directive, runtime.clock, 'file');

  const labels = [
    ...(directive.label === undefined ? [] : [directive.label]),
    ...(options.labels ?? '')
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label.length > 0),
  ];

  const result = backend.file({
    loop: directive.loop,
    title,
    body: await flagOrStdin(options.body),
    ...(options.file === undefined ? {} : { primaryFile: options.file }),
    labels,
    // The topic comes from the DIRECTIVE, never from a flag: a headless run has
    // no way to know what a loop is pointed at except by reading the file that
    // says so, and a per-run override would let two runs of one loop file
    // under different areas.
    ...(directive.topic === undefined ? {} : { topic: directive.topic }),
    // APPROVAL IS A PROPERTY OF THE TASK, NOT OF THE LOOP THAT FILED IT.
    // It used to be loop-wide, which is why "improve" had to be its own loop:
    // its findings were taste and needed a human, while a reproduced crash did
    // not. With one producer filing both, the distinction moves to the item —
    // the flag decides, and the directive's value is only the default for a
    // run that does not say.
    needsApproval: options.needsApproval ?? directive.needsApproval,
    maxOpenIssues: directive.maxOpenIssues,
  });

  if (result.status === 'refused') {
    throw new Error(result.reason);
  }

  // THE GUARD RAIL, ENFORCED WHERE FILING HAPPENS. An instruction like "find UI
  // improvements" has no natural end — an agent will keep producing plausible
  // findings forever, and two hundred open tickets is worse than none. The cap
  // stops the hunt while the list is still readable and hands it back to a
  // person. Counted only for something NEW: a duplicate is evidence the hunt is
  // running out, not a finding.
  const aim = runLock(readLoopState(flowDir, runtime.clock()), directive.loop, options.owner, runtime.clock())?.focus;
  if (aim !== undefined && result.status === 'filed') {
    const store = recordInstructionRun(readInstructions(flowDir), aim, 1, toIso(runtime.clock()));
    writeInstructions(flowDir, store);
  }
  return { status: result.status, loop: directive.loop, item: result.item };
}

/**
 * The outcome of `loop claim`. `empty` is a quiet queue and `lost` is a rival
 * run getting there first — neither is a failure, and both exit 0.
 */
export interface ClaimVerbResult {
  status: 'claimed' | 'empty' | 'lost';
  loop: string;
  owner: string;
  reason?: string;
  item?: QueueItem;
}

/** `loop claim` — claim work, subject to the eligibility rules. */
/**
 * Parse a comma-separated id list — `--skip 1533,1540`.
 *
 * Empty entries are dropped rather than refused (a trailing comma is a typo, not
 * an instruction), but a value with no usable id at all refuses: a run that
 * meant to pass over something and silently passed over nothing would be handed
 * the same head it was stepping around.
 */
function parseIdList(raw: string | undefined, flag: string): string[] {
  if (raw === undefined) return [];
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0 && raw.trim().length > 0) {
    throw new Error(`malformed --${flag} '${raw}' — expected one or more comma-separated item ids`);
  }
  return [...new Set(ids)];
}

function runClaim(options: LoopCommandOptions, runtime: Required<LoopRuntime>): ClaimVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'claim');
  const directive = readLoopDirective(flowDir, loop);
  const { backend } = openQueue(options, directive, runtime.clock, 'claim');
  const owner = resolveOwner(options, runtime.clock());

  const skip = parseIdList(options.skip, 'skip');
  const result = backend.claim({
    owner,
    loop: directive.loop,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(skip.length === 0 ? {} : { skip }),
  });

  if (result.status === 'refused') {
    throw new Error(result.reason);
  }
  if (result.status === 'empty') {
    return { status: 'empty', loop: directive.loop, owner, reason: result.reason };
  }
  // LOST IS NOT AN ERROR. Another engineer's run took this item between the read
  // and the write; the run's next move is the next task, not a stop. Exiting
  // non-zero here would turn a rival's success into this loop's failure, and a
  // run reported as failed is a run a person is asked to come and look at.
  if (result.status === 'lost') {
    return {
      status: 'lost',
      loop: directive.loop,
      owner,
      reason: result.reason,
      item: result.item,
    };
  }
  return { status: 'claimed', loop: directive.loop, owner, item: result.item };
}

/** The outcome of `loop adopt`. */
export interface AdoptVerbResult {
  status: 'adopted';
  loop: string;
  id: string;
  /** The written reason, echoed so the caller sees what was recorded. */
  detail: string;
  item: QueueItem;
}

/**
 * `loop adopt` — a person hands the loop an item the loop did not file.
 *
 * THE ONLY WAY A FOREIGN ITEM EVER BECOMES WORKABLE, and it is not on the path
 * a run walks. `claim` has no flag that reaches it; this verb refuses outright
 * while a run holds the loop (`requireNoRun`); and the run prompt never names
 * it. The rule the incident needed was not "ask before adopting" — an agent can
 * always talk itself into having asked — it was that adoption is somebody else's
 * act entirely.
 *
 * `--detail` IS REQUIRED. Adoption overrides the system's own judgment about
 * whose work this is, and an override with no reason recorded is indistinguishable
 * from a mistake six weeks later.
 */
function runAdopt(options: LoopCommandOptions, runtime: Required<LoopRuntime>): AdoptVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'adopt');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'adopt');
  const detail = requireFlag(options.detail, '--detail <why>', 'adopt');
  const now = runtime.clock();
  // BEFORE the queue is touched: a refused adoption has read nothing and
  // written nothing, so the item is exactly as its author left it.
  requireNoRun(options, directive, 'adopt', now);
  const { backend } = openQueue(options, directive, runtime.clock, 'adopt');

  const result = backend.adopt({ id, loop: directive.loop, detail });
  if (result.status === 'refused') {
    throw new Error(result.reason);
  }

  // Recorded where a person auditing the loop reads: the moment the loop was
  // given something it could not have taken.
  appendRunLogEntry(flowDir, {
    ts: toIso(now),
    kind: 'adopt',
    loop: directive.loop,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    reason: `item ${id} adopted — ${detail}`,
  });

  return { status: 'adopted', loop: directive.loop, id, detail, item: result.item };
}

/** The outcome of `loop unclaim`. Releasing what nobody held is success. */
export interface UnclaimVerbResult {
  status: 'unclaimed';
  loop: string;
  id: string;
  /** False when the item was not claimed in the first place. */
  wasClaimed: boolean;
  /** True when the released claim was another run's, abandoned past the TTL. */
  tookOverAbandoned: boolean;
  item: QueueItem;
}

/**
 * `loop unclaim` — give a claimed item back to the queue.
 *
 * ONE OF THE THREE HONEST ENDINGS of a claim: closing is `loop close`, handing
 * off is a pipeline stage still in flight, and this is releasing. It used to be
 * reachable only from inside the stalled-pipeline cleanup, and since Phase 6
 * deleted that cleanup it is the ONLY way a claim gets released without being
 * closed. A run that claimed something it turns out not to be doing — the item
 * is not real work, the session is ending, a human took it over — must be able
 * to say so, or its only alternatives are a dishonest close and a ghost claim
 * nobody can see.
 *
 * The ownership check is the backend's (`unclaim` refuses another owner's
 * claim), so a late finisher still cannot release the run that took over —
 * until that run's lock has expired, which is what the loop's TTL is passed in
 * to decide. Past it there is nobody left to protect, and without the override
 * the item is stranded for good: `loop status` reports the abandoned claim, and
 * no verb in the family can act on it.
 */
function runUnclaim(options: LoopCommandOptions, runtime: Required<LoopRuntime>): UnclaimVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'unclaim');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'unclaim');
  const { backend } = openQueue(options, directive, runtime.clock, 'unclaim');

  const result = backend.unclaim(
    id,
    options.owner?.trim() === '' ? undefined : options.owner,
    directive.loop,
    lockTtlMs(directive.maxRunMinutes),
  );
  if (result.status === 'refused') {
    throw new Error(result.reason);
  }
  return {
    status: 'unclaimed',
    loop: directive.loop,
    id,
    wasClaimed: result.wasClaimed,
    tookOverAbandoned: result.tookOverAbandoned ?? false,
    item: result.item,
  };
}

/** The outcome of `loop plan`. Clearing the record is the same verb. */
export interface PlanVerbResult {
  status: 'recorded';
  loop: string;
  id: string;
  /** What the item now carries — '' when the record was cleared. */
  plan: string;
  item: QueueItem;
}

/**
 * `loop plan` — record on the claimed item which plan's pipeline this run is
 * advancing.
 *
 * THE HANDOFF, MADE STRUCTURAL (#1599). A consumer run remembers nothing between
 * runs, so the next one has to learn what is in flight from disk — and the only
 * record was `flow/STATE.md`, a file a prompt had to remember to write and five
 * skills were told to delete on completion. The run holds the item; the item is
 * read by whoever picks it up next; so the plan name goes on the item.
 *
 * A RUN'S OWN VERB, unlike `adopt` and `rework`: entering a pipeline stage is
 * exactly what a run does, and the run is the only thing that knows the plan's
 * name at the moment it is created. Every rule about WHO may record it, WHAT a
 * plan name may look like and WHERE it lands for a person's item lives in the
 * backend, not here (allowed-pattern #14).
 */
function runPlan(options: LoopCommandOptions, runtime: Required<LoopRuntime>): PlanVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'plan');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'plan');
  const { backend } = openQueue(options, directive, runtime.clock, 'plan');

  const owner = options.owner?.trim() ?? '';
  const result = backend.recordPlan({
    id,
    loop: directive.loop,
    ...(options.plan === undefined ? {} : { plan: options.plan }),
    ...(owner.length === 0 ? {} : { owner }),
  });
  if (result.status === 'refused') {
    throw new Error(result.reason);
  }
  return { status: 'recorded', loop: directive.loop, id, plan: result.plan, item: result.item };
}

/** Parse the evidence payload, refusing rather than closing on an unreadable one. */
function parseEvidence(raw: string): CloseEvidence | undefined {
  if (raw.trim().length === 0) return undefined;
  const parsed = parseJsonArg(raw, 'evidence');
  return parsed as unknown as CloseEvidence;
}

/** The outcome of `loop close`. */
export interface CloseVerbResult {
  /**
   * `handled` when the item was filed by a person: the evidence gate ran, the
   * claim label came off, and NOTHING else was written — the issue stays open
   * until GitHub closes it on the merge. Reporting that as `closed` would be the
   * loop claiming an act it deliberately did not perform.
   */
  status: 'closed' | 'handled';
  loop: string;
  reason: string;
  item: QueueItem;
  /** What was and was not written, on a `handled` outcome. Absent otherwise. */
  note?: string;
  /**
   * How many items are still claimable, counted AFTER this one was settled.
   *
   * THE HANDOFF TO THE NEXT TASK, in the reply the run already reads. Finishing
   * an item is the exact moment a run decides whether it is done, and until now
   * that decision was made against nothing: the close reply said what happened
   * to this item and stopped, so "is there more?" was a question the run had to
   * think to ask. Runs stopped at one item for exactly that long. The count is
   * the answer, delivered unasked.
   */
  remaining: number;
}

/**
 * `loop close` — close an item, subject to the evidence gate.
 *
 * The gate itself lives in `validateCloseEvidence` (Phase 2) and is reached
 * through the backend, so this verb cannot weaken it: a `done` close without
 * captured exit codes refuses here for the same reason it refuses everywhere —
 * including for the person's item that comes back `handled` rather than closed.
 */
async function runClose(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): Promise<CloseVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'close');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'close');
  const reason = requireFlag(options.reason, '--reason <done|wontfix|duplicate>', 'close');
  if (!isQueueCloseReason(reason)) {
    throw new Error(`unknown close reason '${reason}' — expected done|wontfix|duplicate`);
  }

  const evidence = parseEvidence(await flagOrStdin(options.evidence));
  const { backend } = openQueue(options, directive, runtime.clock, 'close');
  const result = backend.close({
    id,
    reason,
    loop: directive.loop,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(evidence === undefined ? {} : { evidence }),
  });

  if (result.status === 'refused') {
    throw new Error(result.reason);
  }
  // Counted after the close, so it answers "what is left for me now" rather than
  // "what was there when I started". A queue that cannot be re-read reports 0
  // — the run's own gate is what actually stops it, and a failed count must not
  // turn a successful close into a failure.
  let remaining = 0;
  try {
    remaining = backend.count({ loop: directive.loop }).claimable;
  } catch {
    remaining = 0;
  }
  return {
    status: result.status,
    loop: directive.loop,
    reason,
    item: result.item,
    ...(result.status === 'handled' ? { note: result.note } : {}),
    remaining,
  };
}

/** The outcome of `loop rework`. */
export interface ReworkVerbResult {
  status: 'reworked';
  loop: string;
  id: string;
  /** The written reason, echoed so the caller sees what was recorded. */
  detail: string;
  item: QueueItem;
}

/**
 * `loop rework` — a person says a fix did not hold, so the loop may work the
 * item again.
 *
 * THE OTHER HALF OF THE HANDLED RECORD. A loop that finishes with an item it did
 * not file writes nothing on the issue — it stays open until the pull request
 * merges — so a local record is what stops the next run re-claiming and
 * re-fixing it. A record with no way to clear it would be a permanent verdict
 * from a machine, which is why this verb exists.
 *
 * A PERSON'S ACT, structurally, exactly like `adopt`: `requireNoRun` refuses it
 * while a run holds the loop, so a run cannot clear the record that is
 * currently stopping it from repeating itself. `--detail` is required for the
 * same reason adoption's is — an override nobody explained is indistinguishable
 * from a mistake six weeks later.
 */
function runRework(options: LoopCommandOptions, runtime: Required<LoopRuntime>): ReworkVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'rework');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'rework');
  const detail = requireFlag(options.detail, '--detail <why>', 'rework');
  const now = runtime.clock();
  requireNoRun(options, directive, 'rework', now);
  const { backend } = openQueue(options, directive, runtime.clock, 'rework');

  const result = backend.rework({ id, loop: directive.loop, detail });
  if (result.status === 'refused') {
    throw new Error(result.reason);
  }

  appendRunLogEntry(flowDir, {
    ts: toIso(now),
    kind: 'rework',
    loop: directive.loop,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    reason: `item ${id} released for rework — ${detail}`,
  });

  return { status: 'reworked', loop: directive.loop, id, detail, item: result.item };
}

/** The outcome of `loop approve`. Repeating one is success, not an error. */
export interface ApproveVerbResult {
  status: 'approved';
  loop: string;
  alreadyApproved: boolean;
  item: QueueItem;
}

/** `loop approve` — clear one item's approval gate. */
function runApprove(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): ApproveVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'approve');
  const directive = readLoopDirective(flowDir, loop);
  const id = requireFlag(options.id, '--id <id>', 'approve');
  const { backend } = openQueue(options, directive, runtime.clock, 'approve');

  const result = backend.approve(id, options.owner);
  if (result.status === 'refused') {
    throw new Error(result.reason);
  }

  // An approval is the one moment a human overrides the loop; the log is where
  // that shows up next to the runs it unblocked.
  if (!result.alreadyApproved) {
    appendRunLogEntry(flowDir, {
      ts: toIso(runtime.clock()),
      kind: 'approve',
      loop: directive.loop,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      reason: `item ${id} approved`,
    });
  }

  return {
    status: 'approved',
    loop: directive.loop,
    alreadyApproved: result.alreadyApproved,
    item: result.item,
  };
}

/**
 * Parse a pause expiry: an ISO timestamp, or `+<n>[mhd]` relative to now.
 * Anything else refuses — a misread expiry either lifts a pause nobody lifted
 * or holds one nobody set.
 */
export function parseUntil(value: string, now: number): number {
  const relative = value.trim().match(/^\+(\d+)([mhd])$/);
  if (relative !== null) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000;
    return now + amount * unit;
  }
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw new Error(`malformed --until '${value}' — expected an ISO timestamp or +<n>[mhd]`);
  }
  return parsed;
}

/** The outcome of `loop pause` / `loop resume`. */
export interface PauseVerbResult {
  status: 'paused' | 'resumed';
  /** `global` stops every loop; `loop` stops only the named one. */
  scope: 'global' | 'loop';
  /** The loop, or '' for a global pause. */
  loop: string;
  reason: string;
  at: string;
  until?: string;
}

/** `loop pause` — stop one loop, or every loop when no `--loop` is given. */
function runPause(options: LoopCommandOptions, runtime: Required<LoopRuntime>): PauseVerbResult {
  const flowDir = flowDirOf(options);
  const loop = options.loop?.trim() ?? '';
  // A pause with no reason is indistinguishable from a bug three days later.
  const reason = requireFlag(options.detail ?? options.reason, '--reason <text>', 'pause');
  const now = runtime.clock();
  const until = options.until === undefined ? undefined : parseUntil(options.until, now);

  mutateLoopState(
    flowDir,
    (state) =>
      loop.length === 0
        ? withGlobalPause(state, { reason, ...(until === undefined ? {} : { until }) }, now)
        : withLoopPause(state, loop, { reason, ...(until === undefined ? {} : { until }) }, now),
    now,
  );

  const entry: RunLogEntry = { ts: toIso(now), kind: 'pause', loop, reason };
  appendRunLogEntry(flowDir, entry);

  return {
    status: 'paused',
    scope: loop.length === 0 ? 'global' : 'loop',
    loop,
    reason,
    at: toIso(now),
    ...(until === undefined ? {} : { until: toIso(until) }),
  };
}

/**
 * `loop resume` — lift a pause.
 *
 * IT ONLY LIFTS THE PAUSE NOW. It used to also zero the consecutive-failure
 * counter, because a tripped breaker would otherwise re-trip on the next single
 * failure and read as "resume did nothing". Phase 6 deleted the breaker, so
 * there is nothing left to reset — and an `awaiting-approval` escalation is a
 * pause like any other, which is what this still lifts.
 */
function runResume(options: LoopCommandOptions, runtime: Required<LoopRuntime>): PauseVerbResult {
  const flowDir = flowDirOf(options);
  const loop = options.loop?.trim() ?? '';
  const reason = (options.detail ?? options.reason ?? 'resumed').trim();
  const now = runtime.clock();
  const focus = options.focus === undefined ? undefined : normalizeFocus(options.focus);

  // Read through the failure-aware reader BEFORE mutating anything: fail-soft
  // (corrupt → empty) plus the stop/start/write below would REPLACE an
  // unreadable store with one holding only the resumed hunt, losing every
  // other recoverable hunt — the loss #1704 fixed for `forget`, one verb over.
  // Refusing up here also keeps the verb atomic: the pause is not lifted and
  // the breaker not reset when the focus half of the verb cannot happen.
  // A MISSING file is still the empty store, and still a success.
  let instructionStore: InstructionStore | undefined;
  if (focus !== undefined) {
    const read = readInstructionsResult(flowDir);
    if (read.store === null) {
      throw new Error(
        `resume refused: ${instructionsPath(flowDir)} is unreadable (${read.error}) — fix or remove the file; nothing was written`,
      );
    }
    instructionStore = read.store;
  }

  mutateLoopState(
    flowDir,
    (state) => (loop.length === 0 ? withoutGlobalPause(state) : withoutLoopPause(state, loop)),
    now,
  );

  // A FOCUS MAKES THIS THE INSTRUCTION'S RESUME TOO (#1578). Now that retyping a
  // capped hunt no longer zeroes it, a person who HAS looked at the list needs a
  // way to say so — and this is the verb that already means "I looked, carry
  // on". It stops the instruction first, which is the one status documented as a
  // person's decision, and then starts it again: the restart-at-zero path is
  // reached only through a human act, never through a re-invocation that happens
  // to type the same sentence.
  if (focus !== undefined && instructionStore !== undefined) {
    const stopped = stopInstruction(instructionStore, focus);
    const restarted = startInstruction(
      stopped,
      focus,
      toIso(now),
      parseInstructionCap(options.cap),
      // Resolved against THIS instant, so a `duration` hunt's window starts when
      // the person started it rather than whenever the sentence was first typed.
      parseInstructionStop(options, toIso(now)),
    );
    writeInstructions(flowDir, restarted.store);
  }

  appendRunLogEntry(flowDir, { ts: toIso(now), kind: 'resume', loop, reason });

  return {
    status: 'resumed',
    scope: loop.length === 0 ? 'global' : 'loop',
    loop,
    reason,
    at: toIso(now),
  };
}

/** The outcome of `loop enable` / `loop disable`. Setting what is already set is success. */
export interface DirectiveVerbResult {
  /** What the directive says NOW — the state the caller asked for, either way. */
  status: 'enabled' | 'disabled';
  loop: string;
  /** What `paused:` now reads. `disable` sets it true; `enable` sets it false. */
  paused: boolean;
  /** What it read before. Equal to `paused` when the file already said this. */
  wasPaused: boolean;
  /** False when the directive already read that way and nothing was written. */
  changed: boolean;
  /** The directive file, in the home it was actually found in. */
  path: string;
}

/**
 * `loop disable` / `loop enable` — turn a loop off, or back on, in its
 * DIRECTIVE.
 *
 * THE SECOND PAUSE, WHICH UNTIL NOW HAD NO WRITER. A loop can be stopped two
 * ways and they are different facts:
 *
 *   - `loop pause` writes `state.json` — local, expiring, forgotten with the
 *     file. It stops the runs on THIS machine until someone resumes them.
 *   - `paused: true` in `loops/<name>.md` is committed intent. It travels with
 *     the repo, survives a lost state file, and outranks everything at the gate.
 *
 * Only the first had a verb, so the second was reachable only by hand-editing
 * markdown — which is why the IDE's loops panel had to tell a person to go and
 * edit a file instead of offering them a button. This is that button's write.
 *
 * These verbs touch NO runtime state. Disabling a loop does not also pause it,
 * and enabling one does not lift a `loop pause` that is standing — a person who
 * set two stops has to lift both, because they meant two different things. A run
 * already in flight is not interrupted either: the directive is read at the gate
 * that opens a run, so this takes effect on the next one (`loop pause` is the
 * verb for stopping what is running now).
 */
function runDirectivePause(
  options: LoopCommandOptions,
  paused: boolean,
): DirectiveVerbResult {
  const verb = paused ? 'disable' : 'enable';
  const flowDir = flowDirOf(options);
  // No global form on purpose. A global directive pause would have to be
  // written into every loop's file at once — N commits' worth of intent from one
  // keystroke — and the thing that stops everything already exists: `loop pause`
  // with no `--loop`.
  const loop = requireLoop(options, verb);
  const written = setDirectivePaused(flowDir, loop, paused);
  return {
    status: paused ? 'disabled' : 'enabled',
    loop,
    paused: written.paused,
    wasPaused: written.wasPaused,
    changed: written.changed,
    path: written.path,
  };
}

/** The outcome of `loop finish`. */
export interface FinishVerbResult {
  status: 'finished';
  loop: string;
  /** The hunt that was ended, as the store held it. */
  text: string;
  /** How many hunts this loop still has RUNNING afterwards. */
  remaining: number;
}

/**
 * `loop finish` — a person says a hunt is done.
 *
 * THE THIRD THING YOU CAN DO WITH A HUNT, and the one people reach for first.
 * `resume --focus` carries on, `forget` erases, and neither is "this is
 * finished, leave the record". A hunt marked `stopped` keeps its count and its
 * history and is still reported — which is exactly what a finished piece of
 * work should do, and what lets the board draw it in Done instead of dropping
 * it off the screen.
 *
 * STOPPED IS A PERSON'S WORD. `dry` and `capped` are things the hunt did to
 * itself; `stopped` is the one status the store documents as a decision, and
 * this verb is the only way to write it deliberately.
 *
 * NO RUNTIME STATE, like `forget` beside it. Whether the LOOP should also stop
 * once its last hunt is finished is a separate question with a separate verb
 * (`loop pause`) — `remaining` is reported so a caller can ask it, rather than
 * this verb answering it for everyone.
 */
function runFinish(options: LoopCommandOptions): FinishVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'finish');
  readLoopDirective(flowDir, loop);
  const focus = normalizeFocus(requireFlag(options.focus, '--focus <text>', 'finish'));
  if (focus === undefined) {
    throw new Error('finish needs --focus <text> — the hunt to end');
  }
  const before = readInstructions(flowDir);
  const existing = findInstruction(before, focus);
  if (existing === undefined) {
    throw new Error(`no hunt matching '${focus}' — nothing to finish`);
  }
  // WHOSE JUDGMENT ENDED IT. `--rule-met` is the agent reporting that the
  // sentence the person wrote came true; without it, a person is switching the
  // hunt off. `meetInstruction` refuses to mislabel a hunt that has no custom
  // rule, so a run reporting on the wrong one leaves the store as it was.
  const after =
    options.ruleMet === true ? meetInstruction(before, focus) : stopInstruction(before, focus);
  writeInstructions(flowDir, after);
  return {
    status: 'finished',
    loop,
    text: existing.text,
    remaining: after.instructions.filter((entry) => entry.status === 'active').length,
  };
}

/** The outcome of `loop forget`. Forgetting nothing is still success. */
export interface ForgetVerbResult {
  status: 'forgotten';
  loop: string;
  /** The sentences that were removed, as the store held them. */
  forgot: string[];
  /** How many hunts the loop is left with. */
  remaining: number;
}

/**
 * `loop forget` — a hunt is over.
 *
 * THE VERB THAT WAS MISSING BETWEEN `resume --focus` AND NOTHING. Those were the
 * only two things a person could do with a standing hunt: carry on (which zeroes
 * the count and keeps hunting) or leave it alone. Neither ends one. A reader
 * clearing a loop out found its hunts still on the board afterwards, reading
 * `filed 0/20` — restarted, not finished, which is the opposite of what they
 * asked for.
 *
 * REMOVAL, NOT A STATUS. `stopped` is a hunt a person paused and may resume, and
 * it is still reported and still drawn. The store's own rule is that it answers
 * "what is being hunted right now" and keeps no history — the run log is the
 * history — so ending a hunt means it leaves the store.
 *
 * `--all` IS REQUIRED TO MEAN ALL. A `forget` with neither `--focus` nor `--all`
 * refuses rather than guessing: the two readings of a bare `loop forget --loop
 * find` are "forget nothing" and "forget everything", and one of them is
 * unrecoverable.
 *
 * NO RUNTIME STATE IS TOUCHED. Forgetting a hunt does not lift a pause, release
 * a run's slot or close anything on the queue — those are three other verbs, and
 * a person who set them meant them.
 */
function runForget(options: LoopCommandOptions): ForgetVerbResult {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'forget');
  // The directive is read for the same reason every other verb reads it: a loop
  // that does not exist must refuse here, not silently rewrite a store.
  readLoopDirective(flowDir, loop);
  const focus = options.focus === undefined ? undefined : normalizeFocus(options.focus);
  const all = options.all === true;
  if (focus === undefined && !all) {
    throw new Error("forget needs --focus <text> or --all — it will not guess which hunts to end");
  }
  // Read through the failure-aware reader, not the fail-soft one: fail-soft
  // (corrupt → empty) plus the unconditional write below would REPLACE an
  // unreadable store with an empty one while reporting "forgot nothing". A
  // verb that will not guess which hunts to end cannot answer that question
  // from a file nobody could parse — refuse with the parse error, the same
  // state `loop status` reports as `instructionsError` instead of "0 hunts".
  // A MISSING file is still the empty store, and still a success.
  const read = readInstructionsResult(flowDir);
  if (read.store === null) {
    throw new Error(
      `forget refused: ${instructionsPath(flowDir)} is unreadable (${read.error}) — fix or remove the file; nothing was written`,
    );
  }
  const before = read.store;
  const after = forgetInstruction(before, all ? undefined : focus);
  const keptKeys = new Set(after.instructions.map((entry) => instructionKey(entry.text)));
  const forgot = before.instructions
    .filter((entry) => !keptKeys.has(instructionKey(entry.text)))
    .map((entry) => entry.text);
  // Written even when nothing matched: an idempotent write of an unchanged store
  // is cheaper to reason about than a conditional one, and the file is tiny.
  writeInstructions(flowDir, after);
  return {
    status: 'forgotten',
    loop,
    forgot,
    remaining: after.instructions.length,
  };
}

/** The outcome of `loop point`. Pointing where it already points is success. */
export interface PointVerbResult {
  status: 'pointed';
  loop: string;
  /** The store it reads NOW — the one the caller asked for, either way. */
  queue: LoopQueueKind;
  /** Where in that store: `owner/name`, or the ledger file it resolved to. */
  location: string | null;
  /** The store it read before. Equal to `queue` when only the location moved. */
  wasQueue: LoopQueueKind;
  /** Where it pointed before. */
  wasLocation: string | null;
  /** False when the directive already said this and nothing was written. */
  changed: boolean;
  /** The directive file, in the home it was actually found in. */
  path: string;
}

/** What `loop describe` did — the fields it actually changed, and the cap now. */
export interface DescribeVerbResult {
  status: 'described';
  loop: string;
  /** Which of cap/direction/rules the write moved. Empty: the file already said it. */
  changed: string[];
  /** The cap after the write, or null when --cap was not given. */
  cap: number | null;
  /** The directive file, in the home it was actually found in. */
  path: string;
}

/**
 * `loop point` — say where a loop's work comes from.
 *
 * ONE VERB, NOT A PAIR, and that is the difference from `enable`/`disable`. The
 * pause verbs come in twos because a pause is a two-directional state and two
 * words keep the two pauses distinguishable in a transcript. A queue is not a
 * direction: it is a store plus a location in it, the set of stores can grow,
 * and `use-github` / `use-ledger` would mint a new verb per backend while
 * leaving the location — the half that actually differs between two loops on
 * the same backend — to a flag anyway.
 *
 * IT IS A VERB, BECAUSE IT WRITES. The family's nouns (`status`, `list`, `log`,
 * `worktree`) report; its verbs (`file`, `claim`, `close`, `push`, `pause`)
 * change something. And `point` is the word this codebase already uses for this
 * exact fact — the parser's own header says what a loop "was pointed at last
 * month is `git log`", and the directive's topic field is documented as "the
 * area this loop is pointed at right now".
 *
 * BOTH FIELDS MOVE IN ONE WRITE. The grammar couples them (`github` requires a
 * repo and refuses a path; `ledger` the reverse), so a two-step edit would put
 * a directive on disk that the parser refuses — and a loop whose directive does
 * not parse does not run at all. The writer rewrites one string and parses it
 * before it becomes a file.
 *
 * It touches NO runtime state and no queue: re-pointing a loop does not pause
 * it, does not resume it, and does not move, copy or close the items sitting in
 * the store it used to read. Those items stay exactly where they are, which is
 * the honest behaviour — a queue is a place, and this verb only says which place
 * the loop looks at next.
 */
/** Whether a flag asked for stdin. `undefined` is "not given", never `-`. */
function isStdinFlag(flag: string | undefined): boolean {
  return flag !== undefined && flag.trim() === '-';
}

/**
 * `loop describe` — what this loop is TOLD: its cap, its Direction, its Rules.
 *
 * THE SIBLING OF `point`. That verb answers "where does this loop's work come
 * from"; this one answers "what is it told about doing it". Both write the
 * committed directive and nothing else, which is what lets a UI offer either
 * without the app ever authoring a directive itself.
 *
 * THE CAP IS THE ONE DEFAULT STOP. Time is not enforced — the grammar says so
 * of `max_run_minutes` — and `empty` is an outcome rather than a limit, so the
 * count of open items is the whole of the leash a loop carries by default.
 * Everything else a run should respect goes in `## Rules`, which is prose the
 * run is handed verbatim, and which nobody has to fill in.
 *
 * At least one field is required: a describe that names nothing is a caller
 * that forgot its arguments, and answering it "changed: false" would look like
 * the loop already said something nobody asked about.
 */
async function runDescribe(options: LoopCommandOptions): Promise<DescribeVerbResult> {
  const flowDir = flowDirOf(options);
  const loop = requireLoop(options, 'describe');

  // PROSE REACHES THIS VERB OVER STDIN, because on Windows it cannot reliably
  // reach it any other way. The `.cmd` shim an IDE-launched agent runs
  // `planflow-ai` through goes via `cmd.exe /c`, whose parser treats a literal
  // newline inside an argument as a statement separator — a multi-line value is
  // silently truncated to its first line before the shim's own script runs
  // (#1865, which fixed the same defect on every `--body`). `## Direction` is
  // multi-line prose by nature: a seeded directive's is fifteen lines, so this
  // flag would have lost fourteen of them and reported success.
  //
  // ONE PAYLOAD, ONE STDIN. Both flags accepting `-` would give the same bytes
  // to two fields, so asking for that is refused rather than served twice.
  if (isStdinFlag(options.direction) && isStdinFlag(options.rules)) {
    throw new Error(
      "describe: only one of --direction or --rules may be '-' — stdin is read once",
    );
  }
  const direction =
    options.direction === undefined ? undefined : await flagOrStdin(options.direction);
  const rules = options.rules === undefined ? undefined : await flagOrStdin(options.rules);
  const capRaw = options.maxOpen;
  if (
    options.direction === undefined &&
    options.rules === undefined &&
    capRaw === undefined
  ) {
    throw new Error(
      'describe needs at least one of --direction <text>, --rules <text> or --max-open <n>',
    );
  }

  const changes: string[] = [];
  let cap: number | null = null;
  let path = '';

  if (capRaw !== undefined) {
    const parsed = Number(capRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`describe: --max-open must be a positive whole number — got '${capRaw}'`);
    }
    const written = setDirectiveCap(flowDir, loop, parsed);
    cap = written.cap;
    path = written.path;
    if (written.changed) changes.push('cap');
  }

  for (const [flag, section] of [
    [direction, 'Direction'],
    [rules, 'Rules'],
  ] as const) {
    if (flag === undefined) continue;
    const written = setDirectiveProse(flowDir, loop, section, flag);
    path = written.path;
    if (written.changed) changes.push(section.toLowerCase());
  }

  return { status: 'described', loop, changed: changes, cap, path };
}

function runPoint(options: LoopCommandOptions): PointVerbResult {
  const flowDir = flowDirOf(options);
  // A loop is required and there is no global form: every loop names its own
  // store, and one keystroke re-pointing a whole project's loops at a repo
  // nobody checked is not a convenience anybody asked for.
  const loop = requireLoop(options, 'point');
  const queue = requireFlag(options.queue, `--queue <${LOOP_QUEUE_KINDS.join('|')}>`, 'point');
  const repo = options.repo?.trim() ?? '';
  const path = options.path?.trim() ?? '';
  const written = setDirectiveQueue(flowDir, loop, {
    queue,
    // Absent stays absent rather than becoming an empty string: the writer
    // reads "not named" as "leave what is there", and an empty value would be
    // a location the caller never chose.
    ...(repo.length === 0 ? {} : { repo }),
    ...(path.length === 0 ? {} : { path }),
  });
  return {
    status: 'pointed',
    loop,
    queue: written.queue,
    location: written.location,
    wasQueue: written.wasQueue,
    wasLocation: written.wasLocation,
    changed: written.changed,
    path: written.path,
  };
}

/** One loop's row in `loop status`. */
export interface LoopStatusRow {
  loop: string;
  engine?: string;
  /**
   * The area the directive currently points this loop at (`topic:`), absent
   * when it points at none.
   *
   * This is the field every surface reads for "where is this loop working" —
   * the human render's bracket and the IDE panel both take it from HERE rather
   * than opening the directive a second time. Absent stays absent: a loop with
   * no topic must not be reported as working on anything in particular.
   */
  topic?: string;
  mission?: string;
  slice?: string;
  /**
   * Which store holds this loop's work — `github` or `ledger`, as the directive
   * says. Absent only when the directive could not be read.
   *
   * THE TRUTH SOURCE, NAMED. Every surface that has to know where a loop's
   * backlog actually lives reads it here rather than parsing the directive a
   * second time — the board above all, which must not guess a queue kind from a
   * path shape. A row with a `directiveError` reports neither this nor the
   * location, and that is the honest answer: nothing on disk said which store
   * this loop uses.
   */
  queueKind?: string;
  /**
   * Repo-relative ledger path, or `owner/name` for GitHub.
   *
   * Named BEFORE the queue is read, so a queue that could not be reached still
   * says which store it was — "unreadable" is only actionable with a location.
   */
  queueLocation?: string;
  /** True when the directive itself says `paused: true`. */
  directivePaused?: boolean;
  pause: PauseReport | null;
  /**
   * Every slot this loop currently has a run in, lowest first — empty when it
   * is idle.
   *
   * A LIST RATHER THAN A LOCK, because a loop with `max_concurrent_runs > 1` can
   * legitimately be running twice and a single field would have to pick one to
   * report and hide the other.
   */
  locks: LoopLockRecord[];
  lastOutcome?: string;
  lastRunAt?: string;
  /** Queue counts, or null when the queue could not be read. */
  queue: {
    open: number;
    closed: number;
    claimed: number;
    awaitingApproval: number;
    parked: number;
    claimable: number;
    maxOpenIssues: number;
    capReached: boolean;
  } | null;
  /**
   * Ids of the open items still behind the approval gate.
   *
   * Counts alone let a reader say "2 waiting" but not act on either one, so
   * the panel's Approve control would render with nothing to name. Emitting
   * the ids here keeps the queue single-reader: the app resolves them from
   * this snapshot instead of opening the store a second time.
   *
   * Absent when the queue could not be read; empty when nothing is gated.
   */
  awaitingApprovalIds?: string[];
  /**
   * Open items still claimed by a run whose lock ran out long ago.
   *
   * A REPORT, and only a report: status is read-only, so nothing here releases
   * anything. What it fixes is the silence — a run that ended without ending
   * its claim leaves an item that no other run may take and no surface ever
   * mentions, and the cap fills with ghosts nobody can name. Absent when the
   * queue could not be read; empty when every claim is live.
   */
  abandonedClaims?: AbandonedClaim[];
  /**
   * Open items held by a run that no longer exists.
   *
   * A DIFFERENT QUESTION FROM `abandonedClaims`, which is why it is a different
   * field. That one asks "has this claim gone quiet for longer than a run is
   * allowed to take" — a guess from a clock, which is right about a dead run and
   * also right about a slow one. This asks the machine: the claim names the
   * session its run lives in, and that session is not among the ones running.
   * No timeout, no guess, and no waiting out a TTL before a killed run's item
   * can be named.
   *
   * ABSENT means nobody could tell, and it must never be read as "nothing is
   * stuck": the queue was unreadable, or no snapshot of the live runs was
   * supplied. EMPTY means the snapshot was read and every claim's run is alive.
   * The result-level `runs` says which.
   */
  stuckClaims?: StuckClaim[];
  /**
   * The standing hunts a producer is working through — what a person typed,
   * how many findings it has filed, its cap and its status.
   *
   * VERBATIM FROM THE STORE. Nothing here is derived: no percentage, no
   * "remaining", no status inferred from a count. `filed` and `cap` are two
   * numbers the store already holds, and a card that wants to say "7/20" has
   * both without this row deciding what they mean.
   *
   * ABSENT when the store could not be read, EMPTY when this loop has none —
   * the same distinction `queue: null` draws, and for the same reason: a
   * producer whose instruction file is corrupt has not stopped hunting, it has
   * stopped being able to say. A row whose directive never parsed reports
   * neither, because whether it hunts at all is a directive fact.
   *
   * REPORTED ON PRODUCER ROWS ONLY, and the reason is a real limit rather than
   * a choice: the store is ONE file per project (`<flowDir>/loops/instructions.json`)
   * whose entries are keyed by their text and carry no loop field, so there is
   * nothing on disk that assigns a hunt to a loop. Only a producer can start
   * one (`loop next` writes the store solely for `engine: producer`), which
   * makes a consumer's `[]` a fact rather than a filter. A project with TWO
   * producers would see the same hunts on both rows — the honest read of a
   * store that never recorded which one typed them. The one per-loop evidence
   * that does exist is a live run's `focus`, reported beside this in `locks`.
   */
  instructions?: Instruction[];
  /** Why the directive could not be read, when it could not. */
  directiveError?: string;
  /** Why the queue could not be read, when it could not. */
  queueError?: string;
  /** WHICH failure — 'signed-out' is the only one with a remedy to offer. */
  queueErrorKind?: GhFailureKind;
  /** Why the instruction store could not be read, when it could not. */
  instructionsError?: string;
}

/** The whole `loop status` report. */
export interface StatusVerbResult {
  status: 'ok';
  loops: LoopStatusRow[];
  globalPause: PauseReport | null;
  /**
   * Whether this report could tell a live run from a dead one, and why not when
   * it could not.
   *
   * REPORTED ONCE FOR THE WHOLE INVOCATION, because it is one snapshot: a reader
   * that saw `stuckClaims: []` on every row and did not know the snapshot was
   * missing would conclude the project is healthy on the strength of a question
   * nobody asked.
   */
  runs: { known: boolean; reason?: string };
  digest: RunDigest;
  generatedAt: string;
}

/**
 * Every loop with a directive file, sorted and de-duplicated across both homes.
 *
 * The tracked `<root>/loops/` is the real home; `flow/loops/` is read too so a
 * machine mid-migration still reports its loops instead of going silently
 * empty. A name present in both is ONE loop — `readLoopDirective` resolves it
 * from the tracked copy, and listing it twice would make `loop status` claim a
 * duplicate that does not exist.
 */
function directiveNames(flowDir: string): string[] {
  const names = new Set<string>();
  for (const dir of [
    join(dirname(flowDir), TRACKED_LOOPS_DIRNAME),
    join(flowDir, LOOPS_DIRNAME),
  ]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.md')) names.add(entry.slice(0, -'.md'.length));
    }
  }
  return [...names].sort();
}

/**
 * The global pause, in the same shape a per-loop pause reports. No clock: the
 * state was read through `readLoopState`, which has already dropped anything
 * expired.
 */
function globalPauseReport(state: LoopState): PauseReport | null {
  const pause = state.globalPause;
  if (pause === undefined) return null;
  const report: PauseReport = { scope: 'global', reason: pause.reason, since: pause.since };
  if (pause.until !== undefined) report.until = pause.until;
  return report;
}

/**
 * Build one status row.
 *
 * FAIL-SOFT PER LOOP, deliberately, and the one place in this feature that is.
 * Status is a REPORT — the panel's data source and the session summary's input.
 * An unreadable directive or an unreachable `gh` must show up as a row that says
 * so, not as a refusal that blanks every other loop's state too.
 */
function statusRow(
  options: LoopCommandOptions,
  flowDir: string,
  state: LoopState,
  loop: string,
  runtime: Required<LoopRuntime>,
  now: number,
  hunts: InstructionsRead,
  reads: QueueReadSession,
  pages: StatusPageCache,
  runs: LiveRuns,
): LoopStatusRow {
  const record = loopRecord(state, loop);
  const row: LoopStatusRow = {
    loop,
    pause: pauseReport(state, loop, now),
    locks: liveLocks(state, loop, now),
    queue: null,
  };
  if (record.lastOutcome !== undefined) row.lastOutcome = record.lastOutcome;
  if (record.lastRunAt !== undefined) row.lastRunAt = record.lastRunAt;

  let directive: LoopDirective;
  try {
    directive = readLoopDirective(flowDir, loop);
  } catch (error) {
    row.directiveError = oneLine(error instanceof Error ? error.message : String(error));
    return row;
  }

  row.engine = directive.engine;
  if (directive.topic !== undefined) row.topic = directive.topic;
  row.mission = directive.mission;
  row.slice = directive.slice;
  row.queueKind = directive.queue;
  row.directivePaused = directive.paused;

  // THE HUNT, AS THE STORE HOLDS IT. Read once for the whole report and handed
  // in (`runStatus`), never opened per row: the file is one per project, and a
  // second open between two rows could report a count that changed underneath
  // the first. Below the directive read on purpose — whether a loop hunts at
  // all is `engine`'s answer, and a row that never got a directive says nothing
  // about instructions rather than guessing.
  if (hunts.store === null) row.instructionsError = oneLine(hunts.error);
  else row.instructions = directive.engine === 'producer' ? hunts.store.instructions : [];

  try {
    const { backend, location } = openQueue(options, directive, runtime.clock, 'status', reads);
    row.queueLocation = location;
    // ONE read for the whole INVOCATION per distinct queue (#1648, extending
    // #1635): rows that share a `repo:` fold from the same page instead of
    // each paying the identical remote round trip, and the scoping a
    // per-row `list({loop})` would have applied comes from the same exported
    // rule (`scopeItemsToLoop`), never re-derived here.
    const page = pages.read(`${backend.kind}:${location}`, () => backend.list({ state: 'all' }));
    const all = scopeItemsToLoop(page, directive.engine, loop);
    const counts = countItems(all);
    row.queue = {
      open: counts.open,
      closed: counts.closed,
      claimed: counts.claimed,
      awaitingApproval: counts.awaitingApproval,
      parked: counts.parked,
      claimable: counts.claimable,
      maxOpenIssues: directive.maxOpenIssues,
      // A PRODUCER'S FACT ONLY (#1585) — see queueReport in next.ts: a
      // consumer's `open` count is the whole in-tray, not its own filed items,
      // so comparing it against the cap reported `28/20 · capReached: true` for
      // a loop that files nothing.
      capReached: directive.engine === 'producer' && counts.open >= directive.maxOpenIssues,
    };
    // ONE read, both answers: the gated ids and the stuck claims are two
    // questions about the same open items, and a second list call would let a
    // queue that changed between them report a state that never existed.
    const open = all.filter((item) => item.state === 'open');
    row.awaitingApprovalIds = open.filter((item) => !item.approved).map((item) => item.id);
    row.abandonedClaims = abandonedClaims(open, lockTtlMs(directive.maxRunMinutes), now);
    // …and the third question about the same open items: which of them is held
    // by a run that no longer exists. The field is left ABSENT when nothing said
    // what is running, so a reader can never mistake "we did not ask" for
    // "everything is fine" (see `stuckClaims` on the row).
    if (runs.known) {
      row.stuckClaims = stuckClaims(claimBindings(loop, open), runs);
    }
  } catch (error) {
    row.queueError = oneLine(error instanceof Error ? error.message : String(error));
    row.queueErrorKind = ghKindOf(error);
  }
  return row;
}

/** `loop status` — every loop's state, plus the rolled-up digest. */
function runStatus(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): StatusVerbResult {
  warnIfCliStale();
  const flowDir = flowDirOf(options);
  const now = runtime.clock();
  const state = readLoopState(flowDir, now);

  const filter = options.loop?.trim() ?? '';
  const names =
    filter.length > 0
      ? [filter]
      : [...new Set([...directiveNames(flowDir), ...Object.keys(state.loops)])].sort();

  const entries = readRunLog(flowDir).filter(
    (entry) => filter.length === 0 || entry.loop === filter,
  );

  // ONE read of the instruction store for the whole report, exactly as `state`
  // above is one read: every row would otherwise re-open the same project-wide
  // file, and rows that disagreed about a count would be a snapshot of a moment
  // that never existed.
  const hunts = readInstructionsResult(flowDir);

  // ONE read of each QUEUE slice for the whole report, the same principle as
  // `state` and `hunts` above carried to the last thing still re-read per row.
  // Two loops pointing at one `repo:` used to phone GitHub twice for the same
  // page — twice per row here, so four calls to report on two loops — and the
  // two pages could disagree, which is the "moment that never existed" problem
  // one line up, arriving through a different door. The session is read-only and
  // dies with this call; nothing that writes to a queue is given one.
  const reads = new QueueReadSession();

  // The page cache lives exactly as long as this invocation — see #1648. It
  // sits ABOVE the read session: the session stops two rows fetching the same
  // argv, this stops them re-parsing the same page.
  const pages = new StatusPageCache();

  // ONE reading of what is running, for the whole report and by the same rule as
  // `state`, `hunts` and `reads` above. THIS VERB DOES NOT GO LOOKING: the
  // snapshot arrives as an argument from whoever dispatched the runs, because a
  // read path that spawns a process is a read path that blocks (allowed-pattern
  // #19). No snapshot means no claim is called dead — never the reverse.
  const runs = parseLiveRuns(options.liveRuns);

  return {
    status: 'ok',
    loops: names.map((loop) =>
      statusRow(options, flowDir, state, loop, runtime, now, hunts, reads, pages, runs),
    ),
    globalPause: globalPauseReport(state),
    runs: runs.known ? { known: true } : { known: false, reason: runs.reason },
    digest: digestRunLog(entries),
    generatedAt: toIso(now),
  };
}

// ── `loop list` — the queue itself, not a count of it ────
//
// `LoopQueueBackend.list()` has always existed and has always been called
// internally (`next`'s known fingerprints, `status`'s gated ids), and no verb
// exposed it. So every caller outside this process — the IDE above all — could
// learn that a loop has 12 open items and never which twelve, which is why a
// board cannot render a Todo column from `loop status` alone.
//
// THIS VERB COMPUTES NOTHING. It picks a query, hands it to the backend and
// serializes the answer. No field is derived, no count is assembled by
// subtracting one number from another, and no item is filtered after the
// backend returned it — a second opinion about which items count is exactly how
// two surfaces start disagreeing about one queue.

/** The slices `--state` accepts. `all` is the queue's memory, closed included. */
export const LIST_STATES: readonly (QueueItemState | 'all')[] = ['open', 'closed', 'all'];

/**
 * The slice a read is about.
 *
 * Defaults to `open` rather than the backend's `all`: a caller that named no
 * slice is asking what there is to work on, and pulling every closed item a
 * repo ever had to answer that is a page of history nobody asked for. The
 * resolved value is echoed in the result, so no reader has to know this default
 * to know what it is holding.
 */
function parseListState(raw: string | undefined): QueueItemState | 'all' {
  const value = raw?.trim() ?? '';
  if (value.length === 0) return 'open';
  if (!(LIST_STATES as readonly string[]).includes(value)) {
    throw new Error(`malformed --state '${value}' — expected ${LIST_STATES.join('|')}`);
  }
  return value as QueueItemState | 'all';
}

/** One loop's slice of `loop list`. */
export interface LoopListRow {
  loop: string;
  /** Which store answered — `github` or `ledger`, as the directive says. */
  queueKind?: string;
  /** Repo-relative ledger path, or `owner/name` for GitHub. */
  queueLocation?: string;
  /**
   * The items the backend returned, verbatim — or NULL when the queue could not
   * be read.
   *
   * Null and empty are different answers and this is the one field that must
   * never confuse them: `[]` says "there is no work", and a queue whose `gh`
   * call failed has said nothing at all. A reader that saw `[]` for both would
   * render an empty Todo over an unreachable backlog, which is the exact
   * failure `queue: null` already spares `loop status`.
   */
  items: QueueItem[] | null;
  /** Why the directive could not be read, when it could not. */
  directiveError?: string;
  /** Why the queue could not be read, when it could not. */
  queueError?: string;
  /** WHICH failure — 'signed-out' is the only one with a remedy to offer. */
  queueErrorKind?: GhFailureKind;
}

/** The whole `loop list` report. */
export interface ListVerbResult {
  status: 'ok';
  /** The slice actually read — resolved here so no reader infers the default. */
  state: QueueItemState | 'all';
  loops: LoopListRow[];
  generatedAt: string;
}

/**
 * Read one loop's queue.
 *
 * FAIL-SOFT PER LOOP, exactly as `statusRow` is and for the same reason: this is
 * a report, and one loop whose `gh` is unauthenticated must not blank out the
 * queue of every other loop in the project.
 */
function listRow(
  options: LoopCommandOptions,
  flowDir: string,
  loop: string,
  state: QueueItemState | 'all',
  runtime: Required<LoopRuntime>,
  reads: QueueReadSession,
): LoopListRow {
  const row: LoopListRow = { loop, items: null };

  let directive: LoopDirective;
  try {
    directive = readLoopDirective(flowDir, loop);
  } catch (error) {
    row.directiveError = oneLine(error instanceof Error ? error.message : String(error));
    return row;
  }
  row.queueKind = directive.queue;

  try {
    const { backend, location } = openQueue(options, directive, runtime.clock, 'list', reads);
    // Named BEFORE the read, so a queue that could not be reached still says
    // which store it was: "unreadable" is only actionable with a location.
    row.queueLocation = location;
    row.items = backend.list({ loop, state });
  } catch (error) {
    row.queueError = oneLine(error instanceof Error ? error.message : String(error));
    row.queueErrorKind = ghKindOf(error);
  }
  return row;
}

/**
 * `loop list` — every item in every loop's queue.
 *
 * `--loop` is a FILTER, not a requirement, matching `status`: a project's board
 * shows the whole project, and two directives naming two different queues are
 * two groups rather than two invocations. A caller that wants one loop names it.
 */
function runList(options: LoopCommandOptions, runtime: Required<LoopRuntime>): ListVerbResult {
  const flowDir = flowDirOf(options);
  const now = runtime.clock();
  const state = parseListState(options.state);

  const filter = options.loop?.trim() ?? '';
  const names =
    filter.length > 0
      ? [filter]
      : [
          ...new Set([...directiveNames(flowDir), ...Object.keys(readLoopState(flowDir, now).loops)]),
        ].sort();

  // ONE read per distinct slice for the whole report, as in `runStatus`. Here
  // the saving is total rather than partial: every row asks for the SAME
  // `--state`, and the loop each item belongs to is decided after parsing rather
  // than by the store, so N loops sharing a repo are N identical requests and
  // collapse to one. The board reads this verb and `status` on every open.
  const reads = new QueueReadSession();

  return {
    status: 'ok',
    state,
    loops: names.map((loop) => listRow(options, flowDir, loop, state, runtime, reads)),
    generatedAt: toIso(now),
  };
}

/** The outcome of `loop log --record`. */
export interface LogRecordResult {
  status: 'recorded';
  entry: RunLogEntry;
  /** Set on a `budget`/`cap` run ending with items still claimable: the drain
   *  is not finished, and this names how much is left and what to do (#14 —
   *  the continuation lives in the verb's answer, not a prompt's memory). */
  continuation?: string;
}

/** The outcome of a `loop log` read. */
export interface LogReadResult {
  status: 'ok';
  /** The last `--limit` entries matching the filter, oldest first. */
  entries: RunLogEntry[];
  /** Rolled up over EVERY matching entry, not just the returned window. */
  digest: RunDigest;
  generatedAt: string;
}

/** Read a positive-integer flag. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_LOG_LIMIT;
  if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw.trim(), 10) <= 0) {
    throw new Error(`malformed --limit '${raw}' — expected a positive integer`);
  }
  return Number.parseInt(raw.trim(), 10);
}

/**
 * The stop condition a run record carries: the run's own word when it named
 * one, otherwise the one condition the CLI can prove by itself.
 *
 * THE BEAT'S WORD WINS, BUT ONLY FROM THE CLOSED VOCABULARY. Whether a producer
 * ran out of room to file or a consumer ran out of items to claim is something
 * only the run saw, so it reports it; an unrecognized word REFUSES rather than
 * being stored, because a fifth condition would make the log uncountable and a
 * silently dropped one would read as "nothing stopped it".
 *
 * WHEN THE BEAT NAMES NONE, NOTHING IS FILLED IN. The CLI used to prove one
 * condition on its own — a spent run budget, arithmetic over the lock the run
 * was about to release. Phase 6 deleted the budget with the rest of the engine
 * (a run lives in a Claude Code session, and that session's end is the end), so
 * there is no longer a condition this code can prove. An unreported one is left
 * unreported rather than guessed at: `budget` is still a word a run may write
 * about its own session, and inventing it here would put a claim in the log
 * that nothing observed.
 *
 * The queue-shaped conditions were never derived here either: a run can stop for
 * a cap it saw three items ago, and re-reading the queue at record time would
 * report the shape of the world after the run rather than the reason it ended.
 */
function runStopCondition(raw: unknown): LoopStopCondition | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const named = raw.trim();
    if (!isLoopStopCondition(named)) {
      throw new Error(
        `unknown stopCondition '${named}' — expected ${LOOP_STOP_CONDITIONS.join('|')}`,
      );
    }
    return named;
  }
  return undefined;
}

/** `item 12` / `items 12, 14` — the ids a refusal has to name to be actionable. */
function itemsPhrase(items: readonly QueueItem[]): string {
  const ids = items.map((item) => item.id);
  return ids.length === 1 ? `item ${ids[0]}` : `items ${ids.join(', ')}`;
}

/**
 * Why a `success` run record is refused, or null when the run ended honestly.
 *
 * THE INVARIANT: a claim ends in exactly three ways — the item is CLOSED, it is
 * HANDED TO THE NEXT BEAT (a pipeline stage is still in flight, which is the
 * whole one-stage-per-run design), or it is RELEASED (`loop unclaim`). A run
 * that reports success having done none of those leaves the item open and held
 * by an owner that is never coming back; and because the run reported SUCCESS,
 * the stall policy never fires either, so the item sits claimed forever and the
 * cap fills with ghosts. That is forbidden-pattern #7 with a queue attached —
 * the worker's own report of success treated as proof the work landed.
 *
 * WHY HERE AND NOT IN A PROMPT (allowed-pattern #14): recording the run is the
 * one call every run makes to end, in every surface — cron, `/loop`, the IDE
 * panel. A rule written into the run prompt would hold only for the runs that
 * read it, and only until one of them reasoned its way past it.
 *
 * FOUR THINGS IT DELIBERATELY DOES NOT DO:
 *
 *   - It never fires on a `failure` record. A run reporting failure is being
 *     honest that it did not finish, and making a failing run unable to report
 *     would be the worse bug. What the item's claim then needs is a person, and
 *     `loop status` names it for them (an abandoned claim, or a stuck one whose
 *     run is gone).
 *   - It never fires for a producer. A producer files and never claims, so any
 *     open claim it saw would be someone else's.
 *   - It only counts claims held by THIS run's owner. Another run's ghost is
 *     not this run's to end — `loop status` reports it as an abandoned claim,
 *     which is the surface for exactly that.
 *   - It fails SOFT on an unreadable directive or queue. Recording the run is
 *     what ends it; a `gh` hiccup must not turn "the run finished" into "the
 *     run crashed".
 *
 * There is no escape flag, on purpose: an invariant a run can assert its way
 * out of is an invariant that quietly stops meaning anything.
 */
function honestEndingRefusal(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  loop: string,
  owner: string | undefined,
): string | null {
  const holder = owner?.trim() ?? '';
  // No owner means no claim can be attributed — the CLI has nothing to compare
  // against, and refusing on someone else's item is the failure mode above.
  if (loop.length === 0 || holder.length === 0) return null;

  const flowDir = flowDirOf(options);
  let directive: LoopDirective;
  try {
    directive = readLoopDirective(flowDir, loop);
  } catch {
    // Sanctioned fail-soft: an unreadable directive is not a reason to lose the
    // run's line
    return null;
  }
  if (directive.engine !== 'consumer') return null;

  let open: QueueItem[];
  try {
    const { backend } = openQueue(options, directive, runtime.clock, 'log');
    open = backend.list({ state: 'open', loop: directive.loop });
  } catch {
    // Sanctioned fail-soft: an unreachable queue must not block the run's line
    return null;
  }

  // The hand-off, checked AFTER the queue rather than before it — the items that
  // prove the claim are also what NAMES the pipeline (#1599). This used to run
  // first, to save a `gh` round-trip on the grounds that "the filesystem already
  // answered"; the filesystem's answer was `flow/STATE.md`, and a run whose
  // finished skill deleted it would be refused for ending mid-pipeline — unable
  // to record its line at all. Derived in code rather than read from the record:
  // a caller-supplied stage would be precisely the escape hatch this must not
  // have.
  try {
    if (deriveStage(readPipelineInput(flowDir, claimedPlan(open, holder))).inFlight) return null;
  } catch {
    // Sanctioned fail-soft: an unreadable pipeline reads as "cannot prove a
    // hand-off", and the claim check below decides
  }

  const held = heldClaims(open, holder);
  if (held.length === 0) return null;

  return [
    `run '${holder}' reported success for loop '${directive.loop}' while still holding ${itemsPhrase(held)}`,
    '— a claim ends by closing the item (`loop close --reason done` with the captured evidence),',
    'by handing it to the next run (a pipeline stage in flight),',
    'or by releasing it (`loop unclaim`); a run that did none of those records outcome `failure`',
  ].join(' ');
}

/**
 * Why this run may not end leaving its own pull request unlanded, or null.
 *
 * A PULL REQUEST NOBODY MERGED IS A FIX NOBODY HAS. The consumer prompt has said
 * so since the landing step was written — and a run still ended with two of them
 * open, because saying it was all that held it up. The item went back to the
 * queue open and claimable, so the next run is served work that is already done
 * and does it again; from the outside the list simply never gets shorter, which
 * is the complaint that produced this rule: "all the pr are there stucked, we
 * should auto merge to main when we finish, and also close the tickets."
 *
 * So opening a pull request and landing it are paired HERE rather than trusted
 * to the run: a `push` entry with no `merge` entry for the same item, both from
 * this owner, is work this run stranded. The pairing is by item id, which is why
 * both records carry one — matching on the prose of `reason` would make the
 * invariant depend on how a sentence is worded.
 *
 * A run that genuinely cannot land its work — the merge gate refused, and that
 * refusal is never something to work around — says so by recording `failure`,
 * which leaves the pull request for a person with the reason attached.
 */
function strandedPullRequestRefusal(
  options: LoopCommandOptions,
  loop: string,
  owner: string | undefined,
): string | null {
  const holder = owner?.trim() ?? '';
  if (loop.length === 0 || holder.length === 0) return null;

  let entries: RunLogEntry[];
  try {
    entries = readRunLog(flowDirOf(options));
  } catch {
    // Sanctioned fail-soft, as everywhere else in this seam: an unreadable log
    // must not turn "the run finished" into "the run crashed".
    return null;
  }
  const mine = entries.filter((entry) => entry.loop === loop && entry.owner === holder);
  const landed = new Set(
    mine.filter((entry) => entry.kind === 'merge' && entry.item !== undefined).map((entry) => entry.item),
  );
  const stranded = [
    ...new Set(
      mine
        .filter((entry) => entry.kind === 'push' && entry.item !== undefined)
        .map((entry) => entry.item as string)
        .filter((item) => !landed.has(item)),
    ),
  ];
  if (stranded.length === 0) return null;

  const items = stranded.map((item) => `#${item}`).join(', ');
  return [
    `run '${holder}' opened a pull request for ${items} and is ending without landing it`,
    '— a pull request nobody merged is a fix nobody has, and the item goes back to the queue open,',
    'so the next run is served work that is already done.',
    'Land it with `loop merge` and close the item, or record outcome `failure` to leave it for a person and say why.',
  ].join(' ');
}

/**
 * Why this run may not record an ending again, or null when it may.
 *
 * A RUN ENDS ONCE. The stop-condition vocabulary is closed so that "why did
 * runs stop" can be COUNTED, and a run able to record its ending twice corrupts
 * exactly that: two entries, two successes, a digest reporting three runs where
 * two happened. Seen live — two wrappers raced 654ms apart and both were
 * accepted, and nothing anywhere noticed.
 *
 * The owner is the run: `run-<timestamp>-<pid>` is minted per invocation, so a
 * second ending under the same owner is the same run ending twice and never two
 * runs colliding. Without an owner nothing can be attributed and the check
 * stands down, exactly like the two rules beside it.
 *
 * Both run kinds count — `run` and `run` are the same event under two
 * spellings, and a run that ended as one must not be able to end again as the
 * other.
 */
function alreadyEndedRefusal(
  options: LoopCommandOptions,
  loop: string,
  owner: string | undefined,
): string | null {
  const holder = owner?.trim() ?? '';
  if (loop.length === 0 || holder.length === 0) return null;

  let entries: RunLogEntry[];
  try {
    entries = readRunLog(flowDirOf(options));
  } catch {
    // Sanctioned fail-soft: an unreadable log is not a reason to lose the run's
    // line — the same trade the sibling checks make.
    return null;
  }
  const ended = entries.find(
    (entry) => entry.loop === loop && entry.owner === holder && isRunKind(entry.kind),
  );
  if (ended === undefined) return null;

  const how = ended.stopCondition === undefined ? '' : ` on '${ended.stopCondition}'`;
  return [
    `run '${holder}' already recorded an ending for loop '${loop}' at ${ended.ts}${how}`,
    '— a run ends once, and a second entry would count it twice in the digest.',
    'A run that has more to say records it as a new run (a fresh `loop next`), not a second ending.',
  ].join(' ');
}

/**
 * Why this run may not report that it ran out of work, or null when it may.
 *
 * THE OTHER HALF OF THE HONEST ENDING. Its sibling above answers "did this run
 * let go of what it was holding"; this one answers "was there anything left for
 * it to do". Both exist for the same reason: how a run ends is checked once, in
 * the one call every run makes to end, rather than asked of a prompt.
 *
 * `empty` and `none` are the two words a run uses to say nothing stopped it. On
 * a consumer both are checkable facts about the queue, and both were being
 * recorded while the queue was full — two runs ended with 27 items claimable and
 * the log said `none`, which reads in the digest as a quiet repo rather than as
 * two runs that gave up. The `budget` check beside it was added after exactly
 * this kind of unchallenged claim; this is the same rule applied to the other
 * words a run can end on.
 *
 * The refusal names `--skip`, because a run meeting this has usually met a
 * refusal on the queue head and concluded it had no way past it. It does.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — the same four carve-outs as its sibling,
 * for the same reasons: never on a `failure` record, never for a producer (whose
 * `empty` means "found nothing to file", a fact about the repo and not the
 * queue), never while a pipeline stage is in flight (advancing one IS the run),
 * and always fail-soft on an unreadable directive or queue.
 */
/**
 * The instruction a REAL limit ends with: how much is left, and what to do.
 *
 * `budget` and `cap` are honest endings — but the queue does not care how many
 * ledger lines the draining takes, and a session (or the daemon's next
 * scheduled run) is supposed to continue until `empty`. `loop close` already
 * prints "N still claimable — claim the next" after every settled item; this is
 * the same rule at the OTHER seam, so the continuation lives in the verb's own
 * answer instead of in a prompt's memory (allowed-pattern #14). Fail-soft
 * everywhere: an unreadable queue costs the notice, never the ending.
 */
function continuationNotice(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  loop: string,
  rawCondition: unknown,
): string | null {
  if (loop.length === 0) return null;
  const named = typeof rawCondition === 'string' ? rawCondition.trim() : '';
  if (named !== 'budget' && named !== 'cap') return null;
  try {
    const directive = readLoopDirective(flowDirOf(options), loop);
    if (directive.engine !== 'consumer') return null;
    const { backend } = openQueue(options, directive, runtime.clock, 'log');
    const claimable = countItems(backend.list({ state: 'all', loop: directive.loop })).claimable;
    if (claimable === 0) return null;
    return `${String(claimable)} item${claimable === 1 ? '' : 's'} still claimable — the ${named} ended this run, not the drain: open a fresh gate (loop next) and continue`;
  } catch {
    return null; // Sanctioned fail-soft: a notice must never cost the ending
  }
}

function earlyStopRefusal(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  loop: string,
  rawCondition: unknown,
): string | null {
  if (loop.length === 0) return null;
  // Only the two words that assert there was nothing left. `cap` and `budget`
  // are real limits, and a run that names neither is not claiming anything.
  const named = typeof rawCondition === 'string' ? rawCondition.trim() : '';
  if (named !== 'empty' && named !== 'none') return null;

  const flowDir = flowDirOf(options);
  let directive: LoopDirective;
  try {
    directive = readLoopDirective(flowDir, loop);
  } catch {
    // Sanctioned fail-soft: an unreadable directive is not a reason to lose the
    // run's line
    return null;
  }
  if (directive.engine !== 'consumer') return null;

  // THE CHEAP QUESTION FIRST: with nothing claimable there is nothing to refuse,
  // whatever the pipeline is doing, so the stage is never derived at all.
  let claimable: number;
  let open: QueueItem[];
  try {
    const { backend } = openQueue(options, directive, runtime.clock, 'log');
    // ONE read (#1635): the claimable count and the open items fold from the
    // same list, instead of `count()` re-reading the queue it just read.
    const all = backend.list({ state: 'all', loop: directive.loop });
    claimable = countItems(all).claimable;
    if (claimable === 0) return null;
    open = all.filter((item) => item.state === 'open');
  } catch {
    // Sanctioned fail-soft: an unreachable queue must not block the run's line
    return null;
  }

  // A run that advanced a pipeline stage stopped for the right reason — the
  // stage IS the run. Derived from the claim first: `flow/STATE.md` alone would
  // read `none` for a run whose finished skill deleted it, and this run would
  // then be refused for stopping early after doing exactly what it should (#1599).
  try {
    if (deriveStage(readPipelineInput(flowDir, claimedPlan(open))).inFlight) return null;
  } catch {
    // Sanctioned fail-soft: an unreadable pipeline reads as "cannot prove a
    // stage was the run", and the claimable count above decides
  }

  return [
    `run recorded stopCondition '${named}' for loop '${loop}', but ${String(claimable)} item${claimable === 1 ? ' is' : 's are'} still claimable`,
    '— a run is not one item, and nothing had stopped it.',
    'Claim again; if the queue head is work this run cannot take, step past it with',
    '`loop claim --skip <id>` rather than ending here.',
    "A run that genuinely cannot continue records the condition that stopped it ('cap', 'budget') or outcome `failure`.",
  ].join(' ');
}

/**
 * `loop log --record <json>` — append the run's line AND end the run.
 *
 * One call, because they are one fact. This is the run's last act: it writes the
 * line and gives the run's slot back, so the checkout it was working in is free
 * for the next run rather than reserved until the TTL runs out (#1624).
 */
function runLogRecord(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
  raw: string,
): LogRecordResult {
  const flowDir = flowDirOf(options);
  const payload = parseJsonArg(raw, 'record');
  const now = runtime.clock();

  const kindRaw = typeof payload.kind === 'string' ? payload.kind : RUN_KIND;
  if (!isRunLogKind(kindRaw)) {
    // The vocabulary is read from its own definition rather than retyped here:
    // a kind added to the log and forgotten in this message is how a caller ends
    // up being told a real kind does not exist.
    throw new Error(`unknown record kind '${kindRaw}' — expected ${RUN_LOG_KINDS.join('|')}`);
  }
  const kind: RunLogKind = kindRaw;

  const loop = (typeof payload.loop === 'string' ? payload.loop : options.loop ?? '').trim();
  if (isRunKind(kind) && loop.length === 0) {
    throw new Error('a run record requires a loop');
  }

  const outcome = payload.outcome;
  if (isRunKind(kind) && outcome !== 'success' && outcome !== 'failure') {
    throw new Error("a run record requires an outcome of 'success' or 'failure'");
  }

  const owner = typeof payload.owner === 'string' ? payload.owner : options.owner;

  // BEFORE anything is written or persisted — the refusal contract is one line,
  // exit 1 and no trace, so a run that is refused here can fix its ending and
  // record again without a half-written log to reconcile.
  if (isRunKind(kind)) {
    // BEFORE the success-only rules: a second ending is wrong whatever outcome
    // it carries, and a run that already failed must not be able to come back
    // and record a success over it.
    const repeated = alreadyEndedRefusal(options, loop, owner);
    if (repeated !== null) {
      throw new Error(repeated);
    }
  }
  if (isRunKind(kind) && outcome === 'success') {
    // A stranded pull request is checked FIRST: it is the one failure where the
    // run looks finished from every other angle — nothing claimed, nothing to
    // do — while the work it did is sitting unlanded.
    const stranded = strandedPullRequestRefusal(options, loop, owner);
    if (stranded !== null) {
      throw new Error(stranded);
    }
    const dishonest = honestEndingRefusal(options, runtime, loop, owner);
    if (dishonest !== null) {
      throw new Error(dishonest);
    }
    const early = earlyStopRefusal(options, runtime, loop, payload.stopCondition);
    if (early !== null) {
      throw new Error(early);
    }
  }
  const continuation = isRunKind(kind)
    ? continuationNotice(options, runtime, loop, payload.stopCondition)
    : null;

  const entry: RunLogEntry = { ts: toIso(now), kind, loop };
  if (owner !== undefined) entry.owner = owner;
  if (outcome === 'success' || outcome === 'failure') entry.outcome = outcome;
  if (typeof payload.verdict === 'string') entry.verdict = payload.verdict as RunLogEntry['verdict'];
  if (typeof payload.reason === 'string') entry.reason = payload.reason;
  // The item this entry is about, when the caller named one. `loop merge` writes
  // it directly; a caller recording a merge by hand must be able to as well, or
  // the stranded-pull-request pairing sees a merge that belongs to nothing.
  if (typeof payload.item === 'string' && payload.item.length > 0) entry.item = payload.item;
  if (isRunKind(kind)) {
    // The stage this run worked, when it named one. It is NO LONGER DERIVED
    // here: the derivation existed so the stalled-pipeline counter could not
    // depend on a prompt remembering the field, and Phase 6 deleted that
    // counter along with the supervisor that acted on it. Recording a stage
    // nothing counts, at the cost of a queue round trip, is a cost with no
    // reader — so what a run says about itself is now all the line carries.
    if (typeof payload.stage === 'string' && payload.stage.trim().length > 0) {
      entry.stage = payload.stage.trim();
    }

    // WHICH CONDITION ENDED THE BEAT. The run's own word wins — only it knows
    // whether it ran out of claimable items or out of room to file — but it must
    // be a word from the closed vocabulary, so the log stays countable.
    const stopCondition = runStopCondition(payload.stopCondition);
    if (stopCondition !== undefined) entry.stopCondition = stopCondition;

    // WHAT THIS BEAT WAS AIMED AT, read off the lock it is still holding rather
    // than from the payload. A person aims a run once, at the gate; asking the
    // run to repeat it here would make the record of hand-steering depend on
    // the run remembering to report being steered — which is exactly the
    // accountability gap that made `/agent-loop <name> <text>` a refusal in the first
    // place.
    const aim = runLock(readLoopState(flowDir, now), loop, owner, now)?.focus;
    if (aim !== undefined) {
      entry.focus = aim;
      // A RUN THAT FILED NOTHING IS THE ONLY EVIDENCE A HUNT IS RUNNING OUT.
      // `loop file` counts each new finding as it happens (which is what keeps
      // the cap live mid-run); nothing counted the runs that found NOTHING, so
      // `quietRuns` never moved and `dry` could never fire. The whole
      // stop-condition was dead code that passed its own unit tests — the same
      // shape of bug as a detector walking a structure the artifact never has.
      if ((entry.filed ?? 0) === 0) {
        writeInstructions(flowDir, recordInstructionRun(readInstructions(flowDir), aim, 0, toIso(runtime.clock())));
      }
    }
  }
  if (typeof payload.note === 'string') entry.note = payload.note;
  if (typeof payload.filed === 'number') entry.filed = payload.filed;
  if (typeof payload.closed === 'number') entry.closed = payload.closed;
  if (typeof payload.durationMs === 'number') entry.durationMs = payload.durationMs;

  if (isRunKind(kind) && (outcome === 'success' || outcome === 'failure')) {
    mutateLoopState(
      flowDir,
      (state) => {
        // How the run ended, kept as history — the counter this used to feed
        // went with the breaker (Phase 6). The slot goes back at the same
        // moment, guarded by owner so a late finisher cannot release a checkout
        // a newer run now holds: a finished run's slot sitting in state.json
        // until its TTL answered `locked` to every later run for up to half an
        // hour while nothing was running (#1624).
        const recorded = withRunOutcome(state, loop, outcome, now);
        return owner === undefined ? recorded : releaseLoopLock(recorded, loop, owner);
      },
      now,
    );
  }

  appendRunLogEntry(flowDir, entry);
  const recorded: LogRecordResult = { status: 'recorded', entry };
  if (continuation !== null) recorded.continuation = continuation;
  return recorded;
}

/** `loop log` — append one line, or read the log and its digest. */
async function runLog(
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): Promise<LogRecordResult | LogReadResult> {
  if (options.record === true) {
    // The bare flag is `classify`'s spelling; a log record is a payload, and
    // silently reading the log instead of appending would lose the run's line.
    throw new Error('log --record requires the run record as JSON (or "-" to read stdin)');
  }
  const raw = await flagOrStdin(options.record === false ? undefined : options.record);
  if (raw.trim().length > 0) {
    return runLogRecord(options, runtime, raw);
  }

  const flowDir = flowDirOf(options);
  const limit = parseLimit(options.limit);
  const filter = options.loop?.trim() ?? '';
  const entries = readRunLog(flowDir).filter(
    (entry) => filter.length === 0 || entry.loop === filter,
  );
  return {
    status: 'ok',
    entries: entries.slice(Math.max(0, entries.length - limit)),
    digest: digestRunLog(entries),
    generatedAt: toIso(runtime.clock()),
  };
}

// ── human rendering (a formatter, never a second computation) ──

function renderPull(pull: PullNote): string {
  if (!pull.attempted) return `pull: skipped — ${pull.note}`;
  return pull.ok ? 'pull: ok' : `pull: ${pull.note}`;
}

function renderNext(result: NextResult): string[] {
  const lines = [
    `${result.loop} (${result.engine}): ${result.verdict} — ${result.reason}`,
    `mission: ${result.mission}`,
    `queue: ${result.queue.open} open / ${result.queue.maxOpenIssues} cap · ${result.queue.claimable} claimable · ${result.queue.awaitingApproval} awaiting approval · ${result.queue.closed} closed`,
    `slice: ${result.slice}${result.scope.length > 0 ? ` · scope ${result.scope.join(', ')}` : ''}`,
    `known fingerprints: ${result.fingerprints.length}`,
    renderPull(result.pull),
  ];
  if (result.stopCondition !== 'none') {
    lines.push(`stop condition: ${result.stopCondition}`);
  }
  if (result.lock !== null) {
    // THE SLOT, AND WHEN IT LAPSES — not a budget. `max_run_minutes` no longer
    // stops anything (Phase 6): it sizes how long this run's checkout stays
    // reserved if the run dies without giving it back.
    lines.push(
      `slot ${String(result.lock.slot)}: ${result.lock.owner}, started ${result.runStartedAt} (reserved until ${result.lock.expiresAt})`,
    );
  }
  return lines;
}

function renderItem(item: QueueItem): string {
  return `#${item.id} ${item.title}${item.url === undefined ? '' : ` (${item.url})`}`;
}

function renderDigest(digest: RunDigest): string {
  // THE BREAKER CLAUSE PRINTS ONLY WHEN THE LOG HOLDS ONE. Phase 6 deleted the
  // breaker, so nothing can trip one again — but the log is append-only and a
  // project that ran before the deletion still has real trips in its history.
  // Printing `0 breaker trips` on every fresh project would advertise a
  // mechanism that no longer exists (forbidden-pattern #12); dropping the clause
  // outright would erase a past that actually happened.
  const trips = digest.breakerTrips > 0 ? ` · ${digest.breakerTrips} breaker trips (historical)` : '';
  return `digest: ${digest.beats} beats · ${digest.success} ok · ${digest.failure} failed · ${digest.filed} filed · ${digest.closed} closed${trips}`;
}

function renderStatusRow(row: LoopStatusRow): string {
  if (row.directiveError !== undefined) {
    return `${row.loop}: no readable directive — ${row.directiveError}`;
  }
  const state =
    row.pause !== null
      ? `paused (${row.pause.reason})`
      : row.directivePaused === true
        ? 'paused by directive'
        : row.locks.length > 0
          ? row.locks.length === 1
            ? `running (${row.locks[0].owner})`
            : `running ×${String(row.locks.length)} (${row.locks.map((lock) => lock.owner).join(', ')})`
          : 'idle';
  const queue =
    row.queue === null
      ? `queue unreadable — ${row.queueError ?? 'unknown'}`
      : `${row.queue.open}/${row.queue.maxOpenIssues} open · ${row.queue.claimable} claimable · ${row.queue.awaitingApproval} awaiting approval`;
  // THE BRACKET ANSWERS "where is this loop working" when the loop can answer
  // it. A topic changes with every steering commit and is the reason someone
  // reads this line at all; the engine never changes for the life of a
  // directive, so it earns the slot only as the fallback — a loop with no
  // topic still reads exactly as it did before topics existed.
  // Named, not counted: an abandoned claim is only actionable if the reader can
  // see WHICH item is stuck, and the whole reason this line exists is that the
  // item was invisible.
  const stuck = row.abandonedClaims ?? [];
  const abandoned =
    stuck.length === 0
      ? ''
      : ` · ${stuck.length} abandoned claim${stuck.length === 1 ? '' : 's'} (${stuck
          .map((claim) => claim.id)
          .join(', ')})`;
  // A DEAD RUN IS A HARDER FACT THAN A LATE ONE, so it gets its own clause
  // rather than being folded into the abandoned-claim count: the item above may
  // simply be taking a long time, this one is held by a session that is not
  // there any more. Silent when nothing said what is running — a line that
  // appeared on every status invocation to say "we did not ask" would be noise
  // on every status invocation.
  const dead = row.stuckClaims ?? [];
  const deadRuns = dead.length === 0 ? '' : ` · ${stuckClaimsPhrase(dead)}`;
  const bracket = row.topic ?? row.engine ?? '?';
  return `${row.loop} [${bracket}] ${state} · ${queue}${abandoned}${deadRuns}`;
}

/**
 * One item, in the vocabulary `renderStatusRow` already uses — "awaiting
 * approval" is the same phrase there, so a person reading a count on one line
 * and the items behind it on the next is reading one language.
 */
function renderListItem(item: QueueItem): string {
  const marks: string[] = [item.state];
  if (!item.approved) marks.push('awaiting approval');
  if (item.claimedBy !== undefined) marks.push(`claimed by ${item.claimedBy}`);
  if (item.plan !== undefined) marks.push(`plan ${item.plan}`);
  const labels = item.labels.length === 0 ? '' : ` · labels: ${item.labels.join(', ')}`;
  return `  ${renderItem(item)} · ${marks.join(' · ')}${labels}`;
}

function renderListRow(row: LoopListRow, state: QueueItemState | 'all'): string[] {
  if (row.directiveError !== undefined) {
    return [`${row.loop}: no readable directive — ${row.directiveError}`];
  }
  const where = `${row.queueKind ?? '?'}${row.queueLocation === undefined ? '' : ` ${row.queueLocation}`}`;
  // The one line that must never read as an empty queue — same words the status
  // row uses, because it is the same fact.
  if (row.items === null) {
    return [`${row.loop} [${where}] queue unreadable — ${row.queueError ?? 'unknown'}`];
  }
  const slice = state === 'all' ? '' : `${state} `;
  const header = `${row.loop} [${where}] ${row.items.length} ${slice}item${row.items.length === 1 ? '' : 's'}`;
  return [header, ...row.items.map(renderListItem)];
}

/**
 * Render the compact human form of a result. Takes the SAME object the JSON is
 * serialized from — `/agent-loop <name>` and a headless run can never disagree.
 */
export function renderHuman(verb: LoopVerb, result: unknown): string {
  switch (verb) {
    case 'next':
      return renderNext(result as NextResult).join('\n');
    case 'file': {
      const filed = result as FileVerbResult;
      return `${filed.status}: ${renderItem(filed.item)}`;
    }
    case 'claim': {
      const claimed = result as ClaimVerbResult;
      if (claimed.status === 'empty') {
        return `empty: ${claimed.reason ?? 'nothing claimable'}`;
      }
      // A LOST CLAIM MUST NOT READ AS A CLAIM. This branch used to treat
      // anything that was not `empty` as claimed, so the one line a run reads
      // would have told it that an item another engineer had just taken was
      // its own — and it would have worked it. The JSON said `lost`; only the
      // human rendering lied.
      if (claimed.status === 'lost') {
        return `lost: ${claimed.reason ?? 'taken by someone else'} — claim again`;
      }
      return `claimed by ${claimed.owner}: ${renderItem(claimed.item as QueueItem)}`;
    }
    case 'adopt': {
      const adopted = result as AdoptVerbResult;
      return `adopted into ${adopted.loop}: ${renderItem(adopted.item)} — ${adopted.detail}`;
    }
    case 'rework': {
      const reworked = result as ReworkVerbResult;
      return `reworkable by ${reworked.loop}: ${renderItem(reworked.item)} — ${reworked.detail}`;
    }
    case 'unclaim': {
      const released = result as UnclaimVerbResult;
      // Naming the takeover is the point: this release took something off a run
      // that is not coming back, and a line that read like any other release
      // would hide exactly the state the abandoned-claim report exists to show.
      const how = released.tookOverAbandoned
        ? 'released (abandoned claim taken over)'
        : released.wasClaimed
          ? 'released'
          : 'was not claimed';
      return `${how}: ${renderItem(released.item)}`;
    }
    case 'plan': {
      const planned = result as PlanVerbResult;
      return planned.plan.length === 0
        ? `pipeline cleared: ${renderItem(planned.item)}`
        : `pipeline ${planned.plan}: ${renderItem(planned.item)}`;
    }
    case 'classify': {
      const classified = result as ClassifyVerbResult;
      const detail = classified.record.detail === undefined ? '' : ` — ${classified.record.detail}`;
      return `${classified.status === 'recorded' ? 'classified' : 'classification'}: item ${classified.id} is ${classified.verdict}${detail}`;
    }
    case 'close': {
      const closed = result as CloseVerbResult;
      // THE NEXT TASK, NAMED AT THE MOMENT THE RUN DECIDES WHETHER TO STOP.
      // Finishing an item is exactly when a run asks "am I done", and the reply
      // used to say nothing about the queue — so a run that had just closed one
      // thing had no reason in front of it to take another. Silent when the
      // queue really is empty: that is the one time stopping is right.
      const next =
        closed.remaining > 0
          ? ` · ${String(closed.remaining)} still claimable — claim the next`
          : '';
      // A `handled` outcome says what did NOT happen, because that is the part a
      // person reading the transcript would otherwise assume.
      return closed.status === 'handled'
        ? `handled (${closed.reason}): ${renderItem(closed.item)}${next}\n${closed.note ?? ''}`.trimEnd()
        : `closed (${closed.reason}): ${renderItem(closed.item)}${next}`;
    }
    case 'escalate': {
      const escalated = result as EscalateVerbResult;
      return [
        `awaiting approval: ${escalated.loop} — ${escalated.reason}`,
        `prompt: ${escalated.promptPath}`,
      ].join('\n');
    }
    case 'worktree': {
      const worktree = result as WorktreeVerbResult;
      // A slot past the first has no base branch to name — saying `[null]`
      // reads as a bug, and "detached" is what git itself calls this.
      const line = `${worktree.status}: ${worktree.path} [${worktree.branch ?? 'detached'}]`;
      // Freshness is part of the answer (#1584): a tree the resolve could not
      // bring current says so here, instead of hiding behind the gate's
      // `pull: ok` (which only ever touched the main checkout).
      const refresh = 'refresh' in worktree ? worktree.refresh : undefined;
      if (refresh === undefined) return line;
      if (refresh.state === 'current') return `${line} — up to date`;
      if (refresh.state === 'refreshed') return `${line} — refreshed`;
      return `${line} — stale (${refresh.state}): ${refresh.detail}`;
    }
    case 'push': {
      const pushed = result as PushVerbResult;
      const pr = pushed.pr === undefined ? '' : `\npr: ${pushed.pr.url} (→ ${pushed.pr.base})`;
      return `pushed: ${pushed.branch} → ${pushed.remote}${pr}`;
    }
    case 'merge': {
      const merged = result as MergeVerbResult;
      // The evidence is part of the human line, not a detail behind it: this is
      // the one verb whose output a person reads to check what a robot landed.
      const evidence = (merged.evidence.commands ?? [])
        .map((entry) => `${entry.command} → exit ${entry.exitCode}`)
        .join('\n  ');
      return [
        `merged: ${merged.branch} → PR #${merged.pr.number} (${merged.pr.url})`,
        `item: #${merged.item.id} ${merged.item.title}`,
        ...(merged.note === undefined ? [] : [merged.note]),
        `evidence:\n  ${evidence}`,
      ].join('\n');
    }
    case 'approve': {
      const approved = result as ApproveVerbResult;
      return `${approved.alreadyApproved ? 'already approved' : 'approved'}: ${renderItem(approved.item)}`;
    }
    case 'pause':
    case 'resume': {
      const paused = result as PauseVerbResult;
      const who = paused.scope === 'global' ? 'all loops' : `loop '${paused.loop}'`;
      const until = paused.until === undefined ? '' : ` until ${paused.until}`;
      return `${paused.status}: ${who} — ${paused.reason}${until}`;
    }
    case 'enable':
    case 'disable': {
      const steered = result as DirectiveVerbResult;
      // ALREADY-SET READS AS ALREADY-SET, never as a write that happened. The
      // line also names the file, because the state it reports is committed
      // markdown a reader can go and look at — and says which pause it moved,
      // since the other one is a different verb and a different lifetime.
      const how = steered.changed ? steered.status : `already ${steered.status}`;
      return `${how}: ${steered.loop} — directive reads paused: ${String(steered.paused)} (${steered.path})`;
    }
    case 'finish': {
      const finished = result as FinishVerbResult;
      // Says what is LEFT, because that is the question the next press asks:
      // a loop with no hunts running is a loop with nothing to do.
      const left =
        finished.remaining === 0
          ? 'nothing left running'
          : `${String(finished.remaining)} still running`;
      return `finished: ${finished.loop} — '${finished.text}' (${left})`;
    }
    case 'forget': {
      const forgotten = result as ForgetVerbResult;
      // NAMES WHAT WENT, and says when nothing did. A verb that removes things
      // and then prints "forgotten" either way leaves the reader unable to tell
      // a hit from a miss — and this one cannot be undone from a second read.
      const count = forgotten.forgot.length;
      if (count === 0) return `forgot nothing: ${forgotten.loop} — no hunt matched`;
      const named = forgotten.forgot.map((text) => `'${text}'`).join(', ');
      return `forgot ${String(count)}: ${forgotten.loop} — ${named} (${String(forgotten.remaining)} left)`;
    }
    case 'point': {
      const pointed = result as PointVerbResult;
      // The same `<kind> <location>` shape `loop status --human` prints for the
      // queue column, so the line that CHANGED a loop's store and the line that
      // REPORTS it read the same way. Already-pointed reads as already-pointed,
      // and the file is named because what it reports is committed markdown.
      const where = `${pointed.queue}${pointed.location === null ? '' : ` ${pointed.location}`}`;
      const how = pointed.changed ? 'pointed' : 'already pointed';
      return `${how}: ${pointed.loop} — reads ${where} (${pointed.path})`;
    }
    case 'describe': {
      const described = result as DescribeVerbResult;
      // "changed nothing" is an ORDINARY outcome here — a panel re-saving a
      // field nobody edited — so it reads as a state, never as a failure. Same
      // shape as `point` above: what happened, to which loop, in which file.
      const what = described.changed.length === 0 ? 'no change' : described.changed.join(', ');
      const cap = described.cap === null ? '' : ` (max_open_issues: ${String(described.cap)})`;
      return `described: ${described.loop} — ${what}${cap} (${described.path})`;
    }
    case 'status': {
      const status = result as StatusVerbResult;
      const lines = status.loops.map(renderStatusRow);
      if (status.globalPause !== null) {
        lines.unshift(`ALL LOOPS PAUSED — ${status.globalPause.reason}`);
      }
      lines.push(renderDigest(status.digest));
      return lines.join('\n');
    }
    case 'list': {
      const listed = result as ListVerbResult;
      const lines = listed.loops.flatMap((row) => renderListRow(row, listed.state));
      // A project with no loops at all is a fact about the PROJECT, and printing
      // nothing would let it be read as a queue with nothing in it.
      return lines.length === 0 ? 'no loops with a directive' : lines.join('\n');
    }
    case 'log': {
      if ((result as LogRecordResult).status === 'recorded') {
        const recorded = result as LogRecordResult;
        // No breaker clause here at all: this renders a record THIS CLI just
        // wrote, and since Phase 6 nothing writes `breakerTripped`. A branch
        // that can never be taken reads as a feature and is not one.
        const stopped =
          recorded.entry.stopCondition === undefined || recorded.entry.stopCondition === 'none'
            ? ''
            : ` · stopped on ${recorded.entry.stopCondition}`;
        const goOn = recorded.continuation === undefined ? '' : ` · ${recorded.continuation}`;
        return `recorded: ${recorded.entry.loop} ${recorded.entry.kind} ${recorded.entry.outcome ?? ''}${stopped}${goOn}`.trim();
      }
      const read = result as LogReadResult;
      const lines = read.entries.map(
        (entry) =>
          `${entry.ts} ${entry.loop || '(global)'} ${entry.kind}${entry.outcome === undefined ? '' : ` ${entry.outcome}`}${entry.reason === undefined ? '' : ` — ${entry.reason}`}`,
      );
      lines.push(renderDigest(read.digest));
      return lines.join('\n');
    }
  }
}

// ── the entry point ──────────────────────────────────────

/** Run one verb and return its result object, without printing. */
async function dispatch(
  verb: LoopVerb,
  options: LoopCommandOptions,
  runtime: Required<LoopRuntime>,
): Promise<unknown> {
  switch (verb) {
    case 'next':
      return runNext(options, runtime);
    case 'file':
      return runFile(options, runtime);
    case 'claim':
      return runClaim(options, runtime);
    case 'adopt':
      return runAdopt(options, runtime);
    case 'rework':
      return runRework(options, runtime);
    case 'unclaim':
      return runUnclaim(options, runtime);
    case 'plan':
      return runPlan(options, runtime);
    case 'classify':
      return runClassify(options, runtime);
    case 'close':
      return runClose(options, runtime);
    case 'approve':
      return runApprove(options, runtime);
    case 'escalate':
      return runEscalate(options, runtime);
    case 'worktree':
      return runWorktree(options, runtime);
    case 'push':
      return runPush(options, runtime);
    case 'merge':
      return runMerge(options, runtime);
    case 'pause':
      return runPause(options, runtime);
    case 'resume':
      return runResume(options, runtime);
    case 'enable':
      return runDirectivePause(options, false);
    case 'disable':
      return runDirectivePause(options, true);
    case 'finish':
      return runFinish(options);
    case 'forget':
      return runForget(options);
    case 'point':
      return runPoint(options);
    case 'describe':
      return runDescribe(options);
    case 'status':
      return runStatus(options, runtime);
    case 'list':
      return runList(options, runtime);
    case 'log':
      return runLog(options, runtime);
  }
}

/**
 * `loop <verb>` — the whole verb family behind one refusal contract.
 *
 * Verbs default to JSON because machines are the primary caller; `--human`
 * renders the same object for a person. On any failure: one `loop refused:`
 * line, exit 1, and nothing persisted beyond what had already been committed
 * by the store the verb was mid-way through (each store's own write is atomic).
 */
export async function runLoop(
  verb: string,
  options: LoopCommandOptions,
  runtime: LoopRuntime = {},
): Promise<void> {
  try {
    if (!isLoopVerb(verb)) {
      throw new Error(`unknown verb '${verb}' — expected ${LOOP_VERBS.join('|')}`);
    }
    const resolved: Required<LoopRuntime> = {
      exec: runtime.exec ?? defaultLoopExec,
      clock: runtime.clock ?? Date.now,
    };
    const result = await dispatch(verb, options, resolved);
    process.stdout.write(
      options.human === true
        ? `${renderHuman(verb, result)}\n`
        : `${JSON.stringify(result)}\n`,
    );
  } catch (error) {
    logError(toRefusalLine(error));
    process.exitCode = 1;
  }
}
