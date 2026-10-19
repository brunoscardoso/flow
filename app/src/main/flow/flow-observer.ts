// FlowObserver — read-only lens over each project root's `flow/` directory
// (which may be a symlink into the central vault — plain fs calls follow it
// transparently). It parses a fixed set of files into a FlowState snapshot:
//
//   .flowconfig             → key/value config (autopilot, git control, …)
//   STATE.md                → active skill / plan / phase / task / next action
//   .heartbeat-events.jsonl → append-only heartbeat event stream (tail-read)
//   .heartbeat-prompt.md    → pending blocked-task prompt (existence = blocked)
//   .autopilot              → legacy autopilot flag (backward compat)
//   .heartbeat-state.json   → lastReadTimestamp for the unread event count
//
// SECURITY: the renderer only ever supplies a rootId (an absolute project
// rootPath). File paths are constructed HERE, in main, from that root and
// the fixed `flow/<file>` suffixes.
//
// Watching: one chokidar watcher per root on the `flow/` directory (depth 0
// — every watched file sits directly inside it; chokidar tolerates the
// directory not existing yet and starts emitting once it appears). Change
// bursts are debounced, then `flow:stateChanged` is pushed to every window.
// The events file is tail-read from a byte cursor so a growing JSONL log is
// never re-parsed from the start; NEW appends (and only new appends) become
// `flow:notification` toasts.
//
// The observer is read-only with TWO exceptions: respondPrompt, which
// implements the plan-flow daemon's blocked-prompt reply contract, and
// setConfig, which merges settings into `.flowconfig` (see the method docs).
//
// Electron is only touched inside `registerFlowChannels` (lazy require), so
// the observer stays loadable from plain Node (test harnesses).

import { EventEmitter } from 'events'
import { timed } from '../ipc/slow-handler'
import { randomBytes } from 'crypto'
import fs from 'fs'
import { basename, join } from 'path'
import { watch, type FSWatcher } from 'chokidar'

import { onFlowLinksChanged } from '../project/flow-link-events'

import { mergeFlowconfig } from '../../shared/flowconfig-merge'
import { withAliasedWrites } from '../../shared/worktree-config-aliases'
import { readWorktreeSettings } from './worktree-settings'
import type {
  FlowNotification,
  FlowNotificationLevel,
  FlowPendingPrompt,
  FlowState,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  WorktreeDefaults,
} from '../../shared/ipc-contract'
import { LEGACY_AUTOPILOT_FILE, autopilotEnabledIn } from './autopilot'

const FLOWCONFIG_FILE = '.flowconfig'
const STATE_FILE = 'STATE.md'
const EVENTS_FILE = '.heartbeat-events.jsonl'
const PROMPT_FILE = '.heartbeat-prompt.md'
const HEARTBEAT_STATE_FILE = '.heartbeat-state.json'
/** execute-plan's append-only execution record — not parsed into FlowState
 *  (no fields surface it), but watched so a 'state-changed' event pokes
 *  interested consumers (e.g. learn-run-triggers.ts) to re-tail it. */
const ROUNDS_FILE = '.rounds.jsonl'
/** Where answered prompts are archived (same layout as prompt-manager.ts). */
const PROMPT_ARCHIVE_DIR = join('archive', 'heartbeat-prompts')

/** The files whose changes should trigger a state refresh. */
const WATCHED_BASENAMES = new Set([
  FLOWCONFIG_FILE,
  STATE_FILE,
  EVENTS_FILE,
  PROMPT_FILE,
  LEGACY_AUTOPILOT_FILE,
  HEARTBEAT_STATE_FILE,
  ROUNDS_FILE,
])

/** Quiet window before a burst of flow file events collapses into one refresh. */
const REFRESH_DEBOUNCE_MS = 200

// ── Pure parsing (exported for tests) ─────────────────────────────────────

/** Parse `.flowconfig`'s `key: value` lines (comments and blanks skipped). */
export function parseFlowconfigText(content: string): Record<string, string> {
  const config: Record<string, string> = Object.create(null)
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z0-9_.-]+):[ \t]*(.*)$/)
    if (match) config[match[1]] = match[2].trim()
  }
  return config
}

