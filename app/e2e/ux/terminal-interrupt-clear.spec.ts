import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): control-key forwarding to the live PTY, the two
 * most-reflexive real-user recovery gestures, as live GREEN guards:
 *
 *   1. Ctrl+C interrupts a running command and returns to a usable prompt.
 *   2. Ctrl+L clears the visible screen (the shell's own clear).
 *
 * Both are ordinary keystrokes that xterm must forward through `onData` →
 * `api.terminal.write` to the shell — the ONLY thing terminal-panel.ts's
 * `attachCustomKeyEventHandler` intercepts is cmd+L (add-to-chat, #152); every
 * other key, including Ctrl+C and Ctrl+L, is meant to flow straight to the PTY.
 * If either keystroke were swallowed (e.g. by a shell shortcut router or focus
 * theft), a user with a runaway command would be stranded — a core stability
 * gap. The existing terminal specs cover open/run/tabs/close/resize/exit but
 * NEVER a control-key interrupt or a clear, so this path was un-guarded.
 *
 * Docked-visible by default (terminalVisible defaults on, shell.ts) — we start a
 * scoped shell with + (never toggle-to-open, which HIDES the docked panel), per
 * terminal-resize.spec.ts.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeHost(win: Page) {
  return win.locator('.fl-term-host:not([hidden])')
}
function activeRows(win: Page) {
  return activeHost(win).locator('.xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

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

async function rowsText(win: Page): Promise<string> {
  return (await activeRows(win).innerText()) ?? ''
}

async function focusShell(win: Page): Promise<void> {
  await activeHost(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
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

test.describe('terminal — control-key forwarding (interrupt + clear)', () => {
  test('Ctrl+C interrupts a running command and the prompt recovers', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await ensureScopedShell(window)
    await focusShell(window)

    // Start a long-running command that blocks the prompt for well over the
    // recovery window below. If Ctrl+C did NOT interrupt it, the follow-up echo
    // could not run for ~30s and the assertion would time out.
    await window.keyboard.type('sleep 30')
    await window.keyboard.press('Enter')
    // Confirm the command line was accepted (echoed by the shell).
    await expect
      .poll(async () => /sleep 30/.test(await rowsText(window)), { timeout: 8000 })
      .toBe(true)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-interrupt-01-running.png` })

    // The reflexive interrupt.
    await window.keyboard.press('Control+c')

    // A fresh command must run promptly — proving the shell returned to a live
    // prompt (the sleep was interrupted, not silently still blocking).
    await window.keyboard.type('echo AFTER_INTERRUPT_7B4C')
    await window.keyboard.press('Enter')
    await expect
      .poll(
        async () =>
          ((await rowsText(window)).match(/AFTER_INTERRUPT_7B4C/g) ?? []).length,
        { timeout: 8000 },
      )
      .toBeGreaterThanOrEqual(2) // echoed command line + its output
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-interrupt-02-recovered.png` })

    expect(errors, `uncaught errors during Ctrl+C interrupt:\n${errors.join('\n')}`).toEqual([])
  })

  test('Ctrl+L clears the visible screen', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await ensureScopedShell(window)
    await focusShell(window)

    // Put a distinctive marker into the viewport.
    await window.keyboard.type('echo CLEAR_MARKER_D91E')
    await window.keyboard.press('Enter')
    await expect
      .poll(
        async () => ((await rowsText(window)).match(/CLEAR_MARKER_D91E/g) ?? []).length,
        { timeout: 8000 },
      )
      .toBeGreaterThanOrEqual(2)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-clear-01-before.png` })

    // Ctrl+L → the shell clears the visible screen; the marker scrolls out of the
    // viewport (xterm-rows renders only the visible grid, not scrollback).
    await focusShell(window)
    await window.keyboard.press('Control+l')

    await expect
      .poll(async () => /CLEAR_MARKER_D91E/.test(await rowsText(window)), { timeout: 8000 })
      .toBe(false)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-clear-02-after.png` })

    // The shell is still live after the clear — a fresh command runs.
    await window.keyboard.type('echo AFTER_CLEAR_5A2F')
    await window.keyboard.press('Enter')
    await expect
      .poll(
        async () => ((await rowsText(window)).match(/AFTER_CLEAR_5A2F/g) ?? []).length,
        { timeout: 8000 },
      )
      .toBeGreaterThanOrEqual(2)

    expect(errors, `uncaught errors during Ctrl+L clear:\n${errors.join('\n')}`).toEqual([])
  })
})
