/**
 * Terminal domain — TerminalManager (owns ptys, ids, kinds, scrollback) and
 * `registerTerminalChannels`, which binds the contract's terminal:* invoke
 * channels and broadcasts terminal:data/exit/created events.
 *
 * Two terminal backings live behind one TerminalInfo surface:
 *   - user terminals: a real interactive PTY (login shell per project root)
 *   - agent terminals: one per thread; a virtual output sink in mirror mode
 *     (bash-bridge hooks write into it), optionally hosting real PTY runs
 *     when the live executor routes a command through `runCommand`.
 *
 * Side-effect-free at import: electron is required lazily inside
 * `registerTerminalChannels` so this module (and TerminalManager) can run
 * under plain Node in harnesses.
 */
import { randomUUID } from 'crypto'
import type {
  StampedTerminalChunk,
  TerminalOutputObserver,
} from '../../shared/terminal-stamp'
import { timed } from '../ipc/slow-handler'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { basename } from 'path'

import type { IpcMainInvokeEvent } from 'electron'

import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  TerminalInfo,
  TerminalOwner,
} from '../../shared/ipc-contract'
import { terminalExitMarker } from '../../shared/terminal-exit'
import { armCommandTimeout } from './command-timeout'
import { BoundedOutputCollector } from './output-collector'
import { PtySession, ScrollbackBuffer } from './pty-manager'

export const TERMINAL_DATA_EVENT = 'terminal-data'
export const TERMINAL_EXIT_EVENT = 'terminal-exit'
export const TERMINAL_CREATED_EVENT = 'terminal-created'
export const TERMINAL_REMOVED_EVENT = 'terminal-removed'
/**
 * A person closed a terminal (the renderer's `terminal:dispose`) — as opposed
 * to housekeeping (quit, project removal, thread deletion), which also removes
 * terminals but must not be read as "they no longer want this shell". Payload:
 * the closed terminal's TerminalInfo. Main-internal; never broadcast.
 */
export const TERMINAL_CLOSED_BY_USER_EVENT = 'terminal-closed-by-user'
/** An unowned user shell was given its owner (`claimOwner`). Payload: its
 *  TerminalInfo. Main-internal; never broadcast. */
export const TERMINAL_OWNER_SET_EVENT = 'terminal-owner-set'
/** A person renamed a terminal's tab (`rename`). Payload: its TerminalInfo.
 *  Main-internal; never broadcast. */
export const TERMINAL_RENAMED_EVENT = 'terminal-renamed'

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
}

export interface TerminalRemovedEvent {
  terminalId: string
}

export interface TerminalManagerOptions {
  /**
   * Resolve a project rootId to a cwd. In this app rootIds ARE absolute
   * rootPaths (same convention as the flow domain), so the default is the
   * identity — the hook exists for coordinators that address roots
   * differently.
   */
  resolveCwd?: (rootId: string) => string | undefined
}

export interface RunCommandOptions {
  timeoutMs?: number
}

export interface RunCommandResult {
  /** Raw collected PTY output (ANSI included — callers strip as needed). */
  output: string
  exitCode: number
  timedOut: boolean
  durationMs: number
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000
/**
 * Hard char (≈byte) ceiling for the output a single agent command COLLECTS and
 * returns to the model. Bounds main-process memory regardless of how much a
 * command prints within the timeout (#271); the head is kept, overflow noted.
 * Matches the scrollback display cap (#171).
 */
const COMMAND_OUTPUT_MAX_CHARS = 2 * 1024 * 1024
/** Grace between the timeout's SIGHUP and the escalated SIGKILL (#272). */
const KILL_GRACE_MS = 2_000
/** Exit code reported for a timed-out command (matches `timeout(1)`'s 124). */
const TIMEOUT_EXIT_CODE = 124

interface TerminalEntry {
  info: TerminalInfo
  /** History for late-attaching renderers (both backings feed it). */
  scrollback: ScrollbackBuffer
  /** Interactive shell — user terminals only; agent tabs are virtual. */
  pty: PtySession | null
  /** In-flight executor runs (live-routing mode), killed on dispose. */
  commandPtys: Set<PtySession>
}

/**
 * Owns every terminal in the app. Emits:
 *   TERMINAL_DATA_EVENT    (TerminalDataEvent)  — output to append
 *   TERMINAL_EXIT_EVENT    (TerminalExitEvent)  — user-terminal shell exited
 *   TERMINAL_CREATED_EVENT (TerminalInfo)       — new terminal (any kind)
 */
export class TerminalManager extends EventEmitter {
  #entries = new Map<string, TerminalEntry>()
  /** Who wants stamped output. Empty is the normal state and the cheap one. */
  #outputObservers = new Set<TerminalOutputObserver>()
  #agentTerminalsByThread = new Map<string, string>()
  #options: TerminalManagerOptions

