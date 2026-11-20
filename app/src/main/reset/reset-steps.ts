/**
 * WHAT EACH RESET ITEM DELETES — one step per item, built from an explicit
 * environment.
 *
 * Every root is REQUIRED (forbidden-pattern #15): the app data folder, the
 * Flow folder (~/plan-flow), Flow's home folder (~/.flow), the database, the
 * two sessions and the per-project uninstall. A test hands in temp folders and
 * fakes; nothing here can fall back to the real ones.
 *
 * THE LINES THIS FILE HOLDS:
 *   - Each item owns its rows. App settings deletes every app setting EXCEPT
 *     the keys another item owns, so an unticked item keeps its own.
 *   - Only what Flow created is removed. An agent account's sign-in folder is
 *     deleted only when it is inside Flow's accounts folder; connectors are
 *     edited only in those folders; the terminal's own Claude Code, Copilot and
 *     Codex sign-ins are never touched.
 *   - Workspace knowledge is deleted on this computer only. Nothing is pushed,
 *     so a team's copy is untouched.
 *   - The project list is read BEFORE any step runs, so removing the Flow
 *     files from projects still knows the projects after the list is gone.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { FlowDatabase } from '../store/db'
import { PROJECTS_TABLE, PROJECT_STATE_TABLE } from '../store/storage-names'
import type { ResetSteps } from './run-reset'

/** The slice of an Electron session a reset uses. */
export interface ResetSession {
  clearStorageData(options?: { storages?: string[] }): Promise<void>
  clearCache(): Promise<void>
}

export interface ResetEnvironment {
  /** The app's data folder (holds the database, attachments, logs). */
  userData: string
  /** The Flow folder: settings, Workspaces and the project list. */
  flowFolder: string
  /** The vault: the personal brain, and the older per-project knowledge in `projects/`. */
  vaultDir: string
  /** Flow's home folder: the accounts it signed in and the integration credentials. */
  flowHome: string
  db: FlowDatabase
  /** The app's own session (its local storage and caches). */
  appSession: ResetSession
  /** The built-in browser's session. */
  browserSession: ResetSession
  /** Remove the Flow files from one project. Rejects with a sentence on failure. */
  uninstallProject: (root: string) => Promise<void>
}

/** Keys owned by an item other than App settings. */
export const OWNED_SETTING_KEYS: Record<string, { prefixes: string[]; exact: string[] }> = {
  'file-defaults': { prefixes: ['worktree.', 'workspace.'], exact: [] },
  launchpad: { prefixes: ['run_setup:', 'run_tweaks:', 'run_usage:'], exact: ['run_order'] },
  connectors: { prefixes: ['connector_ask_first:', 'connector_suggestions_dismissed:'], exact: [] },
  integrations: { prefixes: ['issue_list_config_'], exact: [] },
  'agent-accounts': { prefixes: [], exact: ['default_account_id'] },
  'workspace-knowledge': { prefixes: ['knowledge_last_synced'], exact: [] },
}

export function settingOwner(key: string): string | null {
  for (const [item, owned] of Object.entries(OWNED_SETTING_KEYS)) {
    if (owned.exact.includes(key)) return item
    if (owned.prefixes.some((prefix) => key.startsWith(prefix))) return item
  }
  return null
}

export function settingKeys(db: FlowDatabase): string[] {
  return (db.prepare('SELECT key FROM app_settings').all() as Array<{ key: string }>).map((row) => row.key)
}

function deleteSettings(db: FlowDatabase, keys: readonly string[]): void {
  const stmt = db.prepare('DELETE FROM app_settings WHERE key = ?')
  db.transaction(() => {
    for (const key of keys) stmt.run(key)
  })()
}

function deleteOwnedSettings(db: FlowDatabase, item: string): void {
  deleteSettings(db, settingKeys(db).filter((key) => settingOwner(key) === item))
}

/** True when `path` is inside `folder` (not the folder itself). */
export function isInside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The project folders Flow manages, read once. */
export function managedRoots(db: FlowDatabase): string[] {
  const rows = db.prepare(`SELECT DISTINCT root_path FROM ${PROJECTS_TABLE}`).all() as Array<{ root_path: string }>
  return rows.map((row) => row.root_path)
}

/** Account sign-in folders Flow created (inside its accounts folder). */
export function flowAccountDirs(db: FlowDatabase, flowHome: string): string[] {
  const accountsDir = join(flowHome, 'accounts')
  const rows = db.prepare('SELECT config_dir_path FROM accounts').all() as Array<{ config_dir_path: string | null }>
  return rows
    .map((row) => row.config_dir_path)
    .filter((path): path is string => typeof path === 'string' && isInside(path, accountsDir))
}

