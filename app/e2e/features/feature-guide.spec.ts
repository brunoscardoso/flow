import type { Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

/**
 * The feature guide, in the real app: the overview once after setup, a tour
 * the first time a screen is on screen, Escape ends it for good, the ? button
 * replays the tour of the screen in front of the person, and the switch in
 * Settings › Guides stops tours from starting.
 *
 * Tips start OFF in a hidden run (so they never cover another spec's screen);
 * this spec turns them on the way a person would have them by default.
 */

test.afterAll(() => cleanupSeeds())

type Guides = { enabled: boolean; overviewSeen: boolean; seen: string[] }

const guides = (window: Page): Promise<Guides> =>
  window.evaluate(() => (window as unknown as { flow: { settings: { getGuides: () => Promise<Guides> } } }).flow.settings.getGuides())

const tour = (window: Page, id: string) => window.locator(`.fl-guide[data-guide="${id}"]`)
const card = (window: Page) => window.locator('.fl-guide-card')

/** The card is inside the window, and so is the lit area when there is one. */
async function expectCardInWindow(window: Page): Promise<void> {
  const box = await card(window).boundingBox()
  const size = window.viewportSize() ?? (await window.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  expect(box).not.toBeNull()
  if (box === null) return
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width)
  expect(box.y + box.height).toBeLessThanOrEqual(size.height)
}

/** Close every tour that is open, and any that opens right behind it. */
async function closeAnyTour(window: Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    if ((await window.locator('.fl-guide').count()) === 0) {
      await window.waitForTimeout(1500)
      if ((await window.locator('.fl-guide').count()) === 0) return
    }
    await card(window).locator('.fl-guide-x').click()
  }
}

const SHOTS = process.env['FLOW_E2E_SHOTS'] ?? ''

test('the overview, a first-open tour, Escape, the (i) replay, and the switch', async ({ window }) => {
  test.setTimeout(180_000)
  const root = await seedProject(window, 'flow-e2e-guide-')
  await activateProject(window, root)
  expect((await guides(window)).enabled).toBe(false)

  await window.evaluate(async () => {
    const flow = (window as unknown as { flow: { settings: { setGuides: (u: object) => Promise<unknown> } } }).flow
    await flow.settings.setGuides({ enabled: true })
    document.dispatchEvent(new CustomEvent('flow:guides-changed'))
  })

  // ── The overview, once ────────────────────────────────────────────────────
  const overview = window.locator('.fl-guide-ov')
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(overview.locator('h1')).toHaveText('Here is what Flow can do')
  await expect(overview.locator('.fl-guide-ov-card')).toHaveCount(6)
  if (process.env['FLOW_E2E_SHOTS']) await window.screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/guide-overview.png` })
  await overview.locator('[data-guide-action="explore"]').click()
  await expect(overview).toHaveCount(0)
  await expect.poll(async () => (await guides(window)).overviewSeen).toBe(true)

  // ── The Tasks tour starts the first time the board is on screen ───────────
  // (whatever else is on screen — the composer, Launchpad — may tour first;
  // close those, the way a person who wants the board would)
  await window.waitForTimeout(2500)
  await closeAnyTour(window)
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
  await expect(window.locator('.fl-board')).toBeVisible({ timeout: 15_000 })
  await expect(tour(window, 'tasks')).toHaveCount(1, { timeout: 10_000 })
  await expect(card(window).locator('.fl-guide-title')).toHaveText('Your board')
  await expect(card(window).locator('.fl-guide-step')).toContainText('Tasks and Loops · 1 of')
  await expectCardInWindow(window)
  // The lit area is around the first lane, not somewhere else.
  const spot = await window.locator('.fl-guide-spot').boundingBox()
  const lane = await window.locator('.fl-board-column:not(.fl-board-remote)').first().boundingBox()
  expect(spot).not.toBeNull()
  expect(lane).not.toBeNull()
  if (spot !== null && lane !== null) {
    expect(Math.abs(spot.x - lane.x)).toBeLessThan(8)
    expect(Math.abs(spot.y - lane.y)).toBeLessThan(8)
  }
  if (process.env['FLOW_E2E_SHOTS']) await window.screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/guide-tasks.png` })

  await card(window).locator('[data-guide-action="next"]').click()
  await expect(card(window).locator('.fl-guide-title')).toHaveText('Let the agent work the list')
  await expectCardInWindow(window)

  // ── Escape ends it, and it does not come back on its own ──────────────────
  await window.keyboard.press('Escape')
  await expect(tour(window, 'tasks')).toHaveCount(0)
  expect((await guides(window)).seen).toContain('tasks')
  await window.waitForTimeout(3000)
  await expect(window.locator('.fl-board')).toBeVisible()
  await expect(tour(window, 'tasks')).toHaveCount(0)

  // ── The (i) on the board replays its tour, where the person is looking ───
  // No toolbar "?" any more: the way in sits on the feature itself.
  await expect(window.locator('button.fl-guide-help')).toHaveCount(0)
  const info = window.locator('.fl-board-column:not(.fl-board-remote) button.fl-guide-info[data-guide-info="tasks"]')
  await expect(info).toHaveCount(1)
  await expect(info).toHaveAttribute('aria-label', 'How the task board works')
  if (SHOTS) await window.locator('.fl-board-column:not(.fl-board-remote)').first().screenshot({ path: `${SHOTS}/guide-info-tasks.png` })
  await info.click()
  await expect(tour(window, 'tasks')).toHaveCount(1, { timeout: 5000 })
  await card(window).locator('.fl-guide-x').click()
  await expect(tour(window, 'tasks')).toHaveCount(0)

  // ── Settings › Guides: what has run, and the switch ───────────────────────
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'guides' } })),
  )
  // Settings has its own tour; close it if it opens.
  const settingsTour = tour(window, 'settings')
  await settingsTour.waitFor({ timeout: 4000 }).catch(() => undefined)
  if ((await settingsTour.count()) > 0) await card(window).locator('.fl-guide-x').click()
  const tasksRow = window.locator('.fl-gset-row[data-guide="tasks"]')
  await expect(tasksRow).toBeVisible({ timeout: 10_000 })
  await expect(tasksRow.locator('.fl-gset-status')).toHaveText('Seen')
  await expect(window.locator('.fl-gset-row[data-guide="blueprint"] .fl-gset-status')).toHaveText('Not yet')
  if (process.env['FLOW_E2E_SHOTS']) await window.screenshot({ path: `${process.env['FLOW_E2E_SHOTS']}/guide-settings.png` })
  await window.locator('input[data-guide-setting="enabled"]').uncheck()
  await expect.poll(async () => (await guides(window)).enabled).toBe(false)

  // With tips off, a screen never opened before shows no tour…
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(3000)
  await expect(tour(window, 'blueprint')).toHaveCount(0)
  expect((await guides(window)).seen).not.toContain('blueprint')

  // …and a person's press still runs it.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:guide-replay', { detail: { id: 'blueprint' } })))
  await expect(tour(window, 'blueprint')).toHaveCount(1, { timeout: 10_000 })
  await expectCardInWindow(window)
})
