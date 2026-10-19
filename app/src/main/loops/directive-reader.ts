// Loop directives, read in-process — the read path that used to be a subprocess.
//
// `loops:read` USED TO RUN the bundled CLI's `loop status` on every call, and
// booting a fresh CLI runtime to read three markdown files was the expensive
// part (it is this reader's channel now — Phase 4 wired it): the
// handler's own comment records `loops:read handled in 2,103ms`, and a profile
// of main found 93% of its CPU inside posix_spawn (see `runCli` in
// loops-handler.ts). Everything the panel draws from a DIRECTIVE — mission,
// topic, engine, slice, queue kind and location, the caps, whether the file
// itself says paused — is a markdown file on local disk. None of it needs a
// process.
//
// THIS FILE MIRRORS A PARSER, IT DOES NOT REPLACE ONE. `src/cli/loop/
// directive-parser.ts` remains the definition of the directive format, and the
// grammar is frozen: every refusal message, default and validation order below
// is copied from it so that a directive reading one way here and another way in
// a headless run is impossible. It is mirrored rather than imported for the same
// reason `LoopStatusRow` is mirrored in ipc-contract.ts — the CLI is ESM at the
// repo root, this workspace is CommonJS main-process TypeScript, and the two
// have never shared a module. `directive-reader.test.ts` pins the mirror against
// this repo's own `loops/` directory, field by field.
//
// PURE ON PURPOSE: no Electron, no child_process, no DOM. It reads files
// asynchronously (allowed pattern #19 — nothing on main may block the process
// every other window waits behind) and it is testable under plain Node.
//
// SCOPE: the DIRECTIVE half of a loops snapshot. A loop's pause, locks and last
// outcome live in `flow/loops/state.json`, and its queue counts come from a
// backend that may be GitHub over the network; neither is read here.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { watch } from 'chokidar'

// ── the frozen grammar, mirrored from src/cli/loop/ ──────────────────────

/** Directory holding loop DIRECTIVES, relative to the project root (tracked). */
export const TRACKED_LOOPS_DIRNAME = 'loops'

/** The legacy home under `flow/` — still read so a machine mid-migration works. */
export const FLOW_LOOPS_DIRNAME = 'loops'

/** Fence delimiting the frontmatter block. */
const FRONTMATTER_FENCE = '---'

/** What `max_run_minutes` was called before the rename; accepted on read. */
const LEGACY_MAX_RUN_MINUTES_KEY = 'max_beat_minutes'

/**
 * Every key the frontmatter grammar allows. Anything else REFUSES, and that is
 * the point: `max_open_issue` is a plausible typo of `max_open_issues`, and a
 * parser that ignored it would run the loop uncapped while the file on disk
 * looks like it set a cap.
 */
const DIRECTIVE_KEYS = [
  'loop',
  'engine',
  'paused',
  'mission',
  'scope',
  'slice',
  'queue',
  'repo',
  'path',
  'label',
  'topic',
  'max_open_issues',
  'max_run_minutes',
  'max_concurrent_runs',
  'needs_approval',
] as const

/** Loop names are filenames, branch segments and state-store keys at once. */
const LOOP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `owner/name` — the only repo form `gh` accepts for a cross-repo call. */
const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/

/** What a loop DOES with a queue. */
export type LoopDirectiveEngine = 'producer' | 'consumer'

/** Every engine, for validation and refusal messages. */
export const LOOP_ENGINES: readonly LoopDirectiveEngine[] = ['producer', 'consumer']

/** How a producer chooses what to look at this run. */
export type LoopDirectiveSlice = 'changed' | 'rotate' | 'full'

/** Every slice mode, for validation and refusal messages. */
export const LOOP_SLICES: readonly LoopDirectiveSlice[] = ['changed', 'rotate', 'full']

/** Where a loop's queue physically lives. */
export type LoopDirectiveQueueKind = 'github' | 'ledger'

/** Every queue kind, for validation and refusal messages. */
export const LOOP_QUEUE_KINDS: readonly LoopDirectiveQueueKind[] = ['github', 'ledger']

/** Slice used when a directive does not name one. */
export const DEFAULT_LOOP_SLICE: LoopDirectiveSlice = 'changed'

