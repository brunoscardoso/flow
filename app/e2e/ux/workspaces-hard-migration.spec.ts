/**
 * THE HARD MIGRATION (decision 2026-10-06) — seen as a person sees it.
 *
 * A profile with three registered projects and NO Workspace, the way every
 * existing install looks the day this ships:
 *
 *   · `vaulted`   — its `flow` is a link into an old vault folder holding a discovery;
 *   · `plain`     — its `flow/` is an untracked folder holding a plan;
 *   · `committed` — its `flow/` is COMMITTED in the code repo.
 *
 * Launch 1 registers them with no Flow folder at all (the app places nothing
 * then — it never migrates into a folder it was not given). Launch 2 gives it
 * one, and must, on its own:
 *
 *   · move `vaulted` and `plain` into the Default Workspace — the switcher says
 *     "Default", one thread list, no project headers;
 *   · bring their knowledge along: the discovery and the plan are read through
 *     each project's `flow` link, and the old copies are still there (the vault
 *     folder untouched, the plain folder kept as `flow.pre-workspace-<date>`);
 *   · leave `committed` waiting, with a "Move it in" card showing the commit.
 *
 * Always hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1. Screens go to
 * FLOW_E2E_SCREENS when set.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

import { dismissOnboarding, expect, test } from '../fixtures/electron'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')

interface Seed {
  root: string
  home: string
  flowHome: string
  profile: string
  vaulted: string
  plain: string
  committed: string
  vaultFolder: string
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function seedRepo(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'Flow QA')
  writeFileSync(join(dir, 'index.ts'), `export const name = '${name}'\n`)
  // What provisioning scaffolds stays out of `git status`, as in a real project.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\n.gitignore\nloops/\nflow.pre-workspace*\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'baseline')
  git(dir, 'remote', 'add', 'origin', `https://example.com/team/${name}.git`)
  return dir
}

function seed(): Seed {
  const root = mkdtempSync(join(tmpdir(), 'flow-hard-migration-'))
  const home = join(root, 'home')
  const flowHome = join(root, 'plan-flow')
  const profile = join(root, 'profile')
  mkdirSync(home)
  mkdirSync(profile)

  const vaulted = seedRepo(root, 'vaulted')
  const vaultFolder = join(root, 'vault', 'vaulted')
  mkdirSync(join(vaultFolder, 'discovery'), { recursive: true })
  writeFileSync(join(vaultFolder, 'discovery', 'discovery_search_v1.md'), '# Discovery: search\n\nFind things fast.\n')
  symlinkSync(vaultFolder, join(vaulted, 'flow'))
  writeFileSync(join(vaulted, '.git', 'info', 'exclude'), '.claude/\n.gitignore\nloops/\nflow\nflow.pre-workspace*\n')

  const plain = seedRepo(root, 'plain')
  mkdirSync(join(plain, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(plain, 'flow', 'plans', 'plan_checkout_v1.md'), '# Plan: checkout\n\n## Phase 1\n')
  writeFileSync(join(plain, '.git', 'info', 'exclude'), '.claude/\n.gitignore\nloops/\nflow\nflow.pre-workspace*\n')

  const committed = seedRepo(root, 'committed')
  mkdirSync(join(committed, 'flow', 'brain'), { recursive: true })
  writeFileSync(join(committed, 'flow', 'brain', 'index.md'), '# Brain\n')
  git(committed, 'add', 'flow')
  git(committed, 'commit', '-q', '-m', 'knowledge in the repo')

  return { root, home, flowHome, profile, vaulted, plain, committed, vaultFolder }
}

async function launch(s: Seed, withFlowFolder: boolean): Promise<{ app: ElectronApplication; window: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_RENDERER_URL: '',
    NODE_ENV: 'production',
    FLOW_E2E: '1',
    DISABLE_AUTO_UPDATE: 'true',
    HOME: s.home,
    PLAN_FLOW_VAULT_DIR: join(s.root, 'vault'),
  }
  // Launch 1 has NO Flow folder of its own: the app must place nothing.
  if (withFlowFolder) env['PLAN_FLOW_HOME'] = s.flowHome
  else delete env['PLAN_FLOW_HOME']
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${s.profile}`], env })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await dismissOnboarding(window)
  return { app, window }
}

async function close(app: ElectronApplication): Promise<void> {
  let pid: number | undefined
  try {
    pid = app.process().pid
  } catch {
    pid = undefined
  }
  await Promise.race([app.close().catch(() => undefined), new Promise((settle) => setTimeout(settle, 15_000))])
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

async function shot(window: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await window.screenshot({ path: join(SCREENS, `${name}.png`) })
}

let seeded: Seed | null = null

test.afterAll(() => {
  if (seeded === null) return
  try {
    rmSync(seeded.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn('[workspaces-hard-migration] could not remove the seed folder', error)
  }
  seeded = null
})

test('an install with no Workspace moves every project into Default on launch, knowledge and all', async () => {
  test.setTimeout(240_000)
  const s = seed()
  seeded = s

  // ── Launch 1: register the three projects; nothing is placed. ──
  const first = await launch(s, false)
  await first.window.evaluate(
    async (roots) => {
      for (const path of roots) await window.flow.project.add({ path })
    },
    [s.vaulted, s.plain, s.committed],
  )
  await expect.poll(async () => (await first.window.evaluate(() => window.flow.project.list())).length).toBe(3)
  // POSITIVE BEFORE ABSENCE: there really was nothing to migrate into yet.
  expect(existsSync(join(s.flowHome, 'workspaces'))).toBe(false)
  expect(lstatSync(join(s.vaulted, 'flow')).isSymbolicLink()).toBe(true)
  expect(realpathSync(join(s.vaulted, 'flow'))).toBe(realpathSync(s.vaultFolder))
  await close(first.app)

  // ── Launch 2: a Flow folder — the migration runs on its own. ──
  const second = await launch(s, true)
  const { window } = second
  try {
    // The switcher names the Default Workspace (after the startup sweep settles).
    const switcher = window.locator('.fl-ws-switcher .fl-project-current')
    await expect(switcher).toHaveText(/Default/, { timeout: 120_000 })

    // The plain notification said what happened, in plain words.
    await expect(window.getByText('Your projects now live in the Default Workspace.', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })

    // Knowledge came along: read through each project's `flow` link.
    const vaultedFlow = realpathSync(join(s.vaulted, 'flow'))
    const plainFlow = realpathSync(join(s.plain, 'flow'))
    expect(vaultedFlow.startsWith(realpathSync(join(s.flowHome, 'workspaces', 'default')))).toBe(true)
    expect(plainFlow.startsWith(realpathSync(join(s.flowHome, 'workspaces', 'default')))).toBe(true)
    expect(readFileSync(join(s.vaulted, 'flow', 'discovery', 'discovery_search_v1.md'), 'utf8')).toContain('Find things fast')
    expect(readFileSync(join(s.plain, 'flow', 'plans', 'plan_checkout_v1.md'), 'utf8')).toContain('Plan: checkout')

    // The old copies are kept: the vault folder untouched, the plain folder renamed aside.
    expect(readFileSync(join(s.vaultFolder, 'discovery', 'discovery_search_v1.md'), 'utf8')).toContain('Find things fast')
    const kept = readdirSync(s.plain).filter((name) => name.startsWith('flow.pre-workspace'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(s.plain, kept[0] as string, 'plans', 'plan_checkout_v1.md'), 'utf8')).toContain('Plan: checkout')

    // The committed folder waits for a person: its card shows the commit and offers "Move it in".
    const card = window.locator('text=Move committed into Default?').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await shot(window, 'hard-migration-cards')
    expect(lstatSync(join(s.committed, 'flow')).isDirectory()).toBe(true)
    expect(lstatSync(join(s.committed, 'flow')).isSymbolicLink()).toBe(false)

    // ONE thread list: no project headers anywhere in the sidebar.
    await expect(window.locator('.fl-thread-list .fl-group-caret')).toHaveCount(0)

    // The switcher: Default with its projects, and the waiting one under "Needs attention".
    await switcher.click()
    const menu = window.locator('.fl-ws-switcher .fl-project-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.fl-ws-item[data-workspace="default"]')).toContainText('Default')
    await expect(menu.locator('.fl-ws-project-name', { hasText: 'vaulted' })).toBeVisible()
    await expect(menu.locator('.fl-ws-project-name', { hasText: 'plain' })).toBeVisible()
    await expect(menu.locator('.fl-ws-heading', { hasText: 'Needs attention' })).toBeVisible()
    await expect(menu.locator('[data-attention="move-in"]')).toContainText('committed')
    await expect(menu).not.toContainText('Projects outside a Workspace')
    // Default offers Rename, never Delete.
    await expect(menu.locator('[data-manage="rename"]')).toBeVisible()
    await expect(menu.locator('[data-manage="delete"]')).toHaveCount(0)
    await shot(window, 'hard-migration-switcher')

    // "Move it in" from the switcher: the dialog shows the commit, and only its press commits.
    await menu.locator('[data-attention="move-in"]').click()
    const dialog = window.locator('.fl-ws-dialog[data-dialog="move-in"]')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('one commit')
    await shot(window, 'hard-migration-move-in')
    await dialog.locator('[data-action="confirm-move-in"]').click()
    await expect(dialog).toContainText('is now part of Default', { timeout: 60_000 })
    expect(realpathSync(join(s.committed, 'flow')).startsWith(realpathSync(join(s.flowHome, 'workspaces', 'default')))).toBe(true)
    expect(readFileSync(join(s.committed, 'flow', 'brain', 'index.md'), 'utf8')).toContain('Brain')
  } finally {
    await close(second.app)
  }
})
