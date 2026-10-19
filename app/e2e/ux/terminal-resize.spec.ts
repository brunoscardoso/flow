import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): the RESIZE rotation item, as a live GREEN guard.
 *
 * Growing/shrinking the window must reflow the live PTY so the shell's column
 * grid follows the panel width (the ResizeObserver → fitTab → `term.resize` +
 * `api.terminal.resize` path in terminal-panel.ts), with no uncaught error and
 * the shell still usable afterward. We assert the SHELL's own view of the grid
 * (`tput cols`) actually tracks the width — narrowing shrinks it, widening grows
 * it — not just that the panel didn't crash.
 *
 * terminal-scoping.spec.ts also intends to cover resize, but its helper toggles
 * the rail action to "open" the terminal, which HIDES the docked-by-default panel
 * (terminalVisible defaults on) — so it is stale/RED test debt. This spec drives
 * the correct docked-aware path (start a scoped shell with +, per
 * terminal-exit-recovery.spec.ts) and guards the refit precisely.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeRows(win: Page) {
  return win.locator('.fl-term-host:not([hidden]) .xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** Docked by default; after activating a project the strip is empty — start a
 *  scoped live shell with + (never toggle-to-open, which would hide the panel). */
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
    .toBeGreaterThanOrEqual(1)
}

/** What the running shell reports as its terminal width, via `tput cols`. */
async function reportedCols(win: Page, tag: string): Promise<number> {
  await win.locator('.fl-term-host:not([hidden])').click()
  const marker = `COLS_${tag}`
  await win.keyboard.type(`echo ${marker}=$(tput cols)`)
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => new RegExp(`${marker}=\\d+`).test(await activeRows(win).innerText()), {
      timeout: 8000,
    })
    .toBe(true)
  const m = (await activeRows(win).innerText()).match(new RegExp(`${marker}=(\\d+)`))
  return m ? parseInt(m[1], 10) : -1
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

test.describe('terminal — resize reflow', () => {
  test('the live shell grid follows the window width (narrow shrinks, widen grows)', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    const wide1 = await reportedCols(window, 'WIDE1')
    expect(wide1, 'the shell reports a real column grid at the initial size').toBeGreaterThan(0)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-resize-01-initial.png` })

    // Shrink the window — the panel narrows and the PTY must reflow smaller.
    await window.setViewportSize({ width: 700, height: 800 })
    await expect
      .poll(async () => await reportedCols(window, 'NARROW'), { timeout: 12000 })
      .toBeLessThan(wide1)
    const narrow = await reportedCols(window, 'NARROW2')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-resize-02-narrow.png` })

    // Grow it wider — the grid must expand again past the narrow width.
    await window.setViewportSize({ width: 1400, height: 800 })
    await expect
      .poll(async () => await reportedCols(window, 'WIDE2'), { timeout: 12000 })
      .toBeGreaterThan(narrow)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-resize-03-wide.png` })

    // The shell is still alive and usable after two reflows — no lost session.
    await runCommand(window, 'echo RESIZE_STILL_LIVE', 'RESIZE_STILL_LIVE')

    expect(errors, `uncaught errors during resize reflow:\n${errors.join('\n')}`).toEqual([])
  })
})