/** Run budget in minutes when a directive does not name one. */
export const DEFAULT_MAX_RUN_MINUTES = 25

/** Concurrent runs when a directive does not name one. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 1

/** Ceiling on `max_concurrent_runs` — each slot is a whole git worktree. */
export const MAX_CONCURRENT_RUNS_LIMIT = 25

/** Open-item cap when a directive does not name one. */
export const DEFAULT_MAX_OPEN_ISSUES = 8

/** Ledger path used when `queue: ledger` and the directive names no `path`. */
export const DEFAULT_LEDGER_PATH = 'flow/loops/queue.jsonl'

/** Queue-state labels a topic may not shadow (CLI: RESERVED_LABELS). */
const RESERVED_TOPICS: readonly string[] = ['needs-approval', 'not-now', 'in-progress']

/** A topic is a word, not a sentence (CLI: TOPIC_MAX_LENGTH). */
const TOPIC_MAX_LENGTH = 50

/** The label grammar a topic must fit — it becomes repo configuration. */
const TOPIC_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/

/**
 * How long a notice may be before it is elided (CLI: NOTE_MAX_LENGTH).
 *
 * Matched to the CLI's so a truncated refusal reads identically whichever side
 * produced it — the parity test asserts the elision, ellipsis included.
 */
const NOTICE_MAX_LENGTH = 200

/**
 * A parsed, VALIDATED directive — the whole of what a loop is pointed at.
 *
 * Every field is either present in the file or a documented default; nothing is
 * optional-because-unparsed. Field names are the CLI's `LoopDirective`, because
 * a rename at this boundary would be a second vocabulary to keep in sync.
 */
export interface LoopDirectiveRecord {
  /** Loop name — must match its filename. */
  loop: string
  engine: LoopDirectiveEngine
  /** Directive-level pause — steering by commit, independent of state.json. */
  paused: boolean
  /** What this loop is for, in one line. Required; never defaulted. */
  mission: string
  /** Paths the loop may work within. Empty means the whole repo. */
  scope: string[]
  slice: LoopDirectiveSlice
  queue: LoopDirectiveQueueKind
  /** `owner/name` — set only when `queue: github`. */
  repo?: string
  /** Ledger file path — set (defaulted) only when `queue: ledger`. */
  path?: string
  /** Queue label applied to filed items. */
  label?: string
  /** The AREA this loop is pointed at right now. Absent when it names none. */
  topic?: string
  maxOpenIssues: number
  maxRunMinutes: number
  maxConcurrentRuns: number
  needsApproval: boolean
  /** `## Direction` prose, trimmed. Empty when the section is absent. */
  direction: string
  /** `## Rules` prose, trimmed. Empty when the section is absent. */
  rules: string
}

// ── parsing ──────────────────────────────────────────────────────────────

/** Throw the one-line refusal for a directive, always naming its source. */
function refuse(source: string, reason: string): never {
  throw new Error(`${source}: ${reason}`)
}

/**
 * Collapse a message to one line, eliding past the CLI's own length.
 *
 * A refusal reaches a card, and a stack trace's worth of newlines in a card is
 * a layout bug wearing an error message's clothes.
 */
export function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > NOTICE_MAX_LENGTH
    ? `${collapsed.slice(0, NOTICE_MAX_LENGTH - 1)}…`
    : collapsed
}

/**
 * Strip a trailing `# …` comment. Only a comment introduced by whitespace goes,
 * so a value that legitimately contains `#` (a fragment, a channel) survives.
 */
function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '')
}

/** Split frontmatter lines from the body. */
function splitFrontmatter(raw: string): { fm: string[] | null; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { fm: null, body: normalized }
  }
  const end = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length)
  if (end === -1) {
    // Unterminated fence — no frontmatter was parsed, and the caller refuses.
    return { fm: null, body: normalized }
  }
  const fm = normalized.slice(FRONTMATTER_FENCE.length + 1, end).split('\n')
  const body = normalized.slice(end + FRONTMATTER_FENCE.length + 2)
  return { fm, body }
}

