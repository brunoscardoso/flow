/**
 * PTY session primitives — a node-pty wrapper following noto's PtyProcess
 * pattern (kitty/ghostty protocol handling deliberately stripped) plus the
 * scrollback ring buffer terminals use to replay history to late-attaching
 * renderers.
 *
 * A PtySession spawns either an interactive login shell (user terminals) or
 * a single command under a login shell (`shell -l -c <command>`, used by the
 * agent bash executor). Login shells matter: without `-l`, PATH setup that
 * users keep in .zprofile/.bash_profile never runs and the first `npm`/`git`
 * hits "command not found".
 *
 * The shell and its argv are NOT assembled here — `../platform/shell` owns
 * that per platform. This module used to build the single-command form as
 * `[...args, '-c', command]`, the POSIX shape reused verbatim on Windows;
 * PowerShell has no `-c`, only the ambiguous abbreviation of `-Command`, so
 * the Windows terminal worked by accident and only for interactive sessions.
 *
 * Side-effect-free at import: node-pty (a native module) is required lazily
 * on first spawn, never at module load.
 */
import type { IPty } from 'node-pty'

import type { TerminalKind } from '../../shared/ipc-contract'
import { shellSpec } from '../platform/shell'

/** Scrollback retained per terminal (~10k lines) for renderer replay. */
export const SCROLLBACK_MAX_LINES = 10_000
/**
 * Hard char (≈byte) ceiling for retained scrollback (#171). The line cap alone
 * gives NO memory bound: `\r`-based redraws (top/htop/progress bars) emit large
 * volumes with ~0 newlines, so line count stays under the cap forever. ~2M
 * chars (a few MB) bounds memory regardless of newline density.
 */
export const SCROLLBACK_MAX_CHARS = 2 * 1024 * 1024

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * Line-bounded ring buffer of raw terminal output (ANSI included, so a
 * replayed snapshot renders identically in xterm). Chunks are dropped from
 * the front once the retained line count exceeds the cap — a whole chunk at
 * a time, which is cheap and close enough for a 10k-line budget.
 */
export class ScrollbackBuffer {
  #chunks: string[] = []
  #chunkLines: number[] = []
  #chunkChars: number[] = []
  #totalLines = 0
  #totalChars = 0
  readonly #maxLines: number
  readonly #maxChars: number

  constructor(maxLines: number = SCROLLBACK_MAX_LINES, maxChars: number = SCROLLBACK_MAX_CHARS) {
    this.#maxLines = maxLines
    this.#maxChars = maxChars
  }

  append(data: string): void {
    if (data.length === 0) {
      return
    }
    const lines = countNewlines(data)
    this.#chunks.push(data)
    this.#chunkLines.push(lines)
    this.#chunkChars.push(data.length)
    this.#totalLines += lines
    this.#totalChars += data.length
    // Evict whole front chunks while EITHER budget is exceeded — the char cap
    // bounds memory even for newline-sparse redraw output (#171).
    while (
      (this.#totalLines > this.#maxLines || this.#totalChars > this.#maxChars) &&
      this.#chunks.length > 1
    ) {
      this.#chunks.shift()
      this.#totalLines -= this.#chunkLines.shift() ?? 0
      this.#totalChars -= this.#chunkChars.shift() ?? 0
    }
    // A single chunk larger than the whole budget (e.g. one multi-MB line) can't
    // be evicted above — trim it to the most-recent tail so the bound is hard.
    if (this.#chunks.length === 1 && this.#totalChars > this.#maxChars) {
      const only = this.#chunks[0]
      const trimmed = only.slice(only.length - this.#maxChars)
      this.#chunks[0] = trimmed
      this.#chunkChars[0] = trimmed.length
      this.#chunkLines[0] = countNewlines(trimmed)
      this.#totalChars = trimmed.length
      this.#totalLines = this.#chunkLines[0]
    }
  }

  /** Full retained history as one string (empty when nothing was written). */
  snapshot(): string {
    return this.#chunks.join('')
  }

  get lineCount(): number {
    return this.#totalLines
  }

  clear(): void {
    this.#chunks = []
    this.#chunkLines = []
    this.#chunkChars = []
    this.#totalLines = 0
    this.#totalChars = 0
  }

  /** Retained scrollback size in chars (≈bytes) — for the memory-bound test. */
  get charCount(): number {
    return this.#totalChars
  }
}

function countNewlines(data: string): number {
  let count = 0
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) === 10) {
      count += 1
    }
  }
  return count
}

export interface PtySessionOptions {
  /** Terminal id this session backs (for labeling/diagnostics only). */
  id: string
  kind: TerminalKind
  /** Owning thread label for agent sessions. */
  threadId?: string
  cwd: string
  cols?: number
  rows?: number
  /**
   * When set, runs this single command and exits; omitted → interactive login
   * shell. The argv is the platform's own (`shell -l -c <command>` on POSIX,
   * `powershell.exe -NoLogo -NonInteractive -Command <command>` on Windows) —
   * see `../platform/shell`.
   */
  command?: string
  /** Extra environment merged over the inherited process env. */
  env?: Record<string, string>
}