  constructor(options: TerminalManagerOptions = {}) {
    super()
    this.#options = options
  }

  listTerminals(): TerminalInfo[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.info }))
  }

  /** Retained output for one terminal (null → unknown id). */
  getScrollback(terminalId: string): string | null {
    const entry = this.#entries.get(terminalId)
    if (!entry) {
      return null
    }
    return entry.pty ? entry.pty.scrollback.snapshot() : entry.scrollback.snapshot()
  }

  /** One terminal's info (a copy), or null for an unknown id. */
  getTerminal(terminalId: string): TerminalInfo | null {
    const entry = this.#entries.get(terminalId)
    return entry ? { ...entry.info } : null
  }

  /**
   * Spawn an interactive login-shell terminal for a project root. `owner` is
   * the scope (conversation or project view) it was opened in — kept on its
   * info so a reloaded window still knows whose shell it is.
   */
  createUserTerminal(request: {
    rootId?: string
    cols: number
    rows: number
    owner?: TerminalOwner
  }): TerminalInfo {
    const cwd = this.#resolveCwd(request.rootId)
    const terminalId = randomUUID()
    const info: TerminalInfo = {
      terminalId,
      kind: 'user',
      title: basename(cwd) || cwd,
      cwd,
      // rootIds ARE absolute rootPaths in this app; the project root the
      // terminal is scoped to (undefined → homedir fallback, unscoped).
      projectRoot: request.rootId,
      ...(request.owner === undefined
        ? {}
        : { owner: { rootPath: request.owner.rootPath, threadId: request.owner.threadId } }),
    }

    const pty = new PtySession({
      id: terminalId,
      kind: 'user',
      cwd,
      cols: request.cols,
      rows: request.rows,
    })

    const entry: TerminalEntry = {
      info,
      scrollback: pty.scrollback,
      pty,
      commandPtys: new Set(),
    }
    this.#entries.set(terminalId, entry)

    pty.onData((data) => {
      this.emit(TERMINAL_DATA_EVENT, { terminalId, data } satisfies TerminalDataEvent)
      this.#stamp(terminalId, data)
    })
    pty.onExit((exitCode) => {
      // Make exit AUTHORITATIVE and durable across windows (#446): mark the entry
      // exited and fold the marker into the retained scrollback, so a window
      // reopened from the dock (macOS keeps the app alive) sees `exited: true` from
      // terminal:list and replays the marker — instead of a live-looking dead tab.
      entry.info.exited = true
      pty.scrollback.append(terminalExitMarker(exitCode))
      this.emit(TERMINAL_EXIT_EVENT, { terminalId, exitCode } satisfies TerminalExitEvent)
    })

    this.emit(TERMINAL_CREATED_EVENT, { ...info })
    return { ...info }
  }

  /**
   * Open (or reuse) the per-thread agent terminal tab. Virtual by default:
   * bash-bridge hooks append mirrored output via `writeOutput`; the live
   * executor attaches real PTY runs via `runCommand`.
   *
   * `cwd` is WHERE THE AGENT IS — the thread's own git worktree when it has
   * one, so a command run from this tab lands in the same checkout the session
   * writes to rather than in the tree the reader is standing in. `projectRoot`
   * is WHICH PROJECT OWNS THE TAB, and the two stopped being the same value
   * when threads got worktrees: keyed on the worktree, `disposeForRoot` would
   * no longer recognise the tab as the removed project's and would leave it
   * running for the life of the process (the #1484 ghost, re-introduced).
   * It defaults to `cwd`, which is exactly today's behaviour for a thread
   * without a worktree.
   */
  ensureAgentTerminal(thread: {
    threadId: string
    title?: string
    cwd?: string
    projectRoot?: string
  }): TerminalInfo {
    const existingId = this.#agentTerminalsByThread.get(thread.threadId)
    if (existingId) {
      const existing = this.#entries.get(existingId)
      if (existing) {
        return { ...existing.info }
      }
      this.#agentTerminalsByThread.delete(thread.threadId)
    }

    const terminalId = randomUUID()
    const info: TerminalInfo = {
      terminalId,
      kind: 'agent',
      title: thread.title ?? `Agent ${thread.threadId.slice(0, 8)}`,
      cwd: thread.cwd ?? homedir(),
      threadId: thread.threadId,
      // The project this tab belongs to — its worktree's OWNER when the thread
      // has one (see above); undefined when the thread has no known root.
      projectRoot: thread.projectRoot ?? thread.cwd,
    }
    this.#entries.set(terminalId, {
      info,
      scrollback: new ScrollbackBuffer(),
      pty: null,
      commandPtys: new Set(),
    })
    this.#agentTerminalsByThread.set(thread.threadId, terminalId)
    this.emit(TERMINAL_CREATED_EVENT, { ...info })
    return { ...info }
  }

  /**
   * Watch every chunk of output, stamped with the moment it arrived.
   *
   * SEPARATE FROM `TERMINAL_DATA_EVENT` ON PURPOSE. That event is how the
   * renderer learns what to draw; widening it would put a timestamp on every
   * chunk crossing IPC for every window, forever, to serve a recording almost
   * nobody is making. This is the channel for the ones who are.
   *
   * COSTS NOTHING WHEN NOBODY IS WATCHING. With no observers the whole of the
   * work is `#outputObservers.size === 0` — no clock read, no object, no
   * iteration. That is the guarantee `#stamp` below exists to keep, and the one
   * a debug session's "recording costs nothing at rest" rests on.
   *
   * Returns its own removal, so a caller cannot forget which function it
   * registered.
   */
  observeOutput(observer: TerminalOutputObserver): () => void {
    this.#outputObservers.add(observer)
    return () => {
      this.#outputObservers.delete(observer)
    }
  }

  /**
   * Hand one chunk to whoever is watching — and read no clock when nobody is.
   *
   * The early return is the feature. Every terminal in the app calls this on
   * every chunk, and terminal output is not debounced or batched anywhere, so
   * anything done here unconditionally is done thousands of times a second
   * during a noisy build.
   */
  #stamp(terminalId: string, data: string): void {
    if (this.#outputObservers.size === 0) return
    const chunk: StampedTerminalChunk = { terminalId, at: Date.now(), data }
    for (const observer of this.#outputObservers) {
      try {
        observer(chunk)
      } catch (error) {
        // An observer that throws must not break the terminal it is watching.
        console.warn('[Terminal] an output observer threw', error)
      }
    }
  }

  /** Append display output (mirrored agent text) — scrollback + broadcast. */
  writeOutput(terminalId: string, data: string): void {
    const entry = this.#entries.get(terminalId)
    if (!entry || data.length === 0) {
      return
    }
    entry.scrollback.append(data)
    this.emit(TERMINAL_DATA_EVENT, { terminalId, data } satisfies TerminalDataEvent)
    // Mirrored agent output is output: a session recording a thread's terminals
    // must see what the agent printed as well as what a person's shell did.
    this.#stamp(terminalId, data)
  }

  /** Renderer keystrokes → pty stdin. No-op for virtual agent terminals. */
  write(terminalId: string, data: string): void {
    const entry = this.#entries.get(terminalId)
    if (!entry) {
      return
    }
    if (entry.pty) {
      entry.pty.write(data)
      return
    }
    // Take-over of an agent tab reaches any live executor-run command.
    for (const commandPty of entry.commandPtys) {
      commandPty.write(data)
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.#entries.get(terminalId)
    if (!entry) {
      return
    }
    entry.pty?.resize(cols, rows)
    for (const commandPty of entry.commandPtys) {
      commandPty.resize(cols, rows)
    }
  }

  /**
   * Run one command in a real PTY attached to `terminalId` (the live
   * bash-executor path): output streams into the terminal as it happens and
   * is also collected for the caller. Rejects for unknown terminal ids.
   */
  runCommand(
    terminalId: string,
    command: string,
    options: RunCommandOptions = {},
  ): Promise<RunCommandResult> {
    const entry = this.#entries.get(terminalId)
    if (!entry) {
      return Promise.reject(new Error(`Unknown terminal: ${terminalId}`))
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    const startedAt = Date.now()

    return new Promise<RunCommandResult>((resolve, reject) => {
      let commandPty: PtySession
      try {
        commandPty = new PtySession({
          id: `${terminalId}:cmd`,
          kind: 'agent',
          threadId: entry.info.threadId,
          cwd: entry.info.cwd,
          command,
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }

      entry.commandPtys.add(commandPty)
      // Bound the collected output in the MAIN process — an uncapped `collected`
      // let a high-volume command OOM/crash the app (#271). The display
      // scrollback is separately capped (#171).
      const collected = new BoundedOutputCollector(COMMAND_OUTPUT_MAX_CHARS)
      let timedOut = false
      let settled = false

      // Hard timeout with escalation + a guaranteed settle: SIGHUP at the
      // timeout, then SIGKILL AND resolve after a grace window, so a command
      // that ignores the signal can't wedge the tool call forever (#272).
      const timeout = armCommandTimeout({
        timeoutMs,
        graceMs: KILL_GRACE_MS,
        softKill: () => {
          timedOut = true
          commandPty.kill('SIGHUP')
        },
        forceKill: () => commandPty.kill('SIGKILL'),
        settle: () => {
          if (settled) return
          settled = true
          entry.commandPtys.delete(commandPty)
          resolve({
            output: collected.result(),
            exitCode: TIMEOUT_EXIT_CODE,
            timedOut: true,
            durationMs: Date.now() - startedAt,
          })
        },
      })

      commandPty.onData((data) => {
        collected.append(data)
        this.writeOutput(terminalId, data)
      })

      commandPty.onExit((exitCode) => {
        if (settled) {
          return
        }
        settled = true
        timeout.cancel()
        entry.commandPtys.delete(commandPty)
        resolve({
          output: collected.result(),
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
        })
      })
    })
  }

  dispose(terminalId: string): void {
    const entry = this.#entries.get(terminalId)
    if (!entry) {
      return
    }
    this.#entries.delete(terminalId)
    if (entry.info.threadId) {
      this.#agentTerminalsByThread.delete(entry.info.threadId)
    }
    entry.pty?.kill()
    for (const commandPty of entry.commandPtys) {
      // Teardown is immediate — force-terminate any in-flight agent command and
      // its process group so nothing is orphaned past dispose (#272).
      commandPty.kill('SIGKILL')
    }
    entry.commandPtys.clear()
    // Tell the renderer to drop the tab. User shells also emit terminal:exit, but
    // virtual AGENT terminals never exit — without this, their ⚙ tabs accumulate
    // permanently and can never be removed (#304).
    this.emit(TERMINAL_REMOVED_EVENT, { terminalId } satisfies TerminalRemovedEvent)
  }

  /**
   * Dispose every terminal belonging to `rootPath`, returning how many went
   * (#1484). Project removal cascades through tasks → threads → thread_roots →
   * the root itself and never reached here, so the removed project's PTYs kept
   * running for the life of the app process: unreachable when another project
   * was open (its tab simply vanished), and a ghost tab for a project that no
   * longer exists when it was the last one. Same contract #1024 established for
   * the boot shell, on the sibling trigger that never got one.
   */
  disposeForRoot(rootPath: string): number {
    // A thread's shell sits in its checkout, so its projectRoot is the
    // worktree — but its OWNER is the project. Matching on projectRoot alone
    // left every thread-worktree shell running after the project went (the
    // thread rows cascade away without an event, so nothing else reaps them).
    const doomed = [...this.#entries.values()]
      .filter((entry) => entry.info.projectRoot === rootPath || entry.info.owner?.rootPath === rootPath)
      .map((entry) => entry.info.terminalId)
    for (const terminalId of doomed) this.dispose(terminalId)
    return doomed.length
  }

  /**
   * Dispose every USER shell a deleted conversation owned, returning how many
   * went. Its shells are hidden everywhere else by design, so once nothing can
   * ever select the conversation again they would run for the life of the
   * process with no tab and no route back — the #1484 ghost, by thread.
   */
  disposeForOwnerThread(threadId: string): number {
    const doomed = [...this.#entries.values()]
      .filter((entry) => entry.info.kind === 'user' && entry.info.owner?.threadId === threadId)
      .map((entry) => entry.info.terminalId)
    for (const terminalId of doomed) this.dispose(terminalId)
    return doomed.length
  }

  /**
   * Give an UNOWNED user shell its owner (the boot shell, adopted by the
   * scope that arrived after it). Refuses — returns false — for an agent tab,
   * an unknown id, or a shell that already has an owner: a shell never moves
   * between conversations.
   */
  claimOwner(terminalId: string, owner: TerminalOwner): boolean {
    const entry = this.#entries.get(terminalId)
    if (!entry || entry.info.kind !== 'user' || entry.info.owner !== undefined) return false
    entry.info.owner = { rootPath: owner.rootPath, threadId: owner.threadId }
    if (entry.info.projectRoot === undefined) entry.info.projectRoot = owner.rootPath
    this.emit(TERMINAL_OWNER_SET_EVENT, { ...entry.info })
    return true
  }

  /**
   * A person renamed this terminal's tab; null (or a blank name) clears it
   * back to the automatic title. Returns false for an unknown id.
   */
  rename(terminalId: string, title: string | null): boolean {
    const entry = this.#entries.get(terminalId)
    if (!entry) return false
    const next = title === null ? '' : title.trim()
    if (next.length > 0) entry.info.customTitle = next
    else delete entry.info.customTitle
    this.emit(TERMINAL_RENAMED_EVENT, { ...entry.info })
    return true
  }

  /** A person closed this terminal: dispose it and say so (see
   *  TERMINAL_CLOSED_BY_USER_EVENT) — the one path that means "not wanted". */
  closeByUser(terminalId: string): void {
    const entry = this.#entries.get(terminalId)
    if (!entry) return
    const info = { ...entry.info }
    this.dispose(terminalId)
    this.emit(TERMINAL_CLOSED_BY_USER_EVENT, info)
  }

  disposeAll(): void {
    for (const terminalId of [...this.#entries.keys()]) {
      this.dispose(terminalId)
    }
    // Manager-level teardown drops subscribers too (consistent with the
    // other managers' dispose contracts).
    this.removeAllListeners()
  }

  #resolveCwd(rootId?: string): string {
    if (!rootId) {
      return homedir()
    }
    if (this.#options.resolveCwd) {
      return this.#options.resolveCwd(rootId) ?? homedir()
    }
    // rootIds are absolute rootPaths in this app (flow-domain convention).
    return rootId
  }
}

// ═══════════════════════════════════════════════════════════════════════
// IPC registration
// ═══════════════════════════════════════════════════════════════════════

export interface TerminalChannelDependencies {
  terminalManager: TerminalManager
}

type TerminalInvokeChannel = Extract<IpcInvokeChannel, `terminal:${string}`>

/**
 * Register the contract's terminal:* invoke channels and wire manager events
 * to renderer broadcasts. Returns a dispose function.
 *
 * Scrollback replay: the contract has no dedicated replay channel yet, so a
 * `terminal:list` call also re-sends each terminal's retained history as
 * `terminal:data` events — to the REQUESTING webContents only, so other
 * windows never see duplicates. The renderer calls list() exactly once per
 * attach and buffers data for tabs it hasn't built yet, which makes the
 * ordering race-free. (A `terminal:scrollback` invoke channel is the
 * proposed contract adjustment.)
 */
export function registerTerminalChannels(deps: TerminalChannelDependencies): () => void {
  const { terminalManager } = deps

  // Lazy so importing this module under plain Node (harnesses) never touches
  // electron; only actual registration needs it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const registeredChannels: TerminalInvokeChannel[] = []

  /** Contract-typed ipcMain.handle (event exposed for sender-scoped replay). */
  function handle<C extends TerminalInvokeChannel>(
    channel: C,
    handler: (
      request: IpcRequest<C>,
      event: IpcMainInvokeEvent,
    ) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (event, request: IpcRequest<C>) =>
      timed(channel, (payload: IpcRequest<C>) => handler(payload, event))(request),
    )
  }

  function broadcast<C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventPayload<C>,
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  handle('terminal:list', (_request, event) => {
    const terminals = terminalManager.listTerminals()
    // Sender-scoped history replay (see doc comment above).
    for (const terminal of terminals) {
      const history = terminalManager.getScrollback(terminal.terminalId)
      if (history && history.length > 0 && !event.sender.isDestroyed()) {
        event.sender.send('terminal:data', {
          terminalId: terminal.terminalId,
          data: history,
        } satisfies IpcEventPayload<'terminal:data'>)
      }
    }
    return terminals
  })

  handle('terminal:create', (request) => terminalManager.createUserTerminal(request))

  handle('terminal:write', ({ terminalId, data }) => {
    terminalManager.write(terminalId, data)
  })

  handle('terminal:resize', ({ terminalId, cols, rows }) => {
    terminalManager.resize(terminalId, cols, rows)
  })

  handle('terminal:dispose', ({ terminalId }) => {
    terminalManager.closeByUser(terminalId)
  })

  handle('terminal:claim', ({ terminalId, owner }) => {
    terminalManager.claimOwner(terminalId, owner)
  })

  handle('terminal:rename', ({ terminalId, title }) => {
    terminalManager.rename(terminalId, title)
  })

  const onData = (event: TerminalDataEvent): void => {
    broadcast('terminal:data', event)
  }
  const onExit = (event: TerminalExitEvent): void => {
    broadcast('terminal:exit', event)
  }
  const onCreated = (info: TerminalInfo): void => {
    broadcast('terminal:created', info)
  }
  const onRemoved = (event: TerminalRemovedEvent): void => {
    broadcast('terminal:removed', event)
  }
  terminalManager.on(TERMINAL_DATA_EVENT, onData)
  terminalManager.on(TERMINAL_EXIT_EVENT, onExit)
  terminalManager.on(TERMINAL_CREATED_EVENT, onCreated)
  terminalManager.on(TERMINAL_REMOVED_EVENT, onRemoved)

  return function disposeTerminalChannels(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    terminalManager.off(TERMINAL_DATA_EVENT, onData)
    terminalManager.off(TERMINAL_EXIT_EVENT, onExit)
    terminalManager.off(TERMINAL_CREATED_EVENT, onCreated)
    terminalManager.off(TERMINAL_REMOVED_EVENT, onRemoved)
  }
}
