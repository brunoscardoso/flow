import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): open, run a command, tabs, resize, close.
 *
 * Drives the REAL terminal surface (a live node-pty shell) the way a user does,
 * rather than only toggling the panel (terminal.spec.ts at the repo root covers
 * the toggle). Each test captures uncaught errors / console.error during the
 * flow and treats them as bug signals. A throwaway git repo is seeded as the
 * active project so terminals are project-scoped (the normal user path).
 */

const SCREEN_DIR = 'e2e/ux/__screens'

/** The single visible terminal host (the others are [hidden]). */
function activeHost(win: Page) {
  return win.locator('.fl-term-host:not([hidden])')
}
function activeRows(win: Page) {
  return activeHost(win).locator('.xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')

/** Reveal the terminal panel and wait for the surface + first xterm to mount. */
async function openTerminalWithShell(win: Page): Promise<void> {
  // Docked-visible by default (#674) — the toggle would HIDE it; reveal only
  // when it isn't on screen.
  if (!(await win.locator(sel.terminalRoot).isVisible())) {
    const toggle = win.locator(statusButtonByText('Terminal'))
    await expect(toggle).toBeVisible()
    await toggle.click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  // xterm mounts lazily via dynamic import; the shell auto-starts (VS Code parity).
  await expect(win.locator('.fl-term-host .xterm').first()).toBeVisible({ timeout: 15000 })
  // The shell should print a prompt (non-whitespace) shortly.
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

/** Type a command into the active terminal and wait for its echoed output. */
async function runCommand(win: Page, cmd: string, marker: string): Promise<void> {
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  // The marker appears at least twice: the echoed command line + the output.
  await expect
    .poll(
      async () => (((await activeRows(win).innerText()).match(new RegExp(marker, 'g')) ?? []).length),
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

/** Visual position (0-based, left→right) of the tab currently carrying `.active`. */
async function activeTabIndex(win: Page): Promise<number> {
  const count = await termTabs(win).count()
  for (let i = 0; i < count; i++) {
    const cls = (await termTabs(win).nth(i).getAttribute('class')) ?? ''
    if (cls.split(/\s+/).includes('active')) return i
  }
  return -1
}

test.describe('terminal flow', () => {
  test('open → auto-start → run command → new tab → close → empty state', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await expect(termTabs(window)).toHaveCount(1)
    await expect(window.locator('.fl-term-empty')).toBeHidden()
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-01-autostart.png` })

    // Run a real command and see its output. (Click in first: the shell that
    // auto-started during project activation must not steal focus from the
    // flow-settings overlay that was open at the time, #683.)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo FLOWPROBE_9F3A2', 'FLOWPROBE_9F3A2')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-02-command-output.png` })

    // Open a second terminal via the + button.
    await window.locator('.fl-term-tool[aria-label="New terminal"]').click()
    await expect(termTabs(window)).toHaveCount(2)
    await expect(window.locator('.fl-term-host .xterm')).toHaveCount(2)

    // Close the active tab → a sibling takes over; one terminal remains active.
    const activeTab = window.locator('.fl-term-tabs .tab.active')
    await activeTab.hover()
    await activeTab.locator('.close').click()
    await expect(termTabs(window)).toHaveCount(1)
    await expect(window.locator('.fl-term-empty')).toBeHidden()
    await expect(window.locator('.fl-term-tabs .tab.active')).toHaveCount(1)

    // Close the last tab → the panel gives its slot back to the editor (#940:
    // a user closing their last terminal hides the panel, instead of leaving
    // the old "No terminals — press + to open one" strip behind).
    const last = termTabs(window).first()
    await last.hover()
    await last.locator('.close').click()
    await expect(window.locator('.fl-term-root')).toHaveCount(0)

    // ⌃` brings it back with a live shell (a reveal auto-starts one, #439) —
    // not a dead, empty panel.
    await window.keyboard.press('Control+Backquote')
    await expect(termTabs(window)).toHaveCount(1, { timeout: 20000 })
    await expect(window.locator('.fl-term-empty')).toBeHidden()
    await expect(window.locator('.fl-term-host .xterm')).toHaveCount(1)

    expect(errors, `uncaught errors during terminal flow:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  test('the shell is focused on open — typing works without clicking in', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    // A USER gesture that opens a terminal must focus it (the boot/switch
    // auto-start deliberately does not steal focus while the activation
    // overlay is up, #683 — so drive the + button, a real user open).
    await window.locator('.fl-term-tool[aria-label="New terminal"]').click()
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused({
      timeout: 15000,
    })

    // Type immediately — output must appear, proving the auto-focus round-trip.
    await runCommand(window, 'echo AUTOFOCUS_TYPED', 'AUTOFOCUS_TYPED')

    expect(errors, `uncaught errors during auto-focus flow:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  test('hiding and reopening the panel preserves the shell and its scrollback', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo PERSIST_MARKER_A', 'PERSIST_MARKER_A')

    const toggle = window.locator(statusButtonByText('Terminal'))
    await toggle.click() // hide
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await toggle.click() // reopen
    await expect(window.locator(sel.terminalRoot)).toBeVisible()

    // Same single terminal, scrollback intact (no lost session, no re-spawn).
    await expect(termTabs(window)).toHaveCount(1)
    await expect
      .poll(async () => /PERSIST_MARKER_A/.test(await activeRows(window).innerText()), {
        timeout: 5000,
      })
      .toBe(true)

    expect(errors, `uncaught errors during hide/reopen:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  test('switching between terminals shows each tab’s own output (no bleed)', async ({ window }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo TERM_A_ONLY', 'TERM_A_ONLY')

    // Open a second terminal and run a distinct command there.
    await window.locator('.fl-term-tool[aria-label="New terminal"]').click()
    await expect(termTabs(window)).toHaveCount(2)
    await expect(window.locator('.fl-term-host .xterm')).toHaveCount(2)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo TERM_B_ONLY', 'TERM_B_ONLY')

    // Switch to the first tab — it must show A, never B.
    await termTabs(window).first().click()
    await expect
      .poll(async () => await activeRows(window).innerText(), { timeout: 5000 })
      .toMatch(/TERM_A_ONLY/)
    expect(await activeRows(window).innerText()).not.toMatch(/TERM_B_ONLY/)

    // Switch to the second tab — it must show B, never A.
    await termTabs(window).nth(1).click()
    await expect
      .poll(async () => await activeRows(window).innerText(), { timeout: 5000 })
      .toMatch(/TERM_B_ONLY/)
    expect(await activeRows(window).innerText()).not.toMatch(/TERM_A_ONLY/)

    expect(errors, `uncaught errors during tab switching:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })

  // Regression guard for issue #408. Closing the ACTIVE middle tab should move
  // focus to the ADJACENT tab (right, else left) — the convention the editor
  // tab strip already implements via `neighborOf`. #408 is FIXED: closing the
  // active middle tab now activates the neighbor (not the left-most terminal).
  // This guards that fixed behavior as a passing regression test.
  test('closing the active middle tab activates the neighbor, not the first tab (#408)', async ({
    window,
  }) => {
    const proj = await seedProject(window)
    await activateProject(window, proj)

    await openTerminalWithShell(window)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo TAB_ONE', 'TAB_ONE')

    const newButton = window.locator('.fl-term-tool[aria-label="New terminal"]')
    await newButton.click()
    await expect(termTabs(window)).toHaveCount(2)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo TAB_TWO', 'TAB_TWO')

    await newButton.click()
    await expect(termTabs(window)).toHaveCount(3)
    await window.locator('.fl-term-host:not([hidden])').click()
    await runCommand(window, 'echo TAB_THREE', 'TAB_THREE')

    // Focus the middle tab (index 1), then close it.
    await termTabs(window).nth(1).click()
    await expect.poll(() => activeTabIndex(window)).toBe(1)
    const middle = window.locator('.fl-term-tabs .tab.active')
    await middle.hover()
    await middle.locator('.close').click()
    await expect(termTabs(window)).toHaveCount(2)

    // The right neighbor (TAB_THREE, now index 1) should be active — NOT the
    // left-most terminal (index 0, TAB_ONE).
    await expect.poll(() => activeTabIndex(window)).toBe(1)
    const shown = await activeRows(window).innerText()
    expect(shown, 'the neighbor terminal (TAB_THREE) should be showing').toMatch(/TAB_THREE/)
    expect(shown, 'must not have jumped back to the first terminal').not.toMatch(/TAB_ONE/)

    cleanupSeeds()
  })
})
