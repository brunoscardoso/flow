import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): recovery after a shell EXITS while the panel
 * stays visible, plus the live tab-title cwd tracking. Complements terminal.spec.ts
 * (open/tabs/close/switch) and terminal-exit-restart.spec.ts (hide+reveal auto-start,
 * #439). Those cover the hide→reveal recovery path; this guards the in-place paths a
 * user hits far more often — clicking + to get a fresh shell without hiding the panel,
 * and the tab label following `cd` — neither previously probed end to end.
 *
 * Boot note: the terminal is DOCKED and visible by default (terminalVisible defaults
 * on). After activating a seeded project the strip is project-scoped and starts EMPTY
 * (the boot auto-start was unscoped), so these tests start a scoped shell with + rather
 * than toggling the rail action (which would HIDE the docked panel). The four older
 * terminal specs still toggle-to-open and are stale against this docked default — test
 * debt, tracked separately, not a product regression.
 *
 * Every test captures uncaught errors / console.error and treats them as bug signals.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeRows(win: Page) {
  return win.locator('.fl-term-host:not([hidden]) .xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** Reveal is not needed (docked by default); ensure a scoped live shell via +. */
async function ensureScopedShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
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

async function exitActiveShell(win: Page): Promise<void> {
  await win.locator('.fl-term-host:not([hidden])').click()
  await win.keyboard.type('exit')
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => await activeRows(win).innerText(), { timeout: 8000 })
    .toMatch(/process exited/i)
}

async function activeTabIndex(win: Page): Promise<number> {
  const n = await termTabs(win).count()
  for (let i = 0; i < n; i++) {
    const cls = (await termTabs(win).nth(i).getAttribute('class')) ?? ''
    if (cls.split(/\s+/).includes('active')) return i
  }
  return -1
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal — exit recovery & cwd title', () => {
  // The user path when a shell exits with the panel still open: click + to get a
  // fresh, live shell — no hide/reveal needed. Guards that + is not a dead click
  // after an exit and that the new tab (not the lingering "(exited)" one) is active.
  test('after the only shell exits, + hands back a LIVE shell (panel stays open)', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    await runCommand(window, 'echo BEFORE_EXIT_R', 'BEFORE_EXIT_R')
    await exitActiveShell(window)

    // The exited tab lingers and stays shown (not the empty state).
    await expect(termTabs(window)).toHaveCount(1)
    await expect(termTabs(window).first()).toContainText(/\(exited\)/i)
    await expect(window.locator('.fl-term-empty')).toBeHidden()
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-exit-recovery-01-exited.png` })

    // + opens a second, LIVE shell that becomes active — the dead tab is not active.
    await newBtn(window).click()
    await expect(termTabs(window)).toHaveCount(2)
    await expect(window.locator('.fl-term-tabs .tab.active')).toHaveCount(1)
    await expect(window.locator('.fl-term-tabs .tab.active')).not.toContainText(/\(exited\)/i)

    // Typing reaches a running shell — echoed AND produces output (marker >= 2).
    await runCommand(window, 'echo RECOVERED_VIA_PLUS', 'RECOVERED_VIA_PLUS')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-exit-recovery-02-recovered.png` })

    expect(errors, `uncaught errors during exit recovery:\n${errors.join('\n')}`).toEqual([])
  })

  // Exiting one of several shells must not crash and must leave the LIVE sibling
  // reachable + usable. (The exited tab is kept active by design — VS Code parity —
  // so this guards stability + sibling reachability, not an auto-switch.)
  test('exiting one of two shells leaves the live sibling reachable and usable', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    await runCommand(window, 'echo SHELL_A', 'SHELL_A')

    // Second live shell (B, now active).
    await newBtn(window).click()
    await expect(termTabs(window)).toHaveCount(2)
    await runCommand(window, 'echo SHELL_B', 'SHELL_B')

    // Back to A (index 0), exit it while B stays live.
    await termTabs(window).nth(0).click()
    await expect.poll(() => activeTabIndex(window)).toBe(0)
    await exitActiveShell(window)

    // No crash; both tabs remain, A marked exited.
    await expect(termTabs(window)).toHaveCount(2)
    await expect(termTabs(window).nth(0)).toContainText(/\(exited\)/i)

    // The live sibling B is one click away and still runs commands.
    await termTabs(window).nth(1).click()
    await expect.poll(() => activeTabIndex(window)).toBe(1)
    await expect(termTabs(window).nth(1)).not.toContainText(/\(exited\)/i)
    await runCommand(window, 'echo SIBLING_STILL_LIVE', 'SIBLING_STILL_LIVE')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-exit-recovery-03-sibling-live.png` })

    expect(errors, `uncaught errors during sibling exit:\n${errors.join('\n')}`).toEqual([])
  })

  // The tab label follows the shell's working directory (OSC 7, emitted by macOS
  // zsh on each prompt): cd into a subdir → tab shows the subdir; cd back → reverts.
  test('the tab title tracks the shell cwd across cd (OSC 7)', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    const tab0 = () => termTabs(window).nth(0)
    const startTitle = (await tab0().innerText()).trim()
    expect(startTitle.length, 'tab starts with a non-empty (folder) title').toBeGreaterThan(0)

    await runCommand(window, 'mkdir -p zzsubdir_probe && cd zzsubdir_probe && pwd', 'zzsubdir_probe')
    await expect(tab0()).toContainText(/zzsubdir_probe/, { timeout: 5000 })
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-cwd-title-subdir.png` })

    await window.keyboard.type('cd ..')
    await window.keyboard.press('Enter')
    await expect(tab0()).not.toContainText(/zzsubdir_probe/, { timeout: 5000 })

    expect(errors, `uncaught errors during cwd-title tracking:\n${errors.join('\n')}`).toEqual([])
  })
})
