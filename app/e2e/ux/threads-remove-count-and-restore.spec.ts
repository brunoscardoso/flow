import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * #1082 — "Remove from sidebar" must count the DESTRUCTION, not the VIEW.
 *
 * The project group's remove confirmation quotes a thread/task count so a
 * misclick can't silently destroy data. That count used to be computed from
 * `ThreadSidebar.#threads`, which is the SEARCH RESULT SET whenever the search
 * box is non-empty — while `project:remove` cascades over EVERY
 * thread + task of the root. With a filter narrowing the sidebar to 1 of 6
 * threads the prompt promised "1 thread" and the click destroyed 6,
 * irreversibly, with no undo and no toast.
 *
 * Three probes against the real menus (no mocks):
 *  1. Control — unfiltered, the count is honest, and Cancel destroys nothing.
 *  2. The #1082 tripwire (formerly a fix-agnostic `test.fixme`, verified
 *     non-vacuous pre-fix: promised 1, destroyed 6) — under an active search
 *     the confirm must still quote the FULL count, and confirming must destroy
 *     exactly what it promised.
 *  3. The milder sibling documented in #1082 — "Archive all threads" under a
 *     filter must count and archive ALL active threads (the item says "all"),
 *     not just the search matches.
 */

interface ThreadRec {
  id: string
  archivedAt: string | null
}

/** Bridge-truth: threads for a root (default excludes archived). */
async function listThreads(
  win: Page,
  projectRoot: string,
  includeArchived = false,
): Promise<ThreadRec[]> {
  return win.evaluate(
    async ({ projectRoot, includeArchived }) =>
      (await (
        window as unknown as {
          flow: {
            threads: {
              list(r: { projectRoot: string; includeArchived: boolean }): Promise<ThreadRec[]>
            }
          }
        }
      ).flow.threads.list({ projectRoot, includeArchived })) as ThreadRec[],
    { projectRoot, includeArchived },
  )
}

/** Create a titled thread bound to a specific project root via the real bridge. */
async function createThread(win: Page, projectRoot: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ projectRoot, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot, title })
    },
    { projectRoot, title },
  )
}

/** The ⋯ "Project actions" button inside the group header row for `name`. */
function moreBtnFor(win: Page, name: string) {
  return win.locator(
    `.row:has([aria-label="New thread or task in ${name}"]) [aria-label="Project actions"]`,
  )
}

/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

function searchBox(win: Page) {
  return win.locator('.fl-thread-search input').first()
}