/**
 * Read frontmatter lines into a key→value map. Duplicate keys REFUSE rather
 * than last-wins: two `mission` lines mean the file disagrees with itself.
 */
function parseFrontmatter(lines: readonly string[], source: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) {
      refuse(source, `malformed frontmatter line '${trimmed}' — expected 'key: value'`)
    }
    let key = trimmed.slice(0, colon).trim()
    const value = stripComment(trimmed.slice(colon + 1)).trim()
    // The pre-rename spelling still loads: a directive is COMMITTED, so another
    // machine's checkout can carry the old key long after this one is updated.
    if (key === LEGACY_MAX_RUN_MINUTES_KEY) key = 'max_run_minutes'
    if (!(DIRECTIVE_KEYS as readonly string[]).includes(key)) {
      refuse(
        source,
        `unknown frontmatter key '${key}' — expected one of ${DIRECTIVE_KEYS.join(', ')}`,
      )
    }
    if (fields.has(key)) {
      refuse(source, `duplicate frontmatter key '${key}'`)
    }
    fields.set(key, value)
  }
  return fields
}

/** Parse an inline `[a, b]` list; a bare value is a one-element list. */
function parseList(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '[]') return []
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** Parse a strict boolean — anything but `true`/`false` refuses. */
function parseBoolean(
  fields: Map<string, string>,
  key: string,
  fallback: boolean,
  source: string,
): boolean {
  const raw = fields.get(key)
  if (raw === undefined || raw.length === 0) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  return refuse(source, `malformed ${key} '${raw}' — expected true or false`)
}

/**
 * Parse a positive-integer cap. Empty, zero, negative, fractional and
 * non-numeric all refuse: a cap is the one field whose misreading lets a
 * producer file without bound.
 */
function parsePositiveInt(
  fields: Map<string, string>,
  key: string,
  fallback: number,
  source: string,
): number {
  const raw = fields.get(key)
  if (raw === undefined || raw.length === 0) return fallback
  if (!/^\d+$/.test(raw)) {
    refuse(source, `malformed ${key} '${raw}' — expected a positive integer`)
  }
  const parsed = Number.parseInt(raw, 10)
  if (parsed <= 0) {
    refuse(source, `malformed ${key} '${raw}' — expected a positive integer`)
  }
  return parsed
}

/** `max_concurrent_runs` — capped, because a slot is a whole worktree on disk. */
function parseConcurrentRuns(fields: Map<string, string>, source: string): number {
  const parsed = parsePositiveInt(fields, 'max_concurrent_runs', DEFAULT_MAX_CONCURRENT_RUNS, source)
  if (parsed > MAX_CONCURRENT_RUNS_LIMIT) {
    refuse(
      source,
      `max_concurrent_runs ${String(parsed)} is above the limit of ${String(MAX_CONCURRENT_RUNS_LIMIT)} — each run holds its own git worktree`,
    )
  }
  return parsed
}

/** Why a topic is unusable, or null when it is fine (CLI: `topicProblem`). */
function topicProblem(topic: string): string | null {
  if (topic.length === 0) return null
  if (RESERVED_TOPICS.includes(topic)) {
    return `reserved topic '${topic}' — ${RESERVED_TOPICS.join(', ')} are queue state, and a topic names an area`
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    return `malformed topic '${topic}' — expected at most ${String(TOPIC_MAX_LENGTH)} characters`
  }
  if (!TOPIC_PATTERN.test(topic)) {
    return `malformed topic '${topic}' — expected lowercase alphanumerics separated by - . _ /, starting and ending with a letter or digit, no spaces`
  }
  return null
}

/**
 * Extract a `## <heading>` section's prose, trimmed. Absent yields the empty
 * string — prose is guidance for the run prompt, not an invariant.
 */
export function extractSection(body: string, heading: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const wanted = heading.trim().toLowerCase()
  const collected: string[] = []
  let inside = false
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match !== null) {
      if (inside) break
      inside = match[1].trim().toLowerCase() === wanted
      continue
    }
    if (inside) collected.push(line)
  }
  return collected.join('\n').trim()
}

