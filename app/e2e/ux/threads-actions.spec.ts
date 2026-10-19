import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, row-action surface (rename · pin · archive · delete).
 *
 * The sibling probe `threads.spec.ts` (PR #387) covers create / search / delete
 * from the empty state. This one guards the ⋯ row-actions menu against
 * regressions in the *stateful* actions that a real user drives daily:
 *
 *  - Rename via the inline menu field renames the row in place.
 *  - Pin floats a thread to the top of its project and marks it with a pin glyph.
 *  - Archive moves a thread out of the active list into a collapsed "Archived"
 *    section that expands to reveal it.
 *  - Deleting the CURRENTLY-OPEN thread tears down the conversation surfaces
 *    (composer hidden, empty state restored) rather than leaving a stale,
 *    deleted thread bound to the composer (#397 teardown path).
 *
 * All actions run credential-free: `threads.create` / `threads.update` /
 * `threads.delete` are immediate IPC, so no Claude account is needed.
 */


/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** Open the ⋯ actions menu for a row via right-click (same menu as the button). */
async function openRowMenu(win: Page, title: string) {
  const row = threadRow(win, title).first()
  await row.click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
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

test('rename: the ⋯ menu inline field renames the row in place', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  const menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeVisible()
  await input.fill('Renamed thread')
  await input.press('Enter')

  await expect(threadRow(window, 'Renamed thread').first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, 'New thread')).toHaveCount(0)

  // STORE: the rename persisted through threads:rename, not just the row UI.
  const titles = await window.evaluate(async (root) => {
    const api = (window as unknown as {
      flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ title: string }>> } }
    }).flow
    return (await api.threads.list({ projectRoot: root })).map((t) => t.title)
  }, dir)
  expect(titles).toContain('Renamed thread')
  expect(titles).not.toContain('New thread')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('pin: a pinned thread floats above an unpinned sibling and shows the pin glyph', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Two distinct threads; "First" is created first, so "Second" (newer) sorts
  // above it by recency. Pinning "First" must lift it back to the top.
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  let menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  await window.locator('.fl-thread-menu-input').fill('First')
  await window.locator('.fl-thread-menu-input').press('Enter')
  await expect(threadRow(window, 'First').first()).toBeVisible({ timeout: 5000 })

  await newThread(window)
  menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  await window.locator('.fl-thread-menu-input').fill('Second')
  await window.locator('.fl-thread-menu-input').press('Enter')
  await expect(threadRow(window, 'Second').first()).toBeVisible({ timeout: 5000 })

  // Before pinning: Second (newer) is above First.
  const firstBefore = await threadRow(window, 'First').first().boundingBox()
  const secondBefore = await threadRow(window, 'Second').first().boundingBox()
  expect(secondBefore!.y).toBeLessThan(firstBefore!.y)

  // Pin First.
  menu = await openRowMenu(window, 'First')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Pin' }).click()

  // After pinning: First floats above Second and carries a pin glyph. (Every
  // row also has a hover Pin BUTTON with the same icon; the glyph is the one
  // titled "Pinned".)
  await expect(window.locator('fl-list').locator('fl-icon[name="pin"][title="Pinned"]')).toHaveCount(1, {
    timeout: 5000,
  })
  const firstAfter = await threadRow(window, 'First').first().boundingBox()
  const secondAfter = await threadRow(window, 'Second').first().boundingBox()
  expect(firstAfter!.y).toBeLessThan(secondAfter!.y)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('archive: the thread leaves the list, and its archive brings it back into view', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  const menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()

  // The thread leaves the active list.
  await expect(threadRow(window, 'New thread')).toHaveCount(0, { timeout: 5000 })

  // Since 2026-09-07 a list's archive is a choice in its own view menu (beside
  // the search) — "Archived (1)" there shows the archived items in the list;
  // the always-present collapsed "Archived (N)" section this used to expand is
  // only drawn for a SEARCH now (#482, threads-archive-search.spec.ts).
  await window.locator('[aria-label="Sort and filter threads"]').click()
  await window.locator('.fl-thread-menu-item', { hasText: 'Archived (1)' }).click()
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('delete the OPEN thread: composer tears down and the empty state returns', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  const row = threadRow(window, 'New thread').first()
  await expect(row).toBeVisible({ timeout: 10000 })

  // Creating a thread auto-selects it → the composer is shown.
  await row.click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  // Delete the currently-open thread via the ⋯ menu confirm.
  await row.click({ button: 'right' })
  await expect(window.locator('.fl-thread-menu')).toBeVisible()
  await window.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).first().click()
  await expect(window.locator('.fl-thread-menu-confirm')).toHaveText('Delete this thread?')
  await window.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).last().click()

  // The deleted thread must not stay bound to the composer (#397 teardown).
  // (The empty state names the Workspace the list belongs to since 2026-10-06.)
  await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet', {
    timeout: 8000,
  })
  await expect(window.locator('.fl-composer')).toBeHidden()
  expect(errors, errors.join(', ')).toHaveLength(0)
})
