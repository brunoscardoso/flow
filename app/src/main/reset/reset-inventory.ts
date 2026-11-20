/**
 * WHAT EACH RESET ITEM HOLDS RIGHT NOW — the counts beside the checkboxes, and
 * the warnings the dialog must show.
 *
 * Read when a person opens the section, never when Settings opens: walking
 * folders for sizes costs time, and most visits to Settings are not resets.
 * Async throughout (allowed-pattern #19). A count that cannot be read is
 * null, and the row still draws — a person may delete what Flow could not
 * measure.
 *
 * The one warning that matters: Workspace knowledge whose changes never
 * reached its shared repository exists only on this computer. The check is
 * read-only (`git status`, and the count of commits ahead of the upstream);
 * it never fetches, commits or pushes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ResetInventory, ResetInventoryRow, ResetItem } from '../../shared/reset-items'
import type { FlowDatabase } from '../store/db'
import { PROJECTS_TABLE } from '../store/storage-names'
import { flowAccountDirs, settingKeys, settingOwner } from './reset-steps'

export interface InventoryEnvironment {
  userData: string
  flowFolder: string
  vaultDir: string
  flowHome: string
  db: FlowDatabase
  /** Run git in a folder; resolves stdout, rejects on failure. */
  git: (cwd: string, args: readonly string[]) => Promise<string>
}

/** Bytes under a path (a file or a folder), links not followed. 0 when absent. */
export async function sizeOf(path: string): Promise<number> {
  let info
  try {
    info = await stat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    total += await sizeOf(join(path, entry.name))
  }
  return total
}

/** Markdown files under a folder, skipping the names in `skip` at its top. */
async function countNotes(dir: string, skip: readonly string[]): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await countNotes(full, [])
    else if (entry.isFile() && entry.name.endsWith('.md')) total += 1
  }
  return total
}

