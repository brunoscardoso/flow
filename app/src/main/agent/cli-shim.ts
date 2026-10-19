// cli-shim — puts a `planflow-ai` wrapper script on the PATH of every
// IDE-launched agent session, so skills that shell out to
// `planflow-ai <verb>` work in ANY project, including ones with no local npm
// install of the CLI. Without this, an agent session's PATH never contains
// the app-bundled CLI (resolveBundledCli in ../index.ts) — only the
// blueprint derive runner knew how to find it.
//
// The wrapper execs the bundled planflow-ai.mjs through the SAME Electron
// binary the app itself runs on, in ELECTRON_RUN_AS_NODE mode (mirrors
// derive-runner.ts's bundled candidate) — no system Node, no npm, no PATH
// dependency of its own.
//
// Regeneration is content-gated: the script embeds a version comment, so a
// rewrite only happens when execPath/bundlePath/version actually changed (or
// the file is missing/corrupted) — bootstrap doesn't touch disk on every
// launch, and bumping the CLI bundle version self-heals every user's shim.
//
// WHAT IS PLATFORM-SPECIFIC LIVES IN ../platform (B1/B2): the shim's file name,
// its script body, whether an exec bit means anything (platform/shim.ts), and
// how PATH is spelled and joined (platform/env.ts). This module is the WRITER —
// it decides where the file goes and when to rewrite it, and asks those pure
// functions what to write. On Windows the two POSIX assumptions it used to make
// both failed SILENTLY: an extensionless `#!/bin/sh` file matches nothing in
// `PATHEXT`, and a `:`-joined PATH fuses the whole system PATH into one
// unusable entry.
//
// Fail-soft: this must never throw or block app bootstrap. Any fs error
// (read-only userData volume, permission denied, …) is logged once and
// resolves to null — sessions simply fall back to whatever PATH they'd have
// had otherwise.

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { extname, join } from 'path'

import { joinPath, pathEnvKey } from '../platform/env'
import { buildShimScript, shimExecMode, shimFileName } from '../platform/shim'

/** Subdirectory of userData the shim lives in — kept off PATH by default so
 *  only sessions that opt in (via withShimPath) see it. */
const SHIM_DIR_NAME = 'bin'

/** The bundled CLI entry inside `bundlePath` that the shim execs. */
const CLI_ENTRY_FILE_NAME = 'planflow-ai.mjs'

/** Windows' own default when the env carries no PATHEXT — the set cmd.exe and
 *  PowerShell fall back to. `.CMD` is always in it, so the shim we write is
 *  resolvable on a stock machine; the check below exists for the machine whose
 *  PATHEXT has been narrowed. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC'

/**
 * Why the shim we just wrote would NOT resolve as a command, or null when it
 * will. This is the NFR5 guard: a shim that exists but cannot be invoked is the
 * exact failure Windows produced silently — the session started, the PATH
 * looked right, and every `planflow-ai` verb was simply missing.
 *
 * The question is platform-shaped, so the answer is too:
 *  - win32 asks whether the file's extension is in `PATHEXT`. `accessSync(X_OK)`
 *    is useless there — Node documents X_OK as having no meaning on Windows and
 *    it succeeds for any existing file, so trusting it would be the same class
 *    of lie as chmod-on-Windows.
 *  - POSIX asks the kernel, via `X_OK`, whether the exec bit actually took.
 *
 * `pathext` is a parameter (not a `process.env` read) so both branches are
 * assertable off-platform (NFR3).
 */
export function shimResolutionProblem(
  shimPath: string,
  platform: NodeJS.Platform | string,
  pathext: string | undefined = process.env['PATHEXT'],
): string | null {
  if (!existsSync(shimPath)) {
    return 'the file does not exist after the write'
  }
  if (platform === 'win32') {
    const extension = extname(shimPath).toLowerCase()
    const known = (pathext ?? DEFAULT_PATHEXT)
      .split(';')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
    if (known.includes(extension)) {
      return null
    }
    return `its extension (${extension === '' ? 'none' : extension}) is not in PATHEXT — Windows will not resolve the command`
  }
  try {
    accessSync(shimPath, fsConstants.X_OK)
    return null
  } catch {
    return 'the file is not executable'
  }
}

