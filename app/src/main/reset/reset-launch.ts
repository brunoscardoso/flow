/**
 * THE APP SIDE OF RESET FLOW — the two moments it touches the running app.
 *
 *   scheduleReset   on confirm: record the request, then restart
 *   runPendingReset at launch, before anything opens the database or a
 *                   session: delete what was asked, record the outcome
 *
 * Electron and the bundled CLI are handed in by `index.ts`; this file decides
 * the order and owns nothing global.
 */
import { execFile } from 'node:child_process'

import type { ResetInventory, ResetItem } from '../../shared/reset-items'
import { openDatabase, type FlowDatabase } from '../store/db'
import { takePendingReset, writePendingReset, writeResetOutcome } from './pending-reset'
import { readResetInventory } from './reset-inventory'
import { resolveResetRoots, type ResetRoots } from './reset-roots'
import { buildResetSteps, type ResetSession } from './reset-steps'
import { runReset } from './run-reset'

export interface ResetLaunchDeps {
  env: NodeJS.ProcessEnv
  userData: string
  databasePath: string
  appSession: () => ResetSession
  browserSession: () => ResetSession
  /** Run the bundled CLI's uninstall in one project. */
  uninstallProject: (root: string) => Promise<void>
  log: (line: string) => void
}

/** Read-only git, bounded, never interactive. */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    )
  })
}

function rootsOrThrow(deps: { env: NodeJS.ProcessEnv; userData: string }): ResetRoots {
  const roots = resolveResetRoots({ env: deps.env, userData: deps.userData })
  if (roots === null) throw new Error('This test run has no isolated Flow folder, so a reset is refused.')
  return roots
}

export function readInventory(deps: { env: NodeJS.ProcessEnv; userData: string; db: FlowDatabase }): Promise<ResetInventory> {
  const roots = rootsOrThrow(deps)
  return readResetInventory({ ...roots, db: deps.db, git: runGit })
}

/** Record the request; the caller restarts the app. */
export function scheduleReset(deps: { env: NodeJS.ProcessEnv; userData: string }, items: ResetItem[]): void {
  rootsOrThrow(deps)
  writePendingReset(deps.userData, items, new Date())
}

/**
 * Perform a pending reset, if there is one. Never throws: a launch must go on
 * whatever the reset did, and what failed is written to the outcome for
 * Settings to report.
 */
export async function runPendingReset(deps: ResetLaunchDeps): Promise<void> {
  let items: ResetItem[] | null
  try {
    items = takePendingReset(deps.userData)
  } catch (error) {
    deps.log(`[reset] could not read the pending reset: ${String(error)}`)
    return
  }
  if (items === null) return
  const roots = resolveResetRoots({ env: deps.env, userData: deps.userData })
  if (roots === null) {
    deps.log('[reset] refused: no isolated Flow folder in a test run')
    return
  }
  let db: FlowDatabase | null = null
  try {
    db = openDatabase(deps.databasePath)
    const steps = buildResetSteps({
      ...roots,
      db,
      appSession: deps.appSession(),
      browserSession: deps.browserSession(),
      uninstallProject: deps.uninstallProject,
    })
    const outcome = await runReset({ items, steps, confirmed: true, now: () => new Date(), log: deps.log })
    writeResetOutcome(deps.userData, outcome)
  } catch (error) {
    deps.log(`[reset] failed: ${error instanceof Error ? error.message : String(error)}`)
    writeResetOutcome(deps.userData, {
      at: new Date().toISOString(),
      done: [],
      failed: items.map((item) => ({ item, detail: 'The reset could not start.' })),
    })
  } finally {
    db?.close()
  }
}
