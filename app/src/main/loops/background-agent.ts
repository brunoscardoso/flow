// Loop runs as Claude Code background agents — the runtime, instead of ours.
//
// A loop run has always been a Claude Code session; what plan-flow supplied was
// the SUPERVISION around it — locks, a run budget, a breaker, a pipeline state
// machine, a worktree pool. Claude Code now runs and lists background agents
// itself (`--bg`, and an agents list scoped to a project root), so this module
// is the whole of what the app needs: start one run, and read what is in flight.
//
// TWO CALLS, AND ONLY TWO. Everything else a run needs — the mission, the
// queue, the caps — is already in the directive on disk (Phase 1) and in the
// queue backend (untouched). Nothing here schedules, retries, times out a run or
// decides that one has gone wrong; a run that dies is REPORTED by the CLI's
// stuck-claim check (Phase 2), which is a report over a snapshot this module
// hands it.
//
// THE SNAPSHOT IS PASSED ON RAW. `loop status --live-runs <json>` re-derives
// liveness from the same array, in the same discriminated-union discipline, and
// it is the authority because it runs on every engineer's machine while this
// file runs only inside the IDE (allowed pattern #14). Pre-filtering here would
// mean two readers of one list that can disagree, so the known branch carries
// the array's own text verbatim alongside the parse.
//
// UNKNOWN IS NOT EMPTY — the safety property, mirrored field for field from
// `src/cli/loop/stuck-claims.ts`. "Nobody could say which runs are alive" and
// "no runs are alive" are different answers, and collapsing them reports every
// live claim in the project as dead. `RunsInFlight` is a union on `known`, so a
// consumer that reads runs off an answer that has none cannot compile.
//
// TWO ENTRY SHAPES, ONE OF WHICH IS NOT A RUN. The agents list carries the
// user's OWN interactive chat sessions beside the background ones — a
// `background` entry has `id` + `state`, an `interactive` entry has `pid` +
// `status`. Observed live: the session that planned this feature appeared in the
// output. An unfiltered reader draws a person's conversation as a loop run, so
// only `kind === 'background'` is ever a run.
//
// ASYNC, ALWAYS, AND NOT FROM HERE. Both calls run a real process, and this
// file runs in the main process where every window waits behind a blocked call
// (allowed pattern #19). The agents read therefore goes through the CLI HOST —
// the utility process every other main-process runner already uses — because
// spawning is not free even when it is async: a sample of main during a live
// stall found 73% of its CPU inside `posix_spawn`, and this module spawns a
// heavier binary than any of them. The host is a fallback away from the old
// behaviour, never a way to lose the feature. The read is additionally cached
// per root and gated on whether anyone is looking (#17) — an off-screen panel
// costs nothing.

import { spawn } from 'child_process'
import { randomUUID } from 'node:crypto'

import { resolveClaudeBinForSpawn } from '../agent/account-resolver'
import { runInCliHost } from '../cli-host/client'

/** The `kind` an entry must carry to be a loop run at all (CLI: BACKGROUND_KIND). */
export const BACKGROUND_KIND = 'background'

/**
 * How long the agents read may take.
 *
 * It is a local process listing its own sessions — sub-second in practice. The
 * budget is for a machine under load, not for work.
 */
export const AGENTS_READ_TIMEOUT_MS = 15_000

/**
 * How long a dispatch may take.
 *
 * `--bg` RETURNS IMMEDIATELY — it starts the agent and exits, so this budget
 * covers process start-up and nothing else. A run's own length is bounded by
 * the run, not by the call that started it.
 */
export const DISPATCH_TIMEOUT_MS = 30_000

/**
 * How long a runs snapshot is served before the list is read again.
 *
 * SHORT, AND A FLOOR RATHER THAN A GUESS: there is no watcher over another
 * program's sessions, so the TTL is the only thing between the panel and a
 * process per refresh. Five seconds is the same window the directive cache uses,
 * for the same reason (allowed pattern #20).
 */
export const RUNS_CACHE_TTL_MS = 5_000

/** Keep only the tail of stderr — a refusal is one line, a stack is not. */
const STDERR_TAIL_CHARS = 2000

