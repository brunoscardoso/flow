// Agent loops — the main-process side of the panel (agent-loops, Phase 7).
//
// Thin wrappers over the bundled CLI's `loop` verb family, plus their IPC
// registration. Nothing here decides anything about a loop: `loops:activity`
// runs `loop status --json` and narrows its output, and the write channels run
// `loop pause|resume|approve` so a control pressed in the IDE lands in exactly
// the state.json a headless beat on another machine reads. THE PANEL IS A VIEW —
// this file is the seam that keeps it one.
//
// The board (loops-on-the-board, Phase 4) added the queue's own two: `loop list`
// for the items a Todo column is made of, and `loop claim` for what a drag into
// Doing means. Same seam, same rule — the app holds no queue store of its own,
// so a human's claim and a loop's claim are one write to one record.
//
// Review finding H1 added the claim's missing other half — `loop unclaim`, so an
// item taken from the board can be given back from the board — and the durable
// `--owner` that makes a retried claim MATCH the one this window already made
// instead of being refused by it.
//
// Modelled on blueprint/feature-runner.ts (spawn the embedded CLI via Electron
// as Node, capture stdout, injectable `spawnFn`), and FAIL-SOFT on every path
// for the same reason: a project with no `flow/loops/` yet, an older bundle
// without the verb, a hung `gh` — each must produce a one-line notice in the
// panel, never a thrown dialog or a crash.
import { spawn } from 'child_process'

import { runInCliHost } from '../cli-host/client'
import { timed } from '../ipc/slow-handler'
import { RunsInFlightCache, type RunsInFlight } from './background-agent'
import { LoopDirectiveCache, oneLine, type LoopDirectiveSnapshot } from './directive-reader'

import { join } from 'node:path'

import {
  emptyRuntimeState,
  readRuntimeState,
  type RuntimePause,
  type RuntimeStateSnapshot,
} from './runtime-state-reader'
import type { BundledCli } from '../blueprint/derive-runner'
import type { RootsProvider } from '../flow/flow-observer'
import type {
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  LoopAbandonedClaim,
  LoopStuckClaim,
  LoopsActivity,
  LoopsRunsReport,
  LoopsStuckReport,
  LoopClaimResult,
  LoopCloseResult,
  LoopDigest,
  LoopFileResult,
  LoopFinishResult,
  LoopForgetResult,
  LoopInstruction,
  LoopInstructionStatus,
  LoopStopChoice,
  LoopStopRule,
  LoopLockInfo,
  LoopPauseInfo,
  LoopQueueCounts,
  LoopQueueGroup,
  LoopQueueItem,
  LoopQueueSnapshot,
  LoopQueueState,
  LoopSourceKind,
  LoopStatusRow,
  LoopUnclaimResult,
  LoopsSnapshot,
  LoopsWriteResult,
} from '../../shared/ipc-contract'

/** A status read is local file + (for a GitHub queue) one `gh` call. */
const STATUS_TIMEOUT_MS = 30_000

/** A queue read is the same shape of work as a status read, item-by-item. */
const QUEUE_TIMEOUT_MS = 30_000

/**
 * A claim is NOT a local write. Under a GitHub queue it is a search, an assign
 * and a comment across the network, so it gets the read budget rather than the
 * pause/resume one — a claim killed at 15s would leave the board saying the
 * card bounced while GitHub finished assigning it.
 */
const CLAIM_TIMEOUT_MS = 30_000

/** A write is a state.json mutation plus a log append — local, fast. */
const WRITE_TIMEOUT_MS = 15_000

/** Keep only the tail of stderr — a refusal is one line, a stack is not. */
const STDERR_TAIL_CHARS = 2000

function unavailable(reason: string): LoopsSnapshot {
  return {
    available: false,
    reason,
    loops: [],
    globalPause: null,
    digest: null,
    generatedAt: null,
  }
}

/** One CLI invocation, capturing stdout and the tail of stderr. Never throws. */
/**
 * A GitHub token for the CLI's `gh` calls, or null.
 *
 * Module-scoped because every `runCli` in this file needs it and none of them
 * is reached from the registration closure — set once when the channels are
 * registered, cleared when they are disposed. Absent (tests, harnesses) means
 * exactly what it meant before: `gh` uses its own login, or fails saying it has
 * none, which the board now reports in its own words.
 */
let githubTokenForCli: (() => Promise<string | null>) | null = null

/** The env every CLI spawn gets: the host's, plus a GitHub token when we have one. */
async function cliEnv(): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (githubTokenForCli === null) return base
  // Never let a token lookup fail a loop verb — the queue read still runs, and
  // a signed-out gh reports itself.
  const token = await githubTokenForCli().catch(() => null)
  return token === null ? base : { ...base, GH_TOKEN: token }
}

async function runCli(
  bundledCli: BundledCli,
  rootPath: string,
  args: readonly string[],
  deps: { spawnFn?: typeof spawn; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  const spawnFn = deps.spawnFn ?? spawn
  // Resolved ONCE, for whichever of the two spawn paths runs. The lookup is
  // cached behind a short TTL in the integrations manager, so this costs a
  // promise, not a process.
  const env = await cliEnv()
  // SPAWNED FROM THE HOST, NOT FROM HERE — unless a test injected its own
  // spawn, which is the one case that must still run in-process. Every loop
  // verb boots a fresh CLI runtime (measured: `loops:read handled in 2,103ms`),
  // and creating that process was costing the main thread more than running it:
  // a profile of main found 93% of its CPU inside posix_spawn.
  if (deps.spawnFn === undefined) {
    const hosted = runInCliHost({
      execPath: bundledCli.execPath,
      args: [bundledCli.cliPath, ...args],
      cwd: rootPath,
      env,
      captureStdout: true,
      timeoutMs: deps.timeoutMs,
    })
    if (hosted !== null) {
      return hosted.then((result) => {
        // The host reports ok/error, not an exit code; a refusal is a non-ok
        // run that still produced output, which is exactly `code: 1` here.
        if (result.error === 'cli host exited' || result.error === 'cli host unreachable') {
          return spawnHere()
        }
        return {
          code: result.ok ? 0 : 1,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error === undefined || result.ok ? null : result.error,
        }
      })
    }
  }
  return spawnHere()

  function spawnHere(): Promise<{
    code: number | null
    stdout: string
    stderr: string
    error: string | null
  }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, [bundledCli.cliPath, ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, stdout, stderr, error: 'timed out' })
    }, deps.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, error: null })
    })
  })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SGR colour codes, as the CLI's logger emits them — see `refusalLine`. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

/** The logger's error bullet, once its colour is gone: `  x <message>`. */
const ERROR_BULLET_PATTERN = /^\s*x\s+/

/**
 * The reason a non-zero exit gives, read off the COMBINED transcript.
 *
 * This CLI's logger routes error() through console.log (allowed pattern #15),
 * so a refusal a user can plainly see is invisible to a stderr-only read — the
 * reason would arrive empty. The LAST non-empty line is the refusal itself;
 * anything above it is whatever the verb had already printed.
 *
 * DECORATION IS STRIPPED, and the live CLI is why: `loop list --state sideways`
 * really emits `\x1b[31m  x\x1b[0m loop refused: malformed --state …`, and the
 * logger colours unconditionally — a pipe is not a TTY, and it does not check.
 * Carried through as-is, a panel notice reads as escape codes and a red `x`
 * glyph the DOM has no terminal to interpret. The MESSAGE is the CLI's, verbatim
 * and unreworded; only the terminal's own paint comes off.
 */
function refusalLine(result: { stdout: string; stderr: string }, fallback: string): string {
  const transcript = `${result.stdout}\n${result.stderr}`.replace(ANSI_PATTERN, '').trim()
  const line = transcript
    .split('\n')
    .map((entry) => entry.replace(ERROR_BULLET_PATTERN, '').trim())
    .filter((entry) => entry.length > 0)
    .pop()
  return line === undefined || line.length === 0 ? fallback : line
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parsePause(raw: unknown): LoopPauseInfo | null {
  if (!isRecord(raw)) return null
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  const since = typeof raw.since === 'string' ? raw.since : ''
  return {
    scope: raw.scope === 'global' ? 'global' : 'loop',
    reason,
    since,
    ...(str(raw.until) === undefined ? {} : { until: raw.until as string }),
  }
}

function parseLock(raw: unknown): LoopLockInfo | null {
  if (!isRecord(raw)) return null
  const owner = str(raw.owner)
  if (owner === undefined) return null
  const slot = typeof raw.slot === 'number' && Number.isInteger(raw.slot) && raw.slot >= 1 ? raw.slot : 1
  return {
    owner,
    slot,
    acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
  }
}

/**
 * The slots a loop is running in.
 *
 * BOTH SHAPES READ, and deliberately: `locks` is what the CLI emits now, `lock`
 * is what every older CLI on a user's PATH still emits. The app ships bundled
 * against one version but runs against whatever `planflow-ai` resolves to, so a
 * reader that knew only the new shape would report a busy loop as idle on any
 * machine a step behind — which is exactly the bug this replaces, pointing the
 * other way.
 */
function parseLocks(raw: Record<string, unknown>): LoopLockInfo[] {
  if (Array.isArray(raw.locks)) {
    return raw.locks
      .map((entry) => parseLock(entry))
      .filter((lock): lock is LoopLockInfo => lock !== null)
      .sort((a, b) => a.slot - b.slot)
  }
  const single = parseLock(raw.lock)
  return single === null ? [] : [single]
}

/** The queue-failure words this build understands; anything else is dropped. */
const QUEUE_ERROR_KINDS = [
  'not-installed',
  'signed-out',
  'bad-credentials',
  'unreachable',
  'rate-limited',
  'unknown',
] as const

/**
 * Queue counts, or null. NULL IS "NOT MEASURED", never "zero of everything":
 * a row whose `gh` call failed carries `queueError`, and rendering that as
 * "0 open" would tell the reader the loop has nothing to do when the truth is
 * that nobody could find out.
 */
function parseQueue(raw: unknown): LoopQueueCounts | null {
  if (!isRecord(raw)) return null
  return {
    open: num(raw.open),
    closed: num(raw.closed),
    claimed: num(raw.claimed),
    awaitingApproval: num(raw.awaitingApproval),
    parked: num(raw.parked),
    claimable: num(raw.claimable),
    maxOpenIssues: num(raw.maxOpenIssues),
    capReached: raw.capReached === true,
  }
}

/**
 * One standing hunt, or null.
 *
 * DROPPED WITHOUT A `text`, for the same reason a status row is dropped without
 * a loop name: the text IS the instruction's identity in the CLI's own store
 * (`instructionKey`), and a hunt nobody can name is one no card can show and no
 * filter can be about.
 *
 * The numbers are read, never repaired: `filed` and `cap` come across as the
 * store holds them, and a status word this reader does not recognise makes the
 * entry null rather than a guessed `active` — a hunt shown as running when the
 * store said something else is the one error a card must not make.
 */
const INSTRUCTION_STATUSES = ['active', 'stopped', 'dry', 'capped', 'elapsed', 'met'] as const

/**
 * A hunt's stop rule, or undefined.
 *
 * DROPPED, NEVER GUESSED, and never at the cost of the hunt around it: this
 * mirrors the CLI's own reader, which keeps a hunt whose rule it cannot parse
 * rather than losing the count with it. A `duration` without a readable `until`
 * is no rule at all — the deadline is the whole of what ends it.
 */
function parseStopRule(raw: unknown): LoopStopRule | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'findings') return { kind: 'findings' }
  if (raw.kind === 'duration') {
    const hours = raw.hours
    const until = str(raw.until)
    if (typeof hours !== 'number' || hours <= 0) return undefined
    if (until === undefined || Number.isNaN(Date.parse(until))) return undefined
    return { kind: 'duration', hours, until }
  }
  if (raw.kind === 'custom') {
    const rule = str(raw.rule)
    if (rule === undefined || rule.trim().length === 0) return undefined
    return { kind: 'custom', rule: rule.trim() }
  }
  return undefined
}

