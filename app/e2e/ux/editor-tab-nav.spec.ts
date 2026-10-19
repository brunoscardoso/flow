import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Dialog } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor), tab-navigation + dirty-close paths.
 *
 * The main editor.spec.ts covers open/tabs/dirty-save/close/reopen/binary. This
 * spec guards the two remaining credential-less core behaviors a user relies on
 * every session but that were previously unprobed:
 *
 *  - ctrl+Tab / ctrl+shift+Tab cycle the tab strip (forward/back, wrapping at the
 *    ends) — the keyboard nav wired in editor/index.ts onKeydown → cycleTab.
 *  - Closing a DIRTY tab prompts (window.confirm); dismiss keeps the tab AND its
 *    unsaved edits, accept discards it. A regression here is silent data loss.
 *
 * Verified by driving the real app: both cycle directions land on the expected
 * tab and Monaco shows the matching content; the confirm gate is honored both
 * ways with zero uncaught errors. (Monaco's benign internal "Canceled" on model
 * dispose is filtered — see editor.spec.ts for the rationale.)
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Click a file-tree row by filename. Waits for the Files tree to finish its
 *  async listDir render, and self-heals against the per-project flow-settings
 *  overlay that can auto-open just after activation and cover the tree on slow
 *  cold Electron launches (it races the seed fixture's dismiss timeout). */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    // Clear any late-arriving overlay before looking for / clicking the row.
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    // Post-#674 the default rail is Threads — switch to Files unless it's already
    // active (clicking the active rail item collapses the sidebar).
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

/** The editor tab strip button whose visible label matches `name`. */
function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('ctrl+Tab cycles the tab strip forward and backward, wrapping at both ends', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const A = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.md'), '# beta-marker\n')
  writeFileSync(join(dir, 'gamma.txt'), 'gamma-marker\n')
  await activateProject(window, dir)

  // Open three tabs in order → strip is [alpha, beta, gamma], gamma active.
  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')
  await openFromTree(window, 'beta.md')
  await expectEditorShows(window, 'beta-marker')
  await openFromTree(window, 'gamma.txt')
  await expectEditorShows(window, 'gamma-marker')
  await expect(tab(window, 'gamma.txt')).toHaveClass(/active/)

  // Forward from the last tab wraps to the first (gamma → alpha) and shows it.
  await window.keyboard.press('Control+Tab')
  await expect(tab(window, 'alpha.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'alpha-marker')

  // Forward again advances one (alpha → beta).
  await window.keyboard.press('Control+Tab')
  await expect(tab(window, 'beta.md')).toHaveClass(/active/)

  // Backward retreats one (beta → alpha).
  await window.keyboard.press('Control+Shift+Tab')
  await expect(tab(window, 'alpha.ts')).toHaveClass(/active/)

  // Backward from the first tab wraps to the last (alpha → gamma).
  await window.keyboard.press('Control+Shift+Tab')
  await expect(tab(window, 'gamma.txt')).toHaveClass(/active/)
  await expectEditorShows(window, 'gamma-marker')

  await window.screenshot({ path: `${SCREENS}/editor-tab-cycle.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('closing a DIRTY tab: dismissing the confirm keeps the tab and its unsaved edits', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')

  // Make the tab dirty.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const ADDED = "unsaved-edit"')
  const dirtyDot = tab(window, 'alpha.ts').locator('.dirty-dot')
  await expect(dirtyDot).toBeVisible()

  // Close it, then DISMISS the discard prompt — the tab and its edits must survive.
  const dialogs: string[] = []
  const onDismiss = (d: Dialog) => {
    dialogs.push(d.message())
    void d.dismiss()
  }
  window.on('dialog', onDismiss)
  await tab(window, 'alpha.ts').locator('.close').click()
  await window.waitForTimeout(400)
  window.off('dialog', onDismiss)

  expect(dialogs.join(' ')).toContain('Discard unsaved changes')
  await expect(tab(window, 'alpha.ts')).toBeVisible()
  await expect(dirtyDot).toBeVisible()
  await expectEditorShows(window, 'unsaved-edit')

  await window.screenshot({ path: `${SCREENS}/editor-dirty-close-cancel.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('closing a DIRTY tab: accepting the confirm discards the tab', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\n// throwaway')
  await expect(tab(window, 'alpha.ts').locator('.dirty-dot')).toBeVisible()

  const onAccept = (d: Dialog) => void d.accept()
  window.on('dialog', onAccept)
  await tab(window, 'alpha.ts').locator('.close').click()
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  window.off('dialog', onAccept)

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