/** SGR colour codes, as a CLI's logger emits them even into a pipe. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

/** The shape `--session-id` requires, and the shape a session id is read back in. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One background agent, as the agents list describes it.
 *
 * `sessionId` is the only REQUIRED field, because it is the only one anything
 * depends on: it is what a claim's owner carries (`runOwner`), and therefore the
 * one fact that makes a stuck claim nameable. Everything else is decoration for
 * a panel and is null when the entry did not carry it — an entry missing its
 * display name is still a run, and dropping it would hide a live one.
 */
export interface BackgroundRun {
  /** The session the run lives in — the identity a claim is bound to. */
  sessionId: string
  /** The short id the agents list shows, when the entry carried one. */
  id: string | null
  /** The display name the session was started with, when it has one. */
  name: string | null
  /** The directory it was started under, when the entry carried one. */
  cwd: string | null
  /** Epoch ms it started, when the entry carried one. */
  startedAt: number | null
  /** What it is doing — the background entry's `state`, verbatim. */
  state: string | null
}

/**
 * What is running for a project root, or the reason nobody could say.
 *
 * `raw` rides on the known branch on purpose: the CLI's stuck-claim check is
 * handed the ARRAY, not this parse, so the two cannot drift into disagreeing
 * about which sessions exist.
 */
export type RunsInFlight =
  | { known: true; runs: BackgroundRun[]; raw: string; readAt: number }
  | { known: false; reason: string; readAt: number }

/** The "could not tell" answer, with a reason a person can act on. */
export function unknownRuns(reason: string, readAt: number): RunsInFlight {
  return { known: false, reason, readAt }
}

/**
 * The JSON array inside whatever the agents list printed.
 *
 * STDOUT IS NOT PURE JSON, and this is observed rather than assumed: some builds
 * print a banner line before the array. A reader that hands the whole transcript
 * to `JSON.parse` reports a healthy machine as unreadable, and an unreadable
 * snapshot suppresses the stuck-claim report entirely — so the banner would
 * silently cost the user the one thing this feature exists to give them.
 *
 * The array is taken from the FIRST `[` to the LAST `]`, which is the only slice
 * that can be the top-level array: anything before it is a banner, anything
 * after it is a trailing notice, and nested brackets are inside those bounds by
 * construction. Returns null when there is no array-shaped slice at all.
 */
export function extractJsonArray(stdout: string): string | null {
  const text = stdout.replace(ANSI_PATTERN, '')
  const open = text.indexOf('[')
  const close = text.lastIndexOf(']')
  if (open < 0 || close < open) return null
  return text.slice(open, close + 1)
}

/**
 * Read a parsed agents array into the background runs it names.
 *
 * DEFENSIVE BY DESIGN, and every departure from the observed shape is "could not
 * tell" rather than a quietly shorter list — narrowing the set of live runs is
 * exactly how a healthy claim gets reported dead:
 *
 *   - not an array, or an entry that is not an object → unknown
 *   - an entry with no string `kind` → unknown, because a reader that cannot
 *     tell a background agent from the user's own chat cannot filter either way
 *   - a background entry with no usable `sessionId` → unknown, because that
 *     unidentifiable entry may be the very run holding a claim in question
 *
 * Entries of any other kind are simply not runs, and are skipped.
 */
export function backgroundRuns(snapshot: unknown, raw: string, readAt: number): RunsInFlight {
  if (!Array.isArray(snapshot)) {
    return unknownRuns('the list of running agents was not a list', readAt)
  }
  const runs: BackgroundRun[] = []
  for (const entry of snapshot) {
    if (typeof entry !== 'object' || entry === null) {
      return unknownRuns('the list of running agents held something that was not an agent', readAt)
    }
    const record = entry as Record<string, unknown>
    const kind = record['kind']
    if (typeof kind !== 'string') {
      return unknownRuns('an entry in the list of running agents did not say what kind it was', readAt)
    }
    if (kind !== BACKGROUND_KIND) continue
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return unknownRuns('a running background agent did not say which session it is', readAt)
    }
    runs.push({
      sessionId: sessionId.trim(),
      id: stringOrNull(record['id']),
      name: stringOrNull(record['name']),
      cwd: stringOrNull(record['cwd']),
      startedAt: typeof record['startedAt'] === 'number' ? record['startedAt'] : null,
      state: stringOrNull(record['state']),
    })
  }
  return { known: true, runs, raw, readAt }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * The same read, from whatever the agents list printed.
 *
 * EMPTY OUTPUT IS UNKNOWN, by the same rule as everything else here: a command
 * that printed nothing has not told us that nothing is running, and treating
 * silence as an empty world is the failure this module exists to avoid.
 */