function parseInstruction(raw: unknown): LoopInstruction | null {
  if (!isRecord(raw)) return null
  const text = str(raw.text)
  if (text === undefined) return null
  const status = raw.status
  if (!INSTRUCTION_STATUSES.includes(status as LoopInstructionStatus)) return null
  const stop = parseStopRule(raw.stop)
  return {
    text,
    ...(str(raw.tag) === undefined ? {} : { tag: raw.tag as string }),
    filed: num(raw.filed),
    cap: num(raw.cap),
    quietRuns: num(raw.quietRuns),
    status: status as LoopInstructionStatus,
    since: typeof raw.since === 'string' ? raw.since : '',
    ...(stop === undefined ? {} : { stop }),
  }
}

/**
 * One stuck claim, or null.
 *
 * DROPPED WITHOUT AN `id` OR A `sessionId`, because those two are what make it
 * actionable: the item is what a person goes and looks at, and the session is
 * how they confirm the run really is gone. An entry missing either would render
 * as a sentence naming nothing.
 */
function parseStuckClaim(raw: unknown): LoopStuckClaim | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const sessionId = str(raw.sessionId)
  if (id === undefined || sessionId === undefined) return null
  return {
    id,
    loop: typeof raw.loop === 'string' ? raw.loop : '',
    owner: typeof raw.owner === 'string' ? raw.owner : '',
    sessionId,
    ...(str(raw.claimedAt) === undefined ? {} : { claimedAt: raw.claimedAt as string }),
  }
}

/**
 * One claim that has gone quiet for too long, or null.
 *
 * DROPPED WITHOUT AN `id`, for the same reason a stuck claim is: the item is
 * what a person goes and looks at, and a sentence naming nothing is worse than
 * no sentence. The age is required too — it IS the claim being made, and the
 * CLI already refuses to report a claim whose timestamp would not parse.
 */
function parseAbandonedClaim(raw: unknown): LoopAbandonedClaim | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const claimedAt = str(raw.claimedAt)
  if (id === undefined || claimedAt === undefined) return null
  if (typeof raw.ageMs !== 'number' || !Number.isFinite(raw.ageMs)) return null
  return {
    id,
    owner: typeof raw.owner === 'string' ? raw.owner : '',
    claimedAt,
    ageMs: raw.ageMs,
  }
}

function parseRow(raw: unknown): LoopStatusRow | null {
  if (!isRecord(raw)) return null
  const loop = str(raw.loop)
  if (loop === undefined) return null
  return {
    loop,
    ...(str(raw.engine) === undefined ? {} : { engine: raw.engine as string }),
    ...(str(raw.topic) === undefined ? {} : { topic: raw.topic as string }),
    ...(str(raw.mission) === undefined ? {} : { mission: raw.mission as string }),
    ...(str(raw.slice) === undefined ? {} : { slice: raw.slice as string }),
    ...(str(raw.queueKind) === undefined ? {} : { queueKind: raw.queueKind as string }),
    ...(str(raw.queueLocation) === undefined ? {} : { queueLocation: raw.queueLocation as string }),
    // BOTH BOOLEANS COME THROUGH, and the difference between `false` and absent
    // is load-bearing: the CLI emits this field for every row whose directive
    // PARSED (`directivePaused: directive.paused`) and omits it entirely for one
    // whose directive it could not read. Narrowing only `true` collapsed those
    // two into one — a healthy, running loop arrived with the field missing,
    // which is exactly how the settings row reads "could not be read". Every
    // running loop in the project was labelled unreadable, beside a switch
    // offering to turn it off.
    ...(typeof raw.directivePaused === 'boolean' ? { directivePaused: raw.directivePaused } : {}),
    pause: parsePause(raw.pause),
    locks: parseLocks(raw),
    ...(str(raw.lastOutcome) === undefined ? {} : { lastOutcome: raw.lastOutcome as string }),
    ...(str(raw.lastRunAt) === undefined ? {} : { lastRunAt: raw.lastRunAt as string }),
    queue: parseQueue(raw.queue),
    // The CLI emits these alongside the counts, from one queue read. ABSENT
    // STAYS ABSENT: it is omitted on a row whose queue could not be read, and
    // an empty array here would read as "measured, nothing waiting".
    ...(Array.isArray(raw.awaitingApprovalIds)
      ? {
          awaitingApprovalIds: raw.awaitingApprovalIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
        }
      : {}),
    // The claims that have gone quiet, on the same absent-stays-absent rule.
    // THE ONE DEAD-RUN SIGNAL THAT STILL FIRES WITHOUT A SESSION — the CLI has
    // emitted it all along and nothing app-side read it, so the IDE had no
    // dead-run signal at all while `stuckClaims` waited on a session nothing
    // records. Kept as a SEPARATE field from `stuckClaims` rather than folded
    // into it: "has this gone quiet too long" and "is this claim's run gone"
    // are different questions with different failure modes, and one number over
    // both would double-count the item they can agree on.
    ...(Array.isArray(raw.abandonedClaims)
      ? {
          abandonedClaims: raw.abandonedClaims
            .map(parseAbandonedClaim)
            .filter((c): c is LoopAbandonedClaim => c !== null),
        }
      : {}),
    // The stuck claims, on the same absent-stays-absent rule and for the
    // sharpest reason of the three: the CLI sets this field ONLY when it was
    // told which runs are alive, so an empty array here would say "every claim's
    // run is running" about a question that was never asked.
    ...(Array.isArray(raw.stuckClaims)
      ? { stuckClaims: raw.stuckClaims.map(parseStuckClaim).filter((c): c is LoopStuckClaim => c !== null) }
      : {}),
    // The hunts, on the same absent-stays-absent rule as the ids above: the CLI
    // omits the field entirely when the instruction store could not be read, and
    // an empty array here would read as "measured, nothing being hunted".
    ...(Array.isArray(raw.instructions)
      ? {
          instructions: raw.instructions
            .map((entry) => parseInstruction(entry))
            .filter((entry): entry is LoopInstruction => entry !== null),
        }
      : {}),
    // The CLI's own per-loop fail-soft fields, carried through VERBATIM. The
    // reason a directive would not parse is the finding; rewording it here
    // would put a second opinion between the reader and the parser that failed.
    ...(str(raw.directiveError) === undefined ? {} : { directiveError: raw.directiveError as string }),
    ...(str(raw.queueError) === undefined ? {} : { queueError: raw.queueError as string }),
    // The CLI's classification, carried as data. Narrowed against the union
    // rather than cast into it: an unrecognised word from a newer CLI is
    // dropped, which is the same fail-soft rule the fields above follow.
    ...(QUEUE_ERROR_KINDS.includes(raw.queueErrorKind as (typeof QUEUE_ERROR_KINDS)[number])
      ? { queueErrorKind: raw.queueErrorKind as (typeof QUEUE_ERROR_KINDS)[number] }
      : {}),
    ...(str(raw.instructionsError) === undefined
      ? {}
      : { instructionsError: raw.instructionsError as string }),
  }
}

function parseDigest(raw: unknown): LoopDigest | null {
  if (!isRecord(raw)) return null
  return {
    entries: num(raw.entries),
    beats: num(raw.beats),
    success: num(raw.success),
    failure: num(raw.failure),
    filed: num(raw.filed),
    closed: num(raw.closed),
    breakerTrips: num(raw.breakerTrips),
    pauses: num(raw.pauses),
    resumes: num(raw.resumes),
    approvals: num(raw.approvals),
    ...(str(raw.since) === undefined ? {} : { since: raw.since as string }),
    ...(str(raw.until) === undefined ? {} : { until: raw.until as string }),
  }
}

/**
 * The reason a status read tells us nothing about which claims are stuck.
 *
 * Its own sentence, not the snapshot's: "the CLI is not on PATH" explains an
 * empty panel, and a reader looking at the stuck-claim line needs to be told
 * that the question was not answered rather than that the answer was "none".
 */
const STUCK_UNKNOWN_FALLBACK = 'nothing said which runs are alive, so no claim can be called dead'

/**
 * `known: false`, optionally carrying what WAS found.
 *
 * A PARTIAL ANSWER IS NOT AN ABSENT ONE. When one loop's list could not be read
 * and another's held a genuinely stuck item, both are true — reporting only the
 * gap would drop the finding, and reporting only the finding would be the C3
 * bug pointing the other way.
 */
function stuckUnknown(reason: string, claims: LoopStuckClaim[] = []): LoopsStuckReport {
  return {
    known: false,
    reason: oneLine(reason.length === 0 ? STUCK_UNKNOWN_FALLBACK : reason),
    ...(claims.length === 0 ? {} : { claims }),
  }
}

/**
 * The reason the loops named could not be checked, in the panel's vocabulary.
 *
 * NOT THE CLI'S OWN LINE. A queue refusal is written for someone at a terminal
 * and legitimately ends in an invocation to type (forbidden pattern #12); the
 * row already carries that text verbatim in `queueError` for whoever is looking
 * at the loop itself. What the project-wide stuck line needs is only WHICH
 * loops went unanswered.
 */
function uncheckedReason(loops: readonly string[]): string {
  const named = loops.join(', ')
  return loops.length === 1
    ? `the list behind ${named} could not be read, so a claim held there cannot be checked`
    : `the lists behind ${named} could not be read, so a claim held there cannot be checked`
}

