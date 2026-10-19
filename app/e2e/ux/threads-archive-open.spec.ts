import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, archiving/deleting the CURRENTLY-OPEN thread.
 *
 * The sibling probes cover create/search/delete (`threads.spec.ts`), the
 * row-action surface (`threads-actions.spec.ts` — including delete-of-the-open
 * thread teardown, #397), the archive⇄active⇄search lifecycle
 * (`threads-archive-search.spec.ts`) and the overflow fold (`threads-overflow.spec.ts`).
 * None of them archive the thread that is *currently open in the composer*.
 *
 * This guards that seam:
 *  - Live guard: deleting the open thread tears the composer down (#397) — the
 *    teardown machinery that archive-open SHOULD share.
 *  - Live guard: archiving the open thread doesn't crash and doesn't lose data —
 *    the thread lands in the collapsed Archived section and is recoverable via
 *    expand → Unarchive.
 *  - #686 tripwire (fixme): archiving the currently-open thread should tear the
 *    composer down (consistent with delete-open) instead of leaving it live and
 *    bound to a now-hidden archived thread with no active row / no affordance.
 *    Flip `test.fixme` → `test` when #686 lands.
 *
 * Credential-free: `threads.create`/`update`/`delete` are immediate IPC.
 */

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}
function archivedHeader(win: Page) {
  return win.locator('fl-list').getByText(/Archived \(/i)
}
async function openRowMenu(win: Page, title: string) {
  await threadRow(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

/**
 * The list's archive control. The "Archived (N)" header that used to sit at the
 * bottom of the sidebar moved into the view menu beside the search (the header
 * now appears only for a SEARCH's archived matches, #482): its row carries the
 * count, and pressing it shows the archived rows in the list. Returns the open
 * menu's archive row; the caller presses it or closes the menu with Escape.
 */
async function archiveToggle(win: Page) {
  await win.locator('[aria-label="Sort and filter threads"]').click()
  const item = win.locator('.fl-thread-menu-item', { hasText: /Archived \(/ })
  await expect(item).toBeVisible({ timeout: 5000 })
  return item
}

/** The archive's count as its menu row says it, read afresh (the menu is drawn
 *  when it opens) and closed again. */
async function archiveCountText(win: Page): Promise<string | null> {
  const text = await (await archiveToggle(win)).textContent()
  await win.keyboard.press('Escape')
  return text
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

test.afterAll(() => cleanupSeeds())

test('delete-open tears the composer down (#397) — the teardown archive-open should share', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  const row = threadRow(window, 'New thread').first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  await row.click({ button: 'right' })
  await window.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).first().click()
  await expect(window.locator('.fl-thread-menu-confirm')).toHaveText('Delete this thread?')
  await window.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).last().click()

  // (The empty state names the Workspace the list belongs to since 2026-10-06.)
  await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet', { timeout: 8000 })
  await expect(window.locator('.fl-composer')).toBeHidden()
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('archive-open does not crash and is fully recoverable (no data loss)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  const row = threadRow(window, 'New thread').first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  // Archive the currently-open thread.
  const menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()

  // It leaves the active list into the list's archive — not dropped.
  await expect(threadRow(window, 'New thread')).toHaveCount(0, { timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (1)')

  // Recoverable: show the archive → Unarchive brings it back to the active list.
  await (await archiveToggle(window)).click()
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  const menu2 = await openRowMenu(window, 'New thread')
  await menu2.locator('.fl-thread-menu-item', { hasText: 'Unarchive' }).click()
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  await expect(archivedHeader(window)).toHaveCount(0, { timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toMatch(/Archived \(0\)$/)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #686 (fixed): archiving the currently-open thread no longer leaves the composer
 * live and bound to a now-hidden archived thread. Consistent with delete-open
 * (#397), the onUpdated handler now tears the conversation/composer down when the
 * open thread's refreshed detail shows it was archived.
 */
test('archiving the OPEN thread tears the composer down like delete (#686)', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  const row = threadRow(window, 'New thread').first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  const menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()
  await expect(threadRow(window, 'New thread')).toHaveCount(0, { timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (1)')

  // Expected once #686 lands: the composer is no longer bound to the hidden,
  // now-archived thread (torn down, matching delete-open).
  await expect(window.locator('.fl-composer')).toBeHidden({ timeout: 5000 })
})
