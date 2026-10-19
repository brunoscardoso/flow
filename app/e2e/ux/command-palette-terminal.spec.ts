import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — the ⌘P "New terminal" COMPLETE round trip. The commands spec proves
 * the panel reveals; this proves the revealed shell is actually USABLE: an xterm
 * mounts, the shell auto-focuses, and typing a command (no click) produces output.
 * Exercises the flow:show-terminal reveal path added this session.
 */

const activeRows = (win: Page) =>
  win.locator('.fl-term-host:not([hidden])').locator('.xterm-rows')

test.afterAll(() => cleanupSeeds())

test('palette "New terminal" reveals a focused, working shell you can type into', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  const termRoot = window.locator('.fl-term-root')
  // Exercise the palette REVEAL path, never a no-op: hide the docked terminal
  // when it is up. A fresh profile no longer mounts one, in which case ⌃` would
  // REVEAL it and defeat the point — so the toggle is conditional.
  if ((await termRoot.count()) > 0) {
    await window.keyboard.press('Control+Backquote')
  }
  await expect(termRoot).toBeHidden()

  // Reveal via the palette.
  const panel = window.locator('.fl-palette-panel')
  await window.keyboard.press('ControlOrMeta+Shift+p')
  await panel.locator('.fl-palette-input').fill('>new terminal')
  await expect(window.locator('.fl-palette-row', { hasText: 'New terminal' })).toBeVisible()
  await window.keyboard.press('Enter')

  // A live xterm mounts and the shell prints a prompt.
  await expect(panel).toBeHidden()
  await expect(termRoot).toBeVisible({ timeout: 10_000 })
  // The VISIBLE host's xterm (a stale hidden host may linger after hide/reveal).
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => (await activeRows(window).innerText()).trim().length, { timeout: 8_000 })
    .toBeGreaterThan(0)

  // The shell is auto-focused — type a command WITHOUT clicking, see its output.
  await expect(
    window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea'),
  ).toBeFocused({ timeout: 8_000 })
  await window.keyboard.type('echo PALETTE_TERM_9Z')
  await window.keyboard.press('Enter')
  // The marker appears at least twice: the echoed command line + the output.
  await expect
    .poll(
      async () =>
        ((await activeRows(window).innerText()).match(/PALETTE_TERM_9Z/g) ?? []).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2)

  expect(errors).toEqual([])
})
