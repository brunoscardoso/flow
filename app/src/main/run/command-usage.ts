/**
 * COMMAND USAGE — the commands a person keeps typing into Flow's own
 * terminals, and the ones the agent started in the background, turned into
 * the Run setup's "you ran it 6 times" / "the agent started it" suggestions.
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
import { looksLongRunningCommand, looksOneShotCommand, nameForCommand } from './run-suggest'

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
])

/** A line that looks like it carries a credential — never kept. */
const SECRET_LIKE = /(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)[a-z_]*\s*=|--(?:password|token|secret)\b|\bbearer\s|:\/\/[^\s/@]+:[^\s/@]+@/i

/** Whether a typed line may be kept as usage: a known runner, not a one-shot, no secret. */
export function isRecordableCommand(line: string): boolean {
  if (SECRET_LIKE.test(line)) return false
  if (looksOneShotCommand(line)) return false
  const first = line.trim().split(/\s+/)[0] ?? ''
  // `FOO=1 npm run dev` — skip leading plain assignments to find the program.
  const words = line.trim().split(/\s+/)
  const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? first
  return RUNNER_PROGRAMS.has(program) || RUNNER_PROGRAMS.has(program.split('/').pop() ?? program)
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
    if (looksOneShotCommand(command)) continue
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
    if (command === '' || command.length > MAX_LINE_LENGTH || looksOneShotCommand(command)) continue
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
 * Usage first (best score first, across projects), then the file-based ones
 * in the order found; one suggestion per (project, command) — the first wins.
 */
export function mergeSuggestions(usage: readonly RunSuggestion[], files: readonly RunSuggestion[]): RunSuggestion[] {
  const out: RunSuggestion[] = []
  const seen = new Set<string>()
  const ranked = [...usage].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  for (const suggestion of [...ranked, ...files]) {
    const key = `${suggestion.projectRoot}::${normalize(suggestion.command)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...suggestion, kind: suggestion.kind ?? 'file' })
  }
  return out
}