/**
 * Non-destructively merge `updates` into an existing `.flowconfig` body.
 * Existing `key: value` lines are rewritten in place (preserving order,
 * comments, and blank lines); keys not already present are appended; a `null`
 * value removes the key. Exported for tests.
 *
 * A NAME, NOT AN ALGORITHM. The merge this used to hold in full is now the one
 * the CLI writes with (allowed-pattern #14) — the observer and `planflow-ai flow
 * set` edit the same hand-written file, and two line-based merges that agree
 * today are two that can stop agreeing tomorrow. The wrapper stays so callers
 * and tests keep the name they already import.
 */
export function mergeFlowconfigText(
  existing: string,
  updates: Record<string, string | null>,
): string {
  return mergeFlowconfig(existing, updates)
}

export interface ParsedStateMd {
  activeSkill?: string
  activePlan?: string
  activePhase?: string
  currentTask?: string
  nextAction?: string
}

const STATE_KV_RE =
  /^(?:-\s*)?\*\*(Active Skill|Active Plan|Current Phase|Current Task|Next Action)\*\*:\s*(.*)$/
const SECTION_RE = /^## (.+)$/

/**
 * Parse the fields we surface from `flow/STATE.md`. First occurrence of each
 * `**Key**: value` line wins; a bare line under a `## Next Action` section is
 * the fallback for nextAction.
 */
export function parseStateMdText(content: string): ParsedStateMd {
  const parsed: ParsedStateMd = {}
  let currentSection = ''
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const sectionMatch = line.match(SECTION_RE)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      continue
    }
    const kvMatch = line.match(STATE_KV_RE)
    if (kvMatch) {
      const value = kvMatch[2].trim()
      if (!value) continue
      switch (kvMatch[1]) {
        case 'Active Skill':
          parsed.activeSkill ??= value
          break
        case 'Active Plan':
          parsed.activePlan ??= value
          break
        case 'Current Phase':
          parsed.activePhase ??= value
          break
        case 'Current Task':
          parsed.currentTask ??= value
          break
        case 'Next Action':
          parsed.nextAction ??= value
          break
      }
      continue
    }
    if (currentSection === 'Next Action' && line && !parsed.nextAction) {
      parsed.nextAction = line
    }
  }
  return parsed
}

/** One line of `flow/.heartbeat-events.jsonl`, defensively normalized. */
export interface HeartbeatEvent {
  id: string
  timestamp: string
  task: string
  type: string
  level: FlowNotificationLevel
  message: string
}

/**
 * Parse heartbeat event JSONL. Malformed lines are skipped (counted, warned
 * once per parse) — the daemon and the app race on this file, so a torn line
 * must never poison the whole stream.
 */
export function parseHeartbeatEventsText(content: string): HeartbeatEvent[] {
  const events: HeartbeatEvent[] = []
  let malformedCount = 0
  let lastParseError: unknown = null
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch (error) {
      malformedCount += 1
      lastParseError = error
      continue
    }
    if (typeof raw !== 'object' || raw === null) {
      malformedCount += 1
      continue
    }
    const candidate = raw as Record<string, unknown>
    events.push({
      id: typeof candidate.id === 'string' ? candidate.id : '',
      timestamp: typeof candidate.timestamp === 'string' ? candidate.timestamp : '',
      task: typeof candidate.task === 'string' ? candidate.task : 'unknown',
      type: typeof candidate.type === 'string' ? candidate.type : 'task_complete',
      level: isHeartbeatLevel(candidate.level) ? candidate.level : 'info',
      message: typeof candidate.message === 'string' ? candidate.message : '',
    })
  }
  if (malformedCount > 0) {
    const detail =
      lastParseError instanceof Error ? ` (last error: ${lastParseError.message})` : ''
    console.warn(
      `[FlowObserver] Skipped ${malformedCount} malformed heartbeat event line(s)${detail}`,
    )
  }
  return events
}

function isHeartbeatLevel(value: unknown): value is FlowNotificationLevel {
  return value === 'info' || value === 'warn' || value === 'error'
}

/** Task name from the prompt's `**Task**: <name>` line, if present. */
export function extractPromptTask(promptMarkdown: string): string | null {
  const match = promptMarkdown.match(/^\*\*Task\*\*:\s*(.+)$/m)
  return match ? match[1].trim() : null
}

