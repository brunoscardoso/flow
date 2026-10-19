import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * #774 — rename terminal tabs. Double-click a terminal tab → inline editor;
 * Enter commits, Escape cancels, blur commits (the #719 rename-on-blur
 * convention). A custom name wins over the automatic cwd/window title; an
 * empty commit clears back to automatic.
 */

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const renameInput = (win: Page) => win.locator('.fl-term-tabs .rename-input')

async function ensureShellTab(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(termTabs(win).first()).toBeVisible({ timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('double-click renames a terminal tab; Enter commits, Escape discards (#774)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await ensureShellTab(window)

  const tab = termTabs(window).first()

  // Double-click → inline editor appears, pre-filled with the current title.
  await tab.dblclick()
  await expect(renameInput(window)).toBeVisible()

  // Type a custom name and commit with Enter.
  await renameInput(window).fill('build watcher')
  await renameInput(window).press('Enter')
  await expect(renameInput(window)).toHaveCount(0)
  await expect(termTabs(window).first()).toContainText('build watcher')

  // Escape discards: start another rename, type, Escape — name unchanged.
  await tab.dblclick()
  await expect(renameInput(window)).toBeVisible()
  await renameInput(window).fill('discarded name')
  await renameInput(window).press('Escape')
  await expect(renameInput(window)).toHaveCount(0)
  await expect(termTabs(window).first()).toContainText('build watcher')

  // Blur commits (#719 convention): rename again, click elsewhere.
  await tab.dblclick()
  await renameInput(window).fill('blur committed')
  await window.locator(sel.terminalRoot).click({ position: { x: 10, y: 10 } })
  await expect(renameInput(window)).toHaveCount(0)
  await expect(termTabs(window).first()).toContainText('blur committed')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('right-click tab menu: Close to the Right, then Close All (#735)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await ensureShellTab(window)

  // Three tabs total.
  while ((await termTabs(window).count()) < 3) {
    await newBtn(window).click()
    await window.waitForTimeout(200)
  }
  await expect(termTabs(window)).toHaveCount(3)

  // Right-click the FIRST tab → menu with the close operations.
  await termTabs(window).first().click({ button: 'right' })
  const menu = window.locator('.fl-term-tabs .ctx-menu')
  await expect(menu).toBeVisible()
  // Left is disabled on the first tab (inert-not-silent), Right is enabled.
  await expect(menu.locator('.ctx-item', { hasText: 'Close to the Left' })).toBeDisabled()

  await menu.locator('.ctx-item', { hasText: 'Close to the Right' }).click()
  await expect(termTabs(window)).toHaveCount(1)

  // Close All from the remaining tab.
  await termTabs(window).first().click({ button: 'right' })
  await window.locator('.fl-term-tabs .ctx-menu .ctx-item', { hasText: 'Close All' }).click()
  await expect(termTabs(window)).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