/**
 * Narrow `loop status --json` stdout into the contract shapes.
 *
 * TWO ANSWERS FROM ONE PARSE, and the second one is a union rather than a list.
 * `runs` on the CLI's result says whether this report could tell a live run
 * from a dead one; the per-row `stuckClaims` are only meaningful when it could.
 * READ IN THAT ORDER, always: an absent list means nobody asked, not that
 * everything is healthy, and collapsing the two would turn the one feature that
 * answers "a run died and nothing told me" into permanent silence.
 */
export function parseStatusResult(stdout: string): { snapshot: LoopsSnapshot; stuck: LoopsStuckReport } {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return { snapshot: unavailable('no output'), stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK) }
  }
  // A refusal is one `loop refused: <reason>` line on the combined transcript —
  // surface it as-is rather than as "unparseable", which would hide the reason.
  if (!trimmed.startsWith('{')) {
    const reason = trimmed.split('\n')[0] ?? 'loop status refused'
    return { snapshot: unavailable(reason), stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      snapshot: unavailable('unparseable loop status output'),
      stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK),
    }
  }
  if (!isRecord(parsed)) {
    return {
      snapshot: unavailable('unparseable loop status output'),
      stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK),
    }
  }

  const loops: LoopStatusRow[] = []
  for (const raw of Array.isArray(parsed.loops) ? parsed.loops : []) {
    const row = parseRow(raw)
    if (row !== null) loops.push(row)
  }

  // `runs.known` FIRST. Only then are the rows' stuck claims a fact rather than
  // an absence — an older CLI that predates the field says nothing here, and
  // "said nothing" is unknown.
  //
  // …AND THE ROWS SECOND, which is the half this used to skip. The CLI names
  // TWO causes for an absent `stuckClaims`, one per row and one for the whole
  // report: "the queue was unreadable, or no snapshot of the live runs was
  // supplied". Only the second was honoured, so a `gh` outage on one github
  // loop — `queueError` set, no `stuckClaims` written — arrived here as
  // `known: true, claims: []` and the panel said nothing at all (review finding
  // C3). A row the CLI did not answer for is therefore a row nobody checked,
  // whatever the snapshot said. Read off the ABSENT FIELD rather than off
  // `queueError`, because absence is the CLI's own signal and it covers the
  // directive-error row too, which returns before the queue is ever opened.
  const runsField = isRecord(parsed.runs) ? parsed.runs : null
  const claims = loops.flatMap((row) => row.stuckClaims ?? [])
  const unchecked = loops.filter((row) => row.stuckClaims === undefined).map((row) => row.loop)
  const stuck: LoopsStuckReport =
    runsField?.known !== true
      ? stuckUnknown(str(runsField?.reason) ?? STUCK_UNKNOWN_FALLBACK, claims)
      : unchecked.length > 0
        ? stuckUnknown(uncheckedReason(unchecked), claims)
        : { known: true, claims }

  return {
    snapshot: {
      available: true,
      reason: null,
      loops,
      globalPause: parsePause(parsed.globalPause),
      digest: parseDigest(parsed.digest),
      generatedAt: str(parsed.generatedAt) ?? null,
    },
    stuck,
  }
}

/** Narrow `loop status --json` stdout into the contract shape. */
export function parseStatusJson(stdout: string): LoopsSnapshot {
  return parseStatusResult(stdout).snapshot
}

/**
 * `loop status --json` for a root, optionally told which runs are alive.
 *
 * `liveRuns` IS THE RAW ARRAY THE AGENTS LIST PRINTED, handed over untouched.
 * Narrowing it here first — sending only the sessions this app parsed out —
 * would make two readers of one list that can disagree about which runs exist
 * (allowed-pattern #14), and the CLI is the authority on liveness. Absent means
 * nobody said, which reports no claim as stuck rather than all of them.
 *
 * Never throws.
 */
export async function readLoops(
  bundledCli: BundledCli | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number; liveRuns?: string } = {},
): Promise<{ snapshot: LoopsSnapshot; stuck: LoopsStuckReport }> {
  if (bundledCli === null) {
    return {
      snapshot: unavailable('bundled CLI unavailable'),
      stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK),
    }
  }
  const live = deps.liveRuns ?? ''
  const result = await runCli(
    bundledCli,
    rootPath,
    ['loop', 'status', ...(live.length === 0 ? [] : ['--live-runs', live])],
    {
      ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
      timeoutMs: deps.timeoutMs ?? STATUS_TIMEOUT_MS,
    },
  )
  if (result.error !== null) {
    return { snapshot: unavailable(result.error), stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK) }
  }
  // A non-zero exit is a refusal, and its reason is the CLI's own line.
  if (result.code !== 0) {
    return {
      snapshot: unavailable(refusalLine(result, 'loop status failed')),
      stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK),
    }
  }
  return parseStatusResult(result.stdout)
}

// ── The fast half: directives, from disk ─────────────────────────────────

/**
 * A project's `flow/` directory — where the CLI keeps runtime state.
 *
 * The directives themselves live in the TRACKED `loops/` (or the legacy
 * `flow/loops/`), which `directiveHomes` already knows about; the pauses only
 * ever live under `flow/`, because they are this machine's answer and never
 * committed.
 */
function flowDirOf(rootPath: string): string {
  return join(rootPath, 'flow')
}

/**
 * One pause in the contract's shape, or null.
 *
 * `scope` is what the CONTRACT calls the difference between "this loop" and
 * "every loop", and it is not on the stored record — the store says which by
 * WHERE it puts the pause. So it is supplied by the caller, which is the only
 * place that knows.
 */
function pauseInfo(
  pause: RuntimePause | undefined,
  scope: 'loop' | 'global' = 'loop',
): LoopPauseInfo | null {
  if (pause === undefined) return null
  return {
    scope,
    reason: pause.reason,
    since: pause.since,
    ...(pause.until === null ? {} : { until: pause.until }),
  }
}

/**
 * A directive snapshot plus the pauses in force, in the shape every loops
 * surface already reads.
 *
 * EVERY ABSENT FIELD IS ABSENT ON PURPOSE. A directive says what a loop IS — its
 * mission, its list, its topic, whether it is switched on. It cannot say what
 * the loop is DOING, so `queue` is null and `locks` is empty here rather than
 * being invented: `queueSegment` prints nothing for a null queue with no error,
 * which is the honest rendering of "not measured".
 *
 * `pause` USED TO BE INVENTED, AND IT WAS THE ONE FIELD THAT COULD BE READ. It
 * was hard-coded null on the same "not measured" grounds, which was harmless
 * while nothing in the app wrote a state pause and became a lie the moment
 * something did: the board's stop writes one, so pressing pause did nothing
 * visible — the write landed, this read could not see it, and the button stayed
 * on "Stop". The gate's own switch-off writes one too, so "Off — nothing left in
 * the list" could never appear at all. It is one small local JSON file beside
 * the directives that were just listed, so it is read (runtime-state-reader.ts).
 */
export function directiveSnapshotToLoops(
  snapshot: LoopDirectiveSnapshot,
  runtime: RuntimeStateSnapshot = emptyRuntimeState(),
): LoopsSnapshot {
  if (!snapshot.available) {
    return unavailable(snapshot.reason ?? 'this project’s loops could not be read')
  }
  return {
    available: true,
    reason: snapshot.reason,
    loops: snapshot.loops.map((entry) => {
      const directive = entry.directive
      if (directive === null) {
        // A LOOP, NOT A GAP. The refusal rides on an otherwise-empty row, which
        // is the same fail-soft shape `loop status` produces for the same file.
        return {
          loop: entry.loop,
          pause: pauseInfo(runtime.pauses[entry.loop]),
          locks: [],
          queue: null,
          ...(entry.directiveError === null ? {} : { directiveError: entry.directiveError }),
        }
      }
      return {
        loop: entry.loop,
        engine: directive.engine,
        ...(directive.topic === undefined ? {} : { topic: directive.topic }),
        mission: directive.mission,
        slice: directive.slice,
        queueKind: directive.queue,
        ...(entry.queueLocation === null ? {} : { queueLocation: entry.queueLocation }),
        directivePaused: directive.paused,
        pause: pauseInfo(runtime.pauses[entry.loop]),
        locks: [],
        queue: null,
      }
    }),
    globalPause: pauseInfo(runtime.globalPause ?? undefined, 'global'),
    digest: null,
    generatedAt: new Date(snapshot.readAt).toISOString(),
  }
}

/** The runs in flight, in the contract's shape. Unknown is never empty. */
export function runsReportOf(runs: RunsInFlight): LoopsRunsReport {
  if (!runs.known) return { known: false, reason: runs.reason }
  return {
    known: true,
    runs: runs.runs.map((run) => ({
      sessionId: run.sessionId,
      id: run.id,
      name: run.name,
      cwd: run.cwd,
      startedAt: run.startedAt,
      state: run.state,
    })),
  }
}

/** One status answer, kept so an off-screen caller can be served without a spawn. */
export interface LoopStatusEntry {
  snapshot: LoopsSnapshot
  stuck: LoopsStuckReport
}

/**
 * The last `loop status` answer per project root.
 *
 * WHAT IT IS FOR, and it is one specific defect: `visible` used to reach the
 * runs cache and stop there, so `readLoops` — a fresh CLI runtime boot plus a
 * `gh` round trip per github loop — ran on EVERY activity read. The tasks board
 * polls this channel every fifteen seconds with `visible: false` because it
 * draws no runs, which meant a CLI boot and two remote reads every fifteen
 * seconds, forever, for a surface that wanted neither. That is the 2,103 ms
 * defect this whole change exists to remove, still running on its own interval
 * (review finding H1).
 *
 * SO THE GATE NOW COVERS BOTH HALVES. A caller that says nobody is looking is
 * served the last answer somebody DID look up, and spends nothing to get it —
 * which is what the board's own comment has always claimed happens.
 *
 * NO TTL, DELIBERATELY, and it is the same reasoning `RunsInFlightCache` gives
 * for its `!visible` branch: a TTL that expired would have to either spawn (the
 * thing this exists to prevent) or start lying about age. The snapshot carries
 * its own `generatedAt`, so a reader that cares how old the answer is can ask
 * it rather than be told by a cache. A caller that IS looking never reads this
 * at all — it reads the CLI.
 */
export class LoopStatusCache {
  readonly #entries = new Map<string, LoopStatusEntry>()

  /** The last answer for a root, or null when nothing has read it yet. */
  last(rootPath: string): LoopStatusEntry | null {
    return this.#entries.get(rootPath) ?? null
  }

  /** Record what a visible caller's read produced. */
  put(rootPath: string, entry: LoopStatusEntry): void {
    this.#entries.set(rootPath, entry)
  }

