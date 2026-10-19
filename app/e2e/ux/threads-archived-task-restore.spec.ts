import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { join } from 'node:path'

/**
 * UX sweep — flow 2 (Threads): the sidebar's "Archived" drawer as a TWO-KIND
 * surface.
 *
 * #1391 gave archived TASKS a home — they now land in the very same "Archived (N)"
 * section as archived threads, one row apart. Every sibling flow-2 probe drives the
 * THREAD half of that drawer (`threads-archive-search`, `threads-archive-open`,
 * `threads-archive-all`), and `task-archive-keeps-thread` drives archiving a task.
 * Nothing drives what a user does NEXT with an archived task: get it back, or find
 * it by name.
 *
 * What this pins:
 *  - Both kinds land in the one drawer, collapsed until asked for.
 *  - Positive control: the archived THREAD's ⋯ menu carries "Unarchive", and it
 *    round-trips the thread back into the live list.
 *  - (fixme) The archived TASK's ⋯ menu, opened from the same section, is the live
 *    menu verbatim — lanes / Pin / Rename / Archive / "Delete task + thread" — with
 *    NO restore verb. The kanban lists `includeArchived: false`, so this drawer is
 *    the only surface that shows the task at all: #1391's "nothing can un-archive"
 *    half is still open (#1466), and the only exit is the destructive delete.
 *  - (fixme) Searching for an archived task returns it TWICE: once above the
 *    divider as a plain, live-looking thread row (the task's 1:1 thread is not
 *    archived, and search drops the task layer), once inside the Archived section.
 *    The #482 defect, in its task variant (#1467).
 *
 * Credential-free: `tasks.create` / `threads.*` are immediate IPC, no agent.
 */

const SHOTS = join(__dirname, '__screens')

function list(win: Page) {
  return win.locator('.fl-thread-sidebar fl-list').first()
}
function row(win: Page, title: string) {
  return list(win).getByText(title, { exact: true })
}
function archivedHeader(win: Page) {
  return list(win).getByText(/Archived \(/i)
}
async function openRowMenu(win: Page, title: string, nth = 0) {
  await row(win, title).nth(nth).click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}
/** Create a task (and its 1:1 thread) through the real IPC bridge. */
async function createTask(win: Page, projectRoot: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, name }) => {
      const api = (
        window as unknown as {
          flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow
      await api.tasks.create({ projectRoot: root, title: name })
    },
    { root: projectRoot, name: title },
  )
}

/**
 * The list's archive control — the one drawer #1391 put tasks into. The
 * "Archived (N)" header that used to sit at the bottom of the sidebar moved into
 * the view menu beside the search (the header now appears only for a SEARCH's
 * archived matches, #482): its row carries the count, and pressing it shows the
 * archived rows in the list. Returns the open menu's archive row.
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

test('an archived thread and an archived task share one Archived drawer, and the thread round-trips out of it', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-arch-task-')
  await activateProject(window, dir)

  await createTask(window, dir, 'Zephyr Task')
  await expect(row(window, 'Zephyr Task').first()).toBeVisible({ timeout: 10000 })
  await newThread(window)
  await expect(row(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  // Archive the thread, then the task.
  let menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()
  await expect(row(window, 'New thread')).toHaveCount(0, { timeout: 5000 })
  menu = await openRowMenu(window, 'Zephyr Task')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()

  // One drawer, both kinds, closed by default — neither row is on screen.
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (2)')
  await expect(row(window, 'New thread')).toHaveCount(0)
  await expect(row(window, 'Zephyr Task')).toHaveCount(0)

  // Show it: both are in there.
  await (await archiveToggle(window)).click()
  await expect(row(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  await expect(row(window, 'Zephyr Task').first()).toBeVisible({ timeout: 5000 })

  // The two menus, side by side — the asymmetry this round filed.
  const taskMenu = await openRowMenu(window, 'Zephyr Task')
  await expect(taskMenu.locator('.fl-thread-menu-item', { hasText: 'Delete task + thread' })).toHaveCount(1)
  await window.screenshot({ path: join(SHOTS, 'threads-archived-task-menu.png') })
  await window.keyboard.press('Escape')

  // Positive control — the THREAD's menu carries the way back, and it works.
  menu = await openRowMenu(window, 'New thread')
  await expect(menu.locator('.fl-thread-menu-item', { hasText: 'Unarchive' })).toHaveCount(1)
  await menu.locator('.fl-thread-menu-item', { hasText: 'Unarchive' }).click()
  await expect(row(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toMatch(/Archived \(1\)$/)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #1466 (#1391's open half): the archived TASK sitting in the drawer the archived thread
 * just walked out of has no exit. Its ⋯ menu is the live menu verbatim (including
 * an "Archive" that re-archives an already-archived task), and the only row that
 * clears it from the drawer is "Delete task + thread" — which also destroys the
 * conversation.
 *
 * Fixed: the menu now mirrors the thread's `isArchived ? 'Unarchive' : 'Archive'`,
 * and the lane rows — unobservable while the task is off the board — are gone
 * while it is archived.
 */
