// Post-merge verification + culprit pinning (#66; Phase 7).
//
// After conflict resolutions are applied, the project's own verification is
// run (typecheck / test / build / lint). Command RESOLUTION and failure
// PARSING are pure and fully unit-testable with plain objects; the runner is a
// thin `execFile` wrapper with the exec injectable so tests never spawn a real
// process. No Electron imports — this module stays plain-Node loadable so it
// unit-tests cleanly (mirroring git-manager.ts).
//
// Priority for each verification kind (deterministic order — typecheck → test
// → build → lint):
//   1. flowconfig `commands.<kind>` (a full command string, e.g. `npx tsc
//      --noEmit`) — parsed into argv, never run through a shell.
//   2. else a matching `package.json` script → run via the package manager
//      (`npm run <kind>`), never the raw script body.
//   3. else the kind is skipped.
// No sources at all → an empty command list; runVerify then reports
// `{ ok: true, ran: [] }` and the caller decides how to notice the skip.

import { execFile } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

/** One resolved verification step, already split into argv (never a shell string). */
export interface VerifyCommand {
  name: string
  command: string
  args: string[]
}

/**
 * The outcome of running an ordered list of verify commands. `ran` lists the
 * step names that executed, in order; on failure the run stops at the first
 * failing step and records it in `firstFailure`.
 */
export interface VerifyResult {
  ok: boolean
  ran: string[]
  firstFailure?: { name: string; output: string }
}

/**
 * verifyMerge's result — a VerifyResult plus the best-effort likely culprit
 * (pinCulprit over the changed files), present only when a step failed. This is
 * the shape the `git:verifyMerge` IPC returns.
 */
export interface VerifyMergeResult extends VerifyResult {
  culprit?: string | null
}

/** A captured process outcome — `code` is the exit status (0 == success). */
export interface ExecOutcome {
  code: number
  stdout: string
  stderr: string
}

/** Injectable exec used by runVerify; the default spawns via `execFile`. */
export type VerifyExec = (command: string, args: string[], cwd: string) => Promise<ExecOutcome>

/**
 * The verification kinds we recognise, in the deterministic order they run:
 * the cheap structural check first (typecheck), then tests, then the full
 * build, then lint. Same inputs always produce the same ordered list.
 */
const VERIFY_KIND_ORDER = ['typecheck', 'test', 'build', 'lint'] as const

/** flowconfig command keys are dotted, e.g. `commands.typecheck`. */
const FLOWCONFIG_COMMAND_PREFIX = 'commands.'
/** The `.flowconfig` file lives under each root's `flow/` directory. */
const FLOWCONFIG_RELATIVE_PATH = join('flow', '.flowconfig')
/** package.json scripts run through the package manager, never the raw body. */
const PACKAGE_MANAGER_COMMAND = 'npm'
/** How many trailing characters of a failing step's output are kept. */
const OUTPUT_TAIL_CHARS = 4000
/** Generous buffer before a verbose tool's output overflows execFile. */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024
/** execFile's `error.code` is the exit status for a process that ran and failed. */
const DEFAULT_FAILURE_CODE = 1

interface ExecError extends Error {
  code?: number | string
}

/**
 * Split a command STRING into an argv pair WITHOUT a shell. Tokens are
 * whitespace-separated; shell quoting is intentionally NOT honoured —
 * flowconfig commands are plain `npx tsc --noEmit` style strings. Returns null
 * when the string is empty/blank.
 */
export function parseCommandString(raw: string): { command: string; args: string[] } | null {
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  const [command, ...args] = tokens
  return { command, args }
}

/**
 * Resolve the ordered verify commands from a flowconfig map plus package.json
 * scripts. PURE — no I/O, fully unit-testable with plain objects. See the
 * module header for the per-kind priority; the result is deterministic.
 */
export function resolveVerifyCommands(
  flowconfig: Record<string, string>,
  packageScripts: Record<string, string>,
): VerifyCommand[] {
  const commands: VerifyCommand[] = []
  for (const kind of VERIFY_KIND_ORDER) {
    const configured = flowconfig[`${FLOWCONFIG_COMMAND_PREFIX}${kind}`]
    if (typeof configured === 'string' && configured.trim().length > 0) {
      const parsed = parseCommandString(configured)
      if (parsed) {
        commands.push({ name: kind, command: parsed.command, args: parsed.args })
        continue
      }
    }
    const script = packageScripts[kind]
    if (typeof script === 'string' && script.trim().length > 0) {
      commands.push({ name: kind, command: PACKAGE_MANAGER_COMMAND, args: ['run', kind] })
    }
  }
  return commands
}

/**
 * Run each verify command in order (cwd = rootPath), stopping at the FIRST
 * non-zero exit and capturing a trimmed tail of its combined output. An empty
 * command list is a no-op success (`{ ok: true, ran: [] }`) — the skip-with-
 * notice decision belongs to the caller. `execImpl` is injectable for tests.
 */