export function parseAgentsOutput(stdout: string, readAt: number): RunsInFlight {
  const raw = extractJsonArray(stdout)
  if (raw === null) {
    return unknownRuns('the list of running agents could not be read', readAt)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unknownRuns('the list of running agents could not be read', readAt)
  }
  return backgroundRuns(parsed, raw, readAt)
}

/** What the two calls need from the world, all injectable for tests. */
export interface BackgroundAgentDeps {
  /** Swapped in tests. NOTHING in a test may reach the real one. */
  spawnFn?: typeof spawn
  /** The Claude Code binary. Defaults to the same one agent sessions run. */
  claudeBin?: string
  timeoutMs?: number
  /** Injected so timestamps and cache windows are testable without sleeping. */
  now?: () => number
  /** Injected so a dispatched session id is assertable. */
  newSessionId?: () => string
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not run at all, or ran too long. */
  error: string | null
  /** True only for the timeout, which needs a reason of its own. */
  timedOut: boolean
}

/**
 * One Claude Code invocation, capturing stdout and the tail of stderr.
 *
 * Never throws and never blocks: a spawn that fails to start resolves with the
 * reason, and a spawn that runs too long is killed and resolves with the
 * timeout (allowed pattern #19).
 */
function runClaude(
  claudeBin: string,
  args: readonly string[],
  cwd: string,
  deps: { spawnFn: typeof spawn; timeoutMs: number; viaHost?: boolean; injected?: boolean },
): Promise<ProcessResult> {
  // SPAWNED FROM THE HOST, NOT FROM HERE — unless a test injected its own
  // spawn, which is the one case that must still run in-process (it is what
  // stops a real `claude` from ever running in a suite). Every other
  // main-process CLI runner already routes through the host, and its header
  // says why: a sample of Electron's main process during a live stall found 73%
  // of its CPU inside `posix_spawn`. This module was spawning a heavier binary
  // than any of them, on main, past the mitigation built for exactly that
  // (review finding H2).
  if (deps.viaHost === true && deps.injected !== true) {
    const hosted = runInCliHost({
      execPath: claudeBin,
      args: [...args],
      cwd,
      env: { ...process.env },
      captureStdout: true,
      timeoutMs: deps.timeoutMs,
    })
    if (hosted !== null) {
      return hosted.then((result) => {
        // A HOST THAT IS NOT THERE IS NOT AN ANSWER. Both of these mean the
        // request never reached a child, so the caller's own spawn still runs —
        // a performance fix must not become a way for the app to lose a
        // feature (see cli-host/client.ts).
        if (result.error === 'cli host exited' || result.error === 'cli host unreachable') {
          return spawnHere()
        }
        // The host enforces the timeout itself and reports it by that name; it
        // reports ok/not-ok rather than an exit code, and a non-ok run that
        // still produced output is exactly `code: 1` here.
        if (result.error === 'timed out') {
          return { code: null, stdout: result.stdout, stderr: result.stderr, error: 'timed out', timedOut: true }
        }
        return {
          code: result.ok ? 0 : 1,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.ok || result.error === undefined ? null : result.error,
          timedOut: false,
        }
      })
    }
  }
  return spawnHere()

  function spawnHere(): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof deps.spawnFn>
    try {
      child = deps.spawnFn(claudeBin, [...args], {
        cwd,
        // No shell, and stdin closed: a background agent must never inherit a
        // terminal this process does not have, and an argument is an argument
        // rather than something a shell gets to reinterpret.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: messageOf(error), timedOut: false })
      return
    }
    let settled = false
    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, error: 'timed out', timedOut: true })
    }, deps.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      finish({ code: null, stdout, stderr, error: error.message, timedOut: false })
    })
    child.on('close', (code: number | null) => {
      finish({ code, stdout, stderr, error: null, timedOut: false })
    })
  })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when a spawn failed because there is no such executable. */
function isMissingBinary(error: string): boolean {
  return error.includes('ENOENT')
}

