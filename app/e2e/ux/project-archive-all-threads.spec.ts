import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { openProjectActions } from './fixtures/project-actions'

/**
 * Flow 1 (extended) — Project MANAGEMENT: the "Archive all threads" project
 * group-header action (#730). Every prior flow-1 round drove reorder, remove,
 * switch, overflow (#818), escape — NONE drove archive-all, a project-scoped
 * bulk action with a counted inline confirmation (a misclick must not silently
 * mass-archive) and a disabled-at-zero guard.
 *
 * Drives the real ⋯ project menu (`#openProjectMenu` → `#confirmArchiveAll` in
 * thread-sidebar.ts) against a seeded project with IPC-created threads, and
 * asserts the observable UX: counted confirm, threads vanish on confirm, the
 * project group header SURVIVES bulk archive (management stays reachable — the
 * sidebar renders a header for every known root regardless of thread count),
 * and Archive-all flips to disabled once the project has zero active threads.
 * Watches for uncaught renderer errors throughout.
 */
const t = test

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
              list(r: {
                projectRoot: string
                includeArchived: boolean
              }): Promise<ThreadRec[]>
            }
          }
        }
      ).flow.threads.list({ projectRoot, includeArchived })) as ThreadRec[],
    { projectRoot, includeArchived },
  )
}

/** Create a thread bound to a specific project root via the real bridge. */
async function createThread(win: Page, projectRoot: string): Promise<void> {
  await win.evaluate(async (projectRoot) => {
    await (
      window as unknown as {
        flow: { threads: { create(r: { projectRoot: string }): Promise<unknown> } }
      }
    ).flow.threads.create({ projectRoot })
  }, projectRoot)
}

/** Thread rows in the sidebar list carrying the default "New thread" title. */
function threadRows(win: Page) {
  return win.locator('fl-list').getByText('New thread', { exact: true })
}

t.describe('project archive-all-threads (#730)', () => {
  t.afterAll(() => cleanupSeeds())

  // The door: the ⋯ on the project's row in the Workspace switcher, which
  // dispatches `flow:project-menu` to the thread sidebar's project menu.
  t('a project with zero threads shows Archive-all DISABLED (no dead click)', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    await activateProject(window, a)
    // Fresh seeded repo has no threads.
    expect(await listThreads(window, a)).toHaveLength(0)

    const menu = await openProjectActions(window, basename(a))
    await expect(menu).toBeVisible()
    const archiveAll = menu.locator('.fl-thread-menu-item', { hasText: 'Archive all threads' })
    await expect(archiveAll).toBeVisible()
    await expect(archiveAll).toBeDisabled()
    // Clicking a disabled control must do nothing — no confirm body, no crash.
    await archiveAll.click({ force: true })
    await expect(menu.locator('.fl-thread-menu-confirm')).toHaveCount(0)

    await window.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  t('Archive-all shows a counted confirm, then bulk-archives; header survives', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const a = await seedProject(window)
    await activateProject(window, a)

    // Three threads bound to this project via the real bridge.
    await createThread(window, a)
    await createThread(window, a)
    await createThread(window, a)
    await expect(async () => {
      expect(await listThreads(window, a)).toHaveLength(3)
    }).toPass({ timeout: 4000 })
    // The three rows render in the sidebar under the project.
    await expect(threadRows(window)).toHaveCount(3, { timeout: 5000 })

    // Open ⋯ → Archive all threads is enabled now that active threads exist.
    const menu = await openProjectActions(window, basename(a))
    await expect(menu).toBeVisible()
    const archiveAll = menu.locator('.fl-thread-menu-item', { hasText: 'Archive all threads' })
    await expect(archiveAll).toBeEnabled()
    await archiveAll.click()

    // Counted confirmation — the exact count, so a misclick can't mass-archive blind.
    const confirm = menu.locator('.fl-thread-menu-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('Archive 3 threads in')
    await expect(confirm).toContainText(basename(a))
    await window.screenshot({ path: join(__dirname, "__screens/project-archive-all-confirm.png") })

    // Confirm → the three threads archive (fail-soft bulk) and leave the active list.
    await menu.locator('.fl-thread-menu-item', { hasText: 'Archive all' }).click()
    await expect(async () => {
      expect(await listThreads(window, a)).toHaveLength(0)
    }).toPass({ timeout: 4000 })
    // …but they still exist, archived (recoverable — not deleted).
    expect(await listThreads(window, a, true)).toHaveLength(3)
    await expect(threadRows(window)).toHaveCount(0, { timeout: 5000 })

    // The project SURVIVES a full archive — management stays reachable (you
    // can still switch to it / un-archive), it doesn't vanish.
    await window.keyboard.press('Escape')
    // Reopening ⋯ now shows Archive-all disabled (zero active threads).
    const menu2 = await openProjectActions(window, basename(a))
    await expect(menu2).toBeVisible()
    await expect(
      menu2.locator('.fl-thread-menu-item', { hasText: 'Archive all threads' }),
    ).toBeDisabled()

    await window.keyboard.press('Escape')
    await window.screenshot({ path: join(__dirname, "__screens/project-archive-all-after.png") })
    expect(errors).toEqual([])
  })
})