/**
 * Parse directive content into a validated record.
 *
 * `source` names the file in every refusal (callers pass the path); it never
 * affects what is parsed. THROWS on any violation — nothing partial is ever
 * returned, and the validation ORDER matters: `perf.md` in this repo refuses on
 * an unknown key before its unknown queue kind is ever looked at, so a reader
 * that checked values first would report a different reason for the same file.
 */
export function parseLoopDirective(content: string, source = 'directive'): LoopDirectiveRecord {
  const { fm, body } = splitFrontmatter(content)
  if (fm === null) {
    refuse(
      source,
      `missing frontmatter — expected a '${FRONTMATTER_FENCE}' fenced block at the top`,
    )
  }
  const fields = parseFrontmatter(fm, source)

  const loop = fields.get('loop')?.trim() ?? ''
  if (loop.length === 0) {
    refuse(source, "missing 'loop' — a directive must name its loop")
  }
  if (!LOOP_NAME_PATTERN.test(loop)) {
    refuse(
      source,
      `malformed loop name '${loop}' — expected lowercase alphanumerics with single dashes`,
    )
  }

  const engine = fields.get('engine')?.trim() ?? ''
  if (engine.length === 0) {
    refuse(source, `missing 'engine' — expected ${LOOP_ENGINES.join('|')}`)
  }
  if (!(LOOP_ENGINES as readonly string[]).includes(engine)) {
    refuse(source, `unknown engine '${engine}' — expected ${LOOP_ENGINES.join('|')}`)
  }

  // The mission is the one field with NO default. A loop running the wrong
  // mission unattended is the failure this whole parser exists to prevent.
  const mission = fields.get('mission')?.trim() ?? ''
  if (mission.length === 0) {
    refuse(source, "missing 'mission' — a loop with no mission has nothing to run")
  }

  const queue = fields.get('queue')?.trim() ?? ''
  if (queue.length === 0) {
    refuse(source, `missing 'queue' — expected ${LOOP_QUEUE_KINDS.join('|')}`)
  }
  if (!(LOOP_QUEUE_KINDS as readonly string[]).includes(queue)) {
    refuse(source, `unknown queue '${queue}' — expected ${LOOP_QUEUE_KINDS.join('|')}`)
  }

  const sliceRaw = fields.get('slice')?.trim() ?? ''
  if (sliceRaw.length > 0 && !(LOOP_SLICES as readonly string[]).includes(sliceRaw)) {
    refuse(source, `unknown slice '${sliceRaw}' — expected ${LOOP_SLICES.join('|')}`)
  }
  const slice = (LOOP_SLICES as readonly string[]).includes(sliceRaw)
    ? (sliceRaw as LoopDirectiveSlice)
    : DEFAULT_LOOP_SLICE

  const directive: LoopDirectiveRecord = {
    loop,
    engine: engine as LoopDirectiveEngine,
    paused: parseBoolean(fields, 'paused', false, source),
    mission,
    scope: parseList(fields.get('scope') ?? ''),
    slice,
    queue: queue as LoopDirectiveQueueKind,
    maxOpenIssues: parsePositiveInt(fields, 'max_open_issues', DEFAULT_MAX_OPEN_ISSUES, source),
    maxRunMinutes: parsePositiveInt(fields, 'max_run_minutes', DEFAULT_MAX_RUN_MINUTES, source),
    maxConcurrentRuns: parseConcurrentRuns(fields, source),
    needsApproval: parseBoolean(fields, 'needs_approval', false, source),
    direction: extractSection(body, 'Direction'),
    rules: extractSection(body, 'Rules'),
  }

  // Queue-shaped fields: a field belonging to the OTHER backend refuses rather
  // than sitting there implying a configuration that is not in force.
  const repo = fields.get('repo')?.trim() ?? ''
  const path = fields.get('path')?.trim() ?? ''
  if (queue === 'github') {
    if (repo.length === 0) {
      refuse(source, "queue 'github' requires 'repo: owner/name'")
    }
    if (!REPO_PATTERN.test(repo)) {
      refuse(source, `malformed repo '${repo}' — expected owner/name`)
    }
    if (path.length > 0) {
      refuse(source, "'path' applies to queue 'ledger' only")
    }
    directive.repo = repo
  } else {
    if (repo.length > 0) {
      refuse(source, "'repo' applies to queue 'github' only")
    }
    directive.path = path.length > 0 ? path : DEFAULT_LEDGER_PATH
  }

  const label = fields.get('label')?.trim() ?? ''
  if (label.length > 0) {
    directive.label = label
  }

  // The topic becomes REPO CONFIGURATION (the GitHub backend creates a missing
  // topic label), so it REFUSES rather than being sanitized: a topic quietly
  // rewritten into something legal is a loop filing under a word its owner
  // never chose, discovered a week later.
  const topic = fields.get('topic')?.trim() ?? ''
  const topicIssue = topicProblem(topic)
  if (topicIssue !== null) {
    refuse(source, topicIssue)
  }
  if (topic.length > 0) {
    directive.topic = topic
  }

  return directive
}