/**
 * The reasons this module gives, in the user's terms rather than the tool's.
 *
 * NOT A RELAY. The underlying CLI writes for someone at a terminal, and its
 * refusals legitimately end in an invocation to type; a panel has no terminal
 * and the reader cannot press a sentence (forbidden pattern #12). So the tool's
 * own line is LOGGED for whoever is debugging and never becomes the reason,
 * while each distinct failure still gets a distinct sentence — "fails soft" and
 * "fails silently" are not the same thing.
 */
const REASONS = {
  noClaudeForRead:
    "Claude Code isn't available here, so Flow can't tell which runs are going in this project.",
  readFailed: "Claude Code couldn't say which runs are going in this project.",
  readTimedOut: 'Claude Code took too long to say which runs are going in this project.',
  notRead: 'Nothing has looked at this project yet, so nothing knows which runs are going.',
  noClaudeForDispatch: "Claude Code isn't available here, so this loop can't be started from Flow.",
  dispatchFailed: "Claude Code couldn't start a run for this loop.",
  dispatchTimedOut: 'Claude Code took too long to start a run for this loop.',
} as const

/**
 * The background agents running under a project root.
 *
 * ONE PROCESS PER READ, which is why the cache below exists and why the panel
 * gates on visibility. Scoped to the root because a run belongs to a project:
 * an unscoped read would mix another project's runs into this one's report, and
 * a claim would be called stuck on the strength of a list it was never in.
 */
export async function readRunsInFlight(
  rootPath: string,
  deps: BackgroundAgentDeps = {},
): Promise<RunsInFlight> {
  const now = deps.now ?? Date.now
  const spawnFn = deps.spawnFn ?? spawn
  const claudeBin = deps.claudeBin ?? (await resolveClaudeBinForSpawn())
  const result = await runClaude(claudeBin, ['agents', '--cwd', rootPath, '--json'], rootPath, {
    spawnFn,
    timeoutMs: deps.timeoutMs ?? AGENTS_READ_TIMEOUT_MS,
    viaHost: true,
    injected: deps.spawnFn !== undefined,
  })
  const readAt = now()
  if (result.timedOut) return unknownRuns(REASONS.readTimedOut, readAt)
  if (result.error !== null) {
    console.warn('[background-agent] listing running agents failed:', result.error)
    return unknownRuns(
      isMissingBinary(result.error) ? REASONS.noClaudeForRead : REASONS.readFailed,
      readAt,
    )
  }
  if (result.code !== 0) {
    console.warn(
      `[background-agent] listing running agents exited ${String(result.code)}:`,
      `${result.stdout}\n${result.stderr}`.replace(ANSI_PATTERN, '').trim().slice(-STDERR_TAIL_CHARS),
    )
    return unknownRuns(REASONS.readFailed, readAt)
  }
  return parseAgentsOutput(result.stdout, readAt)
}

/**
 * Whether anyone is looking at this project's runs right now.
 *
 * THE VERDICT COMES FROM THE CALLER, deliberately. The renderer already owns the
 * one rule (`shouldPollLoops` — document hidden, pane visible), and a second
 * copy of it in the main process would be a second rule to keep in step
 * (allowed pattern #17 says put the test in ONE helper and call it). What this
 * module owns is the consequence: when nobody is looking, nothing spawns.
 */
export interface RunsReadGate {
  visible: boolean
}

interface RunsCacheEntry {
  snapshot: RunsInFlight | null
  inFlight: Promise<RunsInFlight> | null
}

/**
 * Runs snapshots, cached per project root.
 *
 * KEYED ON THE ROOT AND NOTHING ELSE, because nothing else changes the answer —
 * there is no limit, filter or query to key on. Concurrent readers share one
 * in-flight promise: the panel and a broadcast can both ask at once, and two
 * processes for one answer is the cost this class exists to remove.
 *
 * AN OFF-SCREEN CALLER SPAWNS NOTHING. It is served what is already known —
 * including the honest "nothing has looked yet" when that is the truth — and a
 * surface coming back into view re-reads on the way in rather than queueing work
 * while it was away.
 */
export class RunsInFlightCache {
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #readFn: (rootPath: string) => Promise<RunsInFlight>
  readonly #entries = new Map<string, RunsCacheEntry>()

