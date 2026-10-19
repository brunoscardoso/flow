import { writeFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — the ⌘P command palette (quick-open). Drives the real flow: open
 * with ⌘P over a seeded project, filter to a file and open it with Enter, flip
 * to command mode with ⌘⇧P, and close with Escape — asserting no page errors.
 *
 * Kept as a PROBE: authored with the feature, run in the next Playwright sweep
 * per the project's no-Playwright-in-band workflow (not launched during
 * execution). The pure core is covered by node-env unit tests.
 */

test.afterAll(() => cleanupSeeds())

test('⌘P opens a blended palette, opens a file, flips to command mode, and closes', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const proj = await seedProject(window)
  // Seed a file so the (index-free) file source has something to surface.
  writeFileSync(join(proj, 'palette-target.ts'), 'export const x = 1\n', 'utf-8')
  await activateProject(window, proj)

  const panel = window.locator('.fl-palette-panel')
  const input = panel.locator('.fl-palette-input')
  const rows = window.locator('.fl-palette-row')

  // Open — the overlay appears and the input takes focus.
  await window.keyboard.press('ControlOrMeta+p')
  await expect(panel).toBeVisible()
  await expect(input).toBeFocused()

  // Typing filters to the seeded file; wait for the FILE row specifically (not
  // just any row) so Enter can't race a stale empty-state action. Enter opens it.
  await input.fill('palette-target')
  const fileRow = window.locator('.fl-palette-row', { hasText: 'palette-target.ts' })
  await expect(fileRow).toBeVisible()
  await window.keyboard.press('Enter')
  await expect(panel).toBeHidden()
  await expect(
    window.locator('.fl-shell fl-tabs .tab', { hasText: 'palette-target.ts' }),
  ).toBeVisible()

  // ⌘⇧P flips straight into command mode (pre-filled `>`), showing commands.
  await window.keyboard.press('ControlOrMeta+Shift+p')
  await expect(panel).toBeVisible()
  await expect(input).toHaveValue('>')
  await expect(rows.first()).toBeVisible()

  // Escape closes without leaving the overlay behind.
  await window.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  expect(errors).toEqual([])
})
