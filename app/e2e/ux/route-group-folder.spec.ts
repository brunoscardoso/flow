import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression for #696 — Next.js **route-group** folders like `app/(protected)/`
 * (names containing parentheses) must appear in the Files tree and expand like
 * any other folder. Reported as "parenthesized folders don't appear."
 *
 * Drives the real Files surface against a seeded project whose `(protected)`
 * folder exists on disk: open the Files rail, expand `app/`, and assert the
 * `(protected)` row shows and expands to reveal its child file. Nothing in the
 * listing or the tree should special-case the parentheses.
 */

/** The visible Files side-panel body (post-#674 activity-bar rail). */
function pane(win: Page) {
  return win.locator('.fl-sidebar-pane:visible')
}

/** Click a file-tree row by its exact visible name, scoped to the Files pane. */
async function clickRow(win: Page, name: string): Promise<void> {
  await pane(win).getByText(name, { exact: true }).click()
}

test.afterAll(() => cleanupSeeds())

test('route-group folder `(protected)` appears in the Files tree and expands (#696)', async ({
  window,
}) => {
  const dir = await seedProject(window)
  // app/(protected)/page.tsx — the Next.js App Router route-group convention.
  mkdirSync(join(dir, 'app', '(protected)'), { recursive: true })
  writeFileSync(join(dir, 'app', '(protected)', 'page.tsx'), 'export default function Page() {}\n')
  // A sibling normal folder so the tree has more than one child to render.
  mkdirSync(join(dir, 'app', 'dashboard'), { recursive: true })
  writeFileSync(join(dir, 'app', 'dashboard', 'page.tsx'), 'export default function D() {}\n')
  await activateProject(window, dir)

  // Open the Files rail.
  await window.locator('[data-rail-item="files"]').click()
  await pickFilesProject(window)
  await expect(pane(window)).toBeVisible()

  // The root auto-expands; `app/` is a direct child — expand it.
  await clickRow(window, 'app')

  // The parenthesized route-group folder must be present…
  await expect(pane(window).getByText('(protected)', { exact: true })).toBeVisible()

  // …and expandable — clicking it reveals its child file.
  await clickRow(window, '(protected)')
  await expect(pane(window).getByText('page.tsx', { exact: true }).first()).toBeVisible()
})
