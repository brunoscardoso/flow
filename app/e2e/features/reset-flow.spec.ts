import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test as base, expect } from '../fixtures/electron'

/**
 * Settings › App › Reset Flow, in the real app.
 *
 *   1. The section opens closed, lists every kind of data when asked, and the
 *      dialog's delete button turns on only for the typed word. The schedule
 *      channel is replaced in main, so pressing it records the request and
 *      the app does NOT restart (a restart would open a window outside the
 *      test's control).
 *   2. A reset recorded before launch runs at launch: the chosen data is gone,
 *      the rest stays, and the result is announced once.
 *
 * Every folder is the run's own: the fixture's temp app data and its isolated
 * Flow folder. Nothing here reaches the real app data, ~/plan-flow or ~/.flow.
 */

const SETTINGS = '.fl-settings-page'

async function openAppSettings(app: ElectronApplication, window: Page): Promise<void> {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (/settings|preferences/i.test(item.label)) {
          item.click()
          return
        }
      }
    }
  })
  await expect(window.locator(SETTINGS)).toBeVisible({ timeout: 8000 })
  await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
}

base('the reset section opens closed, lists every kind of data, and confirms only on the typed word', async ({ app, window, userDataDir }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  // Replace the schedule channel in main: record the request, restart nothing.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __resetRequests: unknown[] }
    g.__resetRequests = []
    ipcMain.removeHandler('reset:schedule')
    ipcMain.handle('reset:schedule', (_event, request: unknown) => {
      g.__resetRequests.push(request)
      return { ok: false, detail: 'Recorded by the test.' }
    })
  })

  await openAppSettings(app, window)
  const section = window.locator('.fl-reset')
  await expect(section).toBeVisible()
  await expect(section.locator('.fl-reset-title')).toHaveText('Reset Flow')
  // Closed: one button, no checkboxes.
  await expect(section.locator('input[type="checkbox"]')).toHaveCount(0)
  await section.locator('[data-action="reset-open"]').click()

  await expect(section.locator('input[type="checkbox"]')).toHaveCount(15)
  await expect(section.locator('input[type="checkbox"]:checked')).toHaveCount(0)
  // The counts arrive from main.
  await expect(section.locator('[data-item="conversations"] .fl-reset-size')).not.toHaveText('')
  const go = section.locator('[data-action="reset-selected"]')
  await expect(go).toBeDisabled()

  await section.locator('[data-item="tasks"] input').check()
  await section.locator('[data-item="logs-caches"] input').check()
  await expect(section.locator('.fl-reset-foot')).toContainText('2 of 15 selected')
  await expect(go).toBeEnabled()
  if (process.env['FLOW_E2E_SHOTS']) await section.screenshot({ path: join(process.env['FLOW_E2E_SHOTS'], 'reset-section.png') })
  await go.click()

  const dialog = window.locator('.fl-reset-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('h2')).toHaveText('Delete 2 kinds of Flow data?')
  await expect(dialog.locator('li')).toHaveCount(2)
  const confirm = dialog.locator('[data-action="reset-confirm"]')
  await expect(confirm).toBeDisabled()
  await dialog.locator('input').fill('dele')
  await expect(confirm).toBeDisabled()
  await dialog.locator('input').fill('delete')
  await expect(confirm).toBeEnabled()
  if (process.env['FLOW_E2E_SHOTS']) await window.screenshot({ path: join(process.env['FLOW_E2E_SHOTS'], 'reset-dialog.png') })
  await confirm.click()

  // The request reached main exactly as chosen, and the refusal is shown.
  await expect(dialog.locator('.fl-reset-message')).toHaveText('Recorded by the test.')
  const requests = await app.evaluate(() => (globalThis as unknown as { __resetRequests: unknown[] }).__resetRequests)
  expect(requests).toEqual([{ items: ['tasks', 'logs-caches'], confirmed: true }])
  expect(existsSync(join(userDataDir, 'reset-pending.json'))).toBe(false)

  // Escape closes the dialog; Hide closes the section and clears the ticks.
  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await section.locator('[data-action="reset-hide"]').click()
  await expect(section.locator('input[type="checkbox"]')).toHaveCount(0)

  expect(errors, errors.join(', ')).toEqual([])
})

const seeded = base.extend({
  userDataDir: async ({ userDataDir }, use) => {
    // A reset confirmed in the previous run, and data for it to find.
    writeFileSync(
      join(userDataDir, 'reset-pending.json'),
      JSON.stringify({ items: ['logs-caches', 'personal-brain'], at: '2026-11-20T00:00:00Z' }),
    )
    mkdirSync(join(userDataDir, 'logs'), { recursive: true })
    writeFileSync(join(userDataDir, 'logs', 'old.log'), 'old')
    const brain = join(userDataDir, 'plan-flow-home', 'brain')
    mkdirSync(join(brain, 'notes'), { recursive: true })
    writeFileSync(join(brain, 'notes', 'idea.md'), '# idea')
    mkdirSync(join(userDataDir, 'run-scripts'), { recursive: true })
    writeFileSync(join(userDataDir, 'run-scripts', 'keep.sh'), 'echo keep')
    await use(userDataDir)
  },
})

seeded('a reset recorded before launch runs at launch and is announced once', async ({ window, userDataDir }) => {
  await expect(window.locator('body')).toBeVisible()
  // Positive first: the app is up, so the launch-time step has run.
  await expect(window.locator('.fl-flow-toast-body', { hasText: 'Flow deleted 2 kinds of data.' })).toBeVisible({ timeout: 15000 })
  expect(existsSync(join(userDataDir, 'reset-pending.json'))).toBe(false)
  expect(existsSync(join(userDataDir, 'logs', 'old.log'))).toBe(false)
  expect(existsSync(join(userDataDir, 'plan-flow-home', 'brain', 'notes', 'idea.md'))).toBe(false)
  // Not chosen, so kept.
  expect(existsSync(join(userDataDir, 'run-scripts', 'keep.sh'))).toBe(true)
  // Taken once.
  expect(existsSync(join(userDataDir, 'reset-outcome.json'))).toBe(false)
})
