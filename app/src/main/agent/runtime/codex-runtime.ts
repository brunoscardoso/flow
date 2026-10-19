// The Codex runtime adapter (multi_runtime_support, Phase 5).
//
// The SECOND AgentRuntime implementation and the first NON-Claude one — proof
// the seam holds for a foreign CLI. Where ClaudeRuntime wraps an in-process SDK
// query, CodexRuntime drives the `codex` binary: each turn is one
// `codex exec --json` child process whose JSONL stdout is mapped to the same
// normalized `AgentStreamEvent` stream (via codex-events.ts) the renderer
// already consumes.
//
// Containment is NATIVE and satisfies the admission floor WITHOUT plan-flow
// building an OS sandbox: `-s workspace-write` confines all writes to `-C <cwd>`
// (spike-confirmed, flow/resources/multi-runtime-spike-report.md). Codex is
// one-shot-per-turn: `send()` is a fresh `codex exec resume <session-id>` that
// continues the same rollout — the resume handle is the `thread.started`
// thread_id, the direct analog of Claude's sdk_session_id.
//
// The `spawn` seam is injected so the whole adapter is exercised with a fake
// child process (no real `codex`, no network); a live contained run is the
// empirical check on top of that.

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type {
  AgentRuntime,
  RuntimeCallbacks,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeStartOptions,
} from './agent-runtime'
import { describeRuntimeFailure, isAuthFailure } from './runtime-failure'
import { clearRuntimeAuthFailure, markRuntimeAuthFailure } from './runtime-auth-state'
import { parseCodexEvent } from './codex-events'
import {
  CODEX_WRITABLE_ROOTS_NOTICE,
  codexWritableRootsOverride,
  codexWritableRootsSupport,
  isWritableRootsRejection,
  type CodexWritableRootsSupport,
} from '../flow-link-roots'

/** Codex's own sandbox policy — writes confined to the `-C <cwd>` root. */
const SANDBOX_MODE = 'workspace-write'

export interface CodexRuntimeDeps {
  /** Injectable process spawner (tests). Default: node child_process spawn. */
  spawnFn?: typeof spawn
  /** The codex executable (default `'codex'` on PATH). */
  execPath?: string
  /** Clock for event timestamps (tests pass a fixed stamp). */
  now?: () => string
  /** Environment for the child — carries the USER's PATH in a GUI-launched
   *  app, which otherwise cannot see the CLI at all (tool-path.ts). */
  env?: NodeJS.ProcessEnv
  /** Which Codex builds refused the writable-roots override this run (tests
   *  pass their own; the app shares one record across every thread). */
  writableRootsSupport?: CodexWritableRootsSupport
}

/**
 * Codex's declared capabilities. Containment is NATIVE (its own fs+network
 * sandbox with approval-on-request), which satisfies the admission floor.
 * `toolApproval: 'on-request'` — Codex approves at its own boundary, it does not
 * expose a Claude-style per-tool pre-veto; `subAgents: 'instance-spawn'` — no
 * native sub-agent tool, plan-flow spawns fresh `codex exec` instances.
 */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  driveHeadless: true,
  parseableStream: true,
  resumeHandle: true,
  containment: 'native',
  toolApproval: 'on-request',
  toolEvents: true,
  subAgents: 'instance-spawn',
  modelSelection: true,
}

/**
 * Build the `codex exec` argv for one turn. A fresh turn reads its prompt from
 * stdin with no positional; a resume turn passes the session id and a `-`
 * PROMPT positional so the follow-up is read from stdin too.
 */