export async function runVerify(
  rootPath: string,
  commands: VerifyCommand[],
  execImpl: VerifyExec = defaultExec,
): Promise<VerifyResult> {
  const ran: string[] = []
  for (const command of commands) {
    ran.push(command.name)
    const outcome = await execImpl(command.command, command.args, rootPath)
    if (outcome.code !== 0) {
      return {
        ok: false,
        ran,
        firstFailure: { name: command.name, output: tailOutput(combineStreams(outcome)) },
      }
    }
  }
  return { ok: true, ran }
}

/**
 * Best-effort "likely culprit": the FIRST changed file that appears in the
 * failure output (by full path, or by basename as a fallback for tools that
 * print relative paths). PURE — returns null when nothing matches.
 */
export function pinCulprit(failureOutput: string, changedFiles: string[]): string | null {
  for (const file of changedFiles) {
    if (!file) continue
    if (failureOutput.includes(file)) return file
    const basename = file.split('/').pop()
    if (basename && basename !== file && failureOutput.includes(basename)) return file
  }
  return null
}

// ── Main-side orchestrator (reads config, then runs) ──────────────────────

/** Injectable I/O for verifyMerge — both readers and the exec are overridable. */
export interface VerifyMergeDeps {
  /** Read a file's text, or null when it does not exist. */
  readFile?: (filePath: string) => Promise<string | null>
  /** The process runner passed through to runVerify. */
  exec?: VerifyExec
}

/**
 * Resolve the root's verify commands from its `flow/.flowconfig` and
 * `package.json`, run them, and (on failure) pin the likely culprit among
 * `changedFiles`. This is the main-side entry the `git:verifyMerge` IPC handler
 * calls; readers + exec are injectable so it is unit-testable without a real
 * repo. A root with no configured commands resolves to `{ ok: true, ran: [] }`.
 */
export async function verifyMerge(
  rootPath: string,
  changedFiles: string[] = [],
  deps: VerifyMergeDeps = {},
): Promise<VerifyMergeResult> {
  const readFile = deps.readFile ?? readTextOrNull
  const [flowconfigText, packageJsonText] = await Promise.all([
    readFile(join(rootPath, FLOWCONFIG_RELATIVE_PATH)),
    readFile(join(rootPath, 'package.json')),
  ])
  const flowconfig = flowconfigText ? parseFlowconfigLines(flowconfigText) : {}
  const packageScripts = packageJsonText ? readPackageScripts(packageJsonText) : {}
  const commands = resolveVerifyCommands(flowconfig, packageScripts)
  const result = await runVerify(rootPath, commands, deps.exec)
  if (!result.ok && result.firstFailure) {
    return { ...result, culprit: pinCulprit(result.firstFailure.output, changedFiles) }
  }
  return result
}

/**
 * Parse `.flowconfig`'s `key: value` lines (comments and blanks skipped).
 * Kept local so this module carries no dependency on the flow domain — the
 * grammar mirrors flow-observer's parseFlowconfigText.
 */
export function parseFlowconfigLines(content: string): Record<string, string> {
  const config: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z0-9_.-]+):[ \t]*(.*)$/)
    if (match) config[match[1]] = match[2].trim()
  }
  return config
}

/** Extract the string-valued `scripts` map from package.json text (fail-soft). */
export function readPackageScripts(packageJsonText: string): Record<string, string> {
  try {
    const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> }
    const scripts = parsed.scripts
    if (!scripts || typeof scripts !== 'object') return {}
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') result[name] = value
    }
    return result
  } catch {
    // A malformed package.json contributes no scripts, never a thrown error —
    // verification is a fail-soft gate, not a hard blocker.
    return {}
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

/** The default runner: spawn via execFile, mapping the exit status into `code`. */
const defaultExec: VerifyExec = (command, args, cwd) =>
  new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolvePromise({
          code: exitCodeFrom(error),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        })
      },
    )
  })

/**
 * The exit status from an execFile callback: the numeric `error.code` when the
 * process ran and failed; DEFAULT_FAILURE_CODE for a spawn failure (e.g. ENOENT
 * — a missing tool is a failed verification, which safely escalates to review);
 * 0 on success.
 */
function exitCodeFrom(error: unknown): number {
  if (!error) return 0
  const code = (error as ExecError).code
  return typeof code === 'number' ? code : DEFAULT_FAILURE_CODE
}

/**
 * Combine stdout+stderr — this repo's tools (tsc, jest) split diagnostics
 * across both streams, so the combined transcript is what the user sees
 * (mirrors allowed-pattern #15).
 */
function combineStreams(outcome: ExecOutcome): string {
  return `${outcome.stdout}\n${outcome.stderr}`.trim()
}

/** Keep only the trailing OUTPUT_TAIL_CHARS characters (the actionable end). */
function tailOutput(output: string): string {
  return output.length > OUTPUT_TAIL_CHARS ? output.slice(output.length - OUTPUT_TAIL_CHARS) : output
}

/** Read a file's UTF-8 text, or null when it (or a parent) does not exist. */
async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}
