import { existsSync } from 'fs'
import { join } from 'path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — the ⌘P "New file" round trip. The command-palette-commands spec
 * proves the name prompt APPEARS; this proves submitting it actually CREATES the
 * file on disk and OPENS it as an editor tab (the file-tree #create → createPath
 * → openFile plumbing behind promptNewFileAtRoot).
 */

test.afterAll(() => cleanupSeeds())

test('New file → type a name → creates the file on disk and opens it', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  const panel = window.locator('.fl-palette-panel')
  await window.keyboard.press('ControlOrMeta+Shift+p')
  await panel.locator('.fl-palette-input').fill('>new file')
  await expect(window.locator('.fl-palette-row', { hasText: 'New file' })).toBeVisible()
  await window.keyboard.press('Enter')

  // Fill the inline prompt and submit.
  const nameInput = window.locator('.fl-tree-menu input')
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await nameInput.fill('palette-created.ts')
  await nameInput.press('Enter')

  // The file opens as an editor tab...
  await expect(
    window.locator('.fl-shell fl-tabs .tab', { hasText: 'palette-created.ts' }),
  ).toBeVisible({ timeout: 10_000 })

  // ...and actually exists on disk.
  await expect(() => {
    expect(existsSync(join(proj, 'palette-created.ts'))).toBe(true)
  }).toPass({ timeout: 5_000 })

  expect(errors).toEqual([])
})
