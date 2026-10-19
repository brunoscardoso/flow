/**
 * A REMOTE TICKET SAYS WHICH PROJECTS IT IS ABOUT — because a person said so.
 *
 * A ticket in the board's Remote column (Jira, GitHub…) was written outside
 * Flow and names no code. Pressing "Add to Todo" used to file it with no
 * project choice, and its chat later started with whatever the first-prompt
 * context gate guessed. The ticket dialog now asks: the Workspace's projects,
 * nothing ticked, the first ticked "starts here", both add buttons off until
 * one is ticked. The card shows the chosen projects as chips with "Change"
 * until the chat starts, and the chat starts with exactly those projects.
 *
 * Seeds a real Workspace through the repo's CLI (like workspaces-sidebar):
 * backend + frontend open in Flow, mobile linked but not open here. The
 * tracker is answered in MAIN (a contextBridge proxy cannot be replaced).
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'

const REPO_CLI = resolve(__dirname, '../../../dist/cli/index.js')
const RESULTS = resolve(__dirname, '../results')

let seeded: { seedRoot: string; backend: string; frontend: string; mobile: string } | null = null

function seed(): { seedRoot: string; backend: string; frontend: string; mobile: string } {
  if (seeded !== null) return seeded
  const seedRoot = mkdtempSync(join(tmpdir(), 'flow-remote-projects-'))
  const flowHome = join(seedRoot, 'home')
  mkdirSync(flowHome, { recursive: true })
  function seedRepo(name: string): string {
    const dir = join(seedRoot, name)
    mkdirSync(dir)
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 'qa@flow.test')
    git('config', 'user.name', 'Flow QA')
    writeFileSync(join(dir, 'index.ts'), `export const name = '${name}'\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'baseline')
    git('remote', 'add', 'origin', `https://example.com/team/${name}.git`)
    return dir
  }
  function cli(...args: string[]): void {
    execFileSync(process.execPath, [REPO_CLI, 'workspace', ...args, '--json'], {
      env: { ...process.env, PLAN_FLOW_HOME: flowHome },
      stdio: 'ignore',
    })
  }
  const backend = seedRepo('backend')
  const frontend = seedRepo('frontend')
  const mobile = seedRepo('mobile')
  cli('create', '--name=Orbit')
  cli('link', `--target=${backend}`, '--workspace=orbit')
  cli('link', `--target=${frontend}`, '--workspace=orbit')
  cli('link', `--target=${mobile}`, '--workspace=orbit')
  seeded = { seedRoot, backend, frontend, mobile }
  return seeded
}

test.use({
  appEnv: async ({}, use) => {
    const { seedRoot } = seed()
    await use({ PLAN_FLOW_HOME: join(seedRoot, 'home') })
  },
})

test.afterAll(() => {
  if (seeded === null) return
  try {
    rmSync(seeded.seedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn('[remote-task-projects] could not remove the seed folder', error)
  }
  seeded = null
})

/** The tracker, answered in main: connected, two tickets assigned to you. */
async function fakeTracker(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('integrations:status')
    ipcMain.handle('integrations:status', (_e: unknown, req: { provider: string }) => ({
      provider: req.provider,
      connected: req.provider === 'github',
    }))
    ipcMain.removeHandler('integrations:assigned')
    ipcMain.handle('integrations:assigned', (_e: unknown, req: { provider: string }) => ({
      ok: true,
      provider: req.provider,
      items: [
        {
          key: 'acme/widgets#41',
          title: 'Endless loading when another user opens the chat',
          description: 'Opening a chat link shared by a teammate spins forever.',
          status: 'open',
          url: 'https://github.com/acme/widgets/issues/41',
        },
        {
          key: 'acme/widgets#42',
          title: 'Slow board render',
          description: '',
          status: 'open',
          url: 'https://github.com/acme/widgets/issues/42',
        },
      ],
      reason: null,
    }))
  })
}

