/**
 * Workspaces Phase 10, after the hard migration — every project lives in a
 * Workspace: added projects land in Default; a new Workspace takes projects
 * MOVED from another; Settings renames, moves and deletes; the paused-sync
 * collision card; and onboarding's always-present Workspace step.
 *
 * Real everywhere it can be: two seeded git repos with remotes, an empty temp
 * Flow folder, and every Workspace operation going through main → the CLI
 * (the source of truth for a Workspace's structure). Only the paused-sync
 * status is stubbed (in main, via `ipcMain.handle`) — producing a real
 * same-topic collision needs a second machine, which is Phase 11's job.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { lazySandbox } from '../fixtures/workspaces'

const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'

// One sandbox for the file: the Workspace's remote is a LOCAL bare repository
// behind an ordinary https address, and git in the app is locked to `file`, so
// sync really runs — and nothing reaches the network (fixtures/workspaces.ts).
const seeded = lazySandbox('settings', (sandbox) => ({
  backend: sandbox.seedRepo('backend'),
  frontend: sandbox.seedRepo('frontend'),
}))

test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })

test.afterAll(async () => {
  await seeded.cleanup()
})

/** The per-project Flow settings open once on a project's first activation — not this spec's subject. */
async function closeProjectOnboarding(page: Page, appearWithinMs = 0): Promise<void> {
  const overlay = page.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close flow settings"])')
  if (appearWithinMs > 0) await overlay.first().waitFor({ timeout: appearWithinMs }).catch(() => undefined)
  for (let attempt = 0; attempt < 3 && (await overlay.count()) > 0; attempt += 1) {
    await overlay.locator('.fl-settings-close').first().click()
    await page.waitForTimeout(200)
  }
  await expect(overlay).toHaveCount(0)
}