// ── Snapshot building ─────────────────────────────────────────────────────

function readTextIfExists(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** Stable prompt id derived from the prompt file's mtime. */
function promptIdFor(promptPath: string): string | null {
  try {
    return `hb-${Math.trunc(fs.statSync(promptPath).mtimeMs)}`
  } catch {
    return null
  }
}

/** Events newer than lastReadTimestamp in `.heartbeat-state.json`. */
function countUnreadEvents(flowDir: string, events: HeartbeatEvent[]): number {
  const raw = readTextIfExists(join(flowDir, HEARTBEAT_STATE_FILE))
  if (raw === null) return events.length
  try {
    const parsed = JSON.parse(raw) as { lastReadTimestamp?: unknown }
    const lastRead = parsed.lastReadTimestamp
    if (typeof lastRead !== 'string' || !lastRead) return events.length
    return events.filter((event) => event.timestamp > lastRead).length
  } catch {
    return events.length
  }
}

/** One-shot full read for roots we are not watching (flow:state on demand). */
function buildFlowState(rootPath: string): { snapshot: FlowState; events: HeartbeatEvent[] } {
  const eventsText = readTextIfExists(join(rootPath, 'flow', EVENTS_FILE))
  const events = eventsText !== null ? parseHeartbeatEventsText(eventsText) : []
  return { snapshot: buildFlowSnapshot(rootPath, events), events }
}

function buildFlowSnapshot(rootPath: string, events: HeartbeatEvent[]): FlowState {
  const flowDir = join(rootPath, 'flow')

  const flowconfigText = readTextIfExists(join(flowDir, FLOWCONFIG_FILE))
  const flowconfig = flowconfigText !== null ? parseFlowconfigText(flowconfigText) : {}
  // ONE RESOLUTION (see `autopilot.ts`): the key wins whenever present — a
  // project that switched autopilot off must not have a stale marker file
  // switch it back on — and the marker answers only for projects older than
  // the key. The chain driver asks the same function.
  const autopilot = autopilotEnabledIn(flowconfig, fs.existsSync(join(flowDir, LEGACY_AUTOPILOT_FILE)))

  const stateText = readTextIfExists(join(flowDir, STATE_FILE))
  const stateMd = stateText !== null ? parseStateMdText(stateText) : null

  const promptPath = join(flowDir, PROMPT_FILE)
  const promptMarkdown = readTextIfExists(promptPath)
  let pendingPrompt: FlowPendingPrompt | null = null
  if (promptMarkdown !== null) {
    pendingPrompt = {
      promptId: promptIdFor(promptPath) ?? 'hb-unknown',
      task: extractPromptTask(promptMarkdown) ?? 'task',
      markdown: promptMarkdown,
    }
  }

  const statusParts = [stateMd?.activeSkill, stateMd?.activePhase].filter((part): part is string =>
    Boolean(part),
  )
  const stateStatus =
    statusParts.length > 0 ? statusParts.join(' · ') : (stateMd?.nextAction ?? undefined)

  return {
    rootId: rootPath,
    flowconfig,
    stateStatus,
    activeSkill: stateMd?.activeSkill,
    activePhase: stateMd?.activePhase,
    autopilot,
    activePlan: stateMd?.activePlan,
    currentTask: stateMd?.currentTask,
    nextAction: stateMd?.nextAction,
    heartbeatUnread: countUnreadEvents(flowDir, events),
    pendingPrompt,
  }
}

// ── Events file tail-reading ──────────────────────────────────────────────

interface EventsTail {
  appended: HeartbeatEvent[]
  cursor: number
}

function isCompleteJsonLine(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Read the events file from a byte cursor. A shrunken file means it was
 * truncated/rotated — re-read from the start and report `truncated` so the
 * caller resets its accumulated list instead of concatenating.
 */
function readHeartbeatEventsTail(
  eventsPath: string,
  cursor: number,
): EventsTail & { truncated: boolean } {
  let fd: number
  try {
    fd = fs.openSync(eventsPath, 'r')
  } catch {
    return { appended: [], cursor: 0, truncated: cursor > 0 }
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size < cursor) {
      return { ...readTailFrom(fd, 0, size), truncated: true }
    }
    return { ...readTailFrom(fd, cursor, size), truncated: false }
  } finally {
    fs.closeSync(fd)
  }
}

function readTailFrom(fd: number, cursor: number, size: number): EventsTail {
  if (size === cursor) {
    return { appended: [], cursor }
  }
  const buffer = Buffer.alloc(size - cursor)
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, cursor)
  const chunk = buffer.subarray(0, bytesRead)
  const text = chunk.toString('utf-8')
  // The daemon may be mid-append: if the trailing residue after the last
  // newline is not complete JSON, leave it for the next read.
  const lastNewline = text.lastIndexOf('\n')
  let consumedText = text
  let consumedBytes = chunk.length
  const residue = text.slice(lastNewline + 1)
  if (residue && !isCompleteJsonLine(residue)) {
    consumedText = text.slice(0, lastNewline + 1)
    consumedBytes = Buffer.byteLength(consumedText, 'utf-8')
  }
  return { appended: parseHeartbeatEventsText(consumedText), cursor: cursor + consumedBytes }
}