async function folderNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${String(Math.round(bytes / (1024 * 1024)))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`
}

function count(db: FlowDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

/**
 * How much of one knowledge folder never reached its shared repository.
 * `noRemote` when the folder has no upstream at all.
 */
export async function unsyncedChanges(
  git: InventoryEnvironment['git'],
  dir: string,
): Promise<{ changes: number; noRemote: boolean } | null> {
  if (!existsSync(join(dir, '.git'))) return null
  try {
    const status = await git(dir, ['status', '--porcelain'])
    const dirty = status.split('\n').filter((line) => line.trim() !== '').length
    let ahead = 0
    let noRemote = false
    try {
      ahead = Number.parseInt((await git(dir, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
    } catch {
      noRemote = true
    }
    return { changes: dirty + ahead, noRemote }
  } catch {
    return null
  }
}

export async function readResetInventory(env: InventoryEnvironment): Promise<ResetInventory> {
  const rows: ResetInventoryRow[] = []
  const add = (item: ResetItem, n: number | null, size: string | null, warning: string | null = null): void => {
    rows.push({ item, size, empty: n === 0, warning })
  }
  const safe = async (item: ResetItem, read: () => Promise<void> | void): Promise<void> => {
    try {
      await read()
    } catch {
      add(item, null, null)
    }
  }
  const { db } = env

  await safe('app-settings', () => {
    const n = settingKeys(db).filter((key) => settingOwner(key) === null).length
    add('app-settings', n, plural(n, 'setting', 'settings'))
  })
  await safe('file-defaults', () => {
    const n = settingKeys(db).filter((key) => settingOwner(key) === 'file-defaults').length
    add('file-defaults', n, `${String(n)} set`)
  })
  await safe('permissions', () => {
    const n = count(db, 'SELECT COUNT(*) AS n FROM permission_rules')
    add('permissions', n, plural(n, 'rule', 'rules'))
  })
  await safe('conversations', async () => {
    const n = count(db, 'SELECT COUNT(*) AS n FROM threads')
    const bytes = await sizeOf(join(env.userData, 'attachments'))
    add('conversations', n, bytes > 0 ? `${plural(n, 'conversation', 'conversations')} · ${formatBytes(bytes)}` : plural(n, 'conversation', 'conversations'))
  })
  await safe('launchpad', async () => {
    const entries = await readdir(join(env.userData, 'run-scripts')).catch(() => [])
    add('launchpad', entries.length, plural(entries.length, 'script', 'scripts'))
  })
  await safe('tasks', () => {
    const n = count(db, 'SELECT COUNT(*) AS n FROM tasks')
    add('tasks', n, plural(n, 'task', 'tasks'))
  })
  await safe('personal-brain', async () => {
    const n = await countNotes(env.vaultDir, ['projects'])
    add('personal-brain', n, plural(n, 'note', 'notes'))
  })
  await safe('agent-accounts', () => {
    const n = count(db, 'SELECT COUNT(*) AS n FROM accounts')
    add('agent-accounts', n, plural(n, 'account', 'accounts'))
  })
  await safe('connectors', () => {
    let n = 0
    for (const dir of flowAccountDirs(db, env.flowHome)) {
      const path = join(dir, '.claude.json')
      if (!existsSync(path)) continue
      const config = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
      n += Object.keys(config.mcpServers ?? {}).length
    }
    add('connectors', n, plural(n, 'connector', 'connectors'))
  })
  await safe('integrations', () => {
    const path = join(env.flowHome, 'credentials.json')
    const n = existsSync(path) ? Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object).length : 0
    add('integrations', n, plural(n, 'source', 'sources'))
  })
  await safe('browser-data', async () => {
    const bytes = await sizeOf(join(env.userData, 'Partitions', 'flow-browser'))
    add('browser-data', bytes, formatBytes(bytes))
  })
  await safe('projects', () => {
    const n = count(db, `SELECT COUNT(DISTINCT root_path) AS n FROM ${PROJECTS_TABLE}`)
    add('projects', n, plural(n, 'project', 'projects'))
  })
  await safe('workspace-knowledge', async () => {
    const workspaces = await folderNames(join(env.flowFolder, 'workspaces'))
    const legacy = await folderNames(join(env.vaultDir, 'projects'))
    let changes = 0
    const localOnly: string[] = []
    for (const name of workspaces) {
      const result = await unsyncedChanges(env.git, join(env.flowFolder, 'workspaces', name))
      if (result === null) continue
      if (result.noRemote) localOnly.push(name)
      else changes += result.changes
    }
    const warnings: string[] = []
    if (changes > 0) {
      warnings.push(
        `${plural(changes, 'Workspace change was', 'Workspace changes were')} never synced. They exist only on this computer and will be lost. Sync first to keep them.`,
      )
    }
    if (localOnly.length > 0) {
      warnings.push(
        `${localOnly.length === 1 ? 'One Workspace has' : `${String(localOnly.length)} Workspaces have`} no shared repository, so ${localOnly.length === 1 ? 'its' : 'their'} knowledge exists only on this computer.`,
      )
    }
    const n = workspaces.length + legacy.length
    const parts = [plural(workspaces.length, 'Workspace', 'Workspaces')]
    if (legacy.length > 0) parts.push(plural(legacy.length, 'older project folder', 'older project folders'))
    add('workspace-knowledge', n, parts.join(' · '), warnings.length > 0 ? warnings.join(' ') : null)
  })
  await safe('project-files', () => {
    const roots = (db.prepare(`SELECT DISTINCT root_path FROM ${PROJECTS_TABLE}`).all() as Array<{ root_path: string }>)
      .map((row) => row.root_path)
      .filter((root) => existsSync(root))
    add('project-files', roots.length, plural(roots.length, 'project', 'projects'))
  })
  await safe('logs-caches', async () => {
    let bytes = 0
    for (const name of ['logs', 'Cache', 'Code Cache', 'connector-icons']) bytes += await sizeOf(join(env.userData, name))
    add('logs-caches', bytes, formatBytes(bytes))
  })

  const running = (() => {
    try {
      return count(db, "SELECT COUNT(*) AS n FROM threads WHERE status = 'running'")
    } catch {
      return 0
    }
  })()
  const busy =
    running > 0
      ? `${running === 1 ? 'A conversation is' : `${String(running)} conversations are`} still working. The reset stops ${running === 1 ? 'it' : 'them'}.`
      : null
  return { rows, busy }
}