  /** Drop a root's answer — called when a project leaves. */
  forget(rootPath: string): void {
    this.#entries.delete(rootPath)
  }

  /** Drop every root — for app shutdown. */
  dispose(): void {
    this.#entries.clear()
  }
}

/**
 * What an off-screen caller is told about liveness when nothing has looked yet.
 *
 * Its own sentence rather than the runs cache's: this one is about the STATUS
 * read not having happened, and a reader needs to be told the question was not
 * asked rather than that the answer was "none".
 */
const STUCK_NOBODY_LOOKED =
  'nobody has looked at this project’s loops yet, so nothing checked which claims are dead'

/** The status half of the same answer, for a caller with no cheaper fallback. */
const STATUS_NOBODY_LOOKED = 'nobody has looked at this project’s loops yet'

/**
 * The expensive half of a loops read: the runs in flight, and the status report
 * they make answerable.
 *
 * ORDERED, NOT PARALLEL, and that is the whole point: the agents list is what
 * `loop status` needs in order to say which claims are stuck, so the status run
 * waits for it. Both are off the panel's critical path — the directives have
 * already been drawn by the time this is called.
 *
 * AN UNKNOWN RUNS SNAPSHOT STILL RUNS THE STATUS, because the counts are worth
 * having even when liveness is not knowable; `--live-runs` is simply not sent,
 * and the CLI reports no claim as stuck rather than all of them.
 *
 * NOTHING SPAWNS FOR A CALLER NOBODY IS LOOKING AT — and that now covers the
 * status read as well as the runs read (review finding H1). An invisible caller
 * gets, in order: the last answer a visible caller produced, or whatever
 * `lastResortStatus` can say without a process (the directives, read from
 * disk), or the honest admission that nobody has looked. It never gets a fresh
 * `loop status`, however old the alternative is.
 */
export async function readLoopsActivity(
  bundledCli: BundledCli | null,
  rootPath: string,
  runsCache: RunsInFlightCache,
  deps: {
    visible: boolean
    spawnFn?: typeof spawn
    timeoutMs?: number
    /** Where a visible caller's answer is kept for the invisible ones. */
    statusCache?: LoopStatusCache
    /** A status an off-screen caller can have for free — the directives on disk. */
    lastResortStatus?: () => Promise<LoopsSnapshot>
  },
): Promise<LoopsActivity> {
  const runs = await runsCache.read(rootPath, { visible: deps.visible })
  if (!deps.visible) {
    const cached = deps.statusCache?.last(rootPath) ?? null
    if (cached !== null) {
      return { status: cached.snapshot, runs: runsReportOf(runs), stuck: cached.stuck }
    }
    // Fail-soft on the fallback too: a directory that could not be listed is a
    // notice on a board, never a rejected IPC call.
    const status = await (deps.lastResortStatus?.() ?? Promise.resolve(null)).catch(
      (error: unknown) => unavailable(oneLine(error instanceof Error ? error.message : String(error))),
    )
    return {
      status: status ?? unavailable(STATUS_NOBODY_LOOKED),
      runs: runsReportOf(runs),
      stuck: stuckUnknown(STUCK_NOBODY_LOOKED),
    }
  }
  const { snapshot, stuck } = await readLoops(bundledCli, rootPath, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(runs.known ? { liveRuns: runs.raw } : {}),
  })
  deps.statusCache?.put(rootPath, { snapshot, stuck })
  return {
    status: snapshot,
    runs: runsReportOf(runs),
    stuck,
  }
}

/** One write verb, reduced to ok/reason. Never throws. */
async function writeVerb(
  bundledCli: BundledCli | null,
  rootPath: string,
  args: readonly string[],
  deps: { spawnFn?: typeof spawn; timeoutMs?: number },
): Promise<LoopsWriteResult> {
  if (bundledCli === null) return { ok: false, reason: 'bundled CLI unavailable' }
  const result = await runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? WRITE_TIMEOUT_MS,
  })
  if (result.error !== null) return { ok: false, reason: result.error }
  if (result.code !== 0) return { ok: false, reason: refusalLine(result, 'loop write failed') }
  return { ok: true, reason: null }
}

/**
 * The reason recorded when Flow pauses a loop and the user typed none.
 *
 * IT NAMED A SURFACE THAT NO LONGER EXISTS. "paused from the IDE panel" was
 * written when the loops lived in a sidebar panel; the panel is gone, and the
 * board renders this verbatim as "All paused — <reason>", so a stale name here
 * becomes a stale sentence on screen. It is also read in a terminal by whoever
 * runs `loop status` next, which is why it says what happened rather than which
 * window it happened in.
 */
export const DEFAULT_PAUSE_REASON = 'stopped by hand in Flow'

/**
 * Pause or resume. An empty `loop` addresses the GLOBAL pause — the CLI's own
 * reading of a missing `--loop`, so the panel never has to special-case it.
 *
 * `--reason` is always sent on a pause: the CLI refuses a reasonless pause, and
 * a pause with no reason is indistinguishable from a bug three days later.
 */
/**
 * The `--stop-*` flags for one chosen rule, or nothing at all.
 *
 * NOTHING IS INVENTED HERE. No rule means no flags, which leaves the hunt on
 * its backstop — the behaviour every hunt written before stop rules has. A
 * malformed choice is likewise dropped rather than repaired: the CLI refuses a
 * half-stated trio loudly (`--stop-hours` without `--stop-kind`), and sending
 * one it would refuse turns a person's resume into an error about a flag the
 * app chose.
 */
function stopArgs(stop: LoopStopChoice | undefined): string[] {
  if (stop === undefined) return []
  if (stop.kind === 'findings') return ['--stop-kind', 'findings']
  if (stop.kind === 'duration') {
    if (!Number.isFinite(stop.hours) || stop.hours <= 0) return []
    return ['--stop-kind', 'duration', '--stop-hours', String(stop.hours)]
  }
  const rule = stop.rule.trim()
  if (rule.length === 0) return []
  return ['--stop-kind', 'custom', '--stop-rule', rule]
}