// ── Roots provider ────────────────────────────────────────────────────────

/** Project roots provider (adapter over ProjectRegistry — see rootsProviderFrom). */
export interface RootsProvider {
  getRoots(): ReadonlyArray<{ rootPath: string }>
  /** Subscribe to root list changes; returns an unsubscribe function. */
  onRootsChanged(listener: () => void): () => void
}

/**
 * Adapter over an EventEmitter-style manager (e.g. ProjectRegistry, which
 * emits 'roots-changed'). Structural — no import of the manager needed.
 */
export function rootsProviderFrom(
  manager: {
    getRoots(): Array<{ rootPath: string }>
    on(event: string, listener: (...args: unknown[]) => void): unknown
    off(event: string, listener: (...args: unknown[]) => void): unknown
  },
  rootsChangedEvent = 'roots-changed',
): RootsProvider {
  return {
    getRoots: () => manager.getRoots(),
    onRootsChanged: (listener) => {
      const wrapped = (): void => listener()
      manager.on(rootsChangedEvent, wrapped)
      return () => {
        manager.off(rootsChangedEvent, wrapped)
      }
    },
  }
}

// ── Observer ──────────────────────────────────────────────────────────────

export const FLOW_NOTIFICATION_EVENT = 'notification'
export const FLOW_STATE_CHANGED_EVENT = 'state-changed'

const EVENT_TYPE_LABELS: Record<string, string> = {
  task_started: 'started',
  task_complete: 'completed',
  task_failed: 'failed',
  task_blocked: 'blocked — needs input',
}

interface RootWatch {
  watcher: FSWatcher
  /** Watches the ROOT for `flow/` itself appearing or being replaced (#1164). */
  rootWatcher: FSWatcher
  refreshTimer: NodeJS.Timeout | null
  snapshot: FlowState
  events: HeartbeatEvent[]
  eventsCursor: number
  seenEventCount: number
  notifiedPromptId: string | null
}

/**
 * Watches every project root's `flow/` directory and emits:
 *   'state-changed' → FlowState        (any watched file changed)
 *   'notification'  → FlowNotification (new heartbeat event / blocked prompt)
 */
export class FlowObserver extends EventEmitter {
  private readonly watches = new Map<string, RootWatch>()
  /**
   * One write chain per root (#1452). `setConfig` is a read-modify-write over
   * the WHOLE flowconfig, and it had no queue, no lock and no compare-and-swap:
   * two overlapping calls both read the same snapshot and the second overwrote
   * the first's key. That is not an exotic race — the settings panel's text
   * inputs commit on blur, so clicking any control after typing fires two calls
   * microseconds apart in the SAME click, and one of them was silently lost.
   */
  private readonly configWrites = new Map<string, Promise<void>>()
  private unsubscribeRoots: (() => void) | null = null
  private unsubscribeLinks: (() => void) | null = null
  private disposed = false

  constructor(private readonly roots: RootsProvider) {
    super()
  }

