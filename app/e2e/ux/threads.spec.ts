import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads (create, search, empty state, select, delete).
 *
 * Drives the real thread sidebar against a seeded project. Asserts the thread
 * UX: the New-thread page's Create makes a persisted "New thread" row; a no-match search shows the distinct
 * "No threads match" hint with no bare project group header (#326 guard);
 * selecting highlights the active row; deleting via the row's right-click menu confirm removes
 * it and returns the empty state.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Create a thread the way a person does: "+" opens the new-thread PAGE (since
 * 2026-09-04), the description is its first message, and Create makes the
 * thread — titled "New thread" until its first turn names it — and opens it.
 * The first turn is really sent, so the agent runs with no account (below).
 */
async function createThread(win: Page, ask = 'Look at the project'): Promise<void> {
  await win.locator('fl-button[aria-label="New thread"]').click()
  await expect(win.locator('.fl-newthread')).toBeVisible({ timeout: 10000 })
  await win.locator('.fl-newthread-body').fill(ask)
  await win.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  await expect(win.locator('.fl-newthread')).toBeHidden({ timeout: 10000 })
}

// The page's Create sends a first message — never to the developer's account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

test.afterAll(() => cleanupSeeds())

test('create: New thread makes a persisted row and clears the empty state', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet')

  await createThread(window)

  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await expect(window.locator('.fl-thread-empty')).toBeHidden()

  await window.screenshot({ path: `${SCREENS}/threads-created.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('search: a no-match query shows the distinct no-match hint, no bare header', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  const search = window.locator('.fl-thread-search input').first()
  await search.fill('zzzz-no-such-thread-xyzzy')

  const emptyHint = window.locator('.fl-thread-empty')
  await expect(emptyHint).toBeVisible({ timeout: 5000 })
  await expect(emptyHint).toContainText('No threads match')
  // #326 guard: no bare project group header / thread rows behind the hint.
  await expect(threadRow(window, 'New thread')).toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/threads-search-nomatch.png` })

  await search.fill('')
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('delete: ⋯ menu → confirm removes the thread and restores the empty state', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThread(window)
  const row = threadRow(window, 'New thread').first()
  await expect(row).toBeVisible({ timeout: 10000 })

  // The row's ⋯ column was retired (2026-09-04); its menu is the right-click.
  await row.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()

  await menu.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).first().click()
  await expect(window.locator('.fl-thread-menu-confirm')).toHaveText('Delete this thread?')
  await window.screenshot({ path: `${SCREENS}/threads-delete-confirm.png` })

  await window
    .locator('.fl-thread-menu-item.danger', { hasText: 'Delete' })
    .last()
    .click()

  await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet', {
    timeout: 10000,
  })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * Regression guard for #386: creating a thread while a no-match search filter is
 * active must surface the new thread (clear the stale filter), not leave the
 * sidebar stuck on "No threads match" with the just-created thread invisible.
 * (#386 landed long ago; #1121 pulled the reveal into the shared create path —
 * this guard is live.)
 */
test(
  'create under an active no-match search reveals the new thread (#386)',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    await createThread(window)
    await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

    const search = window.locator('.fl-thread-search input').first()
    await search.fill('qqzz-nomatch')
    await expect(window.locator('.fl-thread-empty')).toContainText('No threads match')

    await createThread(window)

    // The freshly-created thread must be visible — the stale filter should clear.
    await expect(window.locator('.fl-thread-empty')).toBeHidden({ timeout: 5000 })
    await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 5000 })
  },
)