export function setLoopPaused(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: {
    loop: string
    paused: boolean
    reason?: string
    focus?: string
    cap?: number
    /** How the hunt this resume starts should END, when a person chose a rule. */
    stop?: LoopStopChoice
  },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopsWriteResult> {
  const loop = request.loop.trim()
  const scope = loop.length === 0 ? [] : ['--loop', loop]
  const reason = (request.reason ?? '').trim()
  // THE HUNT RIDES THE RESUME, and only the resume: `loop pause` takes no focus,
  // and passing one there would be an argument the verb ignores — the kind of
  // silently-dropped flag that makes a caller believe a write happened.
  //
  // A focus with NO LOOP is dropped too: an empty `--loop` is the CLI's GLOBAL
  // scope, and `runResume` writes the instruction store from the same
  // invocation, so a global resume carrying a focus would restart a hunt as a
  // side effect of unpausing the project.
  const focus = (request.focus ?? '').trim()
  const hunt =
    request.paused || focus.length === 0 || loop.length === 0
      ? []
      : [
          '--focus',
          focus,
          // Positive integers only: the CLI refuses anything else outright, and
          // sending it would turn a resume into a refusal over a number the
          // board chose rather than the person did.
          ...(typeof request.cap === 'number' && Number.isInteger(request.cap) && request.cap > 0
            ? ['--cap', String(request.cap)]
            : []),
          ...stopArgs(request.stop),
        ]
  const args = request.paused
    ? ['loop', 'pause', ...scope, '--reason', reason.length === 0 ? DEFAULT_PAUSE_REASON : reason]
    : ['loop', 'resume', ...scope, ...(reason.length === 0 ? [] : ['--reason', reason]), ...hunt]
  return writeVerb(bundledCli, rootPath, args, deps)
}

/**
 * THE ONE PLACE THE DIRECTIVE-PAUSE VERB IS NAMED.
 *
 * The CLI owns the write — the app never opens a directive, and this is the
 * seam that keeps that true. The verb's spelling was still being settled on the
 * CLI side when this landed, so it is assumed here as
 * `loop directive --loop <n> --paused true|false` and confined to this one
 * function: renaming it (to `loop enable|disable`, `loop switch`, or whatever
 * the CLI ships) is a one-line change here and nothing else moves. A verb this
 * CLI does not have refuses with its own `loop refused: unknown verb …` line,
 * which `writeVerb` surfaces verbatim — a wrong guess is a visible notice, not
 * a silent no-op.
 */
export function directivePauseArgs(loop: string, paused: boolean): string[] {
  // TWO VERBS, NOT ONE WITH A FLAG — the CLI's own idiom for a two-directional
  // state change (`pause`/`resume` is the precedent this pair must stay
  // distinguishable from). `pause`/`resume` write runtime state.json;
  // `disable`/`enable` write the directive's committed intent, so no reader of a
  // transcript can mistake one write for the other.
  return ['loop', paused ? 'disable' : 'enable', '--loop', loop]
}

/**
 * Switch one loop on or off IN ITS DIRECTIVE. Never throws.
 *
 * A DIFFERENT FACT FROM `setLoopPaused`, and deliberately a different call. That
 * one writes state.json ("stopped for now"); this one writes the directive's own
 * `paused:` field — versioned intent that travels with the repo and that no
 * resume lifts. A control that wrote both would let one press undo a decision
 * somebody committed, so the two never share an invocation.
 *
 * A LOOP IS REQUIRED, with no empty-string global reading: there is no
 * project-wide directive to switch off, and an empty scope here would be a
 * silently-dropped argument rather than a broader one.
 */
export function setDirectivePaused(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; paused: boolean },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopsWriteResult> {
  const loop = request.loop.trim()
  // Refused locally rather than spawned: a directive write that names no loop
  // is a bug in the caller, not an outcome the CLI should be asked about.
  if (loop.length === 0) return Promise.resolve({ ok: false, reason: 'this needs a loop to switch' })
  return writeVerb(bundledCli, rootPath, directivePauseArgs(loop, request.paused), deps)
}

/**
 * THE ONE PLACE THE QUEUE-SOURCE VERB IS NAMED, on the same rule as its
 * sibling above: the CLI owns the write, and confining its spelling to one
 * function keeps a rename a one-line change here.
 *
 * NO `--path` IS EVER SENT. The verb accepts one — a ledger loop can read any
 * file — and this app must not ask for it: a path in a text box is the thing
 * forbidden pattern #12 exists to prevent, and the CLI reads an unmentioned
 * path as "leave what is there", so a loop already pointed at its own list
 * keeps it. The repo, by contrast, is always sent under `github`: `owner/name`
 * is a name rather than a path, and it is the one thing nothing can guess.
 */
export function directiveQueueArgs(loop: string, queue: LoopSourceKind, repo: string): string[] {
  return [
    'loop',
    'point',
    '--loop',
    loop,
    '--queue',
    queue,
    ...(queue === 'github' ? ['--repo', repo] : []),
  ]
}

/**
 * Point one loop at the list its work comes from. Never throws.
 *
 * A THIRD FACT, AND A THIRD CHANNEL. `setLoopPaused` writes "stopped for now";
 * `setDirectivePaused` writes "switched off"; this writes WHERE the work comes
 * from — and none of them touches either of the others. Re-pointing a loop
 * leaves both pauses exactly where they were, because a person who parked a
 * loop and then changed its list meant two things and asked for one.
 *
 * VALIDATED HERE TOO, and not because the CLI cannot be trusted to: it refuses
 * a `github` with no repo perfectly well. The check is here so an obviously
 * empty request never becomes a spawned process whose refusal has to travel
 * back and be reworded — the renderer already validated what a person typed,
 * and this is the same rule stated where the request actually leaves the app.
 */
export function setDirectiveQueue(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; queue: LoopSourceKind; repo?: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopsWriteResult> {
  const loop = request.loop.trim()
  if (loop.length === 0) return Promise.resolve({ ok: false, reason: 'this needs a loop to point' })
  if (request.queue !== 'github' && request.queue !== 'ledger') {
    // A kind this build does not know is a caller bug, not a queue outcome —
    // and sending it would put an unknown word in a committed file.
    return Promise.resolve({ ok: false, reason: 'that is not a list this build knows' })
  }
  const repo = (request.repo ?? '').trim()
  if (request.queue === 'github' && repo.length === 0) {
    return Promise.resolve({ ok: false, reason: 'a GitHub list needs the name of a repository' })
  }
  return writeVerb(bundledCli, rootPath, directiveQueueArgs(loop, request.queue, repo), deps)
}

/**
 * THE ONE PLACE THE STEERING VERB IS NAMED, on the same rule as its two
 * siblings above: the CLI owns the write.
 *
 * ONLY THE FIELDS THE CALLER NAMED ARE SENT. `describe` reads an unmentioned
 * flag as "leave what is there", so a panel saving a direction never clears the
 * rules underneath it, and saving a cap never touches either. An empty STRING
 * is different from an absent one and is passed through deliberately: it is how
 * a person says "this loop has no rules of its own", which is a state they mean
 * rather than a box they forgot.
 */
export function directiveDescribeArgs(loop: string, fields: DirectiveDescription): string[] {
  return [
    'loop',
    'describe',
    '--loop',
    loop,
    ...(fields.direction === undefined ? [] : ['--direction', fields.direction]),
    ...(fields.rules === undefined ? [] : ['--rules', fields.rules]),
    ...(fields.maxOpen === undefined ? [] : ['--max-open', String(fields.maxOpen)]),
  ]
}

/** What a person can say about a loop. An absent field is one they left alone. */
export interface DirectiveDescription {
  /** `## Direction` — what to look at. Empty string removes the section. */
  direction?: string
  /** `## Rules` — this loop's own constraints. Empty string removes them. */
  rules?: string
  /** `max_open_issues` — the one stop a loop keeps by default. */
  maxOpen?: number
}

/**
 * Say what a loop is told: its direction, its rules, its one stop. Never throws.
 *
 * A FOURTH FACT AND A FOURTH CHANNEL, beside "stopped for now", "switched off"
 * and "where the work comes from". This one touches none of those: a person who
 * rewrites a loop's rules has not asked to start it, and a loop parked last week
 * stays parked.
 *
 * WHY THE APP CANNOT JUST WRITE THE FILE. The directive is committed markdown
 * with a grammar the CLI's own parser enforces, and a file that does not parse
 * does not merely lose an edit — the loop stops running. The verb rewrites and
 * re-parses before it saves; this side sends fields and renders the answer.
 *
 * VALIDATED HERE TOO, for the reason its sibling gives: an obviously empty
 * request should never become a spawned process whose refusal has to travel back
 * and be reworded.
 */
export function setDirectiveDescription(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string } & DirectiveDescription,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopsWriteResult> {
  const loop = request.loop.trim()
  if (loop.length === 0) return Promise.resolve({ ok: false, reason: 'this needs a loop to describe' })

  const { direction, rules, maxOpen } = request
  if (direction === undefined && rules === undefined && maxOpen === undefined) {
    // Nothing was named. Reporting success would tell a person their edit was
    // saved when no edit was sent.
    return Promise.resolve({ ok: false, reason: 'there is nothing here to save' })
  }
  if (maxOpen !== undefined && (!Number.isInteger(maxOpen) || maxOpen < 1)) {
    return Promise.resolve({
      ok: false,
      reason: 'the number of open items to stop at has to be a whole number above zero',
    })
  }
  return writeVerb(bundledCli, rootPath, directiveDescribeArgs(loop, { direction, rules, maxOpen }), deps)
}

/** `loop approve --loop <n> --id <id>`. */
export function approveLoopItem(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; id: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopsWriteResult> {
  const loop = request.loop.trim()
  const id = request.id.trim()
  if (loop.length === 0 || id.length === 0) {
    return Promise.resolve({ ok: false, reason: 'approve needs a loop and an item id' })
  }
  return writeVerb(bundledCli, rootPath, ['loop', 'approve', '--loop', loop, '--id', id], deps)
}

// ── The queue itself: `loop list` and `loop claim` ────────────────────────
//
// `loop status` answers HOW MANY, and a board's Todo column is a list of items,
// so it cannot be drawn from counts at all. These two are the read and the write
// that column needs, and they are the same two the CLI already has: nothing here
// opens a queue store, and nothing here decides who may hold an item.

function queueUnavailable(reason: string): LoopQueueSnapshot {
  return { available: false, reason, state: null, loops: [], generatedAt: null }
}

/** Every string in an array, dropping anything that is not one. */
function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

/** A loop's own record that it is finished with an item it did not file. */
function parseHandled(raw: unknown): { at: string; detail: string } | null {
  if (!isRecord(raw)) return null
  const at = str(raw.at)
  if (at === undefined) return null
  return { at, detail: typeof raw.detail === 'string' ? raw.detail : '' }
}

/**
 * One queue item, or null.
 *
 * DROPPED WITHOUT AN `id`, for the same reason a status row is dropped without
 * a loop name: the id is the item's identity, and an item nobody can name is
 * one no card can claim, approve or link to.
 *
 * `approved` defaults to FALSE and that direction is deliberate — an item whose
 * gate could not be read shows as needing a human rather than as ready to work,
 * which is the error a person can see and correct. `state` is the mirror of it:
 * `closed` is asserted, never assumed, because a closed item leaves the board.
 */
function parseQueueItem(raw: unknown): LoopQueueItem | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (id === undefined) return null
  const handled = parseHandled(raw.handled)
  const closeReason = str(raw.closeReason)
  return {
    id,
    loop: typeof raw.loop === 'string' ? raw.loop : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    ...(str(raw.primaryFile) === undefined ? {} : { primaryFile: raw.primaryFile as string }),
    state: raw.state === 'closed' ? 'closed' : 'open',
    labels: strings(raw.labels),
    approved: raw.approved === true,
    ...(str(raw.claimedBy) === undefined ? {} : { claimedBy: raw.claimedBy as string }),
    ...(Array.isArray(raw.assignees) ? { assignees: strings(raw.assignees) } : {}),
    ...(str(raw.claimedAt) === undefined ? {} : { claimedAt: raw.claimedAt as string }),
    ...(str(raw.plan) === undefined ? {} : { plan: raw.plan as string }),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...(str(raw.closedAt) === undefined ? {} : { closedAt: raw.closedAt as string }),
    ...(closeReason === 'done' || closeReason === 'wontfix' || closeReason === 'duplicate'
      ? { closeReason }
      : {}),
    ...(str(raw.url) === undefined ? {} : { url: raw.url as string }),
    ...(handled === null ? {} : { handled }),
  }
}

/**
 * One loop's group, or null when the entry has no loop name.
 *
 * `items` STAYS NULL UNLESS THE CLI SENT AN ARRAY. This is the one narrowing in
 * this file that must not be defaulted: `[]` says the backlog is clear, and a
 * loop whose backend could not be reached has said nothing at all. Turning the
 * second into the first would draw an empty Todo over an unreachable queue —
 * the exact failure the reason string on `queueError` exists to prevent.
 */
function parseQueueGroup(raw: unknown): LoopQueueGroup | null {
  if (!isRecord(raw)) return null
  const loop = str(raw.loop)
  if (loop === undefined) return null
  return {
    loop,
    ...(str(raw.queueKind) === undefined ? {} : { queueKind: raw.queueKind as string }),
    ...(str(raw.queueLocation) === undefined ? {} : { queueLocation: raw.queueLocation as string }),
    items: Array.isArray(raw.items)
      ? raw.items.map((entry) => parseQueueItem(entry)).filter((item): item is LoopQueueItem => item !== null)
      : null,
    // The CLI's own per-loop fail-soft fields, carried through VERBATIM — the
    // reason a queue would not open is the finding.
    ...(str(raw.directiveError) === undefined ? {} : { directiveError: raw.directiveError as string }),
    ...(str(raw.queueError) === undefined ? {} : { queueError: raw.queueError as string }),
    // Narrowed against the union, not cast into it: a word this build does not
    // know is dropped rather than trusted, the same fail-soft rule as above.
    ...(QUEUE_ERROR_KINDS.includes(raw.queueErrorKind as (typeof QUEUE_ERROR_KINDS)[number])
      ? { queueErrorKind: raw.queueErrorKind as (typeof QUEUE_ERROR_KINDS)[number] }
      : {}),
  }
}

/** Narrow `loop list` stdout into the contract shape. */
export function parseListJson(stdout: string): LoopQueueSnapshot {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return queueUnavailable('no output')
  // A refusal is one `loop refused: <reason>` line — surface it as-is rather
  // than as "unparseable", which would hide the reason.
  if (!trimmed.startsWith('{')) return queueUnavailable(trimmed.split('\n')[0] ?? 'loop list refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return queueUnavailable('unparseable loop list output')
  }
  if (!isRecord(parsed)) return queueUnavailable('unparseable loop list output')

  const loops: LoopQueueGroup[] = []
  for (const raw of Array.isArray(parsed.loops) ? parsed.loops : []) {
    const group = parseQueueGroup(raw)
    if (group !== null) loops.push(group)
  }

  const state = str(parsed.state)
  return {
    available: true,
    reason: null,
    // Echoed, never inferred: the CLI resolves `--state`'s default and says
    // which slice it read, so nothing here has to know what that default is.
    state: state === 'open' || state === 'closed' || state === 'all' ? state : null,
    loops,
    generatedAt: str(parsed.generatedAt) ?? null,
  }
}

/**
 * `loop list` for a root — the board's Todo read. Never throws.
 *
 * READING WRITES NOTHING: this verb opens the backend and calls `list()`, which
 * is why it is safe to run every time a board opens. No label is created, no
 * issue is assigned, no comment is posted.
 *
 * `loop` is a FILTER and is omitted when empty, so the default read is the whole
 * project — two directives naming two queues are two groups, not two calls.
 * `state` is likewise only sent when the caller named one, leaving the CLI's own
 * default (`open`) the single definition of what an unqualified read means.
 */
export async function readLoopQueue(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop?: string; state?: LoopQueueState } = {},
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopQueueSnapshot> {
  if (bundledCli === null) return queueUnavailable('bundled CLI unavailable')
  const loop = (request.loop ?? '').trim()
  const args = [
    'loop',
    'list',
    ...(loop.length === 0 ? [] : ['--loop', loop]),
    ...(request.state === undefined ? [] : ['--state', request.state]),
  ]
  const result = await runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? QUEUE_TIMEOUT_MS,
  })
  if (result.error !== null) return queueUnavailable(result.error)
  if (result.code !== 0) return queueUnavailable(refusalLine(result, 'loop list failed'))
  return parseListJson(result.stdout)
}

