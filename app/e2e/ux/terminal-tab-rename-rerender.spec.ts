import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal). #959: the inline tab-rename editor (#774) lives
 * INSIDE the tab button, and `fl-tabs.#render()` rebuilds the strip wholesale —
 * so any owner-side `renderTabs()` while a rename is open rips the editor out
 * from under the user, commits whatever was typed so far, and drops the rest of
 * the keystrokes.
 *
 * `terminal-panel.ts` calls `renderTabs()` on every OSC 7 cwd report, OSC 0/2
 * window title, tab exit and tab add/remove — i.e. on ordinary background
 * activity the user isn't looking at. (This is also why the committed guard
 * `terminal-tab-rename.spec.ts:27` fails ~1 run in 3 with `locator.fill:
 * Timeout` — the input it is filling is deleted mid-fill.)
 *
 * Guards here:
 *  1. LIVE — the plain rename round-trip with no background churn still works
 *     (Enter commits; the name survives).
 *  2. LIVE (#959) — an open rename editor survives a background re-render (a
 *     running command's `cd`): fl-tabs now DEFERS any render while a
 *     .rename-input is open and replays it when the editor closes.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const renameInput = (win: Page) => win.locator('.fl-term-tabs .rename-input')
const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** Open (or reuse) a shell in the active project and wait for its first prompt. */
async function ensureShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(activeHost(win).locator('.xterm')).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
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

test('renaming a quiet terminal tab commits the full name (#774)', async ({ window }) => {
  const errors = trackErrors(window)

  const dir = await seedProject(window, 'flow-ux-rnq-')
  await activateProject(window, dir)
  await ensureShell(window)

  // Let the freshly-spawned shell finish reporting its cwd/title, so the strip is
  // quiet before the rename starts (the race this spec's fixme is about).
  await window.waitForTimeout(2000)

  const tab = termTabs(window).first()
  await tab.dblclick()
  await expect(renameInput(window)).toBeVisible()
  await renameInput(window).fill('build watcher')
  await renameInput(window).press('Enter')

  await expect(renameInput(window)).toHaveCount(0)
  await expect(termTabs(window).first()).toContainText('build watcher')
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-rename-01-quiet.png` })

  expect(errors, `uncaught errors during quiet rename:\n${errors.join('\n')}`).toEqual([])
})

test(
  'an open rename editor survives a background re-render and commits the FULL name (#959)',
  async ({ window }) => {
    const errors = trackErrors(window)

    const dir = await seedProject(window, 'flow-ux-rnr-')
    const subdir = 'sigma_probe_dir_99'
    mkdirSync(join(dir, subdir))
    await activateProject(window, dir)
    await ensureShell(window)

    // Kick off a command that will change the cwd LATER — its OSC 7 report is what
    // re-renders the tab strip, mid-rename.
    await activeHost(window).click({ position: { x: 5, y: 5 } })
    await window.keyboard.type(`sleep 4; cd ${subdir}`)
    await window.keyboard.press('Enter')

    // While it runs, the user tidies up and renames the tab — one key at a time.
    await termTabs(window).first().dblclick()
    await expect(renameInput(window)).toBeVisible()
    await renameInput(window).press('ControlOrMeta+a')
    for (const ch of 'build watcher') {
      await window.keyboard.press(ch === ' ' ? 'Space' : ch)
      await window.waitForTimeout(400)
    }

    // The editor must still be the user's — the background cd must not have
    // destroyed it and committed a truncated fragment.
    await expect(
      renameInput(window),
      'a background cd (OSC 7 → renderTabs) must not destroy the open rename editor',
    ).toHaveCount(1)
    await renameInput(window).press('Enter')
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-rename-02-rerender.png` })

    await expect(termTabs(window).first()).toContainText('build watcher')

    expect(errors, `uncaught errors during rename-vs-rerender:\n${errors.join('\n')}`).toEqual([])
  },
)
