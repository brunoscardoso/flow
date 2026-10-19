import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'

/**
 * Terminals must open SIDE BY SIDE, not only as tabs (#1133).
 *
 * The panel could show exactly one terminal: every host but the active tab's
 * was hidden, so comparing a server log against a test run meant flipping tabs
 * back and forth. Splitting puts both on screen in one resizable row.
 *
 * Guards the whole loop: split → two live panes → focus follows the click →
 * closing one collapses the row back to the survivor (which stays live).
 */
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const splitBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="Split terminal"]')
/** Panes currently on screen — the row. */
const panes = (win: Page) => win.locator('.fl-term-split .fl-term-host:not([hidden])')

async function ensureShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await expect(panes(win).first().locator('.xterm')).toBeVisible({ timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('splitting shows two live terminals side by side (#1133)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)
  // The terminal is docked-VISIBLE by default (#674), and since #1341 it
  // survives opening your first project — so clicking the rail item now
  // HIDES it. Reveal only when it isn't already on screen.
  if (!(await window.locator('.fl-term-root').isVisible())) {
    await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Terminal"]').click()
  }
  await ensureShell(window)

  // One terminal → one pane. The pre-split experience, unchanged.
  await expect(panes(window)).toHaveCount(1)
  await expect(splitBtn(window)).toBeEnabled()

  await splitBtn(window).click()

  // Two panes, both alive: a split that leaves a blank host is the bug in a
  // new costume.
  await expect(panes(window)).toHaveCount(2, { timeout: 20000 })
  await expect(panes(window).nth(0).locator('.xterm')).toBeVisible({ timeout: 15000 })
  await expect(panes(window).nth(1).locator('.xterm')).toBeVisible({ timeout: 15000 })
  // Genuinely side by side — the second pane starts to the right of the first,
  // not stacked on top of it.
  const left = await panes(window).nth(0).boundingBox()
  const right = await panes(window).nth(1).boundingBox()
  expect(left && right && right.x > left.x, 'the new pane sits beside the old one').toBe(true)

  // The split terminal is the focused one, and the marker says so.
  await expect(panes(window).nth(1)).toHaveClass(/focused/)

  // Focus follows the click: clicking back into the left pane moves both the
  // marker and the tab strip's selection.
  await panes(window).nth(0).click()
  await expect(panes(window).nth(0)).toHaveClass(/focused/)
  await expect(panes(window).nth(1)).not.toHaveClass(/focused/)

  // Closing the focused pane's tab collapses the row to the survivor, which
  // must still be live (not a blank host).
  await window.locator('.fl-term-tabs .tab.active .close').click()
  await expect(panes(window)).toHaveCount(1, { timeout: 15000 })
  await expect(panes(window).first().locator('.xterm')).toBeVisible()
  // A single pane needs no focus marker — there is nothing to disambiguate.
  await expect(panes(window).first()).not.toHaveClass(/focused/)

  expect(errors, `renderer errors during split flow:\n${errors.join('\n')}`).toEqual([])
})
