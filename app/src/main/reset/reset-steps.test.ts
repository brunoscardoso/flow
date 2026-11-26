/**
 * Every reset step against a temp database and temp folders — never the real
 * app data, Flow folder or ~/.flow. Runs under Electron-as-Node (the database
 * module is built for Electron's ABI).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RESET_ITEMS, type ResetItem } from '../../shared/reset-items'
import { openDatabase, type FlowDatabase } from '../store/db'
import { readResetInventory } from './reset-inventory'
import { buildResetSteps, isInside, settingOwner, type ResetSession } from './reset-steps'
import { resolveResetRoots } from './reset-roots'
import { runReset } from './run-reset'

let base: string
let userData: string
let flowFolder: string
let vaultDir: string
let flowHome: string
let db: FlowDatabase
let calls: string[]

function session(name: string): ResetSession {
  return {
    clearStorageData: (options) => {
      calls.push(`${name}.clearStorageData:${(options?.storages ?? ['all']).join(',')}`)
      return Promise.resolve()
    },
    clearCache: () => {
      calls.push(`${name}.clearCache`)
      return Promise.resolve()
    },
  }
}

function write(path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function setting(key: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, '1')
}

function keys(): string[] {
  return (db.prepare('SELECT key FROM app_settings ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key)
}

function n(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'flow-reset-steps-'))
  userData = join(base, 'userData')
  flowFolder = join(base, 'plan-flow')
  vaultDir = join(flowFolder, 'brain')
  flowHome = join(base, 'dot-flow')
  mkdirSync(userData, { recursive: true })
  db = openDatabase(join(userData, 'flow.db'))
  calls = []

  const project = join(base, 'repo')
  mkdirSync(project)
  db.prepare(
    "INSERT INTO workspaces (id, window_id, root_path, position, added_at) VALUES ('p1', 'w', ?, 0, 'now')",
  ).run(project)
  db.prepare("INSERT INTO workspace_state (project_root, last_active_at, account_id) VALUES (?, 'now', 'a1')").run(project)
  db.prepare(
    "INSERT INTO threads (id, workspace_root, title, created_at, updated_at) VALUES ('t1', ?, 'Hello', 'now', 'now')",
  ).run(project)
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('m1', 't1', 'user', 'hi', 'now')",
  ).run()
  db.prepare(
    "INSERT INTO permission_rules (id, project_root, tool_name, verdict, created_at) VALUES ('r1', ?, 'Bash', 'allow', 'now')",
  ).run(project)
  const flowAccount = join(flowHome, 'accounts', 'uuid-1')
  const outsideAccount = join(base, 'my-own-claude')
  db.prepare("INSERT INTO accounts (id, label, config_dir_path, created_at) VALUES ('a1', 'Work', ?, 'now')").run(flowAccount)
  db.prepare("INSERT INTO accounts (id, label, config_dir_path, created_at) VALUES ('a2', 'Mine', ?, 'now')").run(outsideAccount)
  write(join(flowAccount, '.claude.json'), JSON.stringify({ mcpServers: { a: {}, b: {} }, projects: { '/x': { mcpServers: { c: {} }, keep: 1 } }, oauth: 'token' }))
  write(join(outsideAccount, '.claude.json'), JSON.stringify({ mcpServers: { mine: {} } }))

  for (const key of ['default_model', 'onboarding_completed', 'worktree.remote', 'run_order', 'run_setup:/repo', 'connector_ask_first:x', 'issue_list_config_github', 'default_account_id', 'knowledge_last_synced:default']) setting(key)

  write(join(userData, 'attachments', 'a.png'))
  write(join(userData, 'share-records.json'), '{}')
  write(join(userData, 'run-scripts', 's1.sh'))
  write(join(userData, 'compose-overrides', 'shop', 'abc123.yml'))
  write(join(userData, 'window-state.json'), '{}')
  write(join(userData, 'logs', 'main.log'))
  write(join(userData, 'connector-icons', 'a.png'))
  write(join(vaultDir, 'notes', 'idea.md'))
  write(join(vaultDir, 'ledger.md'))
  write(join(vaultDir, 'projects', 'old', 'flow', 'plans', 'p.md'))
  write(join(flowFolder, 'workspaces', 'default', 'workspace.json'), '{}')
  write(join(flowFolder, 'settings', 'workspaces.local.json'), '{}')
  write(join(flowFolder, 'projects.local.json'), '{}')
  write(join(flowHome, 'credentials.json'), JSON.stringify({ github: {}, azure: {} }))
})

afterEach(() => {
  db.close()
  rmSync(base, { recursive: true, force: true })
})

function steps() {
  return buildResetSteps({
    userData,
    flowFolder,
    vaultDir,
    flowHome,
    db,
    appSession: session('app'),
    browserSession: session('browser'),
    uninstallProject: (root) => {
      calls.push(`uninstall:${root}`)
      return Promise.resolve()
    },
  })
}

async function reset(items: ResetItem[]) {
  return runReset({ items, steps: steps(), confirmed: true, now: () => new Date('2026-11-20T00:00:00Z') })
}

describe('each item deletes its own data and nothing else', () => {
  it('app settings keep the keys other items own', async () => {
    await reset(['app-settings'])
    expect(keys()).toEqual([
      'connector_ask_first:x',
      'default_account_id',
      'issue_list_config_github',
      'knowledge_last_synced:default',
      'run_order',
      'run_setup:/repo',
      'worktree.remote',
    ])
    expect(existsSync(join(userData, 'window-state.json'))).toBe(false)
    expect(calls).toContain('app.clearStorageData:localstorage')
    expect(n('SELECT COUNT(*) AS n FROM threads')).toBe(1)
  })

  it('conversations go with their messages and files; projects and tasks stay', async () => {
    expect(n('SELECT COUNT(*) AS n FROM messages')).toBe(1)
    await reset(['conversations'])
    expect(n('SELECT COUNT(*) AS n FROM threads')).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM messages')).toBe(0)
    expect(existsSync(join(userData, 'attachments'))).toBe(false)
    expect(existsSync(join(userData, 'share-records.json'))).toBe(false)
    expect(n('SELECT COUNT(*) AS n FROM workspaces')).toBe(1)
  })

  it('the personal brain keeps the older project knowledge folder', async () => {
    await reset(['personal-brain'])
    expect(existsSync(join(vaultDir, 'notes'))).toBe(false)
    expect(existsSync(join(vaultDir, 'ledger.md'))).toBe(false)
    expect(existsSync(join(vaultDir, 'projects', 'old', 'flow', 'plans', 'p.md'))).toBe(true)
  })

  it('agent accounts delete only the sign-in folders Flow created', async () => {
    await reset(['agent-accounts'])
    expect(existsSync(join(flowHome, 'accounts', 'uuid-1'))).toBe(false)
    expect(existsSync(join(base, 'my-own-claude', '.claude.json'))).toBe(true)
    expect(n('SELECT COUNT(*) AS n FROM accounts')).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM workspace_state WHERE account_id IS NOT NULL')).toBe(0)
    expect(keys()).not.toContain('default_account_id')
  })

  it('connectors are removed from Flow accounts only, keeping the sign-in', async () => {
    await reset(['connectors'])
    const config = JSON.parse(readFileSync(join(flowHome, 'accounts', 'uuid-1', '.claude.json'), 'utf8'))
    expect(config).toEqual({ projects: { '/x': { keep: 1 } }, oauth: 'token' })
    expect(JSON.parse(readFileSync(join(base, 'my-own-claude', '.claude.json'), 'utf8'))).toEqual({ mcpServers: { mine: {} } })
    expect(keys()).not.toContain('connector_ask_first:x')
  })

  it('Workspace knowledge goes from this computer; the project list stays', async () => {
    await reset(['workspace-knowledge'])
    expect(existsSync(join(flowFolder, 'workspaces'))).toBe(false)
    expect(existsSync(join(vaultDir, 'projects'))).toBe(false)
    expect(existsSync(join(vaultDir, 'ledger.md'))).toBe(true)
    expect(existsSync(join(flowFolder, 'projects.local.json'))).toBe(true)
  })

  it('project files are removed from the projects known before the list was deleted', async () => {
    await reset(['projects', 'project-files'])
    expect(n('SELECT COUNT(*) AS n FROM workspaces')).toBe(0)
    expect(calls).toContain(`uninstall:${join(base, 'repo')}`)
  })

  it('everything at once leaves nothing behind, and the browser is cleared', async () => {
    const outcome = await reset([...RESET_ITEMS])
    expect(outcome.failed).toEqual([])
    expect(keys()).toEqual([])
    expect(existsSync(join(flowHome, 'credentials.json'))).toBe(false)
    expect(existsSync(join(userData, 'run-scripts'))).toBe(false)
    expect(existsSync(join(userData, 'compose-overrides'))).toBe(false)
    expect(existsSync(join(userData, 'logs'))).toBe(false)
    expect(calls).toContain('browser.clearStorageData:all')
    expect(n('SELECT COUNT(*) AS n FROM permission_rules')).toBe(0)
  })
})

describe('the inventory', () => {
  it('counts each item and warns about knowledge with no shared repository', async () => {
    mkdirSync(join(flowFolder, 'workspaces', 'default', '.git'))
    const git = (_cwd: string, args: readonly string[]) =>
      args[0] === 'status' ? Promise.resolve(' M plans/p.md\n') : Promise.reject(new Error('no upstream'))
    const inventory = await readResetInventory({ userData, flowFolder, vaultDir, flowHome, db, git })
    const size = (item: ResetItem) => inventory.rows.find((row) => row.item === item)
    expect(inventory.rows.map((row) => row.item)).toEqual([...RESET_ITEMS])
    expect(size('app-settings')?.size).toBe('2 settings')
    expect(size('conversations')?.size).toMatch(/^1 conversation/)
    expect(size('connectors')?.size).toBe('2 connectors')
    expect(size('integrations')?.size).toBe('2 sources')
    expect(size('personal-brain')?.size).toBe('2 notes')
    expect(size('workspace-knowledge')?.warning).toMatch(/no shared repository/)
    expect(size('tasks')?.empty).toBe(true)
    expect(inventory.busy).toBeNull()
  })

  it('counts unsynced changes when there is an upstream', async () => {
    mkdirSync(join(flowFolder, 'workspaces', 'default', '.git'))
    const git = (_cwd: string, args: readonly string[]) =>
      Promise.resolve(args[0] === 'status' ? ' M a.md\n?? b.md\n' : '1\n')
    const inventory = await readResetInventory({ userData, flowFolder, vaultDir, flowHome, db, git })
    expect(inventory.rows.find((row) => row.item === 'workspace-knowledge')?.warning).toMatch(/^3 Workspace changes were never synced/)
  })
})

describe('helpers', () => {
  it('knows which item owns a setting', () => {
    expect(settingOwner('worktree.remote')).toBe('file-defaults')
    expect(settingOwner('workspaces_current')).toBeNull()
    expect(settingOwner('default_model')).toBeNull()
  })

  it('tells inside from outside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/a/b/../x', '/a/b')).toBe(false)
  })

  it('refuses a test run without an isolated Flow folder, and isolates one with it', () => {
    expect(resolveResetRoots({ env: { FLOW_E2E: '1' }, userData: '/u', home: '/h' })).toBeNull()
    expect(resolveResetRoots({ env: { FLOW_E2E: '1', PLAN_FLOW_HOME: '/t/home', PLAN_FLOW_VAULT_DIR: '/h/real' }, userData: '/u', home: '/h' })).toEqual({
      userData: '/u',
      flowFolder: '/t/home',
      vaultDir: '/t/home/brain',
      flowHome: '/u/e2e-flow-home',
    })
    expect(resolveResetRoots({ env: {}, userData: '/u', home: '/h' })?.flowHome).toBe('/h/.flow')
  })
})
