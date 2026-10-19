import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel, statusButtonByText } from '../selectors'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal). Un-probed core seam: the terminal TAB LABEL
 * follows the shell's current directory (OSC 7). Every prior flow-8 probe drove
 * open/run/close/switch/rename/scoping/theme/exit — none asserted that a `cd`
 * in the shell re-titles the tab to the new folder (the "which directory is
 * this terminal in" affordance a user relies on across many tabs).
 *
 * Driven end-to-end: a real interactive login zsh (macOS default) emits OSC 7 on
 * each prompt's precmd, so a `cd` into a distinctively-named subdir of the
 * seeded project must move the tab title to that subdir's basename.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

async function openProjectShell(win: Page): Promise<void> {
  // Terminal may be docked-visible by default; reveal via the toggle if not.
  if (!(await win.locator(sel.terminalRoot).isVisible())) {
    await win.locator(statusButtonByText('Terminal')).click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(termTabs(win).first()).toBeVisible({ timeout: 15000 })
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm')).toBeVisible({ timeout: 15000 })
  // Wait for the shell to print its first prompt.
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

test.afterAll(() => cleanupSeeds())

test('terminal tab title follows the shell cwd after cd (OSC 7)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  const dir = await seedProject(window)
  const subdir = 'zebra_probe_dir_71'
  mkdirSync(join(dir, subdir))
  await activateProject(window, dir)
  await openProjectShell(window)

  await expect(termTabs(window)).toHaveCount(1)
  const projBase = dir.split('/').filter(Boolean).pop() as string

  // The freshly-spawned shell starts in the project root; its first-prompt OSC 7
  // should title the tab with the project folder name.
  await expect
    .poll(async () => (await termTabs(window).first().innerText()).trim(), { timeout: 10000 })
    .toContain(projBase)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-cwd-01-project.png` })

  // cd into a distinctively-named subdir → the tab must re-title to that folder.
  await window.locator('.fl-term-host:not([hidden])').click({ position: { x: 5, y: 5 } })
  await window.keyboard.type(`cd ${subdir}`)
  await window.keyboard.press('Enter')

  await expect
    .poll(async () => (await termTabs(window).first().innerText()).trim(), { timeout: 10000 })
    .toContain(subdir)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-cwd-02-subdir.png` })

  // cd back up → the tab must return to the project folder (not stick on the subdir).
  await window.keyboard.type('cd ..')
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await termTabs(window).first().innerText()).trim(), { timeout: 10000 })
    .toContain(projBase)

  expect(errors, `uncaught errors during cwd-follow flow:\n${errors.join('\n')}`).toEqual([])
})

test('a user-renamed tab is NOT clobbered by a later cd (custom title wins, #774)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  const dir = await seedProject(window)
  const subdir = 'kappa_probe_dir_71'
  mkdirSync(join(dir, subdir))
  await activateProject(window, dir)
  await openProjectShell(window)
  await expect(termTabs(window)).toHaveCount(1)

  // Rename the tab to a custom name.
  const tab = termTabs(window).first()
  await tab.dblclick()
  const renameInput = window.locator('.fl-term-tabs .rename-input')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('deploy watcher')
  await renameInput.press('Enter')
  await expect(tab).toContainText('deploy watcher')

  // cd into a subdir — the shell re-emits OSC 7, but the custom name must persist
  // (a user who named their tab does not want it silently overwritten by cwd).
  await window.locator('.fl-term-host:not([hidden])').click({ position: { x: 5, y: 5 } })
  await window.keyboard.type(`cd ${subdir}`)
  await window.keyboard.press('Enter')

  // Give the OSC 7 / render pipeline time to (wrongly) re-title, then assert the
  // custom name still stands and the cwd folder never leaked into the label.
  await window.waitForTimeout(1500)
  await expect(tab).toContainText('deploy watcher')
  expect((await tab.innerText()).includes(subdir), 'cwd folder must not clobber a custom tab name').toBe(
    false,
  )
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-cwd-03-custom-wins.png` })

  expect(errors, `uncaught errors during custom-vs-cwd flow:\n${errors.join('\n')}`).toEqual([])
})