/**
 * Login shell detection: $SHELL first, platform default as fallback.
 *
 * Now a thin read of `shellSpec` rather than its own copy of the rules, so the
 * interactive form and the single-command form can never disagree about which
 * shell they are talking about (allowed-pattern #14).
 */
export function detectShell(): { shell: string; args: string[] } {
  const spec = shellSpec(process.platform, process.env.SHELL)
  return { shell: spec.shell, args: spec.interactiveArgs }
}

/**
 * Exactly what a PtySession will hand node-pty — the whole spawn shape as one
 * pure value, so it can be asserted without a native module and from either
 * host (NFR3). `platform`/`envShell` are injectable for the same reason;
 * production callers take the defaults.
 *
 * On darwin this is byte-identical to the pre-port assembly (`$SHELL` or
 * `/bin/zsh`, `['-l']`, `['-l', '-c', command]`). Only the Windows branch
 * changes, and only because its previous shape was the POSIX one by accident.
 */
export function ptySpawnSpec(
  command: string | undefined,
  platform: NodeJS.Platform | string = process.platform,
  envShell: string | undefined = process.env.SHELL,
): { shell: string; args: string[] } {
  const spec = shellSpec(platform, envShell)
  // Truthiness, not `!== undefined`: an empty `command` meant "interactive"
  // before the port and still does.
  return {
    shell: spec.shell,
    args: command ? spec.singleCommandArgs(command) : spec.interactiveArgs,
  }
}

/** Inherited env with undefined entries dropped (node-pty wants string values). */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  // npm sets this in scripts; leaking it into an interactive shell breaks
  // global installs inside the terminal (same fix as noto's PtyProcess).
  delete env.npm_config_prefix
  env.TERM = 'xterm-256color'
  return { ...env, ...extra }
}

/**
 * One live pseudo-terminal. Data fan-out is callback-based; every byte the
 * pty produces is also appended to the session's scrollback buffer so the
 * owner can replay history.
 */
export class PtySession {
  readonly id: string
  readonly kind: TerminalKind
  readonly threadId: string | undefined
  readonly cwd: string
  readonly scrollback: ScrollbackBuffer

  #proc: IPty | null = null
  #cols: number
  #rows: number
  #exited = false
  #dataCallbacks: Array<(data: string) => void> = []
  #exitCallbacks: Array<(exitCode: number) => void> = []

  constructor(options: PtySessionOptions) {
    this.id = options.id
    this.kind = options.kind
    this.threadId = options.threadId
    this.cwd = options.cwd
    this.scrollback = new ScrollbackBuffer()
    this.#cols = options.cols ?? DEFAULT_COLS
    this.#rows = options.rows ?? DEFAULT_ROWS

    // Lazy native-module load: importing this file must never pull in the
    // node-pty binding (harnesses and non-terminal code paths stay clean).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require('node-pty') as typeof import('node-pty')
    const { shell, args: spawnArgs } = ptySpawnSpec(options.command)

    this.#proc = nodePty.spawn(shell, spawnArgs, {
      name: 'xterm-256color',
      cols: this.#cols,
      rows: this.#rows,
      cwd: options.cwd,
      env: buildEnv(options.env),
    })

    this.#proc.onData((data: string) => {
      this.scrollback.append(data)
      for (const callback of this.#dataCallbacks) {
        callback(data)
      }
    })

    this.#proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.#exited = true
      this.#proc = null
      for (const callback of this.#exitCallbacks) {
        callback(exitCode)
      }
    })
  }

  get pid(): number {
    return this.#proc?.pid ?? -1
  }

  get cols(): number {
    return this.#cols
  }

  get rows(): number {
    return this.#rows
  }

  get exited(): boolean {
    return this.#exited
  }

  onData(callback: (data: string) => void): void {
    this.#dataCallbacks.push(callback)
  }

  onExit(callback: (exitCode: number) => void): void {
    this.#exitCallbacks.push(callback)
  }

  write(data: string): void {
    this.#proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) {
      return
    }
    this.#cols = cols
    this.#rows = rows
    try {
      this.#proc?.resize(cols, rows)
    } catch {
      // Resizing a pty that raced its own exit throws — nothing to do.
    }
  }

  /**
   * Signal the pty. `signal` defaults to node-pty's SIGHUP. On POSIX this is a
   * best-effort process-GROUP kill (negative pid) so children the shell spawned
   * (a dev server, a process holding a port) die with it instead of orphaning
   * (#272); it falls back to the single-process kill if the group signal isn't
   * permitted. #proc is left set so an escalation can re-signal (SIGHUP →
   * SIGKILL); onExit clears it when the process actually dies.
   */
  kill(signal?: string): void {
    const proc = this.#proc
    if (!proc) return
    // Default to SIGHUP (node-pty's own default) so a no-arg kill and the group
    // path agree — process.kill(-pid) would otherwise default to SIGTERM.
    const sig = (signal ?? 'SIGHUP') as NodeJS.Signals
    try {
      if (process.platform !== 'win32' && proc.pid > 0) {
        try {
          process.kill(-proc.pid, sig)
        } catch {
          proc.kill(sig)
        }
      } else {
        proc.kill(sig)
      }
    } catch {
      // Already dead / invalid signal on a gone process.
    }
  }
}