function claimRefused(loop: string, reason: string): LoopClaimResult {
  return { status: 'refused', loop, owner: null, reason, item: null }
}

/** Narrow `loop claim` stdout into the contract shape. */
export function parseClaimJson(loop: string, stdout: string): LoopClaimResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return claimRefused(loop, 'no output')
  if (!trimmed.startsWith('{')) return claimRefused(loop, trimmed.split('\n')[0] ?? 'loop claim refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return claimRefused(loop, 'unparseable loop claim output')
  }
  if (!isRecord(parsed)) return claimRefused(loop, 'unparseable loop claim output')
  // A status this reader does not recognise is a REFUSAL, not a claim. Reading
  // an unknown word as success is how a card would settle in Doing over an item
  // this app never took — the failure `lost` already exists to prevent.
  const status = parsed.status
  if (status !== 'claimed' && status !== 'empty' && status !== 'lost') {
    return claimRefused(loop, `unexpected loop claim status '${String(status)}'`)
  }
  return {
    status,
    loop: str(parsed.loop) ?? loop,
    owner: str(parsed.owner) ?? null,
    reason: str(parsed.reason) ?? null,
    item: parseQueueItem(parsed.item),
  }
}

/**
 * `loop claim --loop <n> [--id <id>]` — take an item. Never throws.
 *
 * THE SAME WRITE A LOOP PERFORMS, which is the point: a human dragging a card to
 * Doing and a headless run picking work up go through one verb, one set of
 * eligibility rules and one record on the item, so the board and the loop can
 * never disagree about who holds what.
 *
 * `--id` is optional in the CLI (absent claims the oldest eligible item) and
 * stays optional here, but a board always names one — a drag is about a card.
 *
 * `--owner` WAS the CLI's to default, and that is the decision review finding
 * H1 overturned. Letting the CLI mint one meant a fresh `run-<ts>-<pid>` per
 * invocation, and `claimBlocker` refuses any claim where
 * `item.claimedBy !== owner` — so a retry from this app could never match the
 * claim this app had just made, and the board reported the user's own item as
 * somebody else's. The caller now names a durable one; it is still optional
 * here, because a caller that has no identity to offer is better served by the
 * CLI's default than by an invented constant.
 */
export function claimLoopItem(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; id?: string; owner?: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopClaimResult> {
  const loop = request.loop.trim()
  // Refused locally rather than spawned: the CLI requires a loop for `claim`,
  // and a claim with no loop is a bug in the caller, not a queue outcome.
  if (loop.length === 0) return Promise.resolve(claimRefused(loop, 'claim needs a loop'))
  if (bundledCli === null) return Promise.resolve(claimRefused(loop, 'bundled CLI unavailable'))
  const id = (request.id ?? '').trim()
  const owner = (request.owner ?? '').trim()
  const args = [
    'loop',
    'claim',
    '--loop',
    loop,
    ...(id.length === 0 ? [] : ['--id', id]),
    ...(owner.length === 0 ? [] : ['--owner', owner]),
  ]
  return runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? CLAIM_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return claimRefused(loop, result.error)
    if (result.code !== 0) return claimRefused(loop, refusalLine(result, 'loop claim failed'))
    return parseClaimJson(loop, result.stdout)
  })
}

function unclaimRefused(reason: string): LoopUnclaimResult {
  return { ok: false, reason, wasClaimed: false }
}

/** Narrow `loop unclaim` stdout into the contract shape. */
export function parseUnclaimJson(stdout: string): LoopUnclaimResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unclaimRefused('no output')
  if (!trimmed.startsWith('{')) return unclaimRefused(trimmed.split('\n')[0] ?? 'loop unclaim refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unclaimRefused('unparseable loop unclaim output')
  }
  if (!isRecord(parsed)) return unclaimRefused('unparseable loop unclaim output')
  // A status this reader does not recognise is a REFUSAL, on the same rule the
  // claim reader states: taking an unknown word for success is how a card would
  // report an item released that is still held.
  if (parsed.status !== 'unclaimed') {
    return unclaimRefused(`unexpected loop unclaim status '${String(parsed.status)}'`)
  }
  // Defaulted to FALSE, and that direction is deliberate: an older CLI that
  // omits the field has told us nothing, and "was not claimed" is the reading
  // that makes the surface say less rather than more than it knows.
  return { ok: true, reason: null, wasClaimed: parsed.wasClaimed === true }
}

/**
 * `loop unclaim --loop <n> --id <id>` — give a claimed item back. Never throws.
 *
 * THE CLAIM'S OTHER HALF, and until review finding H1 it had no surface in the
 * app at all: an item claimed from the board could only be released by running
 * `planflow-ai loop unclaim` in a terminal, which the app never mentions. The
 * OWNERSHIP CHECK IS THE BACKEND'S — `unclaim` refuses another owner's claim —
 * so nothing here has to decide who may release what, and this channel cannot
 * be talked into freeing a stranger's item however it is called.
 *
 * The CLAIM's timeout, not the write one: under a GitHub queue a release is a
 * label removal, an unassign and a body edit across the network, exactly the
 * shape of work the claim it undoes performed.
 */
export function unclaimLoopItem(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; id: string; owner?: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopUnclaimResult> {
  const loop = request.loop.trim()
  const id = request.id.trim()
  // Refused locally rather than spawned: the CLI requires both, and a release
  // that names neither is a bug in the caller, not a queue outcome.
  if (loop.length === 0 || id.length === 0) {
    return Promise.resolve(unclaimRefused('unclaim needs a loop and an item id'))
  }
  if (bundledCli === null) return Promise.resolve(unclaimRefused('bundled CLI unavailable'))
  const owner = (request.owner ?? '').trim()
  const args = [
    'loop',
    'unclaim',
    '--loop',
    loop,
    '--id',
    id,
    ...(owner.length === 0 ? [] : ['--owner', owner]),
  ]
  return runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? CLAIM_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return unclaimRefused(result.error)
    if (result.code !== 0) return unclaimRefused(refusalLine(result, 'loop unclaim failed'))
    return parseUnclaimJson(result.stdout)
  })
}

function closeRefused(reason: string): LoopCloseResult {
  return { ok: false, reason, status: null, note: null }
}

/**
 * Narrow `loop close` stdout into the contract shape.
 *
 * TWO SUCCESSES, NOT ONE. `closed` settled the item in the store; `handled`
 * means it was a PERSON's issue, so the claim came off and a local record was
 * written while the issue itself stays open for the pull request to close. The
 * board has to be able to tell the reader which of those happened, so an
 * unrecognised status is a refusal rather than a shrug — reporting somebody's
 * still-open report as resolved is the failure this guards.
 */
export function parseCloseJson(stdout: string): LoopCloseResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return closeRefused('no output')
  if (!trimmed.startsWith('{')) return closeRefused(trimmed.split('\n')[0] ?? 'loop close refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return closeRefused('unparseable loop close output')
  }
  if (!isRecord(parsed)) return closeRefused('unparseable loop close output')
  if (parsed.status !== 'closed' && parsed.status !== 'handled') {
    return closeRefused(`unexpected loop close status '${String(parsed.status)}'`)
  }
  return {
    ok: true,
    reason: null,
    status: parsed.status,
    note: typeof parsed.note === 'string' && parsed.note.trim().length > 0 ? parsed.note : null,
  }
}

/**
 * `loop close` — a person settles an item they do not want done.
 *
 * THE REASON IS REQUIRED HERE TOO, and refused locally rather than spawned: the
 * store keeps it as permanent searchable memory, the CLI refuses without it, and
 * a caller that forgot it is a bug in the app rather than an outcome of the
 * queue. `--reason done` is unreachable by the contract's type — closing as done
 * needs evidence a button cannot honestly produce.
 */
export function closeLoopItem(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; id: string; reason: 'wontfix' | 'duplicate'; detail: string; owner?: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopCloseResult> {
  const loop = request.loop.trim()
  const id = request.id.trim()
  const detail = request.detail.trim()
  if (loop.length === 0 || id.length === 0) {
    return Promise.resolve(closeRefused('a dismissal needs a loop and an item id'))
  }
  if (detail.length === 0) {
    return Promise.resolve(closeRefused('a dismissal needs a written reason'))
  }
  if (bundledCli === null) return Promise.resolve(closeRefused('bundled CLI unavailable'))
  const owner = (request.owner ?? '').trim()
  const args = [
    'loop',
    'close',
    '--loop',
    loop,
    '--id',
    id,
    '--reason',
    request.reason,
    '--detail',
    detail,
    ...(owner.length === 0 ? [] : ['--owner', owner]),
  ]
  return runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? CLAIM_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return closeRefused(result.error)
    if (result.code !== 0) return closeRefused(refusalLine(result, 'loop close failed'))
    return parseCloseJson(result.stdout)
  })
}

function finishRefused(reason: string): LoopFinishResult {
  return { ok: false, reason, remaining: null }
}