test('create a Workspace from the switcher, add projects, manage it in Settings, settle a collision', async ({ app, window }) => {
  const { sandbox, backend, frontend } = seeded.get()
  test.setTimeout(150_000)
  mkdirSync(SCREENS, { recursive: true })
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  await window.evaluate(
    async ({ backend, frontend }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
      const api = (window as unknown as { flow: any }).flow
      for (const path of [backend, frontend]) await api.project.add({ path })
      await api.project.setActive({ rootPath: backend })
    },
    { backend, frontend },
  )
  await closeProjectOnboarding(window, 3_000)

  // ── Every project added lands in a Workspace: Default ────────────────────
  const switcher = window.locator('.fl-ws-switcher')
  await expect(switcher.locator('.fl-project-name')).toHaveText('Default', { timeout: 60_000 })
  await expect.poll(() => lstatSync(join(backend, 'flow')).isSymbolicLink(), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => lstatSync(join(frontend, 'flow')).isSymbolicLink(), { timeout: 30_000 }).toBe(true)

  // ── New Workspace… from the switcher, then MOVE the backend into it ──────
  await switcher.locator('.fl-project-current').click()
  await switcher.locator('[data-action="new-workspace"]').click()
  const create = window.locator('.fl-ws-dialog[data-dialog="create"]')
  await expect(create).toBeVisible()
  await expect(create).toContainText('A project’s knowledge moves with it')
  await create.locator('#fl-ws-create-name').fill('Acme')
  await create.locator('#fl-ws-create-remote').fill(sandbox.remoteUrl)
  await window.screenshot({ path: join(SCREENS, 'workspaces-new-dialog.png') })
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Create Workspace' }).click()
  await expect(create.locator('.fl-ws-dialog-title')).toHaveText('Move projects into it?', { timeout: 30_000 })
  await expect(create).toContainText('Acme is ready.')
  const projects = create.locator('.fl-ws-dialog-project')
  await expect(projects).toHaveCount(2)
  // Unticked until a person chooses: moving changes where a project's knowledge lives.
  await expect(projects.locator('input[type="checkbox"]:checked')).toHaveCount(0)
  await projects.filter({ hasText: 'backend — in Default' }).locator('input[type="checkbox"]').check()
  await window.screenshot({ path: join(SCREENS, 'workspaces-add-open-projects.png') })
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Move selected' }).click()
  await expect(projects.filter({ hasText: 'backend' }).locator('.fl-ws-dialog-project-status')).toHaveText('Done', { timeout: 60_000 })
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
  await expect(create).toHaveCount(0)
  await expect(switcher.locator('.fl-project-name')).toHaveText('Acme', { timeout: 30_000 })

  // ── Settings → Workspaces: no switch; move the frontend here ────────────
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'workspaces' } })),
  )
  const section = window.locator('.fl-settings-page .fl-wss')
  await expect(section).toBeVisible({ timeout: 15_000 })
  await expect(section.locator('[data-part="workspaces-switch"]')).toHaveCount(0)
  await expect(section).not.toContainText('Use Workspaces')
  const card = section.locator('.fl-wss-card[data-workspace="acme"]')
  const defaultCard = section.locator('.fl-wss-card[data-workspace="default"]')
  await expect(card.locator('.fl-wss-name')).toHaveText('Acme')
  await expect(card.locator('.fl-wss-remote')).toHaveText(sandbox.remoteUrl)
  // The Workspace cards say where things live; the Flow folder block is gone
  // (the cards above are the positive — the section did render).
  await expect(section.locator('[data-part="flow-folder"]')).toHaveCount(0)
  await expect(section).not.toContainText('Flow folder')
  await expect(section).not.toContainText('not supported yet')
  await expect(card.locator('.fl-wss-project')).toHaveCount(1)
  // Default is said to be Default, and can't be deleted; Acme can.
  await expect(defaultCard).toContainText('It can’t be deleted.')
  await expect(defaultCard.locator('[data-part="delete-workspace"]')).toHaveCount(0)
  await expect(card.locator('[data-part="delete-workspace"]')).toHaveCount(1)

  await card.locator('[data-part="move-here"]').click()
  await card.locator('.fl-wss-add select').selectOption({ label: 'frontend — in Default' })
  await card.locator('[data-part="move-here-confirm"]').click()
  // A sync of Acme may be running when Move is pressed — the move waits for it.
  await expect(card.locator('.fl-wss-project')).toHaveCount(2, { timeout: 90_000 })
  await expect(card.locator('.fl-wss-project-name .fl-wss-value')).toHaveText(['backend', 'frontend'])
  expect(lstatSync(join(frontend, 'flow')).isSymbolicLink()).toBe(true)
  await expect(card.locator('.fl-wss-project button', { hasText: 'Project settings' })).toHaveCount(2)
  await window.screenshot({ path: join(SCREENS, 'workspaces-settings-section.png') })

  // ── Sync now really syncs — to the local bare repository, never the network ──
  const syncStatus = card.locator('[data-part="sync-status"]')
  await card.locator('[data-part="sync-now"]').click()
  await expect(syncStatus).toHaveText(/^(Synced|Up to date)/, { timeout: 60_000 })
  expect(sandbox.remoteFiles()).toEqual(expect.arrayContaining(['workspace.json', 'projects/backend/brain/.gitkeep']))

  // ── The collision card (status stubbed in main: a paused sync) ──────────
  await app.evaluate(({ ipcMain }) => {
    const ask = {
      id: 'ask-decision',
      kind: 'decision',
      topic: 'Feature-flag rollout',
      path: 'projects/backend/brain/decisions/flag-rollout.md',
      existingPath: 'projects/backend/brain/decisions/flag-rollout.md',
      existing: 'Roll flags out team by team.',
      incoming: 'Roll flags out by percentage of users.',
      merged: null,
      truncated: false,
      options: ['ours', 'theirs', 'file'],
    }
    const paused = { state: 'paused', lastSyncedAt: null, detail: 'Acme needs you to choose.', asks: [ask], reviews: [] }
    const synced = { state: 'synced', lastSyncedAt: new Date().toISOString(), detail: null, asks: [], reviews: [] }
    const g = globalThis as unknown as { __resolved: unknown[] }
    g.__resolved = []
    ipcMain.removeHandler('workspaces:syncStatus')
    ipcMain.handle('workspaces:syncStatus', () => (g.__resolved.length > 0 ? synced : paused))
    ipcMain.removeHandler('workspaces:resolve')
    ipcMain.handle('workspaces:resolve', (_event, request) => {
      g.__resolved.push(request)
      return { ok: true, status: synced }
    })
  })
  // Settings re-reads on its next refresh; the notification's own event opens the card.
  // The notification names its Workspace (every project lives in one, so Default is here too).
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-workspace-sync', { detail: { slug: 'acme' } })),
  )
  const collision = window.locator('.fl-collision')
  await expect(collision).toBeVisible()
  await expect(collision).toContainText('Acme needs you to choose one thing before it syncs again.')
  const item = collision.locator('.fl-collision-item.decision')
  await expect(item.locator('.fl-collision-topic')).toHaveText('Feature-flag rollout')
  await expect(item).toContainText('What the Workspace already says')
  await expect(item).toContainText('Roll flags out by percentage of users.')
  await expect(item.locator('button[data-choice]')).toHaveText([
    'Keep mine',
    'Keep the Workspace’s',
    'Let Flow adapt it',
    'Record a change',
  ])
  await window.screenshot({ path: join(SCREENS, 'workspaces-collision-card.png') })
  await item.locator('button[data-choice="ours"]').click()
  await expect(collision).toContainText('All settled. The Workspace syncs again on its own.')
  const resolved = await app.evaluate(() => (globalThis as unknown as { __resolved: unknown[] }).__resolved)
  // The decision names the item by its id, so the CLI decides exactly what was shown.
  expect(resolved).toEqual([{ slug: 'acme', id: 'ask-decision', path: 'projects/backend/brain/decisions/flag-rollout.md', take: 'ours' }])
  await collision.locator('.fl-collision-header button').click()
  await expect(collision).toHaveCount(0)

  // ── Rename, then Delete: the projects go back to Default ────────────────
  await card.locator('[data-part="rename-workspace"]').click()
  const rename = window.locator('.fl-ws-dialog[data-dialog="rename"]')
  await expect(rename).toBeVisible()
  await rename.locator('#fl-ws-rename-name').fill('Acme Team')
  await rename.locator('.fl-ws-dialog-btn', { hasText: 'Rename' }).click()
  await expect(rename).toHaveCount(0, { timeout: 30_000 })
  await expect(card.locator('.fl-wss-name')).toHaveText('Acme Team', { timeout: 30_000 })

  await card.locator('[data-part="delete-workspace"]').click()
  const del = window.locator('.fl-ws-dialog[data-dialog="delete"]')
  await expect(del).toBeVisible()
  await expect(del).toContainText('Its 2 projects move to Default: backend, frontend.')
  await expect(del).toContainText('The shared copy online is not deleted')
  await window.screenshot({ path: join(SCREENS, 'workspaces-delete-dialog.png') })
  await del.locator('[data-action="confirm-delete"]').click()
  await expect(del).toContainText('Its projects are in Default now.', { timeout: 60_000 })
  await del.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
  await expect(section.locator('.fl-wss-card[data-workspace="acme"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(defaultCard.locator('.fl-wss-project')).toHaveCount(2)
  await expect(switcher.locator('.fl-project-name')).toHaveText('Default', { timeout: 30_000 })
  // The shared repository was never touched.
  expect(sandbox.remoteFiles()).toEqual(expect.arrayContaining(['workspace.json']))

  expect(errors, errors.join('\n')).toEqual([])
})

