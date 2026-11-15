/**
 * COMMAND USAGE — the commands a person keeps typing into Flow's own
 * terminals, and the ones the agent started in the background, turned into
 * the Run setup's "you ran it 6 times" / "the agent started it" suggestions —
 * for a running step (long-running commands) and for a one-time action (the
 * one-shot jobs a person runs now and then: migrations, codegen, seeds, tests).
 *
 *   - `feedLine` is the terminal's hot path: per keystroke it appends to a
 *     string and nothing else. A line counts only when Enter ends it and it
 *     was typed plainly — an escape sequence (arrows, history recall, a
 *     paste) or a control key (Tab completion, Ctrl-R) makes what the shell
 *     runs unknowable, so that line is dropped. Ctrl-C and Ctrl-U start over.
 *   - `CommandUsageStore` is the ONE writer of the recorded commands
 *     (allowed-pattern #14): per project, capped, ranked by count × recency,
 *     written to the app settings after a quiet moment — never per keystroke.
 *   - `usageSuggestions` / `mergeSuggestions` are pure: what is offered, and
 *     in which order (usage first, then what the project's files declare).
 *
 * Nothing here runs anything; a suggestion is only an offer (NFR-5). Every
 * label is plain words — never a path or a setting (forbidden-pattern #12).
 */
import type { RunSuggestion } from '../../shared/run-setup'
import { MAX_LINE_LENGTH } from '../terminal/line-buffer'
import { looksLongRunningCommand, looksOnceCommand, looksOneShotCommand, nameForCommand, oncePriority } from './run-suggest'

export interface UsageEntry {
  command: string
  count: number
  /** ISO time of the last run. */
  lastUsedAt: string
}

/** The most commands kept per project. */
export const MAX_USAGE_ENTRIES = 50
export { MAX_LINE_LENGTH }
/** Ran this often (and not a one-shot), it is offered even without a long-running word. */
export const OFTEN_RUN = 3
/** Recency halves a command's weight every this many days. */
const HALF_LIFE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

// The line buffer lives beside the terminals that feed it.
export { feedLine, newLineBuffer, type LineBuffer } from '../terminal/line-buffer'

// ─── ranking ─────────────────────────────────────────────────────────────────

/** count × recency: a command run often and lately ranks first. */
export function usageScore(count: number, lastUsedAt: string, now: number): number {
  const at = Date.parse(lastUsedAt)
  const ageDays = Number.isFinite(at) ? Math.max(0, now - at) / DAY_MS : HALF_LIFE_DAYS * 4
  return count * Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

function normalize(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/** Read stored entries defensively — an older or newer build may have written them. */
export function parseUsageEntries(raw: unknown): UsageEntry[] {
  if (!Array.isArray(raw)) return []
  const out: UsageEntry[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (typeof record.command !== 'string') continue
    const command = normalize(record.command)
    if (command === '' || command.length > MAX_LINE_LENGTH || seen.has(command)) continue
    const count = typeof record.count === 'number' && Number.isFinite(record.count) ? Math.max(1, Math.floor(record.count)) : 1
    const lastUsedAt = typeof record.lastUsedAt === 'string' && Number.isFinite(Date.parse(record.lastUsedAt)) ? record.lastUsedAt : new Date(0).toISOString()
    seen.add(command)
    out.push({ command, count, lastUsedAt })
  }
  return out
}

/** Add one run of `command` to `entries`, keeping the best `MAX_USAGE_ENTRIES` by score. */
export function addUsage(entries: readonly UsageEntry[], command: string, now: number): UsageEntry[] {
  const key = normalize(command)
  if (key === '') return [...entries]
  const at = new Date(now).toISOString()
  const found = entries.find((entry) => entry.command === key)
  const next = found
    ? entries.map((entry) => (entry === found ? { command: key, count: entry.count + 1, lastUsedAt: at } : entry))
    : [...entries, { command: key, count: 1, lastUsedAt: at }]
  if (next.length <= MAX_USAGE_ENTRIES) return next
  // Over the cap: drop the lowest-ranked — never the one just run.
  const ranked = [...next].sort(
    (a, b) => (a.command === key ? -1 : b.command === key ? 1 : usageScore(b.count, b.lastUsedAt, now) - usageScore(a.count, a.lastUsedAt, now)),
  )
  const keep = new Set(ranked.slice(0, MAX_USAGE_ENTRIES).map((entry) => entry.command))
  return next.filter((entry) => keep.has(entry.command))
}

// ─── what may be kept ────────────────────────────────────────────────────────

/**
 * Programs whose lines are worth keeping. A line is kept ONLY when it starts
 * with one of these: what is typed at a password prompt (sudo, ssh, a database
 * client) never does, so it never reaches the settings file.
 */
const RUNNER_PROGRAMS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'deno', 'node', 'tsx', 'ts-node', 'nodemon',
  'uv', 'uvx', 'poetry', 'pipenv', 'python', 'python3', 'uvicorn', 'gunicorn', 'flask', 'celery', 'hatch', 'pdm',
  'docker', 'docker-compose', 'podman', 'temporal', 'make', 'just', 'task',
  'cargo', 'go', 'air', 'rails', 'bundle', 'bin/rails', 'bin/dev', 'php', 'artisan', 'mix', 'iex',
  'java', 'gradle', './gradlew', 'mvn', './mvnw', 'dotnet', 'turbo', 'nx', 'vite', 'next', 'expo',
  'redis-server', 'mongod', 'postgres', 'stripe', 'ngrok', 'foreman', 'overmind', 'honcho', 'tilt', 'skaffold',
  // One-shot jobs worth offering as one-time actions: migrations, codegen, tests.
  'alembic', 'prisma', 'drizzle-kit', 'knex', 'typeorm', 'sequelize', 'rake', 'dbmate', 'goose', 'atlas',
  'supabase', 'pytest', 'vitest', 'jest', 'playwright', 'graphql-codegen', 'buf', 'sqlc',
])

