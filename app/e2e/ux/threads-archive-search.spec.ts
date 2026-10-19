import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the archive ⇄ active ⇄ search lifecycle.
 *
 * The sibling probes cover create/search/delete (`threads.spec.ts`) and the
 * row-action surface rename/pin/archive/delete-open (`threads-actions.spec.ts`).
 * This one guards the *round-trips* a real user drives when tidying their
 * sidebar — the paths those probes stop short of:
 *
 *  - Unarchive returns a thread to the active list AND tears down the now-empty
 *    "Archived" section (no ghost header left behind).
 *  - Rename → Escape cancels cleanly, keeping the original title.
 *  - Rename → whitespace-only is a no-op that keeps the original title (the
 *    blank-title guard) with no crash.
 *
 * It also pins the currently-BROKEN archived-in-search behavior (#482) as a
 * `test.fixme`: `searchThreads()` doesn't filter archived, so an archived thread
 * reappears in search results rendered as a plain row — visually identical to an
 * active thread, with no "Archived" section/badge to distinguish it. Flip the
 * fixme to `test` when the indicator lands.
 *
 * All actions are credential-free (`threads.create`/`update`/`delete` are
 * immediate IPC), so no Claude account is needed.
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
async function renameTo(win: Page, from: string, to: string) {
  const menu = await openRowMenu(win, from)
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = win.locator('.fl-thread-menu-input')
  // The field takes focus on the task after the Rename click — what a person
  // types into. Typing before that lands skips the focus the blur-commit
  // (#719) is armed by, so wait for it rather than race it.
  await expect(input).toBeFocused()
  await expect(input).toBeVisible()
  await input.fill(to)
  await input.press('Enter')
  await expect(threadRow(win, to).first()).toBeVisible({ timeout: 5000 })
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

test('unarchive returns the thread to the active list and clears the Archived section', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  // Archive → the thread leaves the list and the list's archive counts it.
  let menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()
  await expect(threadRow(window, 'New thread')).toHaveCount(0, { timeout: 5000 })
  const toggle = await archiveToggle(window)
  await expect(toggle).toHaveText(/^Archived \(1\)$/)

  // Show the archive and unarchive.
  await toggle.click()
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Unarchive' }).click()

  // The thread is back in the active list AND the archive is empty again — no
  // ghost section, nothing left to count. Wait for the async refresh to settle.
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  await expect(archivedHeader(window)).toHaveCount(0, { timeout: 5000 })
  // The menu is drawn when it opens, so read it afresh until the refresh lands.
  await expect
    .poll(
      async () => {
        const text = await (await archiveToggle(window)).textContent()
        await window.keyboard.press('Escape')
        return text
      },
      { timeout: 8000 },
    )
    .toMatch(/Archived \(0\)$/)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('rename → Escape cancels and keeps the original title', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await renameTo(window, 'New thread', 'KeepThisName')

  const menu = await openRowMenu(window, 'KeepThisName')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeFocused()
  await input.fill('DiscardedName')
  await input.press('Escape')

  await expect(window.locator('.fl-thread-menu-input')).toHaveCount(0)
  await expect(threadRow(window, 'KeepThisName').first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, 'DiscardedName')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('rename → whitespace-only is a no-op that keeps the original title', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await renameTo(window, 'New thread', 'RealName')

  const menu = await openRowMenu(window, 'RealName')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeFocused()
  await input.fill('     ')
  await input.press('Enter')

  await expect(window.locator('.fl-thread-menu-input')).toHaveCount(0)
  await expect(threadRow(window, 'RealName').first()).toBeVisible({ timeout: 5000 })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #482 (fixed by PR #485): an archived thread that matches a search must be
 * grouped under the "Archived" section — forced-expanded during search so the
 * match is visible — instead of being flattened in with active rows (where it
 * was visually indistinguishable from an active thread, silently undoing the
 * archive action's hide/declutter intent). `searchThreads()` still returns
 * archived matches; the sidebar now partitions them into the Archived section.
 * This guards the regression: if search ever flattens archived matches again,
 * the "Archived (…)" header disappears and this fails.
 */
test('an archived thread is grouped under the Archived section when it matches a search (#482)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await renameTo(window, 'New thread', 'ArchiveMe-Zephyr')

  const menu = await openRowMenu(window, 'ArchiveMe-Zephyr')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()
  await expect(threadRow(window, 'ArchiveMe-Zephyr')).toHaveCount(0, { timeout: 5000 })
  await expect(await archiveToggle(window)).toHaveText(/^Archived \(1\)$/)
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-thread-menu')).toHaveCount(0)

  // Search surfaces the archived thread…
  await window.locator('.fl-thread-search input').first().fill('ArchiveMe-Zephyr')
  await expect(threadRow(window, 'ArchiveMe-Zephyr').first()).toBeVisible({ timeout: 5000 })

  // …and it is grouped under the "Archived" section (forced-expanded in search),
  // NOT flattened in as a plain, active-looking row.
  await expect(archivedHeader(window).first()).toBeVisible({ timeout: 3000 })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