  /** Start watching current roots and follow root list changes. */
  start(): void {
    this.syncRoots()
    this.unsubscribeRoots = this.roots.onRootsChanged(() => this.syncRoots())
    // A Workspace change can repoint `flow` without chokidar noticing: a watch
    // on the old target would go silent, so every root's watch is re-armed.
    this.unsubscribeLinks = onFlowLinksChanged(() => {
      for (const rootPath of [...this.watches.keys()]) this.rearmWatch(rootPath)
    })
  }

  /** Current snapshot for a root (rootId === absolute rootPath). Unknown
   *  roots are parsed on demand so `flow:state` never fails closed. */
  getState(rootPath: string): FlowState {
    const entry = this.watches.get(rootPath)
    if (entry) return entry.snapshot
    return buildFlowState(rootPath).snapshot
  }

  /**
   * The ONE write this read-only observer performs — replying to a blocked
   * heartbeat prompt, per the plan-flow daemon contract:
   *   1. append the user's reply as a `## User Response` section,
   *   2. archive the combined document to
   *      flow/archive/heartbeat-prompts/prompt_<task>_<timestamp>.md
   *      (same naming as prompt-manager.ts's archivePrompt),
   *   3. remove flow/.heartbeat-prompt.md — the daemon only checks the
   *      file's existence, so removal is what resumes the task.
   */
  async respondPrompt(rootPath: string, promptId: string, response: string): Promise<void> {
    const flowDir = join(rootPath, 'flow')
    const promptPath = join(flowDir, PROMPT_FILE)

    let content: string
    try {
      content = await fs.promises.readFile(promptPath, 'utf-8')
    } catch {
      throw new Error('[FlowObserver] No pending prompt to respond to')
    }
    // A reply is only ever delivered to the prompt the user actually answered
    // (#1004): the daemon overwrites the ONE prompt file per project when a
    // second task blocks, so answering "the latest prompt" can approve a
    // question the user never saw. The card passes the promptId it was built
    // from precisely so this seam can refuse a stale reply.
    const currentId = promptIdFor(promptPath)
    if (currentId && promptId && currentId !== promptId) {
      this.resurfacePrompt(rootPath, promptPath, content)
      throw new Error(
        '[FlowObserver] The blocked task changed its question while you were replying — your answer was NOT sent; please answer the new question',
      )
    }

    const task = extractPromptTask(content) ?? 'task'
    const responded = `${content.trimEnd()}\n\n---\n\n## User Response\n\n**Time**: ${new Date().toISOString()}\n\n${response.trim()}\n`

    // Guard the unlink: if the daemon replaced the prompt while the user was
    // typing, deleting it would silently discard a question nobody answered.
    // Checked BEFORE the archive write (#1004) so a refused reply never leaves
    // a stray archive file recording an answer that was not delivered.
    let latest: string | null
    try {
      latest = await fs.promises.readFile(promptPath, 'utf-8')
    } catch {
      latest = null
    }
    if (latest !== null && latest !== content) {
      this.resurfacePrompt(rootPath, promptPath, latest)
      throw new Error(
        '[FlowObserver] Prompt changed while responding — a newer prompt is pending; please answer it',
      )
    }

    const archiveDir = join(flowDir, PROMPT_ARCHIVE_DIR)
    await fs.promises.mkdir(archiveDir, { recursive: true })
    const sanitizedTask = task.replace(/[^a-zA-Z0-9_-]/g, '_')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.promises.writeFile(
      join(archiveDir, `prompt_${sanitizedTask}_${stamp}.md`),
      responded,
      'utf-8',
    )

    if (latest !== null) {
      await fs.promises.unlink(promptPath)
    }
    this.refresh(rootPath, false)
  }

  /** Re-surface the pending prompt after a refused reply — reset the dedupe so
   *  the (newer) question re-notifies and the renderer rebuilds the card. */
  private resurfacePrompt(rootPath: string, promptPath: string, markdown: string): void {
    const entry = this.watches.get(rootPath)
    if (entry) {
      entry.notifiedPromptId = null
      this.refresh(rootPath, false)
    } else {
      this.emitPromptNotification(rootPath, {
        promptId: promptIdFor(promptPath) ?? 'hb-unknown',
        task: extractPromptTask(markdown) ?? 'task',
        markdown,
      })
    }
  }

