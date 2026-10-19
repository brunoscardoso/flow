import { join } from 'node:path'
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'

/**
 * Terminal TAB SWITCHING — per-tab scrollback isolation + independent liveness.
 *
 * The core promise of terminal tabs: each tab is its own shell with its own
 * scrollback. Clicking between two LIVE tabs must show ONLY the clicked tab's
 * output (no cross-contamination) and each shell must remain independently
 * interactive. Distinct from:
 *   - terminal-close-active-neighbor.spec (verifies A survives B *closing*)
 *   - terminal-background-output-drain.spec (#208, hidden-tab buffer via IPC)
 *   - terminal-exit-recovery.spec (switching after a shell *exits*)
 * None of those drive the plain interactive "two live tabs, click back and
 * forth, assert isolation" path — the most basic thing a user does with tabs.
 */

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')

const MARK_A = 'TABSWITCH_ALPHA_71'
const MARK_B = 'TABSWITCH_BETA_71'
const SCREEN_DIR = join(__dirname, "__screens/terminal-tab-switch")

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
  // >=2 occurrences: the typed command line echo + the command's own output.
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

test('switching between two live terminal tabs isolates scrollback and keeps both shells live', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Tab A (index 0): a live shell with a marker unique to A.
  await ensureShell(window)
  const tabA = await activeTabIndex(window)
  expect(tabA).toBeGreaterThanOrEqual(0)
  await runCommand(window, `echo ${MARK_A}`, MARK_A)

  // Tab B (index 1): a second live shell, now active, with a marker unique to B.
  await newBtn(window).click()
  await expect(termTabs(window)).toHaveCount(2)
  await expect.poll(() => activeTabIndex(window)).toBe(1)
  await runCommand(window, `echo ${MARK_B}`, MARK_B)

  // B is active: its view shows B's marker and MUST NOT show A's — A's
  // scrollback belongs to a different shell/tab.
  await expect(activeRows(window)).toContainText(MARK_B)
  expect(
    (await activeRows(window).innerText()).includes(MARK_A),
    "tab A's output must not leak into tab B's active view",
  ).toBe(false)
  await window.screenshot({ path: `${SCREEN_DIR}/01-tabB-active.png` })

  // Click back to A (index 0). Its view shows A's marker and MUST NOT show B's.
  await termTabs(window).nth(0).click()
  await expect.poll(() => activeTabIndex(window), { timeout: 5000 }).toBe(0)
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toHaveCount(1)
  await expect(activeRows(window)).toContainText(MARK_A)
  expect(
    (await activeRows(window).innerText()).includes(MARK_B),
    "tab B's output must not leak into tab A's active view",
  ).toBe(false)
  await window.screenshot({ path: `${SCREEN_DIR}/02-tabA-active.png` })

  // A's shell is independently live — a fresh command runs in A, not B.
  await runCommand(window, 'echo A_STILL_LIVE', 'A_STILL_LIVE')

  // Click to B again. B's scrollback is intact (its marker) and it never picked
  // up A's fresh command — full isolation across the round-trip.
  await termTabs(window).nth(1).click()
  await expect.poll(() => activeTabIndex(window), { timeout: 5000 }).toBe(1)
  await expect(activeRows(window)).toContainText(MARK_B)
  const bText = await activeRows(window).innerText()
  expect(bText.includes(MARK_A), "A's output must not appear in B after round-trip").toBe(false)
  expect(bText.includes('A_STILL_LIVE'), "A's later command must not appear in B").toBe(false)
  await window.screenshot({ path: `${SCREEN_DIR}/03-tabB-again.png` })

  // B's shell is still independently live.
  await runCommand(window, 'echo B_STILL_LIVE', 'B_STILL_LIVE')

  expect(errors, `uncaught errors during tab switch:\n${errors.join('\n')}`).toHaveLength(0)
})