// ── Onboarding's Workspace offer ────────────────────────────────────────────

function launchPlain(userDataDir: string, home: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      // The sandbox's git locks and its own HOME: nothing this app runs can
      // reach the network or sign in as the developer.
      ...seeded.get().sandbox.gitEnv,
      HOME: seeded.get().sandbox.machine.home,
      PLAN_FLOW_HOME: home,
      ...extraEnv,
    } as Record<string, string>,
  })
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^(Next|Finish)$/ })
    .first()
    .evaluate((b) => (b as HTMLButtonElement).disabled)
}

/** Walk the wizard (opened from Settings → App → Getting Started) to the step after the project settings. */
async function walkPastProjectSettings(win: Page): Promise<ReturnType<Page['locator']>> {
  for (let i = 0; i < 4 && (await win.locator('.fl-settings-overlay:not([hidden])').count()) > 0; i += 1) {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
  }
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'app' } })))
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await win.locator('.fl-settings-page button', { hasText: 'Getting Started' }).click()
  const wizard = win.locator(WIZARD)
  await expect(wizard).toBeVisible()
  for (const title of ['Choose your agent', 'Connect a Claude account', 'Open a project', 'Choose a mode']) {
    const claude = wizard.locator('.fl-wizard-body button', { hasText: 'Claude (Anthropic)' })
    if ((await claude.count()) > 0) await claude.click()
    await expect.poll(() => nextDisabled(win), { timeout: 20_000 }).toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText(title)
  }
  await wizard.locator('.fl-wizard-body .fl-wizard-btn', { hasText: /^Manual/ }).click()
  for (const title of ['Sign in to Flow', 'Your project settings']) {
    await expect.poll(() => nextDisabled(win), { timeout: 20_000 }).toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText(title)
  }
  await expect.poll(() => nextDisabled(win), { timeout: 20_000 }).toBe(false)
  await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
  return wizard
}