  constructor(
    deps: BackgroundAgentDeps & {
      ttlMs?: number
      /** The read itself — swapped in tests to count how often it actually runs. */
      readFn?: (rootPath: string) => Promise<RunsInFlight>
    } = {},
  ) {
    this.#now = deps.now ?? Date.now
    this.#ttlMs = deps.ttlMs ?? RUNS_CACHE_TTL_MS
    this.#readFn =
      deps.readFn ??
      ((rootPath) =>
        readRunsInFlight(rootPath, {
          ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
          ...(deps.claudeBin === undefined ? {} : { claudeBin: deps.claudeBin }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
          now: this.#now,
        }))
  }

  /** The root's runs — from cache when it is fresh, from a process when it is not. */
  read(rootPath: string, gate: RunsReadGate = { visible: true }): Promise<RunsInFlight> {
    const entry = this.#entries.get(rootPath)
    if (entry !== undefined) {
      if (entry.inFlight !== null) return entry.inFlight
      if (entry.snapshot !== null) {
        const fresh = this.#now() - entry.snapshot.readAt < this.#ttlMs
        if (fresh || !gate.visible) return Promise.resolve(entry.snapshot)
      }
    }
    if (!gate.visible) return Promise.resolve(unknownRuns(REASONS.notRead, this.#now()))
    return this.#refresh(rootPath)
  }

  /** Drop a root's cache — called when a project leaves. */
  forget(rootPath: string): void {
    this.#entries.delete(rootPath)
  }

  /** Drop every root — for app shutdown. */
  dispose(): void {
    this.#entries.clear()
  }

  #refresh(rootPath: string): Promise<RunsInFlight> {
    const entry = this.#ensure(rootPath)
    const pending = this.#readFn(rootPath).then(
      (snapshot) => {
        if (entry.inFlight === pending) {
          entry.inFlight = null
          entry.snapshot = snapshot
        }
        return snapshot
      },
      (error: unknown) => {
        if (entry.inFlight === pending) entry.inFlight = null
        throw error
      },
    )
    entry.inFlight = pending
    return pending
  }

  #ensure(rootPath: string): RunsCacheEntry {
    const existing = this.#entries.get(rootPath)
    if (existing !== undefined) return existing
    const entry: RunsCacheEntry = { snapshot: null, inFlight: null }
    this.#entries.set(rootPath, entry)
    return entry
  }
}

/**
 * A run somebody asked for.
 *
 * `confirmed` IS THE WHOLE GUARD, and it is a required field rather than an
 * option with a default (forbidden pattern #15). Starting a run is expensive and
 * outward-facing — it opens issues, pushes branches and comments on a queue five
 * engineers share — so the one thing that must never happen is a run starting
 * because a caller omitted something. A request that does not say a person asked
 * for it is refused before anything is spawned, and the refusal is a value, not
 * an exception, so a caller cannot swallow it by not catching.
 */
export interface LoopRunRequest {
  /** Project root the run works in. */
  rootPath: string
  /** Which loop — its directive supplies the mission, the queue and the caps. */
  loop: string
  /** Optional aim for THIS run: where to look first inside the loop's mission. */
  focus?: string
  /**
   * Pin the session the run will live in.
   *
   * Normally absent and generated here. A caller supplies one only when it has
   * already recorded the binding somewhere and needs the run to match it.
   */
  sessionId?: string
  /** A person asked for this run. Nothing starts without it. */
  confirmed: true
}

/** What a dispatch attempt produced. */
export type LoopRunDispatch =
  | {
      dispatched: true
      /** The session the run lives in — bind claims to this. */
      sessionId: string
      loop: string
      /** Epoch ms the run was started, from the injected clock. */
      startedAt: number
    }
  | { dispatched: false; reason: string }

function refused(reason: string): LoopRunDispatch {
  return { dispatched: false, reason }
}

/**
 * What the run is told to do.
 *
 * A PROMPT IS NOT UI TEXT. Forbidden pattern #12 forbids putting an invocation
 * in front of a person who cannot press it; this string is read by an agent
 * whose whole job is to run things, and naming the command is the only way to
 * start the run at all. It never reaches a panel.
 *
 * THE SESSION IS PASSED DOWN, not inferred. The run records it on every claim it
 * takes (`--session`, which rides inside the owner — see the CLI's
 * `stuck-claims.ts`), and that binding is the entire reason a claim held by a
 * run that died can be named later. A run that was not told its session takes
 * claims nothing can check.
 */
