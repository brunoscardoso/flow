/**
 * Agent Bash ↔ terminal bridge (ADR-001, Phase 9 verdict).
 *
 * Two independent mechanisms, both side-effect-free at import — the
 * coordinator decides which to wire into AgentManager's session options:
 *
 * 1. `createBashMirrorHooks` — the SHIPPED BASELINE. PreToolUse/PostToolUse
 *    hook callbacks (shaped for SDK `options.hooks`) that mirror every agent
 *    Bash call into that thread's agent terminal tab: the command line on
 *    PreToolUse, stdout/stderr on PostToolUse. Hooks ALWAYS fire — including
 *    for "safe" commands that bypass `canUseTool` — so this is the complete
 *    observation channel. Display-only: the SDK's own Bash implementation
 *    (sandboxing, timeouts, background tasks) is untouched.
 *
 * 2. `createBashPtyExecutor` — the OPTIONAL live-output route. An
 *    SDK-MCP-tool-shaped handler (for `tool('bash', ..., handler)` +
 *    `createSdkMcpServer` + `toolAliases: { Bash: 'mcp__flow__bash' }`) that
 *    runs the command in a real Flow-owned PTY, streaming output into the
 *    agent tab as it happens, and returns the collected output to the model.
 *    Per ADR-001 this replaces the SDK Bash implementation — reimplemented
 *    timeout here, permission pipeline stays the coordinator's concern.
 *
 * Do NOT enable both for the same session: the mirror's PostToolUse would
 * double-print output the executor already streamed live.
 */
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'

/**
 * What the bridge needs from the terminal side — a structural slice of
 * TerminalManager (./index.ts) so harnesses can substitute a fake without
 * pulling Electron into the module graph.
 */
export interface BashBridgeTerminals {
  ensureAgentTerminal(thread: {
    threadId: string
    title?: string
    cwd?: string
    projectRoot?: string
  }): { terminalId: string }
  /** Append display output to a terminal (scrollback + renderer broadcast). */
  writeOutput(terminalId: string, data: string): void
  /** Run a command in a Flow-owned PTY attached to the terminal, streaming live. */
  runCommand(
    terminalId: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ output: string; exitCode: number; timedOut: boolean }>
}

/** The agent thread a bridge instance is bound to (one bridge per session). */
export interface AgentThreadContext {
  threadId: string
  /** Tab label; falls back to a shortened thread id. */
  title?: string
  /**
   * The root the thread's SESSION runs in — its own git worktree when it has
   * one (`sessionRootFor` in agent-manager answers this; never recompute the
   * path), else the project tree. The agent tab starts here so a command the
   * reader takes over lands in the checkout the agent has been writing to.
   */
  cwd?: string
  /** The project that OWNS the tab, when `cwd` is a worktree of it — the key
   *  terminal teardown filters on (see TerminalManager.ensureAgentTerminal). */
  projectRoot?: string
}

/** Hooks object ready to spread into SDK session `options.hooks`. */
export type BashMirrorHooks = {
  PreToolUse: HookCallbackMatcher[]
  PostToolUse: HookCallbackMatcher[]
}

// ── Formatting (Stark accent for the prompt, ANSI red for stderr) ────────

const ACCENT_PROMPT = '\x1b[38;2;116;173;232m$\x1b[0m'
const DIM_ON = '\x1b[2m'
const RED_ON = '\x1b[31m'
const STYLE_OFF = '\x1b[0m'

/** PTY-less text goes through LF→CRLF so xterm renders line starts correctly. */
function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

function formatCommandLine(command: string): string {
  return `\r\n${ACCENT_PROMPT} ${toCrlf(command)}\r\n`
}

// ── Tool input/response extraction (defensive: shapes are `unknown`) ─────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function extractCommand(toolInput: unknown): string | null {
  const input = asRecord(toolInput)
  return input && typeof input.command === 'string' ? input.command : null
}

interface BashResponseView {
  stdout: string
  stderr: string
  interrupted: boolean
}

/**
 * Bash `tool_response` per the ADR-001 spike: `{stdout, stderr, interrupted}`.
 * Falls back to a plain string or an MCP-style `{content: [{text}]}` so a
 * future SDK shape change degrades to "print what we got" instead of silence.
 */
function extractBashResponse(toolResponse: unknown): BashResponseView {
  if (typeof toolResponse === 'string') {
    return { stdout: toolResponse, stderr: '', interrupted: false }
  }
  const response = asRecord(toolResponse)
  if (!response) {
    return { stdout: '', stderr: '', interrupted: false }
  }
  if (typeof response.stdout === 'string' || typeof response.stderr === 'string') {
    return {
      stdout: typeof response.stdout === 'string' ? response.stdout : '',
      stderr: typeof response.stderr === 'string' ? response.stderr : '',
      interrupted: response.interrupted === true,
    }
  }
  if (Array.isArray(response.content)) {
    const text = response.content
      .map((block) => {
        const rec = asRecord(block)
        return rec && typeof rec.text === 'string' ? rec.text : ''
      })
      .join('')
    return { stdout: text, stderr: '', interrupted: false }
  }
  return { stdout: '', stderr: '', interrupted: false }
}