  /**
   * Merge `updates` into the root's `flow/.flowconfig` (creating the file and
   * the `flow/` directory if needed). The write is non-destructive — existing
   * keys are rewritten in place, unknown keys appended, comments preserved.
   * The chokidar watcher picks up the change and rebroadcasts
   * `flow:stateChanged`; a direct refresh here makes the update immediate for
   * roots we already watch.
   *
   * A `null` value REMOVES the key: the project stops overriding whatever it was
   * overriding and inherits again. That is a destructive edit to a file a person
   * hand-writes, so it only ever arrives from an explicit switch — never from a
   * field left blank and never for a key the caller did not name
   * (forbidden-pattern #15).
   */
  async setConfig(rootPath: string, updates: Record<string, string | null>): Promise<void> {
    if (Object.keys(updates).length === 0) return
    // Queue behind this root's previous write so the read sees the previous
    // write's RESULT rather than the snapshot it started from (#1452). Chained
    // on a swallowed copy: one failed write must not poison every write after it,
    // while the caller still gets its own error.
    const previous = this.configWrites.get(rootPath) ?? Promise.resolve()
    const write = previous.then(
      () => this.writeConfigNow(rootPath, updates),
      () => this.writeConfigNow(rootPath, updates),
    )
    this.configWrites.set(
      rootPath,
      write.then(
        () => undefined,
        () => undefined,
      ),
    )
    return write
  }

