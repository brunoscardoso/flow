import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * #751 — creating a thread with permission prompts skipped, matching the
 * New-task modal's opt-in. The per-project "+" menu offers a dangerous-labeled
 * entry; the created thread carries bypassPermissions=true in the store
 * (applied BEFORE any turn), while the plain "New thread" stays false.
 */

async function threadFlags(win: Page, root: string): Promise<boolean[]> {
  return win.evaluate(
    async (projectRoot) => {
      const flow = (
        window as unknown as {
          flow: {
            threads: {
              list(r: {
                projectRoot: string
              }): Promise<Array<{ bypassPermissions: boolean }>>
            }
          }
        }
      ).flow
      const threads = await flow.threads.list({ projectRoot })
      return threads.map((t) => t.bypassPermissions)
    },
    root,
  )
}

test.afterAll(() => cleanupSeeds())

// FIXME(project menu): the per-project ⋯ "Project actions" button left the
// sidebar with the flat Workspace list (6249e622). The project menu is now asked
// for from the Workspace switcher's project row, which this harness cannot reach
// yet — so this guard waits for a way in rather than being rewritten to a
// different surface.
test.fixme('the + menu creates a skip-permissions thread; plain creation stays safe (#751)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Plain creation via the + menu → bypass stays false.
  await window.locator('[aria-label^="New thread or task in"]').first().click()
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: /^New thread$/ }).click()
  await expect.poll(() => threadFlags(window, dir), { timeout: 5000 }).toEqual([false])

  // Skip-permissions creation via the dangerous-labeled entry → bypass true.
  await window.locator('[aria-label^="New thread or task in"]').first().click()
  await window
    .locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'skip permissions' })
    .click()
  await expect
    .poll(async () => (await threadFlags(window, dir)).sort(), { timeout: 5000 })
    .toEqual([false, true])

  expect(errors, errors.join(', ')).toHaveLength(0)
})