/** Narrow `loop finish` stdout into the contract shape. */
export function parseFinishJson(stdout: string): LoopFinishResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return finishRefused('no output')
  if (!trimmed.startsWith('{')) return finishRefused(trimmed.split('\n')[0] ?? 'loop finish refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return finishRefused('unparseable loop finish output')
  }
  if (!isRecord(parsed)) return finishRefused('unparseable loop finish output')
  if (parsed.status !== 'finished') {
    return finishRefused(`unexpected loop finish status '${String(parsed.status)}'`)
  }
  // Defaulted to 0 rather than null: the verb always counts, and an older CLI
  // that did not would leave a caller deciding "does the loop still have work"
  // from a missing number. Zero is the reading that stops it, which is the safe
  // direction for a control that offers to stop things.
  return {
    ok: true,
    reason: null,
    remaining: typeof parsed.remaining === 'number' ? parsed.remaining : 0,
  }
}

/** `loop finish` — mark one hunt stopped, leaving it in the store. */
export function finishLoopHunt(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; focus: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopFinishResult> {
  const loop = request.loop.trim()
  const focus = request.focus.trim()
  if (loop.length === 0 || focus.length === 0) {
    return Promise.resolve(finishRefused('finish needs a loop and the hunt to end'))
  }
  if (bundledCli === null) return Promise.resolve(finishRefused('bundled CLI unavailable'))
  return runCli(bundledCli, rootPath, ['loop', 'finish', '--loop', loop, '--focus', focus], {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? WRITE_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return finishRefused(result.error)
    if (result.code !== 0) return finishRefused(refusalLine(result, 'loop finish failed'))
    return parseFinishJson(result.stdout)
  })
}

function forgetRefused(reason: string): LoopForgetResult {
  return { ok: false, reason, forgot: [] }
}

/**
 * Narrow `loop forget` stdout into the contract shape.
 *
 * FORGETTING NOTHING IS A SUCCESS, and it is reported as one with an empty
 * list — the caller asked for a hunt to be gone and it is gone. Reading that as
 * a failure would have the screen say a reset was refused when it did exactly
 * what was asked.
 */
export function parseForgetJson(stdout: string): LoopForgetResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return forgetRefused('no output')
  if (!trimmed.startsWith('{')) return forgetRefused(trimmed.split('\n')[0] ?? 'loop forget refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return forgetRefused('unparseable loop forget output')
  }
  if (!isRecord(parsed)) return forgetRefused('unparseable loop forget output')
  if (parsed.status !== 'forgotten') {
    return forgetRefused(`unexpected loop forget status '${String(parsed.status)}'`)
  }
  const forgot = Array.isArray(parsed.forgot)
    ? parsed.forgot.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { ok: true, reason: null, forgot }
}

/** `loop forget` — end one standing hunt, or every one this loop has. */
export function forgetLoopHunts(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; focus?: string; all?: boolean },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopForgetResult> {
  const loop = request.loop.trim()
  const focus = (request.focus ?? '').trim()
  if (loop.length === 0) return Promise.resolve(forgetRefused('forget needs a loop'))
  // The CLI refuses a forget that names neither, and so does this: the two
  // readings of a bare forget are "nothing" and "everything".
  if (focus.length === 0 && request.all !== true) {
    return Promise.resolve(forgetRefused('forget needs a hunt to end, or all of them'))
  }
  if (bundledCli === null) return Promise.resolve(forgetRefused('bundled CLI unavailable'))
  const args = [
    'loop',
    'forget',
    '--loop',
    loop,
    ...(request.all === true ? ['--all'] : ['--focus', focus]),
  ]
  return runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? WRITE_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return forgetRefused(result.error)
    if (result.code !== 0) return forgetRefused(refusalLine(result, 'loop forget failed'))
    return parseForgetJson(result.stdout)
  })
}

function fileRefused(reason: string): LoopFileResult {
  return { ok: false, reason, status: null }
}

/**
 * Narrow `loop file` stdout into the contract shape.
 *
 * THE EXIT CODE ALREADY SAID IT WORKED — this reads only WHICH success it was.
 * That is the difference from `parseUnclaimJson` beside it, and it is why an
 * unreadable line here is not a refusal: the caller reaches this function only
 * after `code === 0`, and a write that exited 0 landed whatever this line says.
 * Turning "I could not read the report" into "the share failed" would tell the
 * user to press again on an item that is already on the list — and a second
 * press files nothing anyway (the backend dedups), so the lie would be
 * self-concealing.
 *
 * A STATUS THIS READER DOES NOT RECOGNISE YIELDS `null`, not a guess. `filed`
 * and `duplicate` are the CLI's own two words for this verb; a third one is a
 * newer CLI saying something this build has no sentence for.
 */
export function parseFileJson(stdout: string): LoopFileResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return { ok: true, reason: null, status: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: true, reason: null, status: null }
  }
  if (!isRecord(parsed)) return { ok: true, reason: null, status: null }
  if (parsed.status === 'filed') return { ok: true, reason: null, status: 'filed' }
  if (parsed.status === 'duplicate') return { ok: true, reason: null, status: 'duplicate' }
  return { ok: true, reason: null, status: null }
}

/**
 * `loop file --loop <n> --title <t> [--body <b>]` — put one piece of work on the
 * shared list. Never throws.
 *
 * THE APP SUPPLIES TWO FACTS AND DECIDES NOTHING ELSE. Labels, the topic, the
 * dedup fingerprint, the open-item cap and the approval gate are all the
 * directive's and the backend's, and passing any of them from here would be a
 * second place they are decided (allowed-pattern #14). That is also why no
 * `--labels` or `--needs-approval` reaches this argv: a board that added its own
 * label would file items a producer's own reads would then treat differently.
 *
 * REFUSED LOCALLY WITHOUT SPAWNING when either fact is missing, exactly as the
 * claim path does: the CLI requires both, and a share that names neither is a
 * bug in the caller rather than an outcome of the queue.
 */