test('an archived task can be restored from the Archived section', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-arch-restore-')
  await activateProject(window, dir)

  await createTask(window, dir, 'Restore Me Task')
  await expect(row(window, 'Restore Me Task').first()).toBeVisible({ timeout: 10000 })

  const menu = await openRowMenu(window, 'Restore Me Task')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()
  await expect(row(window, 'Restore Me Task')).toHaveCount(0, { timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (1)')
  await (await archiveToggle(window)).click()
  await expect(row(window, 'Restore Me Task').first()).toBeVisible({ timeout: 5000 })

  // The way back, mirroring the archived thread's menu.
  const archived = await openRowMenu(window, 'Restore Me Task')
  await expect(archived.locator('.fl-thread-menu-item', { hasText: /Unarchive|Restore/i })).toHaveCount(1)
  // …and nothing that cannot apply: no re-archive, and no lane rows writing a
  // lane onto a task no board will show.
  await expect(archived.locator('.fl-thread-menu-item', { hasText: /^Archive$/ })).toHaveCount(0)
  await expect(
    archived.locator('.fl-thread-menu-item', { hasText: /Move to (Todo|Doing|Done)/ }),
  ).toHaveCount(0)
  await archived.locator('.fl-thread-menu-item', { hasText: /Unarchive|Restore/i }).first().click()

  // Back among the live rows, drawer gone.
  await expect(row(window, 'Restore Me Task').first()).toBeVisible({ timeout: 5000 })
  await expect(archivedHeader(window)).toHaveCount(0, { timeout: 8000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toMatch(/Archived \(0\)$/)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #1467 — the task variant of #482: an archived task's 1:1 thread is NOT archived, and
 * search drops the task layer entirely (`showTasks = !searching`), so the archived
 * task's chat renders as an ordinary live row ABOVE the divider — while the archived
 * task row renders again INSIDE the Archived section. One archived thing, two rows,
 * one of them wearing the live costume (and offering "Archive", which archives the
 * thread as a third state). Flip `test.fixme` → `test` when search stops double-listing.
 */
test('searching for an archived task returns exactly one row, inside the Archived section', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-arch-search-')
  await activateProject(window, dir)

  await createTask(window, dir, 'Zephyr Task')
  await createTask(window, dir, 'Zephyr Live')
  await expect(row(window, 'Zephyr Task').first()).toBeVisible({ timeout: 10000 })

  const menu = await openRowMenu(window, 'Zephyr Task')
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click()
  await expect(row(window, 'Zephyr Task')).toHaveCount(0, { timeout: 5000 })
  await expect.poll(() => archiveCountText(window), { timeout: 8000 }).toBe('Archived (1)')

  await window.locator('.fl-thread-search input').first().fill('Zephyr')
  await expect(row(window, 'Zephyr Live').first()).toBeVisible({ timeout: 5000 })

  // ONE row for the archived task, and it is the archived one (task menu),
  // under the search's Archived section.
  await expect(row(window, 'Zephyr Task')).toHaveCount(1)
  await expect(archivedHeader(window).first()).toHaveText(/Archived \(1\)/i)
  // The restore verb this row should also carry is #1466, not #1467 — it has its
  // own fixme above. Asserting it here would have kept THIS contract red for a
  // second, unrelated reason.

  expect(errors, errors.join(', ')).toHaveLength(0)
})