/**
 * Words that make a runner line housekeeping rather than a job worth offering
 * again: installing, help, logging in. Never kept.
 */
const HOUSEKEEPING_WORD =
  /^(install|i|ci|add|remove|rm|uninstall|update|upgrade|outdated|audit|help|--help|-h|version|--version|-v|login|logout|whoami|init|config|ls|list|link|unlink|cache|self-update)$/i

/** A line that looks like it carries a credential — never kept. */
const SECRET_LIKE = /(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)[a-z_]*\s*=|--(?:password|token|secret)\b|\bbearer\s|:\/\/[^\s/@]+:[^\s/@]+@/i

/**
 * Whether a typed line may be kept as usage: a known runner, no secret, and
 * not housekeeping (an install, help, a login). One-shot jobs ARE kept — they
 * are what a one-time action is made of; a running step's suggestions leave
 * them out (`usageSuggestions`).
 */
export function isRecordableCommand(line: string): boolean {
  if (SECRET_LIKE.test(line)) return false
  // `FOO=1 npm run dev` — skip leading plain assignments to find the program.
  const words = line.trim().split(/\s+/).filter((word) => word !== '')
  const at = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (at < 0) return false
  const program = words[at]!
  const known = RUNNER_PROGRAMS.has(program) || RUNNER_PROGRAMS.has(program.split('/').pop() ?? program)
  if (!known) return false
  const rest = words.slice(at + 1)
  // A bare runner (a REPL) does nothing worth offering again.
  if (rest.length === 0) return false
  // Housekeeping is the runner's own subcommand (`npm install`, `uv add`), not
  // a word further on (`alembic upgrade head` is a migration).
  return !HOUSEKEEPING_WORD.test(rest[0]!)
}

// ─── the store ───────────────────────────────────────────────────────────────

export interface UsageSettings {
  getRunUsage(projectRoot: string): unknown
  setRunUsage(projectRoot: string, entries: readonly UsageEntry[]): void
}

export interface CommandUsageStoreDeps {
  settings: UsageSettings
  now?: () => number
  /** How long the store waits after the last record before writing. */
  debounceMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** The one writer of recorded terminal commands. */
export class CommandUsageStore {
  readonly #deps: CommandUsageStoreDeps
  readonly #cache = new Map<string, UsageEntry[]>()
  readonly #dirty = new Set<string>()
  #timer: unknown = null