// ── the snapshot ─────────────────────────────────────────────────────────

/**
 * One loop's directive, or the NAMED NOTICE explaining why there isn't one.
 *
 * A malformed directive is never a missing loop. `loop status` is fail-soft per
 * row for exactly this reason and this mirrors it: a snapshot nobody could read
 * is a notice, not an empty list, and a loop that vanishes from the panel
 * because its file has a typo is the app disagreeing with the disk in silence.
 */
export interface LoopDirectiveEntry {
  /** The loop's name — its filename stem, which is also its identity. */
  loop: string
  /** Absolute path of the file that answered, or the tracked candidate. */
  source: string
  /** Null exactly when `directiveError` is set. */
  directive: LoopDirectiveRecord | null
  /** The CLI's own refusal, one line. Null when the directive parsed. */
  directiveError: string | null
  /**
   * Where this loop's work lives — `owner/name` or the ledger path.
   *
   * The same string `loop status` reports as `queueLocation`, derived from the
   * directive alone so a queue that cannot be REACHED still says which store it
   * was. Null only when the directive itself did not parse.
   */
  queueLocation: string | null
}

/**
 * Every loop a project has a directive for, ordered by name.
 *
 * `reason` is a notice about the snapshot AS A WHOLE and is independent of
 * `available`: a home that existed and could not be listed sets it even when the
 * other home answered, because a partial list silently missing loops is the
 * failure this shape exists to prevent.
 */
export interface LoopDirectiveSnapshot {
  /** False only when a directory that EXISTS could not be listed at all. */
  available: boolean
  reason: string | null
  loops: LoopDirectiveEntry[]
  /** Epoch ms the snapshot was taken, from the injected clock. */
  readAt: number
}

/**
 * Where a loop's directive may live, in precedence order: the tracked
 * `<root>/loops/` first, then the legacy `flow/loops/`.
 *
 * Reading both is a MIGRATION affordance, not a feature. The tracked home always
 * wins, so a committed directive can never be shadowed by a stale local copy.
 */
export function directiveHomes(rootPath: string): string[] {
  return [
    join(rootPath, TRACKED_LOOPS_DIRNAME),
    join(rootPath, 'flow', FLOW_LOOPS_DIRNAME),
  ]
}

/** Errno codes that mean "this directory is simply not here" — absence, not failure. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Where the CLI reports a parsed loop's work lives (CLI: `openQueue`). */
function queueLocationOf(directive: LoopDirectiveRecord): string {
  return directive.queue === 'github'
    ? (directive.repo ?? '')
    : (directive.path ?? DEFAULT_LEDGER_PATH)
}

function notice(loop: string, source: string, message: string): LoopDirectiveEntry {
  return { loop, source, directive: null, directiveError: oneLine(message), queueLocation: null }
}

