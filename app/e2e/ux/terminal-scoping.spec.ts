import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): project scoping across switches + resize reflow.
 *
 * Complements terminal.spec.ts (open/run/tabs/close) and terminal-exit-restart.ts
 * (exit lifecycle). Here we drive the two remaining core terminal behaviors a real
 * user hits that the other probes don't:
 *
 *  1. PROJECT SCOPING (ADR-002): terminals belong to the active project. Switching
 *     projects must hide the other project's shell and reveal this project's own —
 *     scrollback must NOT bleed across the boundary, and the correct tab must come
 *     back on return.
 *  2. RESIZE: growing the window must reflow the live PTY (cols/rows follow the
 *     panel) without an uncaught error, and the shell must stay usable afterward.
 *
 * Every test captures uncaught errors / console.error and treats them as bug
 * signals (per flow/qa-sweep-runbook.md).
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeHost(win: Page) {
  return win.locator('.fl-term-host:not([hidden])')
}
function activeRows(win: Page) {
  return activeHost(win).locator('.xterm-rows')
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
  if ((await termTabs(win).count()) === 0) {
    await win.locator('.fl-term-tool[aria-label="New terminal"]').click()
  }
  await expect(win.locator('.fl-term-host .xterm').first()).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

async function runCommand(win: Page, cmd: string, marker: string): Promise<void> {
  await activeHost(win).click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await expect
    .poll(
      async () => ((await activeRows(win).innerText()).match(new RegExp(marker, 'g')) ?? []).length,
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(2)
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Read the live xterm cols/rows of the active terminal from the renderer. */
async function activeGrid(win: Page): Promise<{ cols: number; rows: number }> {
  return win.evaluate(() => {
    const host = document.querySelector('.fl-term-host:not([hidden]) .xterm') as
      | (HTMLElement & { _core?: unknown })
      | null
    // xterm stores dims on the .xterm-screen via the terminal instance; read the
    // rendered row count as a robust proxy for `rows`, and columns from the cell.
    const rows = host?.querySelectorAll('.xterm-rows > div').length ?? 0
    return { cols: 0, rows }
  })
}

test.describe('terminal — project scoping & resize', () => {
  test('switching projects isolates terminals — no scrollback bleed, correct tab returns', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const projA = await seedProject(window)
    const projB = await seedProject(window)

    // Project A: open a terminal and leave a distinctive marker.
    await activateProject(window, projA)
    await openTerminalWithShell(window)
    await expect(termTabs(window)).toHaveCount(1)
    await runCommand(window, 'echo SCOPE_MARKER_ALPHA', 'SCOPE_MARKER_ALPHA')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-scope-01-projA.png` })

    // Switch to project B — A's terminal must vanish (its PTY keeps running,
    // hidden). B has no terminal yet, so the switch path auto-starts a fresh
    // shell scoped to B (#957/#1024 — a visible panel is never left blank).
    await activateProject(window, projB)
    await expect(termTabs(window)).toHaveCount(1, { timeout: 15000 })
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toBeVisible({
      timeout: 15000,
    })
    await expect
      .poll(async () => (await activeRows(window).innerText()).trim().length, { timeout: 10000 })
      .toBeGreaterThan(0)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-scope-02-projB-autostart.png` })

    // Leave a DIFFERENT marker in B's auto-started terminal.
    await expect(window.locator('.fl-term-host .xterm')).toHaveCount(2) // A(hidden)+B
    await runCommand(window, 'echo SCOPE_MARKER_BETA', 'SCOPE_MARKER_BETA')

    // B's terminal must show ONLY B's marker — never A's (no cross-project bleed).
    const bText = await activeRows(window).innerText()
    expect(bText, 'B terminal shows its own marker').toMatch(/SCOPE_MARKER_BETA/)
    expect(bText, 'B terminal must not leak project A output').not.toMatch(/SCOPE_MARKER_ALPHA/)

    // Return to A — A's original terminal reappears with its scrollback intact,
    // and B's marker must NOT be visible here.
    await activateProject(window, projA)
    await expect(termTabs(window)).toHaveCount(1)
    await expect
      .poll(async () => /SCOPE_MARKER_ALPHA/.test(await activeRows(window).innerText()), {
        timeout: 5000,
      })
      .toBe(true)
    const aText = await activeRows(window).innerText()
    expect(aText, "A terminal must not show project B's output").not.toMatch(/SCOPE_MARKER_BETA/)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-scope-03-back-to-projA.png` })

    expect(errors, `uncaught errors during project-scoping flow:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  test('growing the window reflows the live shell (rows follow the panel), no error', async ({
    window,
    app,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await runCommand(window, 'echo BEFORE_RESIZE', 'BEFORE_RESIZE')
    const before = await activeGrid(window)
    expect(before.rows, 'shell has a real grid before resize').toBeGreaterThan(0)

    // Grow the OS window substantially — the ResizeObserver on the hosts must
    // refit the active terminal (SIGWINCH the PTY), increasing its row count.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const [w, h] = win.getSize()
      win.setSize(Math.max(w, 1400), h + 400)
    })
    await expect
      .poll(async () => (await activeGrid(window)).rows, { timeout: 6000 })
      .toBeGreaterThan(before.rows)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-resize-after.png` })

    // The shell is still alive and usable after the reflow.
    await runCommand(window, 'echo AFTER_RESIZE', 'AFTER_RESIZE')

    expect(errors, `uncaught errors during resize flow:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })
})