/**
 * Ensures `<userDataDir>/bin/<platform shim name>` exists and matches what we'd
 * write for the given (execPath, bundlePath, version) — writing/rewriting it
 * only when the content would actually change. Returns the shim's directory
 * (for PATH injection via withShimPath) on success, or null if anything about
 * the write failed. Never throws.
 *
 * `platform` is injectable so both branches are testable from either host
 * (NFR3); production callers take the default.
 */
export function ensureCliShim(
  userDataDir: string,
  bundlePath: string,
  execPath: string,
  version: string,
  platform: NodeJS.Platform | string = process.platform,
): string | null {
  try {
    const shimDir = join(userDataDir, SHIM_DIR_NAME)
    const shimPath = join(shimDir, shimFileName(platform))
    const cliPath = join(bundlePath, CLI_ENTRY_FILE_NAME)
    const content = buildShimScript(platform, execPath, cliPath, version)

    const existing = existsSync(shimPath) ? readFileSync(shimPath, 'utf8') : null
    if (existing !== content) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, content, 'utf8')
    }
    // Idempotent — cheap to re-assert every bootstrap in case something else
    // (an editor save, a backup restore) stripped the exec bit. A null mode
    // means chmod is MEANINGLESS on this platform (Windows), so we skip it
    // rather than call a no-op and believe it protected something.
    const execMode = shimExecMode(platform)
    if (execMode !== null) {
      chmodSync(shimPath, execMode)
    }

    // NFR5 — name the failure instead of degrading into a missing capability.
    // We still hand back shimDir: the PATH entry is harmless, the shim may yet
    // be invokable in ways this check cannot see, and swallowing it into a
    // null return would put us right back to a silent absence.
    const problem = shimResolutionProblem(shimPath, platform)
    if (problem !== null) {
      console.error(
        `[cli-shim] The planflow-ai shim at ${shimPath} will NOT resolve as a command: ${problem}. ` +
          'Agent sessions will start, but every `planflow-ai` verb will fail with a command-not-found error.',
      )
    }
    return shimDir
  } catch (error) {
    console.error('[cli-shim] Failed to ensure planflow-ai shim:', error)
    return null
  }
}

/**
 * Prepends `shimDir` to `env`'s PATH, returning a NEW env object (never
 * mutates the input — callers pass both live account-scoped envs and
 * process.env itself). A missing/empty existing PATH degrades to just
 * shimDir rather than a leading/trailing separator.
 *
 * Both halves of "PATH" are platform decisions (B1): the delimiter (`;` vs `:`)
 * and the KEY. Windows env keys are case-insensitive but `process.env` surfaces
 * them with their real casing (usually `Path`), and an object spread is
 * case-SENSITIVE — writing a literal `PATH` onto an env that already has `Path`
 * produces BOTH keys and leaves it to the spawn implementation which one wins.
 * `pathEnvKey` resolves the env's own key so the spread overwrites it in place.
 *
 * An env carrying BOTH `Path` and `PATH` already lost that argument (review F4):
 * overwriting one leaves the other stale, and which the child reads is undefined
 * — the very bug this function exists to prevent. Node's Windows `process.env`
 * is case-insensitive so it cannot produce that shape, but a hand-merged env
 * can, so the duplicates are collapsed rather than trusted not to occur.
 */
export function withShimPath(
  env: NodeJS.ProcessEnv,
  shimDir: string,
  platform: NodeJS.Platform | string = process.platform,
): NodeJS.ProcessEnv {
  const key = pathEnvKey(env, platform)
  const next: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    // Drop every PATH-like key; the canonical one is written back below.
    if (platform === 'win32' && name.toUpperCase() === 'PATH' && name !== key) continue
    next[name] = value
  }
  next[key] = joinPath(platform, shimDir, env[key])
  return next
}