/** Drop every connector from one of Flow's own account config files. */
export function removeConnectorsFromConfig(configDir: string): void {
  const path = join(configDir, '.claude.json')
  if (!existsSync(path)) return
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete config['mcpServers']
  const projects = config['projects']
  if (typeof projects === 'object' && projects !== null) {
    for (const entry of Object.values(projects as Record<string, unknown>)) {
      if (typeof entry === 'object' && entry !== null) delete (entry as Record<string, unknown>)['mcpServers']
    }
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function rm(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/** Every entry of `dir` except the names in `keep`. */
function emptyFolder(dir: string, keep: readonly string[] = []): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (keep.includes(name)) continue
    rm(join(dir, name))
  }
}

export function buildResetSteps(env: ResetEnvironment): ResetSteps {
  const { db } = env
  // Read before anything is deleted.
  const roots = managedRoots(db)

  return {
    'app-settings': async () => {
      deleteSettings(db, settingKeys(db).filter((key) => settingOwner(key) === null))
      rm(join(env.userData, 'window-state.json'))
      await env.appSession.clearStorageData({ storages: ['localstorage'] })
    },
    'file-defaults': () => deleteOwnedSettings(db, 'file-defaults'),
    permissions: () => {
      db.prepare('DELETE FROM permission_rules').run()
    },
    conversations: () => {
      db.transaction(() => {
        db.prepare(`UPDATE ${PROJECT_STATE_TABLE} SET active_thread_id = NULL`).run()
        db.prepare("DELETE FROM thread_tab_state WHERE thread_id <> ''").run()
        // Messages, tool calls, attachments' rows, roots and subtasks follow by cascade.
        db.prepare('DELETE FROM threads').run()
      })()
      rm(join(env.userData, 'attachments'))
      rm(join(env.userData, 'share-records.json'))
    },
    launchpad: () => {
      deleteOwnedSettings(db, 'launchpad')
      rm(join(env.userData, 'run-scripts'))
    },
    tasks: () => {
      db.prepare('DELETE FROM tasks').run()
    },
    'personal-brain': () => {
      // The older per-project knowledge lives in `projects/` and goes with
      // Workspace knowledge, not with the personal brain.
      emptyFolder(env.vaultDir, ['projects'])
    },
    'agent-accounts': () => {
      for (const dir of flowAccountDirs(db, env.flowHome)) rm(dir)
      db.transaction(() => {
        db.prepare('DELETE FROM accounts').run()
        db.prepare(`UPDATE ${PROJECT_STATE_TABLE} SET account_id = NULL`).run()
      })()
      deleteOwnedSettings(db, 'agent-accounts')
    },
    connectors: () => {
      // Runs before agent accounts would remove the folders, and on its own
      // when accounts are kept.
      const failures: string[] = []
      for (const dir of flowAccountDirs(db, env.flowHome)) {
        try {
          removeConnectorsFromConfig(dir)
        } catch {
          failures.push(dir)
        }
      }
      deleteOwnedSettings(db, 'connectors')
      rm(join(env.userData, 'connector-icons'))
      if (failures.length > 0) throw new Error(`${String(failures.length)} account settings file(s) could not be read`)
    },
    integrations: () => {
      rm(join(env.flowHome, 'credentials.json'))
      deleteOwnedSettings(db, 'integrations')
    },
    'browser-data': async () => {
      await env.browserSession.clearStorageData()
      await env.browserSession.clearCache()
    },
    projects: () => {
      db.transaction(() => {
        db.prepare(`DELETE FROM ${PROJECTS_TABLE}`).run()
        db.prepare(`DELETE FROM ${PROJECT_STATE_TABLE}`).run()
      })()
      rm(join(env.flowFolder, 'projects.local.json'))
    },
    'workspace-knowledge': () => {
      rm(join(env.flowFolder, 'workspaces'))
      rm(join(env.flowFolder, 'settings', 'workspaces.local.json'))
      rm(join(env.vaultDir, 'projects'))
      deleteOwnedSettings(db, 'workspace-knowledge')
    },
    'project-files': async () => {
      const failed: string[] = []
      for (const root of roots) {
        if (!existsSync(root)) continue
        try {
          await env.uninstallProject(root)
        } catch {
          failed.push(root)
        }
      }
      if (failed.length > 0) throw new Error(`${String(failed.length)} project(s) could not be cleaned`)
    },
    'logs-caches': async () => {
      rm(join(env.userData, 'logs'))
      rm(join(env.userData, 'connector-icons'))
      await env.appSession.clearCache()
    },
  }
}