test.describe('project remove-from-sidebar count vs cascade (#1082)', () => {
  test.afterAll(() => cleanupSeeds())

  // FIXME(project menu): the per-project ⋯ "Project actions" button left the
  // sidebar with the flat Workspace list (6249e622). The project menu is now asked
  // for from the Workspace switcher's project row, which this harness cannot reach
  // yet — so this guard waits for a way in rather than being rewritten to a
  // different surface.
  test.fixme('control: unfiltered confirm quotes the full count; Cancel destroys nothing', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    await activateProject(window, a)
    const titles = ['Ctrl one', 'Ctrl two', 'Ctrl three', 'Ctrl four', 'Ctrl five', 'Ctrl six']
    for (const title of titles) await createThread(window, a, title)
    await expect(async () => {
      expect(await listThreads(window, a)).toHaveLength(6)
    }).toPass({ timeout: 5000 })

    await moreBtnFor(window, basename(a)).click()
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()

    const confirm = menu.locator('.fl-thread-menu-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('6 threads')
    await expect(confirm).toContainText(basename(a))

    // Cancel — nothing dies.
    await menu.locator('.fl-thread-menu-item', { hasText: 'Cancel' }).click()
    await expect(menu).toHaveCount(0)
    expect(await listThreads(window, a, true)).toHaveLength(6)
    expect(errors).toEqual([])
  })

  // FIXME(project menu): the per-project ⋯ "Project actions" button left the
  // sidebar with the flat Workspace list (6249e622). The project menu is now asked
  // for from the Workspace switcher's project row, which this harness cannot reach
  // yet — so this guard waits for a way in rather than being rewritten to a
  // different surface.
  test.fixme('under a search filter the confirm still quotes ALL threads, and the cascade matches it', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const b = await seedProject(window, 'flow-ux-cnt-')
    await activateProject(window, b)
    const titles = [
      'Zeta perf tuning',
      'Omega needle thread',
      'Zeta infra cleanup',
      'Zeta billing spike',
      'Zeta auth rework',
      'Zeta migration notes',
    ]
    for (const title of titles) await createThread(window, b, title)
    await expect(async () => {
      expect(await listThreads(window, b)).toHaveLength(6)
    }).toPass({ timeout: 5000 })
    await expect(threadRow(window, 'Omega needle thread').first()).toBeVisible({ timeout: 5000 })
    // 'Zeta migration notes' is the MOST RECENT thread, so it is rendered even
    // though the sidebar folds unpinned threads beyond 5 (#71) — waiting on ITS
    // disappearance below proves the search render actually landed. (Waiting on
    // the oldest row would pass vacuously: the fold already hides it.)
    await expect(threadRow(window, 'Zeta migration notes').first()).toBeVisible({ timeout: 5000 })

    // Narrow the sidebar to ONE of the six threads.
    await searchBox(window).fill('Omega')
    await expect(threadRow(window, 'Omega needle thread').first()).toBeVisible({ timeout: 5000 })
    await expect(threadRow(window, 'Zeta migration notes')).toHaveCount(0, { timeout: 5000 })

    // Remove from sidebar → the prompt must count the cascade (6), not the view (1).
    await moreBtnFor(window, basename(b)).click()
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()

    const confirm = menu.locator('.fl-thread-menu-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('6 threads')
    await window.screenshot({ path: join(__dirname, "__screens/threads-remove-count-confirm.png") })

    // Confirm — the destruction equals the promise: all 6, project gone.
    await menu.locator('.fl-thread-menu-item.danger', { hasText: 'Remove' }).click()
    await expect(async () => {
      expect(await listThreads(window, b, true)).toHaveLength(0)
    }).toPass({ timeout: 5000 })
    expect(errors).toEqual([])
  })

  // FIXME(project menu): the per-project ⋯ "Project actions" button left the
  // sidebar with the flat Workspace list (6249e622). The project menu is now asked
  // for from the Workspace switcher's project row, which this harness cannot reach
  // yet — so this guard waits for a way in rather than being rewritten to a
  // different surface.
  test.fixme('sibling: Archive-all under a filter counts and archives ALL active threads', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const c = await seedProject(window, 'flow-ux-arc-')
    await activateProject(window, c)
    const titles = ['Solo archive needle', 'Bulk item one', 'Bulk item two', 'Bulk item three']
    for (const title of titles) await createThread(window, c, title)
    await expect(async () => {
      expect(await listThreads(window, c)).toHaveLength(4)
    }).toPass({ timeout: 5000 })

    // Narrow the sidebar to ONE of the four threads.
    await searchBox(window).fill('Solo')
    await expect(threadRow(window, 'Solo archive needle').first()).toBeVisible({ timeout: 5000 })
    await expect(threadRow(window, 'Bulk item one')).toHaveCount(0, { timeout: 5000 })

    // Archive ALL threads → the confirm counts all 4, and all 4 archive.
    await moreBtnFor(window, basename(c)).click()
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.fl-thread-menu-item', { hasText: 'Archive all threads' }).click()

    const confirm = menu.locator('.fl-thread-menu-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('Archive 4 threads')

    await menu.locator('.fl-thread-menu-item', { hasText: 'Archive all' }).click()
    await expect(async () => {
      expect(await listThreads(window, c)).toHaveLength(0)
    }).toPass({ timeout: 5000 })
    // Archived, not deleted — recoverable, all four still exist.
    expect(await listThreads(window, c, true)).toHaveLength(4)
    expect(errors).toEqual([])
  })
})
