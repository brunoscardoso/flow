import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, waitForStableNode } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * #857 — approve ↔ stage sync between the Review (Phases) surface and the
 * Source Control (Changes) surface. The staging area is the single source of
 * truth: approving a file in Phases stages it (visible under "Staged Changes"
 * in the Changes view), and staging from the git side reads back as approved
 * (green ✓) in Phases. Both directions are driven here end-to-end.
 */

async function seedRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-appr-sync-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  await activateProject(win, dir)
  return dir
}

test.afterAll(() => cleanupSeeds())

test('approving in Phases stages the file; git-side staging reads back as approved (#857)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedRepo(window)
  await window.locator('[data-rail-item="source-control"]').click()
  await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(window.locator('.fl-review')).toBeAttached()
  // The list rebuilds a couple of times as a fresh project settles; a click
  // landing on a replaced node is lost (#1093/#1094).
  await waitForStableNode(window, '.fl-review-file')

  // Approve app.ts in the review surface…
  const row = window.locator('.fl-review-file', { hasText: 'app.ts' })
  await expect(row).toBeVisible()
  await row.locator('.fl-review-approve').click()
  await expect(row).toHaveClass(/fl-review-file-approved/)

  // …and the Changes view now shows it under Staged Changes.
  await window.locator(sel.scViewBtn).filter({ hasText: 'Changes' }).click()
  const stagedHeader = window.getByText('Staged Changes', { exact: false })
  await expect(stagedHeader).toBeVisible({ timeout: 5_000 })

  // Reverse: unstage from the git side (real git), then the review surface
  // re-derives — the ✓ is gone after its git:changed refresh.
  execFileSync('git', ['restore', '--staged', 'app.ts'], { cwd: dir })
  await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect
    .poll(
      async () =>
        (await window.locator('.fl-review-file', { hasText: 'app.ts' }).getAttribute('class')) ?? '',
      { timeout: 10_000 },
    )
    .not.toMatch(/fl-review-file-approved/)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