/** The per-project onboarding opens Flow settings once; not what this spec is about. */
async function closeProjectOnboarding(page: Page): Promise<void> {
  const overlay = page.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close flow settings"])')
  await overlay.first().waitFor({ timeout: 3_000 }).catch(() => undefined)
  for (let attempt = 0; attempt < 3 && (await overlay.count()) > 0; attempt += 1) {
    await overlay.locator('.fl-settings-close').first().click()
    await page.waitForTimeout(200)
  }
}

interface FlowApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
  [key: string]: any
}

test('a remote ticket is filed with the projects a person ticks, and its chat starts with exactly those', async ({
  window,
  app,
}) => {
  test.setTimeout(180_000)
  const { backend, frontend } = seed()
  mkdirSync(RESULTS, { recursive: true })
  await fakeTracker(app)

  await window.evaluate(
    async ({ backend, frontend }) => {
      const api = (window as unknown as { flow: FlowApi }).flow
      for (const path of [backend, frontend]) await api.project.add({ path })
      await api.project.setActive({ rootPath: backend })
    },
    { backend, frontend },
  )
  await expect(window.locator('.fl-ws-switcher .fl-project-name')).toHaveText('Orbit', { timeout: 30_000 })
  await closeProjectOnboarding(window)

  // ── The board, its Remote column ────────────────────────────────────────
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
  const toggle = window.locator('.fl-board-lane-btn[aria-label*="assigned to you"]')
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  await toggle.click()
  const remoteCards = window.locator('.fl-board-remote-card')
  await expect(remoteCards).toHaveCount(2, { timeout: 15_000 })

  // ── The ticket: its projects, nothing ticked ────────────────────────────
  await remoteCards.filter({ hasText: 'Endless loading' }).click()
  const detail = window.locator('.fl-board-detail')
  await expect(detail).toBeVisible()
  const picker = detail.locator('.fl-task-projects')
  // Positive first: the section and its projects ARE drawn…
  await expect(picker).toBeVisible()
  await expect(picker.locator('.fl-task-projects-label')).toHaveText('Projects for this task')
  await expect(picker.locator('.fl-task-projects-hint')).toHaveText(
    'Pick the projects this ticket is about. Nothing is ticked for you.',
  )
  const rows = picker.locator('.fl-task-project')
  await expect(rows.locator('.fl-task-project-name')).toHaveText(['backend', 'frontend', 'mobile'])
  // …the one not open in Flow says why and cannot be ticked…
  const mobileRow = rows.filter({ hasText: 'mobile' })
  await expect(mobileRow.locator('input')).toBeDisabled()
  await expect(mobileRow.locator('.fl-task-project-note')).toHaveText('Not open in Flow')
  // …and nothing is ticked, so neither add button can act.
  await expect(rows.locator('input:checked')).toHaveCount(0)
  await expect(picker.locator('.fl-task-projects-count')).toHaveText('0 of 3 in this Workspace')
  const addTodo = detail.locator('button', { hasText: 'Add to Todo' })
  const addStart = detail.locator('button', { hasText: 'Add and start' })
  await expect(addTodo).toBeVisible()
  await expect(addTodo).toBeDisabled()
  await expect(addStart).toBeDisabled()
  await expect(detail.locator('.fl-task-projects-need')).toHaveText('Tick at least one project')

  // ── Tick two: the FIRST ticked starts the chat ──────────────────────────
  // By keyboard: ticking keeps focus on the box pressed (the rows are updated
  // in place, never rebuilt under the person's focus).
  const frontendBox = rows.filter({ hasText: 'frontend' }).locator('input')
  await frontendBox.focus()
  await window.keyboard.press('Space')
  await expect(frontendBox).toBeChecked()
  await expect(frontendBox).toBeFocused()
  await rows.filter({ hasText: 'backend' }).locator('input').check()
  await expect(rows.filter({ hasText: 'backend' }).locator('input')).toBeFocused()
  await expect(rows.filter({ hasText: 'frontend' }).locator('.fl-task-project-note')).toHaveText('starts here')
  await expect(rows.filter({ hasText: 'backend' }).locator('.fl-task-project-note')).toHaveText('')
  await expect(picker.locator('.fl-task-projects-count')).toHaveText('2 of 3 in this Workspace')
  await expect(addTodo).toBeEnabled()
  await expect(addStart).toBeEnabled()
  await expect(detail.locator('.fl-task-projects-need')).toHaveText('')
  await detail.screenshot({ path: join(RESULTS, 'remote-task-projects.png') })

  await addTodo.click()
  await expect(detail).toHaveCount(0)

  // ── The card: the two projects as chips, and Change ─────────────────────
  const card = window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-card', { hasText: 'Endless loading' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  const chips = card.locator('.fl-task-project-chip')
  await expect(chips).toHaveText(['frontend', 'backend'], { timeout: 15_000 })
  await expect(card.locator('.fl-task-project-change')).toHaveText('Change')
  // The chips replace the card's project line.
  await expect(card.locator('.fl-board-project-tag')).toHaveCount(0)
  await card.screenshot({ path: join(RESULTS, 'remote-task-projects-card.png') })

  // The record: filed in frontend, its chat attached to backend.
  const filed = await window.evaluate(
    async ({ frontend }) => {
      const api = (window as unknown as { flow: FlowApi }).flow
      const tasks = (await api.tasks.list({ projectRoot: frontend })) as Array<{ title: string; threadId: string }>
      const task = tasks.find((entry) => entry.title.includes('Endless loading'))
      const threads = (await api.threads.list({ projectRoot: frontend })) as Array<{ id: string; projectRoot: string; additionalRoots: string[] }>
      const thread = threads.find((entry) => entry.id === task?.threadId)
      return { found: task !== undefined, projectRoot: thread?.projectRoot ?? null, roots: thread?.additionalRoots ?? null }
    },
    { frontend },
  )
  expect(filed).toEqual({ found: true, projectRoot: frontend, roots: [backend] })

  // ── Change: untick one, the card follows ────────────────────────────────
  await card.locator('.fl-task-project-change').click()
  const dialog = window.locator('.fl-task-projects-dialog')
  await expect(dialog).toBeVisible()
  const dialogRows = dialog.locator('.fl-task-project')
  await expect(dialogRows.filter({ hasText: 'frontend' }).locator('input')).toBeChecked()
  await expect(dialogRows.filter({ hasText: 'backend' }).locator('input')).toBeChecked()
  await expect(dialogRows.filter({ hasText: 'frontend' }).locator('.fl-task-project-note')).toHaveText('starts here')
  await dialogRows.filter({ hasText: 'backend' }).locator('input').uncheck()
  await dialog.locator('button', { hasText: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(chips).toHaveText(['frontend'], { timeout: 15_000 })

  // ── Add and start: the chat opens with exactly the ticked project ───────
  await remoteCards.filter({ hasText: 'Slow board render' }).click()
  await expect(detail).toBeVisible()
  await detail.locator('.fl-task-project').filter({ hasText: 'backend' }).locator('input').check()
  await detail.locator('button', { hasText: 'Add and start' }).click()
  await expect(detail).toHaveCount(0)
  const composerChips = window.locator('.fl-project-chips')
  await expect(composerChips).toBeVisible({ timeout: 20_000 })
  await expect(composerChips.locator('.fl-project-chip.primary')).toHaveText('backend', { timeout: 15_000 })
  await expect(composerChips.locator('.fl-project-chip:not(.fl-project-chip-add)')).toHaveText(['backend'])
  await window.screenshot({ path: join(RESULTS, 'remote-task-projects-chat.png') })

  // And the first ticket's chat starts with its one project, frontend.
  const chat = await window.evaluate(
    async ({ frontend }) => {
      const api = (window as unknown as { flow: FlowApi }).flow
      const tasks = (await api.tasks.list({ projectRoot: frontend })) as Array<{ title: string; threadId: string }>
      const task = tasks.find((entry) => entry.title.includes('Endless loading'))
      const threads = (await api.threads.list({ projectRoot: frontend })) as Array<{ id: string; additionalRoots: string[] }>
      return threads.find((entry) => entry.id === task?.threadId)?.additionalRoots ?? null
    },
    { frontend },
  )
  expect(chat).toEqual([])
})
