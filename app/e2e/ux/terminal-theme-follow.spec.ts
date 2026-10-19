import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { openSettings } from './fixtures/settings'

/**
 * UX sweep — flow 8 (Terminal): the OPEN terminal follows the app theme.
 *
 * xterm (like Monaco) cannot read CSS custom properties, so terminal-panel.ts
 * re-themes every open xterm imperatively off the same `<html data-theme>` signal
 * the rest of the app follows (a MutationObserver, #399). Every prior flow-8 probe
 * drives shell lifecycle (open/run/tabs/close/exit/resize/scope/interrupt/select-
 * chat) — NONE drive the live theme flip. If the observer missed, an open terminal
 * would stay a dark rectangle inside a light app (or vice-versa): a jarring visual
 * mismatch on a core surface. This guards that a user flipping App theme in
 * Settings re-themes ALL open terminals in place, both directions, no error.
 *
 * Observable: xterm (DOM renderer) paints `theme.foreground` onto the
 * `.xterm-rows` text `color` — dark #cccccc → rgb(204, 204, 204), light #37352f →
 * rgb(55, 53, 47). The background is canvas/per-cell painted (no stable CSS
 * property), so the foreground color is the reliable DOM signal of the live theme.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const DARK_FG = 'rgb(204, 204, 204)' // XTERM_THEME_DARK.foreground #cccccc
const LIGHT_FG = 'rgb(55, 53, 47)' // XTERM_THEME_LIGHT.foreground #37352f

function activeHost(win: Page) {
  return win.locator('.fl-term-host:not([hidden])')
}
function activeRows(win: Page) {
  return activeHost(win).locator('.xterm-rows')
}
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** Every open terminal (visible OR hidden — the observer re-themes them all)
 *  must carry `target` as its rows `color`. Returns false until at least one row
 *  exists AND all of them match, so a poll converges on the settled theme. */
async function everyRowColorIs(win: Page, target: string): Promise<boolean> {
  return win.evaluate((t) => {
    const rows = [...document.querySelectorAll('.fl-term-host .xterm-rows')]
    return rows.length > 0 && rows.every((el) => getComputedStyle(el).color === t)
  }, target)
}

/** The terminal panel is docked-visible by default (terminalVisible on, shell.ts);
 *  start a scoped shell with + — NEVER toggle-to-open, which HIDES the panel. */
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

async function setAppTheme(win: Page, mode: 'light' | 'dark'): Promise<void> {
  // Settings is a page in the editor area now (its App group holds the theme),
  // not a modal over the window — the docked terminal stays on screen under it,
  // which is exactly the state this spec measures.
  await openSettings(win, 'App')
  const themeSelect = win.locator('.fl-settings-page select[aria-label="App theme"]')
  await expect(themeSelect).toBeVisible()
  await themeSelect.selectOption(mode)
  await expect
    .poll(async () => win.evaluate(() => document.documentElement.dataset['theme']))
    .toBe(mode)
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test.describe('terminal — follows the app theme (#399)', () => {
  test('flipping App theme re-themes every OPEN terminal in place, both directions', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    // Default mode is dark — the terminal opens dark.
    await ensureScopedShell(window)
    // Open a SECOND terminal so "every open terminal" is a non-trivial guard
    // (the non-active sibling must re-theme too, not just the visible one).
    await newBtn(window).click()
    await expect(termTabs(window)).toHaveCount(2)
    await expect.poll(() => everyRowColorIs(window, DARK_FG), { timeout: 10000 }).toBe(true)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-theme-01-dark.png` })

    // Flip to LIGHT via the real Settings control — EVERY open terminal re-themes.
    await setAppTheme(window, 'light')
    await expect.poll(() => everyRowColorIs(window, LIGHT_FG), { timeout: 10000 }).toBe(true)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-theme-02-light.png` })

    // Flip back to DARK — re-themes again (the dynamic MutationObserver, not a
    // one-shot at mount).
    await setAppTheme(window, 'dark')
    await expect.poll(() => everyRowColorIs(window, DARK_FG), { timeout: 10000 }).toBe(true)

    // The shell is still alive after the theme churn (not disposed / re-spawned).
    await window.locator('.fl-term-host:not([hidden])').click()
    await window.keyboard.type('echo THEME_ALIVE_7Q2')
    await window.keyboard.press('Enter')
    await expect
      .poll(async () => /THEME_ALIVE_7Q2/.test(await activeRows(window).innerText()), {
        timeout: 8000,
      })
      .toBe(true)

    expect(errors, `uncaught errors during theme flip:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })
})