/** Read and parse one loop's directive, resolving the tracked home first. */
async function readEntry(loop: string, homes: readonly string[]): Promise<LoopDirectiveEntry> {
  const candidates = homes.map((dir) => join(dir, `${loop}.md`))
  let source: string | null = null
  let content: string | null = null
  let unreadable: string | null = null
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, 'utf-8')
      source = candidate
      break
    } catch (error) {
      // Absence falls through to the next home; anything else is a real failure
      // and stops here rather than being reported as "no such loop".
      if (ABSENT_CODES.has(errnoOf(error) ?? '')) continue
      unreadable = `${candidate}: unreadable (${messageOf(error)})`
      break
    }
  }
  if (content === null || source === null) {
    // Reachable when a directive is deleted between the listing and this read.
    return notice(
      loop,
      candidates[0],
      unreadable ?? `no directive for loop '${loop}' at ${candidates.join(' or ')}`,
    )
  }
  let directive: LoopDirectiveRecord
  try {
    directive = parseLoopDirective(content, source)
  } catch (error) {
    return notice(loop, source, messageOf(error))
  }
  // Two names for one loop would key the state store one way and the queue
  // another, and the mismatch would surface only as work landing under a loop
  // nobody is watching.
  if (directive.loop !== loop) {
    return notice(
      loop,
      source,
      `${source}: loop '${directive.loop}' does not match its filename '${loop}.md'`,
    )
  }
  return { loop, source, directive, directiveError: null, queueLocation: queueLocationOf(directive) }
}

/**
 * Read a project's whole `loops/` directory into an ordered snapshot.
 *
 * Async throughout (allowed pattern #19): this is called from the main process,
 * where a synchronous read stalls every window rather than just its caller.
 */
export async function readLoopDirectives(
  rootPath: string,
  deps: { now?: () => number } = {},
): Promise<LoopDirectiveSnapshot> {
  const now = deps.now ?? Date.now
  const homes = directiveHomes(rootPath)
  const names = new Set<string>()
  const failures: string[] = []
  let listed = 0
  for (const dir of homes) {
    let files: string[]
    try {
      files = await readdir(dir)
    } catch (error) {
      if (!ABSENT_CODES.has(errnoOf(error) ?? '')) {
        failures.push(`${dir}: unreadable (${messageOf(error)})`)
      }
      continue
    }
    listed += 1
    // A name present in both homes is ONE loop — `readEntry` resolves it from
    // the tracked copy, and listing it twice would claim a duplicate that does
    // not exist.
    for (const file of files) {
      if (file.endsWith('.md')) names.add(file.slice(0, -'.md'.length))
    }
  }

  const reason = failures.length === 0 ? null : oneLine(failures.join('; '))
  if (listed === 0 && failures.length > 0) {
    // Nothing could be listed at all — the one case that is a notice rather
    // than a project with no loops.
    return { available: false, reason, loops: [], readAt: now() }
  }

  const loops = await Promise.all([...names].sort().map((loop) => readEntry(loop, homes)))
  return { available: true, reason, loops, readAt: now() }
}

// ── the cache ────────────────────────────────────────────────────────────

/**
 * How long a snapshot may be served without re-reading.
 *
 * A TTL *as well as* a watcher, deliberately (allowed pattern #20): the watcher
 * is the fast path, and the window is the floor under it. File events are not a
 * guarantee — they are missed on network volumes and are documented flaky on
 * macOS temp directories in this project's own notes — and invalidation you can
 * forget to fire is worse than staleness you chose.
 */
export const DIRECTIVE_CACHE_TTL_MS = 5_000

/** A running watcher, reduced to the one thing the cache does with it. */
export interface LoopDirectiveWatcher {
  close: () => void
}

/** What the cache needs from the world, all injectable for tests. */
export interface LoopDirectiveCacheDeps {
  /** Injected so the TTL window is testable without sleeping. */
  now?: () => number
  ttlMs?: number
  /** Start watching a root's directive homes. Null means "no watcher here". */
  watchFn?: (dirs: readonly string[], onChange: () => void) => LoopDirectiveWatcher | null
  /** The read itself — swapped in tests to count how often it actually runs. */
  readFn?: (rootPath: string) => Promise<LoopDirectiveSnapshot>
}

interface CacheEntry {
  snapshot: LoopDirectiveSnapshot | null
  /** When `snapshot` was taken, by the injected clock. */
  readAt: number
  /** Set by the watcher; forces the next read past the TTL. */
  stale: boolean
  inFlight: Promise<LoopDirectiveSnapshot> | null
  watcher: LoopDirectiveWatcher | null
}

