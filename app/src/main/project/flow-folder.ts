// THE FLOW FOLDER, resolved by the same rule the CLI uses (src/cli/utils/files.ts
// `resolveFlowFolder` / `getVaultDir`). The app mirrors that rule rather than
// inventing one: when the two disagreed, the app would trust a different folder
// than the one every verb writes into.
//
//   1. `PLAN_FLOW_HOME` — the Flow folder itself.
//   2. `PLAN_FLOW_VAULT_DIR` — the vault's parent when it is the conventional
//      `…/brain`, otherwise the vault folder itself.
//   3. `~/plan-flow`.
//
// The vault is `PLAN_FLOW_VAULT_DIR`, else `<Flow folder>/brain`.

import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'

const FLOW_FOLDER_NAME = 'plan-flow'
const VAULT_FOLDER_NAME = 'brain'
const WORKSPACES_FOLDER_NAME = 'workspaces'

/** The Flow folder — parent of `workspaces/`, `settings/` and (by default) the vault. */
export function resolveFlowFolder(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const flowHome = env.PLAN_FLOW_HOME
  if (flowHome !== undefined && flowHome.trim() !== '') return resolve(flowHome)
  const vault = env.PLAN_FLOW_VAULT_DIR
  if (vault !== undefined && vault.trim() !== '') {
    const resolvedVault = resolve(vault)
    return basename(resolvedVault) === VAULT_FOLDER_NAME ? dirname(resolvedVault) : resolvedVault
  }
  return join(home, FLOW_FOLDER_NAME)
}

/** The vault — `PLAN_FLOW_VAULT_DIR`, else `<Flow folder>/brain`. */
export function resolveVaultDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const vault = env.PLAN_FLOW_VAULT_DIR
  if (vault !== undefined && vault.trim() !== '') return resolve(vault)
  return join(resolveFlowFolder(env, home), VAULT_FOLDER_NAME)
}

/** `<Flow folder>/workspaces` — where every Workspace's project folders live. */
export function resolveWorkspacesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveFlowFolder(env, home), WORKSPACES_FOLDER_NAME)
}

/**
 * Where a project's `flow` link may legitimately land: `<Flow folder>/workspaces`
 * (every project's knowledge since the hard migration) and the vault (where
 * links pointed before it). THE ONE ANSWER for every guard that trusts a
 * `flow` link — the file reader and writers (paths.ts), the agent sandboxes
 * (flow-link-roots.ts) — so a link the migration made is never trusted by one
 * surface and refused by another. A link is honoured only when its real
 * target sits STRICTLY inside one of these.
 */
/** `[workspaces, vault]` — in that order. */
export function trustedFlowLinkBases(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): [string, string] {
  return [resolveWorkspacesDir(env, home), resolveVaultDir(env, home)]
}