export function dispatchPrompt(loop: string, sessionId: string, focus?: string): string {
  const aim = focus?.trim() ?? ''
  const command = aim.length > 0 ? `/agent-loop ${loop} ${aim}` : `/agent-loop ${loop}`
  return [
    command,
    '',
    `Pass --session ${sessionId} to every planflow-ai loop verb you call in this run, so that`,
    'every item this run claims records the session holding it and a claim left behind by a run',
    'that died can be named.',
  ].join('\n')
}

/**
 * The arguments that start one background run.
 *
 * `--session-id` IS PINNED BY THE DISPATCHER rather than read back afterwards.
 * `--bg` returns as soon as the agent is started and prints nothing this code
 * may depend on, so reading the identity back would mean a second process, a
 * race against the agents list, and an unanswerable case where the run exists
 * but the caller never learned its name. Choosing the id up front makes the
 * binding exist before the run does.
 *
 * The display name is the loop's, so a person scanning their own agents list
 * sees which loop a session belongs to instead of a generated phrase.
 */
export function dispatchArgs(loop: string, sessionId: string, prompt: string): string[] {
  return ['--bg', '--session-id', sessionId, '--name', `loop ${loop}`, prompt]
}

/**
 * Start one run of one loop, as a Claude Code background agent.
 *
 * REFUSES LOCALLY BEFORE IT SPAWNS. An unconfirmed request, an empty root, a
 * loop name that is not a name and a pinned session that is not a session are
 * each answered without starting a process — a refusal that had to travel
 * through a spawned agent is a refusal that cost a run to discover.
 *
 * NOTHING IS SUPERVISED FROM HERE. No lock is taken, no budget is started and no
 * timeout kills the run: the process this awaits is the DISPATCH, which exits
 * immediately, and the run itself outlives it. What replaces the supervision is
 * the pair of reports — the agents list above, and the CLI's stuck-claim check
 * over the snapshot it produces.
 */
export async function dispatchLoopRun(
  request: LoopRunRequest,
  deps: BackgroundAgentDeps = {},
): Promise<LoopRunDispatch> {
  if (request.confirmed !== true) {
    return refused('A run starts only when someone asks for it, and nothing asked for this one.')
  }
  const rootPath = request.rootPath.trim()
  if (rootPath.length === 0) {
    return refused('A run needs a project to work in, and this request named none.')
  }
  const loop = request.loop.trim()
  if (loop.length === 0 || /\s/.test(loop)) {
    return refused('A run needs the name of a loop to run, and this request named none.')
  }
  const now = deps.now ?? Date.now
  const pinned = request.sessionId?.trim() ?? ''
  if (pinned.length > 0 && !UUID_PATTERN.test(pinned)) {
    return refused('The session this run was asked to use is not one Claude Code can start.')
  }
  const sessionId = pinned.length > 0 ? pinned : (deps.newSessionId ?? randomUUID)()
  const spawnFn = deps.spawnFn ?? spawn
  const claudeBin = deps.claudeBin ?? (await resolveClaudeBinForSpawn())
  const prompt = dispatchPrompt(loop, sessionId, request.focus)
  const result = await runClaude(claudeBin, dispatchArgs(loop, sessionId, prompt), rootPath, {
    spawnFn,
    timeoutMs: deps.timeoutMs ?? DISPATCH_TIMEOUT_MS,
  })
  if (result.timedOut) return refused(REASONS.dispatchTimedOut)
  if (result.error !== null) {
    console.warn('[background-agent] starting a run failed:', result.error)
    return refused(isMissingBinary(result.error) ? REASONS.noClaudeForDispatch : REASONS.dispatchFailed)
  }
  if (result.code !== 0) {
    console.warn(
      `[background-agent] starting a run exited ${String(result.code)}:`,
      `${result.stdout}\n${result.stderr}`.replace(ANSI_PATTERN, '').trim().slice(-STDERR_TAIL_CHARS),
    )
    return refused(REASONS.dispatchFailed)
  }
  return { dispatched: true, sessionId, loop, startedAt: now() }
}
