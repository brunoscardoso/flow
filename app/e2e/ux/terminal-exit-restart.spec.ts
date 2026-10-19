import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX regression — flow 8 (Terminal): behavior after the shell process EXITS.
 *
 * Complements terminal.spec.ts (open/tabs/close/switch/persist). Here we drive
 * the shell to termination (`exit`) and assert the panel stays sane and — after
 * hide+reopen — hands the user a USABLE shell rather than a frozen dead one.
 *
 * The reopen-after-exit case guards issue #439 (now FIXED, issue closed): when the
 * only shell has exited, revealing the panel again auto-starts a live shell (VS Code
 * parity) alongside the lingering `(exited)` tab, instead of stranding the user on
 * the inert dead tab that silently swallows keystrokes. Live regression guard.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeRows(win: Page) {
  return win.locator('.fl-term-host:not([hidden]) .xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')

async function openTerminalWithShell(win: Page): Promise<void> {
  // Docked-visible by default (#674) — the toggle would HIDE it; reveal only
  // when it isn't on screen.
  if (!(await win.locator(sel.terminalRoot).isVisible())) {
    const toggle = win.locator(statusButtonByText('Terminal'))
    await expect(toggle).toBeVisible()
    await toggle.click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  await expect(win.locator('.fl-term-host .xterm').first()).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

async function runCommand(win: Page, cmd: string, marker: string): Promise<void> {
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await expect
    .poll(
      async () => ((await activeRows(win).innerText()).match(new RegExp(marker, 'g')) ?? []).length,
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(2)
}

async function exitShell(win: Page): Promise<void> {
  await win.locator('.fl-term-host:not([hidden])').click()
  await win.keyboard.type('exit')
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => await activeRows(win).innerText(), { timeout: 8000 })
    .toMatch(/process exited/i)
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test.describe('terminal — exit & restart', () => {
  test('typing `exit` terminates the shell: exit banner + (exited) tab, no crash', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo BEFORE_EXIT', 'BEFORE_EXIT')
    await exitShell(window)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-exit-banner.png` })

    // The tab lingers, clearly marked as exited (VS Code keeps exit output).
    await expect(termTabs(window)).toHaveCount(1)
    await expect(termTabs(window).first()).toContainText(/\(exited\)/i)
    await expect(activeRows(window)).toContainText(/process exited/i)

    // No uncaught error from terminating the PTY.
    expect(errors, `uncaught errors during exit:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  // Guards #439 (FIXED, issue closed) — after the only shell exits, reopening the
  // panel must give the user a LIVE shell (auto-start on reveal), not the inert
  // (exited) tab that silently drops keystrokes. ensureStarted now excludes exited
  // tabs from the live-tab check, so revealing after an exit auto-starts a fresh
  // shell. This is a live regression guard for that fix.
  test(
    'reopening the panel after the only shell exited hands back a usable shell (#439)',
    async ({ window }) => {
      const errors = trackErrors(window)
      const proj = await seedProject(window)
      await activateProject(window, proj)

      await openTerminalWithShell(window)
      await exitShell(window)

      const toggle = window.locator(statusButtonByText('Terminal'))
      await toggle.click() // hide
      await expect(window.locator(sel.terminalRoot)).toBeHidden()
      await toggle.click() // reopen
      await expect(window.locator(sel.terminalRoot)).toBeVisible()

      // A fresh LIVE shell auto-starts alongside the lingering (exited) tab, and
      // the new one is the ACTIVE tab — not the dead shell that swallows input.
      await expect(termTabs(window)).toHaveCount(2)
      await expect(window.locator('.fl-term-tabs .tab.active')).toHaveCount(1)
      await expect(window.locator('.fl-term-tabs .tab.active')).not.toContainText(/\(exited\)/i)
      // The ACTIVE (visible) host mounts its xterm — the exited tab's host stays
      // hidden, so target the non-hidden one specifically.
      await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toBeVisible({
        timeout: 15000,
      })

      // Typing must actually reach a running shell — poll for the command to be
      // echoed AND produce output (marker >= 2), robust to shell warm-up time.
      await window.locator('.fl-term-host:not([hidden])').click()
      await window.keyboard.type('echo REOPENED_ALIVE')
      await window.keyboard.press('Enter')
      await expect
        .poll(
          async () =>
            ((await activeRows(window).innerText()).match(/REOPENED_ALIVE/g) ?? []).length,
          { timeout: 12000 },
        )
        .toBeGreaterThanOrEqual(2)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-reopen-after-exit-live.png` })

      expect(errors, `uncaught errors during reopen-after-exit:\n${errors.join('\n')}`).toEqual([])
      cleanupSeeds()
    },
  )
})
