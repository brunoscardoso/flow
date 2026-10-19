// user-cli-shim — repairs a stale `~/.local/bin/planflow-ai` at app start.
//
// `planflow-ai init` (its PATH rails) can write a shim into the user's
// `~/.local/bin` that names the CLI entry it was run from. After an app update
// — or once the checkout or scratch build it named is deleted — that entry is
// gone, while `which planflow-ai` still finds the FILE, so every terminal and
// heartbeat invocation fails with MODULE_NOT_FOUND (tasklist BUG 2026-10-05).
// Provisioning skips current projects and refreshes drifted ones with
// `init --refresh-owned`, which never runs the PATH rails, so nothing ever
// noticed.
//
// ONE WRITER (allowed-pattern #14): the shim is written only by the CLI
// (`repairPlanflowShim` in src/cli/commands/path-rails.ts). This module is a
// cheap read-only GATE — one small file read, async, off the window's path —
// that spawns `planflow-ai path repair` only when the shim plan-flow wrote
// names an entry that no longer exists. The CLI decides again, under its own
// rules: it never creates a shim, never touches a file without plan-flow's
// marker, and leaves a correct shim (and its mtime) alone.
//
// The marker and target parsing duplicate src/cli/utils/platform-shim.ts on
// purpose — the app and the CLI are separate bundles (see platform/shim.ts).

import { access, readFile } from 'fs/promises'
import { join } from 'path'

import { shimFileName } from '../platform/shim'

/** The sentence every shim plan-flow's `init` writes carries (POSIX: em dash; Windows: hyphen). */
const PLANFLOW_SHIM_MARKER = /planflow-ai shim [—-] written by plan-flow's/

/** The CLI verb that repairs the shim — the only writer. */
export const REPAIR_ARGS = ['path', 'repair', '--json'] as const

/** Where `init`'s PATH rails put the shim, for a home directory. */
export function userShimPath(homeDir: string, platform: NodeJS.Platform | string): string {
  return join(homeDir, '.local', 'bin', shimFileName(platform))
}

/**
 * The entry a plan-flow-written shim runs, or null when the content is not a
 * plan-flow shim (a user's own file) or names no entry.
 */
export function planflowShimTarget(content: string): string | null {
  if (!PLANFLOW_SHIM_MARKER.test(content)) return null
  const match = /^(?:exec )?node "([^"]+)"/m.exec(content)
  return match === null ? null : match[1]
}

export interface UserShimRepairDeps {
  homeDir: string
  platform?: NodeJS.Platform | string
  /** Run the bundled CLI with these args (the app's one CLI spawn path). */
  runCli: (args: readonly string[]) => Promise<{ ok: boolean; error?: string }>
  readText?: (path: string) => Promise<string | null>
  exists?: (path: string) => Promise<boolean>
  log?: (line: string) => void
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    // Sanctioned fallback: no shim (or an unreadable one) is nothing to repair.
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Sanctioned fallback: an inaccessible target is a missing one.
    return false
  }
}

export type UserShimRepairOutcome = 'no-shim' | 'not-ours' | 'healthy' | 'repaired' | 'repair-failed'

/**
 * Check the user's shim and, only when plan-flow wrote it and its target is
 * gone, ask the CLI to repair it. Never throws.
 */
export async function repairStaleUserCliShim(deps: UserShimRepairDeps): Promise<UserShimRepairOutcome> {
  const platform = deps.platform ?? process.platform
  const readText = deps.readText ?? readTextOrNull
  const exists = deps.exists ?? pathExists
  const log = deps.log ?? ((line: string) => console.log(line))
  try {
    const shimPath = userShimPath(deps.homeDir, platform)
    const content = await readText(shimPath)
    if (content === null) return 'no-shim'
    if (!PLANFLOW_SHIM_MARKER.test(content)) return 'not-ours'
    const target = planflowShimTarget(content)
    if (target !== null && (await exists(target))) return 'healthy'
    const result = await deps.runCli(REPAIR_ARGS)
    if (!result.ok) {
      log(`[cli-shim] could not repair the stale planflow-ai shim at ${shimPath}: ${result.error ?? 'failed'}`)
      return 'repair-failed'
    }
    log(`[cli-shim] repaired the stale planflow-ai shim at ${shimPath} (it named ${target ?? 'nothing readable'})`)
    return 'repaired'
  } catch (error) {
    log(`[cli-shim] stale-shim check failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'repair-failed'
  }
}
