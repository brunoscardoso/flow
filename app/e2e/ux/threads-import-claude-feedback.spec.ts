import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Flow 2 (threads) — "Import Claude history" project ⋯ menu affordance feedback.
 *
 * The project group ⋯ menu offers "Import Claude history" (#296), which re-scans
 * the project's Claude Code CLI sessions and MUST always give the user a result
 * toast — imported N / already-imported / none-found / read-error. Every existing
 * threads e2e drives create/search/delete/rename/pin/archive/multi-select/reorder;
 * NONE drives this import affordance or its feedback. `importClaudeSessions` was
 * unit-tested only (claude-import.test.ts); this is the first live e2e of the full
 * renderer→IPC→store→toast loop.
 *
 * Credential-free & deterministic: the seeded root is a per-run unique tmpdir git
 * repo, so its derived `~/.claude/projects/<encoded>` path never exists → the IPC
 * returns { imported: 0, skipped: 0 } → the deterministic "No Claude Code history
 * found for this project." info toast. No native dialog (the handler derives the
 * reader path in main from the validated rootPath — never a picker).
 *
 * Expected UX: clicking the item closes the menu and surfaces a titled feedback
 * toast; the affordance never dead-clicks. Watches pageerrors throughout.
 */

function projectActions(win: Page) {
  return win.locator('[aria-label="Project actions"]').first()
}

test.afterAll(() => cleanupSeeds())

// FIXME(project menu): the per-project ⋯ "Project actions" button left the
// sidebar with the flat Workspace list (6249e622). The project menu is now asked
// for from the Workspace switcher's project row, which this harness cannot reach
// yet — so this guard waits for a way in rather than being rewritten to a
// different surface.
test.fixme('Import Claude history surfaces a result toast (no dead-click, #296)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Open the project group ⋯ menu.
  await projectActions(window).click()
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()

  const importItem = menu.locator('.fl-thread-menu-item', { hasText: 'Import Claude history' })
  await expect(importItem).toBeVisible()
  await expect(importItem).toBeEnabled()

  // Click the affordance. It must (a) close the menu and (b) surface feedback —
  // NOT silently do nothing (the dead-click failure mode this guards against).
  await importItem.click()
  await expect(menu).toBeHidden()

  // A titled feedback toast appears. For a fresh throwaway repo with no CLI
  // history, the deterministic branch is the "none found" message.
  const toast = window.locator('.fl-flow-toast')
  await expect(toast.filter({ hasText: 'Claude Code import' })).toBeVisible({ timeout: 5000 })
  await expect(toast.filter({ hasText: 'No Claude Code history found for this project.' })).toBeVisible({
    timeout: 5000,
  })

  // The import is a no-op for the thread list — no phantom threads were created,
  // the empty active list is preserved.
  await expect(window.locator('fl-list').getByText('New thread', { exact: true })).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