export function buildCodexArgs(input: {
  resumeId: string | null
  model?: string
  effort?: 'low' | 'medium' | 'high'
  cwd: string
  /** Directories beyond `cwd` the turn may write (absolute; others dropped). */
  writableRoots?: readonly string[]
}): string[] {
  const writableRoots = codexWritableRootsOverride(input.writableRoots ?? [])
  const common = [
    '--json',
    '-s',
    SANDBOX_MODE,
    '-C',
    input.cwd,
    '--skip-git-repo-check',
    ...(input.model !== undefined ? ['-m', input.model] : []),
    // FLOW OWNS THE EFFORT. The composer sets it per thread, Codex has exactly
    // this dial (low | medium | high | none), and until now the thread's choice
    // stopped at Flow's edge while Codex used whatever its config said.
    //
    // It also un-breaks a real machine. A `model_reasoning_effort` a given
    // codex build does not recognise makes EVERY headless run die before it
    // starts ("Failed to deserialize overridden config: unknown variant
    // `xhigh`") — and a `-c` override replaces that value before the file is
    // deserialized, so the turn runs. Verified live: same config, same binary,
    // one flag, and the session came up on gpt-5.1-codex-max.
    ...(input.effort !== undefined ? ['-c', `model_reasoning_effort="${input.effort}"`] : []),
    // THE `flow/` LINK POINTS OUTSIDE THE REPOSITORY. `-s workspace-write`
    // confines writes to `-C <cwd>`, and Codex resolves the link — so every
    // knowledge write was "Operation not permitted" until the link's target
    // (and the thread's other projects) were named as writable roots. Proven
    // on codex 0.19: refused without this override, written with it.
    ...(writableRoots !== null ? ['-c', writableRoots] : []),
  ]
  if (input.resumeId) {
    return ['exec', 'resume', ...common, input.resumeId, '-']
  }
  return ['exec', ...common]
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex'
  readonly capabilities = CODEX_CAPABILITIES

  private readonly spawnFn: typeof spawn
  private readonly execPath: string
  private readonly now: () => string
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly writableRootsSupport: CodexWritableRootsSupport

  constructor(deps: CodexRuntimeDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn
    this.execPath = deps.execPath ?? 'codex'
    this.now = deps.now ?? ((): string => new Date().toISOString())
    this.env = deps.env
    this.writableRootsSupport = deps.writableRootsSupport ?? codexWritableRootsSupport
  }

  start(options: RuntimeStartOptions, callbacks: RuntimeCallbacks): RuntimeSession {
    // The Codex resume handle — the thread_id from `thread.started`. Seeded from
    // a caller-supplied resume target, then updated once the child reports one.
    let sessionId: string | null = options.resumeSessionId ?? null
    let model = options.model
    const effort = options.effort
    let child: ChildProcess | null = null
    let disposed = false

    const onSessionId = (id: string): void => {
      if (sessionId === id) return
      sessionId = id
      callbacks.onSessionId(id)
    }

    // Emit one JSONL line's worth of normalized events. Events are stamped with
    // the plan-flow THREAD id (options.threadId); the codex session id rides in
    // result.sessionId and becomes the resume handle.
    /** What the tool said outside its protocol — the account of a failure. */
    let strayOutput = ''
    /** An auth refusal, kept whatever envelope it arrived in. */
    let authOutput = ''
    /** What THIS turn's process wrote to stderr — where a config refusal is said. */
    let stderrOutput = ''
    /** True once this turn produced anything (an event or a session id): from
     *  then on a failure is the turn's, never a config refusal to retry. */
    let turnProduced = false
    const noteAuth = (text: string): void => {
      if (authOutput.length === 0) authOutput = text.trim().replace(/\s+/g, ' ').slice(0, 300)
    }

    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      // A REFUSED CREDENTIAL ARRIVES INSIDE THE PROTOCOL. Measured: codex
      // reports it as a JSON `background_event` — "stream error: Failed to
      // refresh token: 401 Unauthorized" — so scanning only the non-JSON lines
      // never sees the one thing the reader most needs to know, and Settings
      // goes on showing a green tick while every turn is rejected.
      if (isAuthFailure(trimmed)) {
        markRuntimeAuthFailure('codex')
        noteAuth(trimmed)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        noteStray(trimmed) // a non-JSON log line: the only words a failure has
        return
      }
      const result = parseCodexEvent(parsed, options.threadId, this.now())
      if (result.sessionId !== undefined || result.events.length > 0) turnProduced = true
      if (result.sessionId !== undefined) onSessionId(result.sessionId)
      for (const event of result.events) callbacks.onEvent(event)
    }

    const noteStray = (text: string): void => {
      const line = text
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && !entry.startsWith('{'))
        .join(' ')
      if (line.length > 0) strayOutput = `${strayOutput}${strayOutput ? ' ' : ''}${line}`.slice(0, 500)
    }

    const runTurn = (prompt: string, resumeId: string | null): void => {
      strayOutput = ''
      authOutput = ''
      stderrOutput = ''
      turnProduced = false
      // A Codex that already refused the override this run is never handed it
      // again — the refusal would kill every turn before it starts.
      const grantsRoots =
        !this.writableRootsSupport.refuses(this.execPath) &&
        codexWritableRootsOverride(options.writableRoots ?? []) !== null
      const proc = this.spawnFn(this.execPath, buildCodexArgs({
          resumeId,
          model,
          cwd: options.cwd,
          ...(effort === undefined ? {} : { effort }),
          ...(grantsRoots ? { writableRoots: options.writableRoots } : {}),
        }), {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.env === undefined ? {} : { env: this.env }),
      })
      child = proc

      const onAbort = (): void => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      if (options.abortSignal.aborted) onAbort()
      else options.abortSignal.addEventListener('abort', onAbort, { once: true })

      proc.stderr?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk)
        stderrOutput = `${stderrOutput}${text}`.slice(-4_000)
        noteStray(text)
      })
      // Codex emits JSONL; buffer partial lines across chunk boundaries.
      let buffer = ''
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk)
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          consumeLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })

      const finish = (code: number | null): void => {
        // A trailing partial line (no final newline) is still a complete event.
        if (buffer.length > 0) {
          consumeLine(buffer)
          buffer = ''
        }
        child = null
        // A CODEX THAT REFUSES THE WRITABLE ROOTS dies at config parse, before
        // the turn begins — nothing was said and nothing was done. Remember the
        // refusal for this run, say so once in plain words, and run the same
        // turn again without the override: a turn that runs (and cannot keep
        // its notes) is worth more than one that never starts.
        //
        // ONLY THEN. A turn that produced an event or a session id has begun —
        // tools may already have run — and re-running it would do the work
        // twice. And only on the config-parse phrase, on stderr, naming the
        // key: a mention of the key anywhere else is not a refusal.
        if (
          code !== 0 &&
          grantsRoots &&
          !turnProduced &&
          !disposed &&
          !options.abortSignal.aborted &&
          isWritableRootsRejection(stderrOutput)
        ) {
          if (this.writableRootsSupport.markRefused(this.execPath)) {
            callbacks.onNotice?.(CODEX_WRITABLE_ROOTS_NOTICE)
          }
          runTurn(prompt, resumeId)
          return
        }
        // A failed turn says so. Codex refuses in plain text — a config it
        // cannot parse, a model it does not have — and dropping those lines
        // left the user with a message they sent and nothing at all after it.
        if (code === 0) {
          // Something worked: whatever we last saw refused is no longer true.
          clearRuntimeAuthFailure('codex')
        } else if (strayOutput.length > 0 || authOutput.length > 0) {
          // A REFUSED CREDENTIAL IS NOT A SIGN-IN. The credential file still
          // says signed in — only the runtime knows it stopped being accepted,
          // and Settings has to stop claiming otherwise (runtime-auth-state).
          const said = strayOutput.length > 0 ? strayOutput : authOutput
          if (isAuthFailure(said)) markRuntimeAuthFailure('codex')
          callbacks.onEvent({
            kind: 'error',
            threadId: options.threadId,
            message: describeRuntimeFailure('Codex', said),
          })
        }
        callbacks.onDone?.()
      }
      proc.on('close', (code) => finish(code))
      proc.on('error', (error) => {
        noteStray(error.message)
        finish(null)
      })

      // The turn's prompt goes on stdin (fresh exec and `-` resume both read it).
      proc.stdin?.write(prompt)
      proc.stdin?.end()
    }

    runTurn(options.prompt, sessionId)

    return {
      get sessionId(): string | null {
        return sessionId
      },
      send: (text: string): void => {
        // A follow-up turn resumes the known rollout; with no session id yet
        // (the first turn never reported one) it can only start fresh.
        runTurn(text, sessionId)
      },
      setModel: (nextModel: string): void => {
        // Applies to the NEXT turn — a codex exec turn's model is fixed at spawn.
        model = nextModel
      },
      interrupt: (): void => {
        // Kill the in-flight turn's process but keep the session: a later send
        // resumes the same rollout by its session id.
        if (child) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          child = null
        }
      },
      dispose: (): void => {
        if (disposed) return
        disposed = true
        if (child) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          child = null
        }
      },
    }
  }
}

// Re-exported for callers that want the normalized event type alongside the
// runtime without reaching into the shared contract.
export type { AgentStreamEvent }
