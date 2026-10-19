/**
 * Workspaces Phase 9 — the sidebar seen as a person sees it.
 *
 * Seeds a real Workspace through the repo's CLI (the source of truth for its
 * structure) in a temp Flow folder: two repos with remotes linked into
 * "Acme", and a third linked into "Side". Workspaces are always on (the hard
 * migration, 2026-10-06), so the app — a temp profile — must show:
 *
 *   · the Workspace's name in the dropdown at the top (there is no project switcher)
 *   · ONE thread list for the Workspace: both projects' threads, no project
 *     headers, each row tagged with its project — and not the other Workspace's
 *   · the open thread's projects as chips above the composer
 *   · the other Workspace's one list when it is chosen in the switcher
 *
 * Phase 11 extends this file (board, gate, sync). Always run hidden:
 * FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'

const REPO_CLI = resolve(__dirname, '../../../dist/cli/index.js')
const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')

/**
 * Seeded on first use, in the worker — never at module load: Playwright also
 * loads this file in its runner process to list the tests, where no hook runs,
 * and a sandbox made there was never removed.
 */
let seeded: { seedRoot: string; backend: string; frontend: string; loose: string } | null = null

function seed(): { seedRoot: string; backend: string; frontend: string; loose: string } {
  if (seeded !== null) return seeded
  const seedRoot = mkdtempSync(join(tmpdir(), 'flow-ws-sidebar-'))
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
  const loose = seedRepo('loose')
  cli('create', '--name=Acme')
  cli('link', `--target=${backend}`, '--workspace=acme')
  cli('link', `--target=${frontend}`, '--workspace=acme')
  cli('create', '--name=Side')
  cli('link', `--target=${loose}`, '--workspace=side')
  seeded = { seedRoot, backend, frontend, loose }
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
  // The app may still be writing into a seeded repo as it shuts down; retry,
  // and never fail a passing spec over a temp folder.
  try {
    rmSync(seeded.seedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn('[workspaces-sidebar] could not remove the seed folder', error)
  }
  seeded = null
})

