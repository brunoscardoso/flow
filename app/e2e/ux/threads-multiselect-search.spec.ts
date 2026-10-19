import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2 (Threads). The ⌘-click multi-select (#730) crossed with the
 * search filter — a seam no sibling flow-2 probe drives.
 *
 * `threads-archive-all.spec.ts` drives multi-select → selection-menu → archive
 * WITHOUT a search active. `threads-search-filter.spec.ts` drives search WITHOUT
 * a selection. Nothing drives what happens when a search NARROWS the list while a
 * multi-selection is live — and that seam has a silent-mass-archive hazard:
 *
 *   #openSelectionMenu (thread-sidebar.ts ~1345) computes `targets` from
 *   `this.#threads` (the CURRENT search result set) ∩ the selection set. So under
 *   a partial search the counted confirmation reflects the VISIBLE actionable
 *   subset ("Archive 1", not "2"), and archiving affects ONLY that subset — a
 *   hidden-but-selected thread is never silently swept in.
 *
 * A regression that made the selection menu act on the full (including-hidden)
 * selection under an active search would silently archive threads the user could
 * not see. This locks the non-destructive, honest-count behavior in.
 *
 * Credential-free: threads.create/update + project:* are immediate IPC.
 */

const SCREENS = 'e2e/ux/__screens'

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}
function searchBox(win: Page) {
  return win.locator('input[aria-label="Search threads"]')
}

/**
 * The list's archive count, as the view menu beside the search says it — the
 * "Archived (N)" header that used to sit at the bottom of the sidebar moved
 * there (the header now appears only for a SEARCH's archived matches, #482).
 * Read afresh (the menu is drawn when it opens) and closed again.
 */
async function archiveCountText(win: Page): Promise<string | null> {
  await win.locator('[aria-label="Sort and filter threads"]').click()
  const item = win.locator('.fl-thread-menu-item', { hasText: /Archived \(/ })
  await expect(item).toBeVisible({ timeout: 5000 })
  const text = await item.textContent()
  await win.keyboard.press('Escape')
  return text
}

test.afterAll(() => cleanupSeeds())

test('multi-select under a partial search archives only the visible subset — hidden selection is spared (#730)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Three active threads: two share the token "refund", one is "export".
  const titles = ['alpha refund', 'beta refund', 'gamma export']
  await window.evaluate(
    async ({ root, titles }) => {
      const flow = (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
          }
        }
      ).flow
      for (const t of titles) await flow.threads.create({ projectRoot: root, title: t })
    },
    { root: dir, titles },
  )
  await expect(threadRow(window, 'gamma export')).toBeVisible({ timeout: 5000 })

  // ⌘-click alpha + beta into the selection (both currently visible).
  await threadRow(window, 'alpha refund').first().click({ modifiers: ['ControlOrMeta'] })
  await threadRow(window, 'beta refund').first().click({ modifiers: ['ControlOrMeta'] })

  // Narrow the list with a search that matches ONLY alpha; beta is now off-view
  // but still in the selection set.
  await searchBox(window).fill('alpha')
  await expect(threadRow(window, 'alpha refund').first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, 'beta refund')).toHaveCount(0, { timeout: 5000 })

  // The selection menu reflects the VISIBLE actionable subset — "1", not "2".
  await threadRow(window, 'alpha refund').first().click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await expect(
    menu.locator('.fl-thread-menu-item', { hasText: /Archive 1 selected thread/ }),
  ).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/threads-multiselect-search-partial.png` })

  // Archive the visible subset. Only alpha must move to Archived; beta — hidden
  // but selected — must NOT be swept in.
  await menu.locator('.fl-thread-menu-item', { hasText: /Archive 1 selected thread/ }).click()
  await expect(menu.locator('.fl-thread-menu-confirm')).toContainText('Archive 1 selected thread?')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()

  // Clear the search: beta stays ACTIVE (not archived), gamma stays active, and
  // exactly one thread landed in Archived — proof the hidden selection was spared.
  await searchBox(window).fill('')
  await expect(threadRow(window, 'beta refund').first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, 'gamma export').first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, 'alpha refund')).toHaveCount(0)
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (1)')
  await window.screenshot({ path: `${SCREENS}/threads-multiselect-search-cleared.png` })

  expect(errors, errors.join(', ')).toHaveLength(0)
})
