/**
 * THE BOTTOM SLOT HOLDS ONE LOG SURFACE, NOT TWO.
 *
 * The browser's debug drawer and the terminal both live along the bottom edge
 * and both show scrolling text; open together they read as one wall (user,
 * 2026-09-21, with a screenshot of both). They are rarely wanted at once —
 * you are reading what the PAGE did or what the SHELL did.
 *
 * DRIVEN FROM THE STATE A PERSON IS ACTUALLY IN: the terminal is visible by
 * default in this app, so the sequence below is the one that produced the
 * screenshot — terminal up, open the drawer, bring the terminal back.
 *
 * Two earlier versions of this spec passed against broken code by driving
 * `flow:show-terminal`, which is a REQUEST only some surfaces dispatch and
 * which the broken code happened to listen to. The rule now rides on a
 * transition announced from `reconcileEditorStack`, where every reveal path
 * converges.
 */
import { test, expect } from '../fixtures/electron'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

const drawerOpen = (win: Page) =>
  win.evaluate(() => {
    const body = document.querySelector('.fl-bdrawer-body') as HTMLElement | null
    return body !== null && !body.hidden
  })

const terminalOpen = (win: Page) =>
  win.evaluate(() => document.querySelectorAll('.fl-term-host').length > 0)

test('opening one bottom surface closes the other', async ({ window }) => {
  test.setTimeout(300_000)
  const page = `file://${resolve('e2e/fixtures/pages/net-probe.html')}`
  await window.evaluate((url: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } }))
  }, page)
  await expect(window.locator('webview')).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(2500)

  // ── THE STARTING STATE: terminal up, drawer closed ───────────────────────
  // The positive first (allowed-pattern #28): both facts are true here, so the
  // exclusions below are changes rather than coincidences.
  await expect.poll(() => terminalOpen(window), { timeout: 30_000 }).toBe(true)
  expect(await drawerOpen(window)).toBe(false)

  // ── OPEN THE DRAWER → THE TERMINAL GOES ─────────────────────────────────
  await window.locator('.fl-bdrawer-tab', { hasText: 'Console' }).click()
  await expect.poll(() => drawerOpen(window), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => terminalOpen(window), { timeout: 30_000 }).toBe(false)

  // ── BRING THE TERMINAL BACK → THE DRAWER GOES ───────────────────────────
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
  await expect.poll(() => terminalOpen(window), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => drawerOpen(window), { timeout: 30_000 }).toBe(false)
})
