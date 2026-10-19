// The concrete runners the thread-worktree service is built with.
//
// Kept out of `thread-worktree.ts` so that module stays a pure decision layer
// with injected collaborators: its whole test suite runs without a repository,
// a git binary, or a spawned process.
//
// ASYNC, ALWAYS. The main process answers every IPC call, so a synchronous
// child here would stall every window, every click and every keystroke — not
// only the caller's (allowed-pattern #19). There is exactly zero `execSync` in
// main and this file does not become the first.

import { execFile } from 'child_process'

import type { RunResult } from './thread-worktree'

/** Longest any single git call may take before it is a failure. Generous —
 *  `status` on a large repo is the slow one, and a false failure here costs a
 *  worktree nobody asked to lose. */
const GIT_TIMEOUT_MS = 30_000

/** Output cap; a porcelain status on a huge tree is the largest thing read. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** Longest a `gh` call may take — a network round trip, and still bounded. */
const GH_TIMEOUT_MS = 60_000

/**
 * Run `git` in `cwd`, capturing stdout. Never rejects: a failed call is a
 * result with `ok: false`, because every caller here has a fallback that is
 * better than an exception (start clean, stay detached, count nothing).
 *
 * argv-only — no shell — so nothing in a branch name or a path can be read as
 * a command.
 */
export function runGitCapturing(
  cwd: string,
  args: readonly string[],
  options: RunLimits = {},
): Promise<RunResult> {
  return runCapturing('git', cwd, args, options.timeoutMs ?? GIT_TIMEOUT_MS, options.signal)
}

/**
 * Run a project's own worktree setup command in `cwd`.
 *
 * THROUGH A SHELL, and that is a deliberate departure from every other runner
 * in this file — all of which are argv-only precisely so nothing in a branch
 * name or a path can be read as a command. Here the string IS a command: a
 * project writes `npm ci && npm run generate` or `./scripts/setup.sh`, and
 * splitting that on whitespace would hand `&&` to `npm` as an argument and run
 * something nobody asked for. Flow runs this string; it does not read it.
 *
 * WHAT THAT COSTS, said out loud: this executes a value from a repository's own
 * `flow/.flowconfig`, automatically, on the first message of a new thread. Every
 * other project-defined command in this app (`commands.lint`) runs only on a
 * path a person triggered. Opening an untrusted repository and sending one
 * message is therefore enough to run its setup command — which is exactly what
 * the feature is for, and worth knowing before pointing Flow at a stranger's
 * code.
 *
 * Bounded by the caller's ceiling, never rejects, and its output is capped:
 * an install prints megabytes and none of it is worth a window's memory.
 */
export function runSetupCapturing(
  cwd: string,
  command: string,
  options: RunLimits = {},
): Promise<RunResult> {
  const shell = process.platform === 'win32' ? 'cmd' : 'sh'
  const flag = process.platform === 'win32' ? '/c' : '-c'
  return runCapturing(
    shell,
    cwd,
    [flag, command],
    options.timeoutMs ?? SETUP_TIMEOUT_MS,
    options.signal,
  )
}

/** Fallback ceiling, only used when no caller supplies one. The resolver's
 *  clamped setting is what actually decides; this exists so the runner is not
 *  unbounded if someone calls it bare. */
const SETUP_TIMEOUT_MS = 10 * 60_000

/**
 * A caller's own ceiling for one call.
 *
 * ONLY THE CALLER KNOWS WHAT IS AT STAKE. The default here is sized for a
 * `status` on a large repository, where a false failure costs a worktree
 * nobody asked to lose. A network fetch before a cut is the opposite trade —
 * the cut can go ahead without it — so it brings a much shorter ceiling and a
 * signal a person can trip by deciding not to wait.
 */
export interface RunLimits {
  timeoutMs?: number
  /** Kills the child when it aborts. The result is a failure, like a timeout. */
  signal?: AbortSignal
}

/**
 * Run `gh` in `cwd` — the same shape, for the pull-request half of a landing
 * (Phase 7, task 7.2). Never rejects: a `gh` that is missing, unauthenticated
 * or refused by a protected branch is a result the landing turns into one
 * sentence, not an exception thrown into the IPC layer.
 *
 * `gh` is slower than git by a network round trip, so it gets its own, longer
 * ceiling — but it still HAS one: a landing that hangs forever is worse than a
 * landing that says it could not reach GitHub.
 */
export function runGhCapturing(cwd: string, args: readonly string[]): Promise<RunResult> {
  return runCapturing('gh', cwd, args, GH_TIMEOUT_MS)
}

/**
 * Measure a directory — `du`, in the same async, bounded, argv-only shape.
 *
 * A SIZE IS ORIENTATION, NEVER A GATE. Its own short ceiling, because a walk of
 * a very large working tree is the one call here that can genuinely take a
 * while, and a management list must open whether or not the number arrives.
 * A timeout comes back `ok: false`, which the inventory reads as "unknown" and
 * the surface prints as nothing at all.
 */
export function runDuCapturing(cwd: string, args: readonly string[]): Promise<RunResult> {
  return runCapturing('du', cwd, args, DU_TIMEOUT_MS)
}

/** Longest a single directory measurement may take. */
const DU_TIMEOUT_MS = 10_000

function runCapturing(
  file: string,
  cwd: string,
  args: readonly string[],
  timeout = GIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        resolve(
          error
            ? { ok: false, stdout: String(stdout), stderr: String(stderr), error: error.message }
            : { ok: true, stdout: String(stdout), stderr: String(stderr) },
        )
      },
    )
  })
}
