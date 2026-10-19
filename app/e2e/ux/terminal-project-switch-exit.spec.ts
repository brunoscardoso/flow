import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel, statusButtonByText } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal). Un-probed core seam: what the user is handed when
 * they ARRIVE at a project's terminal via a PROJECT SWITCH.
 *
 * Flow-8 has 20+ probes covering open/run/tabs/close/resize/exit/scoping/theme/
 * cwd/drain/rename — and the exit lifecycle is guarded on the *reveal* arrival
 * path (#439: hide+reopen must auto-start a fresh live shell instead of handing
 * back the dead "(exited)" tab) and the *window-reopen* path (#446). The third
 * arrival path — `setActiveProject` (ADR-002 project scoping) — was never driven
 * against an exited shell.
 *
 * It behaves differently: `setActiveProject` picks `firstVisibleTab()` (terminal-
 * panel.ts) rather than the live-tab check `ensureStarted()` uses
 * (`hasLiveVisibleTab`, terminal-reveal.ts), and it never calls `ensureStarted()`
 * — so returning to a project whose only shell exited re-activates and FOCUSES
 * the dead tab, silently swallowing every keystroke.
 *
 * Guards here:
 *  1. LIVE — the #439 reveal path still recovers (hide+reveal after `exit` yields
 *     a usable shell). This is the sibling contrast that makes the switch-path
 *     behaviour a defect rather than a design choice.
 *  2. LIVE — a project switch away and back with a LIVE shell keeps that shell
 *     live and usable (the switch path itself is sound; the defect is specific
 *     to the exited case).
 *  3. LIVE (#957) — returning to a project whose only shell exited hands the
 *     user a USABLE terminal: setActiveProject is now liveness-aware
 *     (reconcileActiveTab prefers live tabs) and calls ensureStarted(), the
 *     same live-tab check the reveal path uses.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** The terminal is docked-visible by default (#674) — reveal only if it isn't. */
async function revealTerminal(win: Page): Promise<void> {
  if (!(await win.locator(sel.terminalRoot).isVisible())) {
    await win.locator(statusButtonByText('Terminal')).click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
}

/** Wait for the active tab's xterm to be attached and printing its first prompt. */
async function waitLiveShell(win: Page): Promise<void> {
  await expect(activeHost(win).locator('.xterm')).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
}

/** Ensure the active project has a shell open and ready (auto-start or `+`). */
async function ensureShell(win: Page): Promise<void> {
  await revealTerminal(win)
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await waitLiveShell(win)
}

/** Type `exit` into the active shell and wait for the tab to be marked exited. */
async function exitActiveShell(win: Page): Promise<void> {
  await activeHost(win).click({ position: { x: 5, y: 5 } })
  await win.keyboard.type('exit')
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => (await termTabs(win).allInnerTexts()).join('|'), { timeout: 10000 })
    .toContain('(exited)')
}

/** Whether the terminal the user is currently shown actually runs a command. */
async function terminalRunsCommand(win: Page, marker: string): Promise<boolean> {
  await activeHost(win).click({ position: { x: 5, y: 5 } })
  await win.keyboard.type(`echo ${marker}`)
  await win.keyboard.press('Enter')
  try {
    await expect
      .poll(async () => (await activeRows(win).innerText()).includes(marker), { timeout: 6000 })
      .toBe(true)
    return true
  } catch {
    return false
  }
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

test('hide+reveal after the only shell exits hands back a USABLE shell (#439 guard)', async ({
  window,
}) => {
  const errors = trackErrors(window)

  const projectA = await seedProject(window, 'flow-ux-tswA-')
  await activateProject(window, projectA)
  await ensureShell(window)
  await exitActiveShell(window)

  // Hide, then reveal — flow:terminal-shown → ensureStarted() → the exited tab is
  // NOT counted as live, so a fresh shell auto-starts and becomes active.
  const toggle = window.locator(statusButtonByText('Terminal'))
  await toggle.click()
  await expect(window.locator(sel.terminalRoot)).toBeHidden()
  await toggle.click()
  await expect(window.locator(sel.terminalRoot)).toBeVisible()
  await waitLiveShell(window)

  expect(
    await terminalRunsCommand(window, 'REVEAL_MARK_7'),
    'after hide+reveal the terminal the user is shown must run commands (#439)',
  ).toBe(true)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-switch-01-reveal-recovers.png` })

  expect(errors, `uncaught errors during reveal recovery:\n${errors.join('\n')}`).toEqual([])
})

test('switching away and back with a LIVE shell keeps it live and usable', async ({ window }) => {
  const errors = trackErrors(window)

  const projectA = await seedProject(window, 'flow-ux-tslA-')
  const projectB = await seedProject(window, 'flow-ux-tslB-')

  await activateProject(window, projectA)
  await ensureShell(window)
  const aTab = (await termTabs(window).allInnerTexts()).join('|')

  await activateProject(window, projectB)
  await ensureShell(window)

  // Back to A — its own (still live) shell must come back, scoped to A alone.
  await activateProject(window, projectA)
  await expect
    .poll(async () => (await termTabs(window).allInnerTexts()).join('|'), { timeout: 8000 })
    .toBe(aTab)
  await waitLiveShell(window)

  expect(
    await terminalRunsCommand(window, 'SWITCH_LIVE_7'),
    "returning to a project must hand back its OWN live shell, still usable",
  ).toBe(true)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-switch-02-live-roundtrip.png` })

  expect(errors, `uncaught errors during live switch round-trip:\n${errors.join('\n')}`).toEqual([])
})

test(
  'returning to a project whose only shell exited hands back a USABLE terminal (#957)',
  async ({ window }) => {
    const errors = trackErrors(window)

    const projectA = await seedProject(window, 'flow-ux-tsxA-')
    const projectB = await seedProject(window, 'flow-ux-tsxB-')

    await activateProject(window, projectA)
    await ensureShell(window)

    await activateProject(window, projectB)
    await ensureShell(window)
    await exitActiveShell(window)

    // Away to A …
    await activateProject(window, projectA)
    await waitLiveShell(window)

    // … and BACK to B. Every other arrival path (boot #446, reveal #439, ⌘⇧`)
    // gives the user a live shell here; the project switch re-activates and
    // focuses B's DEAD tab instead, swallowing every keystroke with no feedback.
    await activateProject(window, projectB)
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await window.waitForTimeout(1500)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-switch-03-return-after-exit.png` })

    expect(
      await terminalRunsCommand(window, 'SWITCH_EXIT_7'),
      'returning to a project whose shell exited must present a usable terminal, not a dead one',
    ).toBe(true)

    expect(errors, `uncaught errors during switch-after-exit:\n${errors.join('\n')}`).toEqual([])
  },
)