// ── 1. Hook mirroring (baseline) ─────────────────────────────────────────

/**
 * Build PreToolUse/PostToolUse hook callbacks that mirror agent Bash
 * activity into the thread's agent terminal tab. Spread the result into the
 * SDK session options: `hooks: { ...createBashMirrorHooks(tm, thread) }`.
 */
export function createBashMirrorHooks(
  terminals: BashBridgeTerminals,
  thread: AgentThreadContext,
): BashMirrorHooks {
  const openThreadTerminal = (): string =>
    terminals.ensureAgentTerminal({
      threadId: thread.threadId,
      title: thread.title,
      cwd: thread.cwd,
      projectRoot: thread.projectRoot,
    }).terminalId

  const preToolUse: HookCallback = (input) => {
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
      const command = extractCommand(input.tool_input)
      if (command !== null) {
        terminals.writeOutput(openThreadTerminal(), formatCommandLine(command))
      }
    }
    return Promise.resolve({})
  }

  const postToolUse: HookCallback = (input) => {
    if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash') {
      const { stdout, stderr, interrupted } = extractBashResponse(input.tool_response)
      const terminalId = openThreadTerminal()
      if (stdout.length > 0) {
        terminals.writeOutput(terminalId, ensureTrailingNewline(toCrlf(stdout)))
      }
      if (stderr.length > 0) {
        terminals.writeOutput(
          terminalId,
          `${RED_ON}${ensureTrailingNewline(toCrlf(stderr))}${STYLE_OFF}`,
        )
      }
      if (interrupted) {
        terminals.writeOutput(terminalId, `${DIM_ON}[interrupted]${STYLE_OFF}\r\n`)
      }
    }
    return Promise.resolve({})
  }

  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [preToolUse] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [postToolUse] }],
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\r\n') ? text : `${text}\r\n`
}

// ── 2. PTY executor (live-output routing option) ─────────────────────────

/** Mirrors the SDK Bash tool's input surface (timeout is milliseconds). */
export interface BashExecutorArgs {
  command: string
  timeout?: number
  description?: string
}

/**
 * Structural CallToolResult — assignable to the MCP SDK's shape without
 * importing `@modelcontextprotocol/sdk` (its exports map does not resolve
 * under this tsconfig's Node module resolution).
 */
export interface BashExecutorResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [key: string]: unknown
}

export type BashPtyExecutor = (
  args: BashExecutorArgs,
  extra: unknown,
) => Promise<BashExecutorResult>

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_TIMEOUT_MS = 600_000

/** ANSI CSI/OSC + carriage returns out; the model wants plain text. */
function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
}

/**
 * Build the `mcp__flow__bash`-compatible executor: runs the model's Bash
 * command in a real PTY attached to the thread's agent tab (output streams
 * into the tab live via TerminalManager.runCommand) and returns the
 * collected output to the model. Wire it as:
 *
 *   tool('bash', 'Run a shell command', { command: z.string(), ... },
 *        createBashPtyExecutor(terminalManager, thread))
 *   + toolAliases: { Bash: 'mcp__flow__bash' }
 */
export function createBashPtyExecutor(
  terminals: BashBridgeTerminals,
  thread: AgentThreadContext,
): BashPtyExecutor {
  return async (args) => {
    const { terminalId } = terminals.ensureAgentTerminal({
      threadId: thread.threadId,
      title: thread.title,
      cwd: thread.cwd,
      projectRoot: thread.projectRoot,
    })
    terminals.writeOutput(terminalId, formatCommandLine(args.command))

    const timeoutMs = Math.min(
      Math.max(1, args.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS),
      MAX_COMMAND_TIMEOUT_MS,
    )

    try {
      const result = await terminals.runCommand(terminalId, args.command, { timeoutMs })
      const text = stripAnsi(result.output)
      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text',
              text: `${text}\n[command timed out after ${timeoutMs}ms]`.trim(),
            },
          ],
          isError: true,
        }
      }
      if (result.exitCode !== 0) {
        return {
          content: [
            { type: 'text', text: `${text}\n[exit code ${result.exitCode}]`.trim() },
          ],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      terminals.writeOutput(terminalId, `${RED_ON}${toCrlf(message)}${STYLE_OFF}\r\n`)
      return {
        content: [{ type: 'text', text: `Failed to run command: ${message}` }],
        isError: true,
      }
    }
  }
}