  /** One serialized read-merge-write. Never call directly — go through
   *  {@link setConfig}, which owns the ordering (allowed-pattern #14). */
  private async writeConfigNow(
    rootPath: string,
    updates: Record<string, string | null>,
  ): Promise<void> {
    const flowDir = join(rootPath, 'flow')
    const configPath = join(flowDir, FLOWCONFIG_FILE)

    let existing: string
    try {
      existing = await fs.promises.readFile(configPath, 'utf-8')
    } catch {
      existing = ''
    }
    // Renamed keys land under both spellings (older builds read the old one) —
    // the same rule as `writeFlowconfig` and the CLI's `flow set`.
    const merged = mergeFlowconfigText(existing, withAliasedWrites(updates))

    await fs.promises.mkdir(flowDir, { recursive: true })
    // Atomic replace, the same shape the project file writer uses: interleaved
    // full-file writes were observed leaving a TORN .flowconfig on disk, and a
    // config half-way through a rewrite is worse than either version of it.
    const tempPath = join(
      flowDir,
      `.${FLOWCONFIG_FILE}.${randomBytes(6).toString('hex')}.flow-tmp`,
    )
    try {
      await fs.promises.writeFile(tempPath, merged, 'utf-8')
      await fs.promises.rename(tempPath, configPath)
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => undefined)
      throw error
    }
    this.refresh(rootPath, false)
  }

  /** Stop all watchers. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoots?.()
    this.unsubscribeRoots = null
    this.unsubscribeLinks?.()
    this.unsubscribeLinks = null
    const closing: Array<Promise<void>> = []
    for (const entry of this.watches.values()) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
      closing.push(entry.watcher.close())
      // #1284: the root watcher (#1241) was closed by stopWatch but NOT here,
      // so quitting leaked one persistent chokidar watcher per open project.
      // A persistent watcher keeps the event loop alive, and the process
      // outlived its own window — measured alive 26 minutes after ⌘Q.
      closing.push(entry.rootWatcher.close())
    }
    this.watches.clear()
    await Promise.all(closing)
    this.removeAllListeners()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private syncRoots(): void {
    if (this.disposed) return
    const current = new Set(this.roots.getRoots().map((root) => root.rootPath))
    for (const rootPath of [...this.watches.keys()]) {
      if (!current.has(rootPath)) this.stopWatch(rootPath)
    }
    for (const rootPath of current) {
      if (!this.watches.has(rootPath)) this.startWatch(rootPath)
    }
  }

  private startWatch(rootPath: string): void {
    const flowDir = join(rootPath, 'flow')
    // #1164: `flow/` is not stable at watch time. project:add registers
    // the root (which brings us here) and THEN fire-and-forgets provisioning,
    // which runs `planflow-ai init --force` and creates/REPLACES the flow vault
    // symlink. The watcher was left bound to a path that no longer exists — or
    // that never existed yet — so for a project added during the session not a
    // single flow/ event was ever observed again: the status line froze, and a
    // task that blocked raised no indicator, no reply card, no toast, for the
    // rest of the session. A boot-restored root worked because its flow/ was
    // already there and stable.
    //
    // So the root itself is watched for `flow` appearing or being swapped, and
    // the real watch is re-armed when it is.
    const rootWatcher = watch(rootPath, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
    })
    const onFlowDirEvent = (path: string): void => {
      if (path === flowDir) this.rearmWatch(rootPath)
    }
    rootWatcher.on('addDir', onFlowDirEvent)
    rootWatcher.on('add', onFlowDirEvent) // a symlink arrives as `add`
    rootWatcher.on('unlinkDir', onFlowDirEvent)
    rootWatcher.on('unlink', onFlowDirEvent)
    rootWatcher.on('error', (error) => {
      console.error(`[FlowObserver] Root watcher error for ${rootPath}:`, error)
    })

    const watcher = watch(flowDir, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const onFileEvent = (path: string): void => {
      if (WATCHED_BASENAMES.has(basename(path))) this.queueRefresh(rootPath)
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    watcher.on('unlink', onFileEvent)
    watcher.on('addDir', (path: string) => {
      if (path === flowDir) this.queueRefresh(rootPath)
    })
    watcher.on('error', (error) => {
      console.error(`[FlowObserver] Watcher error for ${rootPath}:`, error)
    })

    const tail = readHeartbeatEventsTail(join(flowDir, EVENTS_FILE), 0)
    const events = tail.appended
    const snapshot = buildFlowSnapshot(rootPath, events)
    const entry: RootWatch = {
      watcher,
      rootWatcher,
      refreshTimer: null,
      snapshot,
      events,
      eventsCursor: tail.cursor,
      // Pre-existing events never toast on startup — only NEW appends do.
      seenEventCount: events.length,
      notifiedPromptId: null,
    }
    this.watches.set(rootPath, entry)

    if (snapshot.pendingPrompt) {
      entry.notifiedPromptId = snapshot.pendingPrompt.promptId
      this.emitPromptNotification(rootPath, snapshot.pendingPrompt)
    }
    this.emit(FLOW_STATE_CHANGED_EVENT, snapshot)
  }

  private stopWatch(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry) return
    this.watches.delete(rootPath)
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    entry.watcher.close().catch((error) => {
      console.error(`[FlowObserver] Failed to close watcher for ${rootPath}:`, error)
    })
    entry.rootWatcher.close().catch((error) => {
      console.error(`[FlowObserver] Failed to close root watcher for ${rootPath}:`, error)
    })
  }

  /**
   * Re-arm a root's flow/ watch after the directory appeared or was replaced
   * (#1164). Rebuilds the snapshot from what is on disk NOW and emits it, so a
   * project that was provisioned after being added reflects its real state
   * immediately instead of staying frozen at whatever the add-time read saw.
   */
  private rearmWatch(rootPath: string): void {
    if (this.disposed || !this.watches.has(rootPath)) return
    this.stopWatch(rootPath)
    this.startWatch(rootPath)
  }

  private queueRefresh(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry || this.disposed) return
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      this.refresh(rootPath, false)
    }, REFRESH_DEBOUNCE_MS)
  }

  private refresh(rootPath: string, initial: boolean): void {
    const entry = this.watches.get(rootPath)
    if (!entry || this.disposed) return

    const tail = readHeartbeatEventsTail(join(rootPath, 'flow', EVENTS_FILE), entry.eventsCursor)
    if (tail.truncated) {
      entry.events = tail.appended
    } else if (tail.appended.length > 0) {
      entry.events = entry.events.concat(tail.appended)
    }
    entry.eventsCursor = tail.cursor
    const events = entry.events

    const snapshot = buildFlowSnapshot(rootPath, events)

    if (initial || tail.truncated || events.length < entry.seenEventCount) {
      entry.seenEventCount = events.length
    } else {
      const fresh = events.slice(entry.seenEventCount)
      entry.seenEventCount = events.length
      for (const event of fresh) this.emitEventNotification(rootPath, event)
    }

    const promptId = snapshot.pendingPrompt?.promptId ?? null
    if (snapshot.pendingPrompt && promptId !== entry.notifiedPromptId) {
      this.emitPromptNotification(rootPath, snapshot.pendingPrompt)
    }
    entry.notifiedPromptId = promptId

    entry.snapshot = snapshot
    this.emit(FLOW_STATE_CHANGED_EVENT, snapshot)
  }

  private emitEventNotification(rootPath: string, event: HeartbeatEvent): void {
    const label = EVENT_TYPE_LABELS[event.type] ?? event.type
    const notification: FlowNotification = {
      kind: 'heartbeat-event',
      rootId: rootPath,
      title: `${event.task} — ${label}`,
      body: event.message,
      timestamp: event.timestamp || new Date().toISOString(),
      level: event.level,
    }
    this.emit(FLOW_NOTIFICATION_EVENT, notification)
  }

  private emitPromptNotification(rootPath: string, prompt: FlowPendingPrompt): void {
    const notification: FlowNotification = {
      kind: 'blocked-prompt',
      rootId: rootPath,
      title: `Task blocked: ${prompt.task}`,
      body: prompt.markdown,
      timestamp: new Date().toISOString(),
      promptId: prompt.promptId,
      level: 'error',
    }
    this.emit(FLOW_NOTIFICATION_EVENT, notification)
  }
}