async function stubWizardProbes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('accounts:status')
    ipcMain.handle('accounts:status', () => ({ checked: false, loggedIn: false }))
  })
}

function storedSwitch(userDataDir: string): string | null {
  const out = execFileSync('sqlite3', [join(userDataDir, 'flow.db'), "SELECT value FROM app_settings WHERE key = 'workspaces_enabled';"])
    .toString()
    .trim()
  return out === '' ? null : out
}

test('onboarding always shows the Default Workspace — rename it there; no switch is ever written', async () => {
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-ux-ws-wizard-'))
  const home = mkdtempSync(join(tmpdir(), 'flow-ux-ws-wizard-home-'))
  const repo = seeded.get().sandbox.seedRepo('wizard-project')
  let app: ElectronApplication | undefined
  try {
    app = await launchPlain(userDataDir, home)
    await (await app.firstWindow()).waitForLoadState('domcontentloaded')
    await app.close()
    execFileSync('sqlite3', [
      join(userDataDir, 'flow.db'),
      `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
         VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
       INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
    ])

    app = await launchPlain(userDataDir, home)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(error.message))
    await win.evaluate(async (p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
      const flow = (window as unknown as { flow: any }).flow
      await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: p })
    }, repo)
    await stubWizardProbes(app)
    const wizard = await walkPastProjectSettings(win)
    // The last step: the Workspace the projects are in.
    await expect(wizard.locator('.fl-settings-header')).toContainText('Your Workspace')
    const body = wizard.locator('.fl-wizard-body')
    await expect(body).toContainText('Your projects are in Default.', { timeout: 60_000 })
    await expect(body.locator('button[data-action="rename-workspace"]')).toHaveText('Rename it')
    await expect(body.locator('button[data-action="join-workspace"]')).toHaveText('Join your team’s Workspace instead')
    // No "Not now", no "Use Workspaces": there is nothing to opt into.
    await expect(body.locator('button[data-action="not-now"]')).toHaveCount(0)
    await expect(body.locator('button[data-action="use-workspaces"]')).toHaveCount(0)
    expect(await nextDisabled(win)).toBe(false)
    await win.screenshot({ path: join(SCREENS, 'workspaces-onboarding-offer.png') })

    await body.locator('button[data-action="rename-workspace"]').click()
    await body.locator('input.fl-wizard-input').fill('Mine')
    await body.locator('button[data-action="save-workspace-name"]').click()
    await expect(body).toContainText('Your projects are in Mine.', { timeout: 30_000 })
    await win.screenshot({ path: join(SCREENS, 'workspaces-onboarding-renamed.png') })
    const listed = await win.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
      return (window as unknown as { flow: any }).flow.workspaces.list()
    })
    expect(listed.ok).toBe(true)
    expect(listed.workspaces.map((workspace: { name: string; isDefault: boolean }) => [workspace.name, workspace.isDefault])).toEqual([
      ['Mine', true],
    ])

    await wizard.locator('.fl-wizard-btn', { hasText: /^Finish$/ }).click()
    await expect(win.locator(WIZARD)).toHaveCount(0, { timeout: 15_000 })
    // The old on/off row is never written.
    expect(storedSwitch(userDataDir)).toBeNull()
    expect(lstatSync(join(repo, 'flow')).isSymbolicLink()).toBe(true)
    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    if (app) await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