export function fileLoopItem(
  bundledCli: BundledCli | null,
  rootPath: string,
  request: { loop: string; title: string; body?: string },
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<LoopFileResult> {
  const loop = request.loop.trim()
  const title = request.title.trim()
  if (loop.length === 0 || title.length === 0) {
    return Promise.resolve(fileRefused('filing needs a list and a title'))
  }
  if (bundledCli === null) return Promise.resolve(fileRefused('bundled CLI unavailable'))
  const body = (request.body ?? '').trim()
  const args = [
    'loop',
    'file',
    '--loop',
    loop,
    '--title',
    title,
    ...(body.length === 0 ? [] : ['--body', body]),
  ]
  return runCli(bundledCli, rootPath, args, {
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    timeoutMs: deps.timeoutMs ?? WRITE_TIMEOUT_MS,
  }).then((result) => {
    if (result.error !== null) return fileRefused(result.error)
    if (result.code !== 0) return fileRefused(refusalLine(result, 'loop file failed'))
    return parseFileJson(result.stdout)
  })
}

// ── IPC registration ──────────────────────────────────────────────────────

export interface LoopsChannelDeps {
  /** Project roots provider — the rootId allowlist, as every other domain. */
  roots: RootsProvider
  /** The app-embedded planflow-ai CLI. Null → every channel reports unavailable. */
  bundledCli?: BundledCli | null
  /**
   * The word this installation claims under (review finding H1) — minted once
   * and persisted by the caller, never by this module. Absent → the channels
   * send no `--owner` and the CLI defaults one per invocation, which is the
   * behaviour that finding is about; it stays reachable so a harness without a
   * settings store still works rather than inventing a constant identity.
   */
  ownerId?: () => string
  /** The directive cache. Injected in tests; one is made here otherwise. */
  directives?: LoopDirectiveCache
  /**
   * A GitHub token for the CLI's `gh` calls — the same one the importer uses.
   *
   * Absent leaves `gh` to its own login, which is what shipped; present makes
   * "Connect GitHub" in the integrations dialog actually fix a board that says
   * it is signed out, instead of granting access on a path the queue read never
   * consults.
   */
  githubToken?: () => Promise<string | null>
  /** The background-agents cache. Injected in tests; one is made here otherwise. */
  runsCache?: RunsInFlightCache
  /** The last-status cache an off-screen caller is served from (review H1). */
  statusCache?: LoopStatusCache
}

/**
 * Implements `loops:read`, `loops:activity`, `loops:setPaused`,
 * `loops:setDirectivePaused`, `loops:approve`, `loops:queue`, `loops:claim`,
 * `loops:unclaim` and `loops:owner`. Returns a dispose function that
 * unregisters them and drops both caches.
 *
 * `rootId` is validated against the live roots on EVERY channel that has one,
 * including the writes — the same rule the blueprint channels apply, so no path
 * outside a known project is ever the cwd of a spawned CLI. `loops:owner` is
 * the one channel with no rootId to check: it names this installation rather
 * than a project, and it spawns nothing.
 */
export function registerLoopsChannels(deps: LoopsChannelDeps): () => void {
  // Lazy require keeps this module importable from plain Node (tests/harnesses).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain } = require('electron') as typeof import('electron')

  githubTokenForCli = deps.githubToken ?? null

  const registered: IpcInvokeChannel[] = []
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  const knownRoot = (rootId: string): boolean =>
    deps.roots.getRoots().some((root) => root.rootPath === rootId)

  /**
   * The `--owner` a claim or a release carries: the renderer's word when it
   * named one, this installation's otherwise, and nothing at all when neither
   * exists (the CLI then defaults its own, as it always did).
   *
   * ONE DEFINITION FOR BOTH VERBS, deliberately (allowed-pattern #14): a claim
   * and its release that could disagree about who the caller is would recreate
   * the finding this fixes, pointing the other way — an item held under a name
   * its own window cannot let go of.
   */
  const ownerFor = (named: string | undefined): string | null => {
    const explicit = (named ?? '').trim()
    if (explicit.length > 0) return explicit
    const installation = (deps.ownerId?.() ?? '').trim()
    return installation.length > 0 ? installation : null
  }

  /**
   * The directives, cached per root behind a watcher.
   *
   * THIS IS THE READ THAT USED TO BE A SUBPROCESS. `loops:read` ran the bundled
   * CLI's `loop status` on every call — `loops:read handled in 2,103ms`, on the
   * process every window waits behind, with a profile of main finding 93% of
   * its CPU inside posix_spawn. The same three markdown files read in-process
   * take about ten milliseconds.
   */
  const directives = deps.directives ?? new LoopDirectiveCache()

  /**
   * The background agents, cached per root and gated on visibility.
   *
   * One Claude Code invocation per read, which is why it is cached and why a
   * caller that says nobody is looking spends nothing (allowed-pattern #17).
   */
  const runsCache = deps.runsCache ?? new RunsInFlightCache()

  /**
   * The last status a VISIBLE caller looked up, per root.
   *
   * This is what an off-screen caller is served instead of a CLI boot — see
   * `LoopStatusCache` and `readLoopsActivity`.
   */
  const statusCache = deps.statusCache ?? new LoopStatusCache()

  /**
   * Activity reads in flight, by root — a second caller joins the first.
   *
   * Every one boots a fresh CLI runtime: measured at `loop status ran for
   * 1,684ms`, twice within a breath of each other at startup because two
   * surfaces both wanted it. Nothing is held after it settles, so the next
   * caller still gets a fresh answer. The DIRECTIVE read needs no such map —
   * its cache already shares one in-flight promise per root.
   *
   * AND THE ANSWER IS NOT THE SAME FOR EVERY CALLER, which is what the first
   * cut of this map missed. Keyed on the root alone, the tasks board's
   * `visible: false` request — which by design spends nothing and can only
   * report what is already known — was handed to the Loops screen that asked,
   * at the same moment on startup, a strictly larger question. The screen that
   * WAS open then rendered "Flow can't tell what is running here", having spent
   * nothing and started nothing, and with its fifteen-second poll deleted
   * nothing re-asked until the user pressed something (review finding H3).
   *
   * So the link records what it is allowed to spend, and joining is asymmetric
   * (allowed-pattern #20 — key on what changes the ANSWER; the shape is
   * `board-queue-gate.ts`'s "a forced caller does not join"): a caller that
   * spends nothing joins ANY read, because every read answers at least its
   * question. A caller that may spend joins only a read that may also spend.
   */
  interface ActivityRead {
    /** True when this read is allowed to spend a process. */
    visible: boolean
    promise: Promise<LoopsActivity>
  }
  const activityInFlight = new Map<string, ActivityRead>()

  handle('loops:read', async ({ rootId }) => {
    if (!knownRoot(rootId)) return unavailable('unknown root')
    // Fail-soft like every other read here: a directory that could not be
    // listed is a notice, and a thrown one would be a dialog.
    try {
      // BOTH HALVES, and the second is why pressing pause does something now:
      // a stop writes `flow/loops/state.json`, so a read that did not open it
      // could never see one.
      const [snapshot, runtime] = await Promise.all([
        directives.read(rootId),
        readRuntimeState(flowDirOf(rootId), Date.now()),
      ])
      return directiveSnapshotToLoops(snapshot, runtime)
    } catch (error) {
      return unavailable(oneLine(error instanceof Error ? error.message : String(error)))
    }
  })

  handle('loops:activity', ({ rootId, visible }) => {
    if (!knownRoot(rootId)) {
      return {
        status: unavailable('unknown root'),
        runs: { known: false, reason: 'unknown root' } satisfies LoopsRunsReport,
        stuck: stuckUnknown(STUCK_UNKNOWN_FALLBACK),
      }
    }
    const wants = visible === true
    const running = activityInFlight.get(rootId)
    // A cheap caller takes whatever is being read; an expensive one takes it
    // only if that read is expensive too.
    if (running !== undefined && (!wants || running.visible)) return running.promise
    const base = readLoopsActivity(deps.bundledCli ?? null, rootId, runsCache, {
      visible: wants,
      statusCache,
      // The cheap half, offered to whoever may not spend: the directives are a
      // file read behind a watcher, so an off-screen board still knows which
      // loops exist and whether they are switched on even before anyone has
      // opened the Loops screen. Everything a file cannot say stays absent,
      // which every reader already renders as "not measured".
      lastResortStatus: async () => {
        const [snapshot, runtime] = await Promise.all([
          directives.read(rootId),
          readRuntimeState(flowDirOf(rootId), Date.now()),
        ])
        return directiveSnapshotToLoops(snapshot, runtime)
      },
    })
    const read: ActivityRead = { visible: wants, promise: base }
    read.promise = base.finally(() => {
      // Only if it is still OURS: a visible read that overtook an invisible one
      // must not have its entry cleared by the read it declined to join.
      if (activityInFlight.get(rootId) === read) activityInFlight.delete(rootId)
    })
    activityInFlight.set(rootId, read)
    return read.promise
  })

  handle('loops:setPaused', ({ rootId, loop, paused, reason, focus, cap, stop }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root' }
    return setLoopPaused(deps.bundledCli ?? null, rootId, {
      loop,
      paused,
      ...(reason === undefined ? {} : { reason }),
      ...(focus === undefined ? {} : { focus }),
      ...(cap === undefined ? {} : { cap }),
      ...(stop === undefined ? {} : { stop }),
    })
  })

  // The directive write, validated exactly like every read and every other
  // write — same rule, same reason: the rootId becomes a spawned CLI's cwd, and
  // a write that rewrites a committed file is the last place to make an
  // exception for it.
  handle('loops:setDirectivePaused', ({ rootId, loop, paused }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root' }
    return setDirectivePaused(deps.bundledCli ?? null, rootId, { loop, paused })
  })

  // The second directive write, validated exactly like the first — same rule,
  // same reason: the rootId becomes a spawned CLI's cwd.
  handle('loops:setDirectiveQueue', ({ rootId, loop, queue, repo }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root' }
    return setDirectiveQueue(deps.bundledCli ?? null, rootId, {
      loop,
      queue,
      ...(repo === undefined ? {} : { repo }),
    })
  })

  /**
   * What one loop is told, read from the directive cache the panel already has
   * open. No process is spawned: this is the app reading a file, which it may.
   */
  handle('loops:describe', async ({ rootId, loop }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root', direction: '', rules: '', maxOpen: null }
    const snapshot = await directives.read(rootId)
    const entry = snapshot.loops.find((row) => row.loop === loop)
    if (entry === undefined) {
      return { ok: false, reason: `there is no loop called ${loop} here`, direction: '', rules: '', maxOpen: null }
    }
    if (entry.directive === null) {
      // The parser's own refusal, carried rather than reworded — the same fact
      // the row already shows, so the editor and the card cannot disagree.
      return { ok: false, reason: entry.directiveError, direction: '', rules: '', maxOpen: null }
    }
    return {
      ok: true,
      reason: null,
      direction: entry.directive.direction,
      rules: entry.directive.rules,
      maxOpen: entry.directive.maxOpenIssues,
    }
  })

  // The third directive write, validated exactly like the other two — same
  // rule, same reason: the rootId becomes a spawned CLI's cwd.
  handle('loops:setDirectiveDescription', ({ rootId, loop, direction, rules, maxOpen }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root' }
    return setDirectiveDescription(deps.bundledCli ?? null, rootId, {
      loop,
      ...(direction === undefined ? {} : { direction }),
      ...(rules === undefined ? {} : { rules }),
      ...(maxOpen === undefined ? {} : { maxOpen }),
    })
  })

  handle('loops:approve', ({ rootId, loop, id }) => {
    if (!knownRoot(rootId)) return { ok: false, reason: 'unknown root' }
    return approveLoopItem(deps.bundledCli ?? null, rootId, { loop, id })
  })

  handle('loops:queue', ({ rootId, loop, state }) => {
    if (!knownRoot(rootId)) return queueUnavailable('unknown root')
    return readLoopQueue(deps.bundledCli ?? null, rootId, {
      ...(loop === undefined ? {} : { loop }),
      ...(state === undefined ? {} : { state }),
    })
  })

  // The write, validated exactly like the reads. A claim spawns a CLI whose cwd
  // is the rootId, so an unvalidated one here would be an arbitrary directory
  // the renderer got to name — which is why this rule has no exception for
  // writes even though a write "obviously" comes from a board that just read.
  handle('loops:claim', ({ rootId, loop, id, owner }) => {
    if (!knownRoot(rootId)) return claimRefused(loop, 'unknown root')
    const resolved = ownerFor(owner)
    return claimLoopItem(deps.bundledCli ?? null, rootId, {
      loop,
      ...(id === undefined ? {} : { id }),
      ...(resolved === null ? {} : { owner: resolved }),
    })
  })

  // The release, validated exactly like the claim it undoes — same rule, same
  // reason: the rootId becomes a spawned CLI's cwd, and a write is the last
  // place to make an exception for it.
  handle('loops:unclaim', ({ rootId, loop, id, owner }) => {
    if (!knownRoot(rootId)) return unclaimRefused('unknown root')
    const resolved = ownerFor(owner)
    return unclaimLoopItem(deps.bundledCli ?? null, rootId, {
      loop,
      id,
      ...(resolved === null ? {} : { owner: resolved }),
    })
  })

  // The one write that puts something on a list somebody else reads, and the
  // rootId check matters most here for that reason: it becomes the spawned
  // CLI's cwd, which is what decides WHICH project's directive — and so which
  // repo — the item is filed into.
  handle('loops:file', ({ rootId, loop, title, body }) => {
    if (!knownRoot(rootId)) return fileRefused('unknown root')
    return fileLoopItem(deps.bundledCli ?? null, rootId, {
      loop,
      title,
      ...(body === undefined ? {} : { body }),
    })
  })

  // A settlement is a write on a list other people read, so it is validated
  // exactly like the file above it — the rootId becomes the spawned CLI's cwd,
  // which decides WHICH project's list the item is settled on. The owner rides
  // along so the CLI's own ownership check can refuse a dismissal of an item
  // somebody else's run is holding.
  handle('loops:close', ({ rootId, loop, id, reason, detail, owner }) => {
    if (!knownRoot(rootId)) return closeRefused('unknown root')
    const resolved = ownerFor(owner)
    return closeLoopItem(deps.bundledCli ?? null, rootId, {
      loop,
      id,
      reason,
      detail,
      ...(resolved === null ? {} : { owner: resolved }),
    })
  })

  handle('loops:finishHunt', ({ rootId, loop, focus }) => {
    if (!knownRoot(rootId)) return finishRefused('unknown root')
    return finishLoopHunt(deps.bundledCli ?? null, rootId, { loop, focus })
  })

  // The instruction store is a project file like any other, so the rootId is
  // validated exactly as every other write validates it.
  handle('loops:forget', ({ rootId, loop, focus, all }) => {
    if (!knownRoot(rootId)) return forgetRefused('unknown root')
    return forgetLoopHunts(deps.bundledCli ?? null, rootId, {
      loop,
      ...(focus === undefined ? {} : { focus }),
      ...(all === undefined ? {} : { all }),
    })
  })

  // No rootId to validate: this names the installation, not a project. It is a
  // coordination word, not a credential — it is written into public issue
  // bodies by every claim it makes, and nothing authorizes on it.
  handle('loops:owner', () => ({ owner: deps.ownerId?.() ?? '' }))

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel)
    // The token provider belongs to THIS registration, not to the process — a
    // module-scoped hook that outlived its owner would hand a disposed
    // manager's token to the next one.
    githubTokenForCli = null
    // The directive cache holds a file watcher per root; the runs cache holds
    // snapshots nothing will invalidate once the channels are gone.
    directives.dispose()
    runsCache.dispose()
    statusCache.dispose()
  }
}