// ── IPC registration ──────────────────────────────────────────────────────

export interface FlowChannelDeps {
  /** Project roots provider (adapter over ProjectRegistry — see rootsProviderFrom). */
  roots: RootsProvider
  /** Optional pre-built observer (tests); defaults to one built from `roots`. */
  observer?: FlowObserver
  /**
   * The person's app-wide worktree defaults — the layer a project inherits
   * until it sets a value of its own.
   *
   * A getter, and optional: the settings store lives in main and answers
   * synchronously, so a caller that has one passes it and a caller that does not
   * (a harness) resolves against the project and the built-ins alone — which is
   * exactly the behaviour that shipped before defaults existed.
   */
  worktreeDefaults?: () => Partial<WorktreeDefaults>
}

/**
 * Implements the contract's `flow:state`, `flow:respondPrompt`, and
 * `flow:setConfig` invoke channels and pushes
 * `flow:notification` / `flow:stateChanged` events to
 * every window. Returns a dispose function that unregisters the handlers and
 * stops the observer.
 */
export function registerFlowChannels(deps: FlowChannelDeps): () => Promise<void> {
  // Lazy require keeps this module importable from plain Node (harnesses);
  // typing stays exact via `typeof import('electron')`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const observer = deps.observer ?? new FlowObserver(deps.roots)
  observer.start()

  const registeredChannels: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle (same pattern as src/main/ipc/index.ts). */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  handle('flow:state', ({ rootId }) => observer.getState(rootId))
  handle('flow:respondPrompt', ({ rootId, promptId, response }) =>
    observer.respondPrompt(rootId, promptId, response),
  )
  handle('flow:setConfig', ({ rootId, updates }) => observer.setConfig(rootId, updates))
  // Every worktree setting in effect for a project, with per-key provenance.
  // ONE READ PER ANSWER: the project file once, the defaults once, through the
  // resolver — no watcher, no poll, no cache to go stale behind a hand edit.
  handle('flow:worktreeSettings', ({ rootId }) =>
    readWorktreeSettings(rootId, { globalDefaults: deps.worktreeDefaults }),
  )

  const onNotification = (notification: FlowNotification): void => {
    broadcast('flow:notification', notification)
  }
  const onStateChanged = (state: FlowState): void => {
    broadcast('flow:stateChanged', state)
  }
  observer.on(FLOW_NOTIFICATION_EVENT, onNotification)
  observer.on(FLOW_STATE_CHANGED_EVENT, onStateChanged)

  // #1284: AWAITABLE. Fire-and-forget disposal let quit run ahead of the
  // watcher closes it depends on — the caller now awaits this.
  return async function disposeFlowChannels(): Promise<void> {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    observer.off(FLOW_NOTIFICATION_EVENT, onNotification)
    observer.off(FLOW_STATE_CHANGED_EVENT, onStateChanged)
    try {
      await observer.dispose()
    } catch (error) {
      console.error('[FlowObserver] Dispose failed:', error)
    }
  }
}