  constructor(deps: CommandUsageStoreDeps) {
    this.#deps = deps
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  /** A project's recorded commands (a copy). */
  entries(projectRoot: string): UsageEntry[] {
    const cached = this.#cache.get(projectRoot)
    if (cached !== undefined) return cached.map((entry) => ({ ...entry }))
    let loaded: UsageEntry[] = []
    try {
      loaded = parseUsageEntries(this.#deps.settings.getRunUsage(projectRoot))
    } catch {
      loaded = []
    }
    this.#cache.set(projectRoot, loaded)
    return loaded.map((entry) => ({ ...entry }))
  }

  /**
   * One command line a person entered in a project's terminal. One-shots
   * (cd, ls, git, an install…) are not kept; the write waits for a quiet moment.
   */
  record(projectRoot: string, command: string): void {
    const line = normalize(command)
    if (projectRoot === '' || line === '' || !isRecordableCommand(line)) return
    const next = addUsage(this.entries(projectRoot), line, this.#now())
    this.#cache.set(projectRoot, next)
    this.#dirty.add(projectRoot)
    this.#schedule()
  }

  /** Write every changed project now (the debounce fired, or the app quits). */
  flush(): void {
    if (this.#timer !== null) {
      ;(this.#deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.#timer)
      this.#timer = null
    }
    for (const root of this.#dirty) {
      try {
        this.#deps.settings.setRunUsage(root, this.#cache.get(root) ?? [])
      } catch (error) {
        console.warn('[Run] could not keep the commands typed in a terminal', error)
      }
    }
    this.#dirty.clear()
  }

  #schedule(): void {
    if (this.#timer !== null) return
    const set = this.#deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.#timer = set(() => {
      this.#timer = null
      this.flush()
    }, this.#deps.debounceMs ?? 2_000)
  }
}

// ─── suggestions ─────────────────────────────────────────────────────────────

function timesLabel(count: number): string {
  if (count === 1) return 'you ran it once'
  if (count === 2) return 'you ran it twice'
  return `you ran it ${count} times`
}

/**
 * One project's usage-based suggestions, best first: the commands the person
 * typed (kept when they look long-running, or were run `OFTEN_RUN`+ times)
 * and the commands the agent started in the background (kept unless they are
 * a one-shot — running in the background is the evidence).
 */
export function usageSuggestions(
  project: { root: string; name: string },
  typed: readonly UsageEntry[],
  agent: ReadonlyArray<{ command: string; startedAt: string }>,
  now: number,
): RunSuggestion[] {
  const byCommand = new Map<string, RunSuggestion>()
  for (const entry of typed) {
    const command = normalize(entry.command)
    // A job that ends (a build, a migration) is a one-time action, never a running step.
    if (!isRecordableCommand(command) || looksOneShotCommand(command) || looksOnceCommand(command)) continue
    if (!looksLongRunningCommand(command) && entry.count < OFTEN_RUN) continue
    byCommand.set(command, {
      projectRoot: project.root,
      projectName: project.name,
      name: nameForCommand(command),
      command,
      source: timesLabel(entry.count),
      kind: 'usage',
      score: usageScore(entry.count, entry.lastUsedAt, now),
    })
  }
  const started = new Map<string, { count: number; lastUsedAt: string }>()
  for (const call of agent) {
    const command = normalize(call.command)
    // The agent runs many things in the background (waits, test runs); only a
    // runner line that keeps running is a way to run the project.
    if (command === '' || command.length > MAX_LINE_LENGTH) continue
    if (!isRecordableCommand(command) || !looksLongRunningCommand(command)) continue
    const seen = started.get(command)
    if (seen === undefined) started.set(command, { count: 1, lastUsedAt: call.startedAt })
    else {
      seen.count += 1
      if (call.startedAt > seen.lastUsedAt) seen.lastUsedAt = call.startedAt
    }
  }
  for (const [command, use] of started) {
    const score = usageScore(use.count, use.lastUsedAt, now)
    const mine = byCommand.get(command)
    if (mine !== undefined) {
      // The person's own count is the plainer story; the agent's runs still lift it.
      mine.score = (mine.score ?? 0) + score
      continue
    }
    byCommand.set(command, {
      projectRoot: project.root,
      projectName: project.name,
      name: nameForCommand(command),
      command,
      source: 'the agent started it',
      kind: 'usage',
      score,
    })
  }
  return [...byCommand.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/**
 * One project's suggestions for a ONE-TIME action from what the person typed:
 * the one-shot jobs (a migration, codegen, a seed, a test run), best first.
 * What the agent ran is left out — it runs tests over and over, which says
 * nothing about what the person wants a button for.
 */
export function onceUsageSuggestions(
  project: { root: string; name: string },
  typed: readonly UsageEntry[],
  now: number,
): RunSuggestion[] {
  const out: RunSuggestion[] = []
  const seen = new Set<string>()
  for (const entry of typed) {
    const command = normalize(entry.command)
    if (seen.has(command) || !isRecordableCommand(command) || !looksOnceCommand(command)) continue
    seen.add(command)
    out.push({
      projectRoot: project.root,
      projectName: project.name,
      name: nameForCommand(command),
      command,
      source: timesLabel(entry.count),
      kind: 'usage',
      score: usageScore(entry.count, entry.lastUsedAt, now),
      use: 'once',
    })
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/**
 * The order a one-time action's suggestions are offered in: what the person
 * actually ran lifts a declared command (and says so); otherwise migrations
 * first, then seeds, codegen and tests. Per project, in project order.
 */
export function rankOnceSuggestions(
  files: readonly RunSuggestion[],
  usage: readonly RunSuggestion[],
  projectOrder: readonly string[],
): RunSuggestion[] {
  const keyOf = (s: RunSuggestion): string => `${s.projectRoot}::${normalize(s.command)}`
  const used = new Map(usage.map((s) => [keyOf(s), s]))
  const pool = new Map<string, RunSuggestion & { rank: number }>()
  for (const file of files) {
    const key = keyOf(file)
    if (pool.has(key)) continue
    const hit = used.get(key)
    pool.set(key, {
      ...file,
      use: 'once',
      kind: hit !== undefined ? 'usage' : 'file',
      source: hit !== undefined ? `${file.source} · ${hit.source}` : file.source,
      rank: oncePriority(file) + (hit !== undefined ? 25 + Math.min(15, hit.score ?? 0) : 0),
    })
  }
  for (const use of usage) {
    const key = keyOf(use)
    if (pool.has(key)) continue
    pool.set(key, { ...use, use: 'once', kind: 'usage', rank: 10 + oncePriority(use) / 2 + Math.min(15, use.score ?? 0) })
  }
  const order = (root: string): number => {
    const at = projectOrder.indexOf(root)
    return at === -1 ? projectOrder.length : at
  }
  return [...pool.values()]
    .sort((a, b) => order(a.projectRoot) - order(b.projectRoot) || b.rank - a.rank)
    .map(({ rank: _rank, ...rest }) => rest)
}

/** How strongly a command reads as THE way to run a project: dev/start first, extras (storybook, preview) last. */
export function runPriority(suggestion: Pick<RunSuggestion, 'name' | 'command' | 'source'>): number {
  const name = suggestion.name.toLowerCase()
  const words = suggestion.command.toLowerCase().split(/\s+/)
  let score = 15
  if (name === 'dev' || name === 'develop' || name === 'start-dev' || name === 'run-dev') score = 50
  else if (name === 'start') score = 45
  else if (name === 'serve' || name === 'server' || name === 'web' || name === 'api') score = 40
  else if (words.includes('up') && (words.includes('compose') || words[0] === 'docker-compose')) score = 30
  else if (/(^|[:_-])(dev|start|serve)([:_-]|$)/.test(name)) score = 25
  else if (/watch/.test(name)) score = 12
  else if (/storybook|preview|docs/.test(name)) score = 6
  const source = suggestion.source.toLowerCase()
  if (source === 'procfile') score += 30
  else if (source === 'readme') score += 28
  else if (source === 'package.json' || source === 'pyproject.toml') score += 20
  else if (source === 'makefile') score += 18
  else if (source === 'docker compose') score += 14
  return score
}

/**
 * The order the panel shows: the way to run each project first — the best
 * candidate of every project, the main project first — then everything else
 * by how likely it is to be a run command. What the person actually ran lifts
 * a declared command (and says so) rather than competing with it; usage that
 * matches nothing declared joins the pool on its own score.
 */
export function rankSuggestions(
  files: readonly RunSuggestion[],
  usage: readonly RunSuggestion[],
  projectOrder: readonly string[],
): RunSuggestion[] {
  const keyOf = (s: RunSuggestion): string => `${s.projectRoot}::${normalize(s.command)}`
  const used = new Map(usage.map((s) => [keyOf(s), s]))
  const pool = new Map<string, RunSuggestion & { rank: number }>()
  for (const file of files) {
    const key = keyOf(file)
    if (pool.has(key)) continue
    const hit = used.get(key)
    pool.set(key, {
      ...file,
      kind: hit !== undefined ? 'usage' : 'file',
      source: hit !== undefined ? `${file.source} · ${hit.source}` : file.source,
      rank: runPriority(file) + (hit !== undefined ? 25 + Math.min(15, hit.score ?? 0) : 0),
    })
  }
  for (const use of usage) {
    const key = keyOf(use)
    if (pool.has(key)) continue
    pool.set(key, { ...use, kind: 'usage', rank: 10 + runPriority(use) / 2 + Math.min(15, use.score ?? 0) })
  }
  const order = (root: string): number => {
    const at = projectOrder.indexOf(root)
    return at === -1 ? projectOrder.length : at
  }
  const all = [...pool.values()].sort((a, b) => b.rank - a.rank || order(a.projectRoot) - order(b.projectRoot))
  const leaders: typeof all = []
  const seenProject = new Set<string>()
  for (const s of [...all].sort((a, b) => order(a.projectRoot) - order(b.projectRoot) || b.rank - a.rank)) {
    if (seenProject.has(s.projectRoot)) continue
    seenProject.add(s.projectRoot)
    leaders.push(s)
  }
  const leaderKeys = new Set(leaders.map(keyOf))
  return [...leaders, ...all.filter((s) => !leaderKeys.has(keyOf(s)))].map(({ rank: _rank, ...rest }) => rest)
}

/** Kept for callers that only have usage and files: same as `rankSuggestions` with no project order. */
export function mergeSuggestions(usage: readonly RunSuggestion[], files: readonly RunSuggestion[]): RunSuggestion[] {
  return rankSuggestions(files, usage, [])
}
