import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'

/**
 * Closing the ACTIVE terminal tab (its ✕) must auto-activate the ADJACENT neighbor
 * (removeTab → neighborOf → activateTab) and keep that neighbor's shell LIVE and
 * on-screen — never a blank host. Distinct from terminal-exit-recovery.spec, which
 * covers a shell EXITING (the tab stays, no auto-switch, by design). The
 * close-active → auto-switch path had no e2e guard.
 */
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')

async function ensureShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

async function runCommand(win: Page, cmd: string, marker: string): Promise<void> {
  await win.locator('.fl-term-host:not([hidden])').click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await expect
    .poll(
      async () => ((await activeRows(win).innerText()).match(new RegExp(marker, 'g')) ?? []).length,
      { timeout: 12000 },
    )
    .toBeGreaterThanOrEqual(2)
}

async function activeTabIndex(win: Page): Promise<number> {
  const n = await termTabs(win).count()
  for (let i = 0; i < n; i++) {
    const cls = (await termTabs(win).nth(i).getAttribute('class')) ?? ''
    if (cls.split(/\s+/).includes('active')) return i
  }
  return -1
}

test.afterAll(() => cleanupSeeds())

test('closing the active terminal tab auto-activates the live neighbor (no blank host)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Terminal A (tab 0) — run a command whose output must survive the neighbor close.
  await ensureShell(window)
  await runCommand(window, 'echo SHELL_A_LIVE', 'SHELL_A_LIVE')

  // Terminal B (tab 1) — a second live shell, now the active tab.
  await newBtn(window).click()
  await expect(termTabs(window)).toHaveCount(2)
  await expect.poll(() => activeTabIndex(window)).toBe(1)

  // Close the ACTIVE tab (B) via its ✕ — the neighbor A must auto-activate.
  await window.locator('.fl-term-tabs .tab.active .close').click()

  await expect(termTabs(window)).toHaveCount(1)
  await expect.poll(() => activeTabIndex(window), { timeout: 5000 }).toBe(0)

  // A's host is the visible one and its shell is STILL LIVE — its earlier output
  // is intact (not disposed/blank), and it still runs a fresh command.
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toHaveCount(1)
  await expect(activeRows(window)).toContainText('SHELL_A_LIVE')
  await runCommand(window, 'echo A_STILL_USABLE', 'A_STILL_USABLE')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
