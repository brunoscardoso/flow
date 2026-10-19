// The Copilot runtime adapter (multi_runtime_support, Phase 5).
//
// The third AgentRuntime — GitHub's `copilot` CLI. Structurally the twin of
// CodexRuntime: each turn is one `copilot -p <prompt> --output-format json`
// child whose JSONL stdout maps to AgentStreamEvents (copilot-events.ts).
//
// Containment is NATIVE and satisfies the admission floor WITHOUT an OS sandbox:
// `-C <cwd>` sets the root, `--add-dir` widens it per additional root, and path
// verification (ON by default) confines writes — we pass `--allow-all-tools`
// (required for non-interactive drive) but deliberately NOT `--allow-all-paths`,
// so the path floor stays. Spike-verified: a headless run wrote only inside cwd.
//
// Resume: the session id arrives in the terminal `result` event; a follow-up
// turn re-runs with `--resume <id>`. The prompt rides on `-p` (an argv value),
// so — unlike Codex — nothing is written to stdin.

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
import { createCopilotParser } from './copilot-events'

export interface CopilotRuntimeDeps {
  /** Injectable process spawner (tests). Default: node child_process spawn. */
  spawnFn?: typeof spawn
  /** The copilot executable (default `'copilot'` on PATH). */
  execPath?: string
  /** Clock for event timestamps (tests pass a fixed stamp). */
  now?: () => string
  /** Environment for the child — carries the USER's PATH in a GUI-launched
   *  app, which otherwise cannot see /opt/homebrew/bin at all (tool-path.ts). */
  env?: NodeJS.ProcessEnv
}

/**
 * Copilot's declared capabilities. Containment is NATIVE (path verification);
 * `toolApproval: 'on-request'` — headless mode auto-approves tools via
 * `--allow-all-tools`, it has no Claude-style per-tool pre-veto;
 * `subAgents: 'instance-spawn'` — plan-flow spawns fresh `copilot` instances.
 */
export const COPILOT_CAPABILITIES: RuntimeCapabilities = {
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
 * Build the `copilot` argv for one turn. Non-interactive drive requires
 * `--allow-all-tools`; path containment is kept by NOT passing
 * `--allow-all-paths` (cwd + `--add-dir` roots stay the writable floor).
 */
export function buildCopilotArgs(
  prompt: string,
  input: { resumeId: string | null; model?: string; cwd: string; additionalRoots: readonly string[] },
): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '-C', input.cwd, '--allow-all-tools', '--no-color']
  for (const root of input.additionalRoots) {
    args.push('--add-dir', root)
  }
  if (input.model !== undefined) {
    args.push('--model', input.model)
  }
  if (input.resumeId) {
    args.push('--resume', input.resumeId)
  }
  return args
}

export class CopilotRuntime implements AgentRuntime {
  readonly id = 'copilot'
  readonly capabilities = COPILOT_CAPABILITIES

  private readonly spawnFn: typeof spawn
  private readonly execPath: string
  private readonly now: () => string
  private readonly env: NodeJS.ProcessEnv | undefined

  constructor(deps: CopilotRuntimeDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn
    this.execPath = deps.execPath ?? 'copilot'
    this.now = deps.now ?? ((): string => new Date().toISOString())
    this.env = deps.env
  }

  start(options: RuntimeStartOptions, callbacks: RuntimeCallbacks): RuntimeSession {
    let sessionId: string | null = options.resumeSessionId ?? null
    let model = options.model
    let child: ChildProcess | null = null
    let disposed = false

    const onSessionId = (id: string): void => {
      if (sessionId === id) return
      sessionId = id
      callbacks.onSessionId(id)
    }

    /** An auth refusal, kept whatever envelope it arrived in — see the codex
     *  runtime: these arrive INSIDE the JSON protocol, not on stderr. */
    let authOutput = ''
    const noteAuth = (text: string): void => {
      if (authOutput.length === 0) authOutput = text.trim().replace(/\s+/g, ' ').slice(0, 300)
    }

    // One parser per turn: it remembers which message's text is still open.
    let parseEvent = createCopilotParser(options.threadId)

    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      if (isAuthFailure(trimmed)) {
        markRuntimeAuthFailure('copilot')
        noteAuth(trimmed)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Not protocol — the tool talking to a human. Keep it for the outcome.
        noteStray(trimmed)
        return
      }
      const result = parseEvent(parsed, this.now())
      if (result.sessionId !== undefined) onSessionId(result.sessionId)
      for (const event of result.events) callbacks.onEvent(event)
    }

    /**
     * A line the JSON stream did not explain.
     *
     * SILENCE WAS THE BUG. `copilot` prints its refusals as plain text —
     *   Error: Model "opus" from --model flag is not available.
     * — which JSON.parse drops, and both `close` and `error` went straight to
     * onDone(). A user sent "hey", the turn ended instantly, and NOTHING
     * appeared: no answer, no error, no clue. Whatever the tool says outside
     * its protocol is the only account of what went wrong, so it is kept and
     * surfaced if the turn produces nothing else.
     */
    let strayOutput = ''
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
      parseEvent = createCopilotParser(options.threadId)
      const proc = this.spawnFn(
        this.execPath,
        buildCopilotArgs(prompt, {
          resumeId,
          model,
          cwd: options.cwd,
          additionalRoots: options.additionalRoots,
        }),
        {
          cwd: options.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(this.env === undefined ? {} : { env: this.env }),
        },
      )
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

      proc.stderr?.on('data', (chunk: Buffer | string) => noteStray(String(chunk)))
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
        if (buffer.length > 0) {
          consumeLine(buffer)
          buffer = ''
        }
        child = null
        // A turn that failed says so. `code` is null when the process could not
        // be spawned at all (no copilot on PATH), which is the same class of
        // "nothing happened" from the user's chair.
        if (code === 0) {
          // Something worked: whatever we last saw refused is no longer true.
          clearRuntimeAuthFailure('copilot')
        } else if (strayOutput.length > 0 || authOutput.length > 0) {
          // A REFUSED CREDENTIAL IS NOT A SIGN-IN. The credential file still
          // says signed in — only the runtime knows it stopped being accepted,
          // and Settings has to stop claiming otherwise (runtime-auth-state).
          const said = strayOutput.length > 0 ? strayOutput : authOutput
          if (isAuthFailure(said)) markRuntimeAuthFailure('copilot')
          callbacks.onEvent({
            kind: 'error',
            threadId: options.threadId,
            message: describeRuntimeFailure('GitHub Copilot', said),
          })
        }
        callbacks.onDone?.()
      }
      proc.on('close', (code) => finish(code))
      proc.on('error', (error) => {
        noteStray(error.message)
        finish(null)
      })
    }

    runTurn(options.prompt, sessionId)

    return {
      get sessionId(): string | null {
        return sessionId
      },
      send: (text: string): void => {
        runTurn(text, sessionId)
      },
      setModel: (nextModel: string): void => {
        model = nextModel
      },
      interrupt: (): void => {
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

export type { AgentStreamEvent }
