import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * #730 — "Archive all threads" in the project ⋯ menu. An old project carries a
 * long thread history; archiving one-by-one is tedious. The menu item opens an
 * in-menu confirmation with the EXACT count (so a misclick can't mass-archive),
 * then archives every active thread; the rows move into the "Archived" section.
 * Credential-free: threads.create/update are immediate IPC.
 */


function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}


/**
 * Make an EMPTY thread called "New thread" in the active project and open it —
 * what the toolbar "+" used to do. Since 2026-09-04 "+" opens the new-thread
 * PAGE, whose Create sends a first message; this spec is about the thread list,
 * not about starting a conversation, so the thread is made over the same IPC
 * the page ends in and opened by its row.
 */
async function newThread(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          project: { active(): Promise<{ rootPath: string } | null> }
          threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
        }
      }
    ).flow
    const active = await flow.project.active()
    if (active === null) throw new Error('newThread: no active project')
    await flow.threads.create({ projectRoot: active.rootPath, title: 'New thread' })
  })
  await openThreadByTitle(win, 'New thread')
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

// The project ⋯ "Project actions" button left the sidebar with the flat
// Workspace list (6249e622); the project menu is now asked for from the Workspace
// switcher's project row, which this harness cannot reach yet.
test.fixme('project menu archives all threads behind a counted confirmation (#730)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Three active threads.
  for (let i = 0; i < 3; i++) {
    await newThread(window)
  }
  await expect(threadRow(window, 'New thread')).toHaveCount(3)

  // Open the project ⋯ menu.
  await window.locator('[aria-label="Project actions"]').first().click()
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()

  // The archive-all item → counted confirmation.
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive all threads' }).click()
  await expect(menu.locator('.fl-thread-menu-confirm')).toContainText('Archive 3 threads')

  // Cancel first — nothing archives.
  await menu.locator('.fl-thread-menu-item', { hasText: 'Cancel' }).click()
  await expect(threadRow(window, 'New thread')).toHaveCount(3)

  // Again, and confirm.
  await window.locator('[aria-label="Project actions"]').first().click()
  await window
    .locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Archive all threads' })
    .click()
  await window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Archive all' }).last().click()

  // All rows leave the active list; the collapsed Archived section holds them.
  await expect(window.locator('fl-list').getByText('Archived (3)')).toBeVisible({ timeout: 5000 })

  // Re-open the menu: archive-all is now disabled (no active threads left).
  await window.locator('[aria-label="Project actions"]').first().click()
  await expect(
    window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Archive all threads' }),
  ).toBeDisabled()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('⌘-click multi-select archives ONLY the selected threads (#730)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Three threads with distinct titles (rename via the store for determinism).
  const titles = ['keep me', 'archive A', 'archive B']
  await window.evaluate(
    async ({ root, titles }) => {
      const flow = (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow
      for (const title of titles) await flow.threads.create({ projectRoot: root, title })
    },
    { root: dir, titles },
  )
  await expect(threadRow(window, 'archive B')).toBeVisible({ timeout: 5000 })

  // ⌘-click the two targets into the selection.
  await threadRow(window, 'archive A').first().click({ modifiers: ['ControlOrMeta'] })
  await threadRow(window, 'archive B').first().click({ modifiers: ['ControlOrMeta'] })

  // Right-click a selected row → selection menu with the exact count.
  await threadRow(window, 'archive A').first().click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive 2 selected threads' }).click()
  // Counted confirmation, then confirm.
  await expect(menu.locator('.fl-thread-menu-confirm')).toContainText('Archive 2 selected threads?')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()

  // Both targets moved to Archived; the third thread stays active.
  await expect(threadRow(window, 'archive A')).toHaveCount(0, { timeout: 5000 })
  await expect(threadRow(window, 'archive B')).toHaveCount(0)
  await expect(threadRow(window, 'keep me')).toBeVisible()
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (2)')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