/** The default watcher: one chokidar watch per root, over both directive homes. */
function watchDirectiveHomes(
  dirs: readonly string[],
  onChange: () => void,
): LoopDirectiveWatcher {
  const watcher = watch([...dirs], {
    // Directives sit directly inside the directory; nothing below it is read.
    depth: 0,
    ignoreInitial: true,
    // An editor save and a `git pull` both land a file in several events, and
    // the snapshot is identical for all of them — settle first, invalidate once.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  })
  watcher.on('all', onChange)
  // A watcher that broke must not make the cache eternal: treat its failure as
  // a change, so the next read goes back to disk instead of trusting a snapshot
  // nothing can invalidate any more.
  watcher.on('error', onChange)
  return {
    close: () => {
      void watcher.close()
    },
  }
}

/**
 * Directive snapshots, cached per project root and invalidated by a watcher.
 *
 * KEYED ON THE ROOT AND NOTHING ELSE, because nothing else changes the answer:
 * the snapshot is every `.md` in that root's two directive homes, and there is
 * no limit, filter or query to key on (allowed pattern #20). Concurrent reads
 * share one in-flight promise — the panel and a broadcast can both ask at once,
 * and two readdir sweeps for one answer is the cost this class exists to remove.
 */
export class LoopDirectiveCache {
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #watchFn: (dirs: readonly string[], onChange: () => void) => LoopDirectiveWatcher | null
  readonly #readFn: (rootPath: string) => Promise<LoopDirectiveSnapshot>
  readonly #entries = new Map<string, CacheEntry>()

  constructor(deps: LoopDirectiveCacheDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#ttlMs = deps.ttlMs ?? DIRECTIVE_CACHE_TTL_MS
    this.#watchFn = deps.watchFn ?? watchDirectiveHomes
    this.#readFn = deps.readFn ?? ((rootPath) => readLoopDirectives(rootPath, { now: this.#now }))
  }

  /** The root's snapshot — from cache when it is fresh, from disk when it is not. */
  read(rootPath: string): Promise<LoopDirectiveSnapshot> {
    const entry = this.#entries.get(rootPath)
    if (entry !== undefined) {
      if (entry.inFlight !== null) return entry.inFlight
      if (
        entry.snapshot !== null &&
        !entry.stale &&
        this.#now() - entry.readAt < this.#ttlMs
      ) {
        return Promise.resolve(entry.snapshot)
      }
    }
    return this.#refresh(rootPath)
  }

  /**
   * Drop a root's cache and stop watching it.
   *
   * Called when a project leaves: a removed project's snapshot is one nothing
   * will ever invalidate, and its watcher is a file handle nobody is reading.
   */
  forget(rootPath: string): void {
    const entry = this.#entries.get(rootPath)
    if (entry === undefined) return
    entry.watcher?.close()
    this.#entries.delete(rootPath)
  }

  /** Drop every root — for app shutdown. */
  dispose(): void {
    for (const rootPath of [...this.#entries.keys()]) this.forget(rootPath)
  }

  #refresh(rootPath: string): Promise<LoopDirectiveSnapshot> {
    const entry = this.#ensure(rootPath)
    // Cleared BEFORE the read, so a change that lands while it is in flight
    // leaves the entry stale and the next caller goes back to disk. Clearing it
    // afterwards would let that change be swallowed by its own snapshot.
    entry.stale = false
    const pending = this.#readFn(rootPath).then(
      (snapshot) => {
        if (entry.inFlight === pending) {
          entry.inFlight = null
          entry.snapshot = snapshot
          entry.readAt = snapshot.readAt
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

  #ensure(rootPath: string): CacheEntry {
    const existing = this.#entries.get(rootPath)
    if (existing !== undefined) return existing
    const entry: CacheEntry = {
      snapshot: null,
      readAt: 0,
      stale: false,
      inFlight: null,
      watcher: null,
    }
    this.#entries.set(rootPath, entry)
    // Watched from the first read rather than from construction — a root nobody
    // has asked about costs nothing (allowed pattern #17).
    entry.watcher = this.#watchFn(directiveHomes(rootPath), () => {
      entry.stale = true
    })
    return entry
  }
}