/** On screen, not merely "visible": a box inside the viewport. */
async function expectOnScreen(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  expect(box, 'element has a box').not.toBeNull()
  if (box === null) return
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

/**
 * The first time a project becomes active its Flow settings open once (the
 * existing per-project onboarding). Not what this spec is about — close it.
 */
async function closeProjectOnboarding(page: Page, appearWithinMs = 0): Promise<void> {
  const overlay = page.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close flow settings"])')
  // It opens after the project switch lands, so a caller that just switched waits for it.
  if (appearWithinMs > 0) await overlay.first().waitFor({ timeout: appearWithinMs }).catch(() => undefined)
  for (let attempt = 0; attempt < 3 && (await overlay.count()) > 0; attempt += 1) {
    await overlay.locator('.fl-settings-close').first().click()
    await page.waitForTimeout(200)
  }
  await expect(overlay).toHaveCount(0)
}

test('a Workspace is one switcher entry, one thread list and chips on a thread', async ({ window }) => {
  const { backend, frontend, loose } = seed()
  test.setTimeout(120_000)
  mkdirSync(SCREENS, { recursive: true })

  // The real "Add project" path minus its native folder picker, then threads.
  const ids = await window.evaluate(
    async ({ backend, frontend, loose }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
      const api = (window as unknown as { flow: any }).flow
      for (const path of [backend, frontend, loose]) await api.project.add({ path })
      await api.project.setActive({ rootPath: backend })
      const orders = await api.threads.create({ projectRoot: backend, title: 'Add the orders endpoint' })
      const screen = await api.threads.create({ projectRoot: frontend, title: 'Orders screen layout' })
      const side = await api.threads.create({ projectRoot: loose, title: 'Loose experiment' })
      // The orders thread already reads the frontend too (as the gate would attach it).
      await api.threads.setRoots({ threadId: orders.id, roots: [frontend] })
      return { orders: orders.id, screen: screen.id, side: side.id }
    },
    { backend, frontend, loose },
  )
  expect(ids.orders).toBeTruthy()

  // ── The switcher names the Workspace ────────────────────────────────────
  const switcher = window.locator('.fl-ws-switcher')
  await expect(switcher.locator('.fl-project-name')).toHaveText('Acme', { timeout: 30_000 })
  await expectOnScreen(window, switcher)
  // …and there is no project switcher beside it any more.
  await expect(window.locator('.fl-project-switcher')).toHaveCount(0)

  // ── One list: both projects' threads, tagged; not the other Workspace's ─
  const sidebar = window.locator('.fl-thread-sidebar')
  const ordersRow = sidebar.getByText('Add the orders endpoint', { exact: true })
  const screenRow = sidebar.getByText('Orders screen layout', { exact: true })
  await expect(ordersRow).toBeVisible({ timeout: 15_000 })
  await expect(screenRow).toBeVisible()
  await expectOnScreen(window, screenRow)
  const tags = sidebar.locator('.fl-thread-project-tag')
  await expect(tags.filter({ hasText: /^backend$/ })).toHaveCount(1)
  await expect(tags.filter({ hasText: /^frontend$/ })).toHaveCount(1)
  // Positive first (the two threads are drawn), then the absence: no thread of Side.
  await expect(sidebar.getByText('Loose experiment', { exact: true })).toHaveCount(0)
  await closeProjectOnboarding(window)
  await window.screenshot({ path: join(SCREENS, 'workspaces-sidebar-list.png') })

  // ── The switcher's menu ─────────────────────────────────────────────────
  await closeProjectOnboarding(window)
  await switcher.locator('.fl-project-current').click()
  const menu = switcher.locator('.fl-project-menu')
  await expect(menu.locator('.fl-ws-item', { hasText: 'Acme' })).toBeVisible()
  await expect(menu.locator('.fl-ws-item', { hasText: 'Side' })).toBeVisible()
  // Every project lives in a Workspace: nothing is listed "outside", nothing needs attention.
  await expect(menu).not.toContainText('outside a Workspace')
  await expect(menu.locator('.fl-ws-heading')).toHaveCount(0)
  await expect(menu.locator('.fl-ws-project-name')).toHaveText(['backend', 'frontend'])
  // New / Join are icons on the open Workspace's row; the one row left is "Add project…".
  await expect(menu.locator('[data-action="new-workspace"]')).toHaveAttribute('aria-label', 'New Workspace…')
  await expect(menu.locator('[data-action="join-workspace"]')).toHaveAttribute('aria-label', 'Join a Workspace…')
  await expect(menu.locator('[data-action="open-project"]')).toHaveText('Add project…')
  // The whole project row opens its settings, with a pointer to say so.
  const projectRow = menu.locator('.fl-ws-project', { hasText: 'backend' })
  await expect(projectRow).toHaveAttribute('role', 'button')
  expect(await projectRow.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer')
  // ON SCREEN, not just "visible": the switcher lives in the sidebar's rail,
  // which clips (overflow: hidden) — a menu inside it passed toBeVisible while
  // nobody could see it. Its box must sit inside the viewport AND be the
  // topmost element at its own centre.
  const box = await menu.boundingBox()
  const viewport = window.viewportSize()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThan(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport?.height ?? Number.POSITIVE_INFINITY)
  const topmostIsMenu = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
    return hit !== null && element.contains(hit)
  })
  expect(topmostIsMenu).toBe(true)
  await window.screenshot({ path: join(SCREENS, 'workspaces-switcher-menu.png') })
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // ── Files with no thread selected: a project picker ─────────────────────
  await window.locator('[data-rail-item="files"]').click()
  const picker = window.locator('.fl-file-tree-picker')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.fl-file-tree-pick')).toHaveText(['backend', 'frontend'])
  await window.screenshot({ path: join(SCREENS, 'workspaces-files-picker.png') })
  await picker.locator('.fl-file-tree-pick', { hasText: 'frontend' }).click()
  await expect(picker).toBeHidden()
  await closeProjectOnboarding(window, 3_000)
  // Back to the threads — a press on the rail item that is already active would hide it.
  const threadsRail = window.locator('[data-rail-item="threads"]')
  if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()

  // ── Chips on a thread ───────────────────────────────────────────────────
  await ordersRow.click()
  const chips = window.locator('.fl-project-chips')
  await expect(chips).toBeVisible({ timeout: 15_000 })
  await expectOnScreen(window, chips)
  await expect(chips.locator('.fl-project-chip.primary')).toHaveText('backend')
  const frontendChip = chips.locator('.fl-project-chip', { hasText: 'frontend' })
  await expect(frontendChip).toBeVisible()
  await expect(frontendChip.locator('.fl-composer-chip-dismiss')).toHaveCount(1)
  await expect(chips.locator('.fl-project-chip.primary .fl-composer-chip-dismiss')).toHaveCount(0)
  await expect(chips.locator('.fl-project-chip-add')).toBeVisible()
  await window.screenshot({ path: join(SCREENS, 'workspaces-thread-chips.png') })

  // ── The other Workspace: its own one list ───────────────────────────────
  await switcher.locator('.fl-project-current').click()
  await menu.locator('.fl-ws-item', { hasText: 'Side' }).click()
  await expect(switcher.locator('.fl-project-name')).toHaveText('Side')
  await closeProjectOnboarding(window, 3_000)
  if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
  await expect(sidebar.getByText('Loose experiment', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Orders screen layout', { exact: true })).toHaveCount(0)
  await expect(sidebar.locator('.fl-thread-project-tag').filter({ hasText: /^loose$/ })).toHaveCount(1)
  await window.screenshot({ path: join(SCREENS, 'workspaces-sidebar-other.png') })

  // ── Back into the Workspace from the switcher ───────────────────────────
  await switcher.locator('.fl-project-current').click()
  await menu.locator('.fl-ws-item', { hasText: 'Acme' }).click()
  await expect(switcher.locator('.fl-project-name')).toHaveText('Acme')
  // The rail can follow the project switch to Files; the list is on the threads rail.
  if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
  await expect(sidebar.getByText('Orders screen layout', { exact: true })).toBeVisible()
  // Choosing the Workspace opened one of its projects — the rest of the app follows.
  await expect
    .poll(async () =>
      window.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
        const active = await (window as unknown as { flow: any }).flow.project.active()
        return (active?.rootPath ?? '') as string
      }),
    )
    .toMatch(/\/(backend|frontend)$/)
  await closeProjectOnboarding(window, 3_000)

  // ── One board for the Workspace, cards tagged by project ────────────────
  await window.evaluate(
    async ({ backend, frontend }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
      const api = (window as unknown as { flow: any }).flow
      await api.tasks.create({ projectRoot: backend, title: 'Expose the orders API' })
      await api.tasks.create({ projectRoot: frontend, title: 'Draw the orders list' })
    },
    { backend, frontend },
  )
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
  const boardTags = window.locator('.fl-board-card .fl-board-project-tag')
  await expect(window.locator('.fl-board-card', { hasText: 'Draw the orders list' })).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-board-card', { hasText: 'Expose the orders API' })).toBeVisible()
  await expect(boardTags.filter({ hasText: /^backend$/ })).not.toHaveCount(0)
  await expect(boardTags.filter({ hasText: /^frontend$/ })).not.toHaveCount(0)
  await window.screenshot({ path: join(SCREENS, 'workspaces-board.png') })
})
