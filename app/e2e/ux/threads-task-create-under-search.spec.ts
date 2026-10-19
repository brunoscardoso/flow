/**
 * UX sweep — flow 2 (Threads), round 19: creating something while a thread
 * SEARCH FILTER is active — the two create buttons in the same toolbar.
 *
 * #386 established the contract for the "+" (New thread) button: a fresh thread
 * can't match a stale query, so `#createThread` clears the filter before
 * refreshing (`shouldClearSearchOnThreadCreate` → `#clearSearch`,
 * thread-sidebar.ts ~443) — otherwise the just-created thread is invisible.
 *
 * The New TASK button (checklist icon, one slot to the left) runs a different
 * path — `#promptNewTask` → `tasks.create` → `#afterCreate` — which never
 * touches the search. And a task is doubly hidden under a search: `#groupRows`
 * drops the whole task layer while searching (`const showTasks = !searching`),
 * and the task's 1:1 thread carries the task title, which won't match the query.
 *
 * No sibling flow-2 probe drives this: `threads-search-filter` drives search
 * without creating, `tasks-newtask*` drive the form with no filter active, and
 * `threads-multiselect-search` crosses search with the selection.
 *
 * Guards here:
 *  1. LIVE — the #386 contract on the thread path: creating a thread under an
 *     active filter clears the search and the new thread is visible.
 *  2. LIVE (#1121) — the same holds for the task path: both create channels
 *     now route through the sidebar's shared reveal step (before the fix the
 *     query survived and the new task rendered nowhere until the user cleared
 *     the search by hand).
 *
 * Credential-free: threads.create / tasks.create are immediate IPC (no agent).
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

/** Two matches for the "refund" query plus one non-match, so the probe can
 *  observe the filter ACTUALLY landing (the query is debounced 150ms — asserting
 *  on the input's value alone would race the create click past it). */
const SEEDED = ['alpha refund', 'beta refund', 'gamma export']

function sidebarList(win: Page) {
  return win.locator('.fl-thread-list fl-list')
}
function row(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}
function searchBox(win: Page) {
  return win.locator('input[aria-label="Search threads"]')
}

async function seedAndFilter(win: Page): Promise<string> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  await win.evaluate(
    async ({ root, titles }: { root: string; titles: string[] }) => {
      const flow = (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow
      for (const title of titles) await flow.threads.create({ projectRoot: root, title })
    },
    { root: dir, titles: SEEDED },
  )
  await expect(row(win, 'gamma export')).toBeVisible({ timeout: 10000 })
  // The per-project flow-settings overlay can land late and swallow clicks.
  await dismissFlowOverlay(win)

  // Narrow to the two "refund" threads — the non-matching row dropping out is
  // the proof the debounced query has actually been applied.
  await searchBox(win).fill('refund')
  await expect(row(win, 'gamma export')).toHaveCount(0, { timeout: 8000 })
  await expect(row(win, 'alpha refund').first()).toBeVisible({ timeout: 8000 })
  await expect.poll(() => searchBox(win).inputValue(), { timeout: 5000 }).toBe('refund')
  return dir
}

test.afterAll(() => cleanupSeeds())

// The new-thread page's Create sends a first message — never to the
// developer's account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })

test('creating a THREAD under an active search filter clears the filter and reveals it (#386)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedAndFilter(window)

  // The toolbar "+" opens the new-thread PAGE (since 2026-09-04); its Create
  // makes the thread — the moment the list must reveal it.
  await window.locator('fl-button[aria-label="New thread"]').click()
  await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 10000 })
  await window.locator('.fl-newthread-body').fill('Look at the refunds')
  await window.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  await expect(window.locator('.fl-newthread')).toBeHidden({ timeout: 10000 })

  // The filter is dropped so the fresh thread (default title) can show — the
  // previously filtered-out 'gamma export' comes back with it.
  await expect.poll(() => searchBox(window).inputValue(), { timeout: 8000 }).toBe('')
  await expect(row(window, 'gamma export').first()).toBeVisible({ timeout: 8000 })
  await expect(row(window, 'alpha refund').first()).toBeVisible({ timeout: 8000 })
  await window.screenshot({ path: `${SCREENS}/threads-create-thread-under-search.png` })

  expect(errors, errors.join(', ')).toEqual([])
})

test(
  'creating a TASK under an active search filter must reveal it too (#1121)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await seedAndFilter(window)

    // The sidebar toolbar's "New task" button is gone; the ⌘⇧P palette's
    // "New task" command opens the same form, anchored on the sidebar.
    await window.keyboard.press('ControlOrMeta+Shift+p')
    await window.locator('.fl-palette-panel .fl-palette-input').fill('>new task')
    await expect(window.locator('.fl-palette-row', { hasText: 'New task' }).first()).toBeVisible()
    await window.keyboard.press('Enter')
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible({ timeout: 5000 })
    await menu.locator('input.fl-thread-menu-input').first().fill('ship the login fix')
    await menu.locator('.fl-thread-menu-item', { hasText: /^Create task$/ }).click()

    // The filter clears (the shared reveal step) and the just-created task's
    // row appears — before the fix the sidebar kept the stale "refund" result
    // set and the task the user just created was nowhere in their list.
    await expect(row(window, 'ship the login fix').first()).toBeVisible({ timeout: 8000 })
    await window.screenshot({ path: `${SCREENS}/threads-create-task-under-search.png` })

    expect(errors, errors.join(', ')).toEqual([])
  },
)
