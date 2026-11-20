/**
 * THE FOLDERS A RESET MAY DELETE IN — decided in one place.
 *
 * A hidden e2e run shares the developer's real home folder, so it must never
 * resolve to the real Flow folder or the real `~/.flow`. Under `FLOW_E2E=1`
 * the Flow folder must be named by `PLAN_FLOW_HOME` (the fixture always sets
 * it) and Flow's home folder moves inside the run's own app data; without
 * `PLAN_FLOW_HOME` the answer is null and no reset runs.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveFlowFolder, resolveVaultDir } from '../project/flow-folder'

export interface ResetRoots {
  userData: string
  flowFolder: string
  vaultDir: string
  flowHome: string
}

export function resolveResetRoots(input: {
  env: NodeJS.ProcessEnv
  userData: string
  home?: string
}): ResetRoots | null {
  const home = input.home ?? homedir()
  const e2e = input.env['FLOW_E2E'] === '1'
  if (e2e) {
    const flowHome = input.env['PLAN_FLOW_HOME']
    if (flowHome === undefined || flowHome.trim() === '') return null
    // The vault follows PLAN_FLOW_HOME only — a developer's own vault variable
    // is ignored inside a test run.
    const isolated = { PLAN_FLOW_HOME: flowHome }
    return {
      userData: input.userData,
      flowFolder: resolveFlowFolder(isolated, home),
      vaultDir: resolveVaultDir(isolated, home),
      flowHome: join(input.userData, 'e2e-flow-home'),
    }
  }
  return {
    userData: input.userData,
    flowFolder: resolveFlowFolder(input.env, home),
    vaultDir: resolveVaultDir(input.env, home),
    flowHome: join(home, '.flow'),
  }
}
