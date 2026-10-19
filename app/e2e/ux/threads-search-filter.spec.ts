import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the POSITIVE search-filter path.
 *
 * The sibling `threads.spec.ts` covers the NEGATIVE search cases (a no-match
 * query shows the distinct hint; creating under a no-match filter reveals the
 * new thread, #386). `threads-archive-search.spec.ts` covers archived matches.
 * What was un-probed: does typing a query that matches ONE of several threads
 * actually NARROW the visible list to just that thread (and hide the others),
 * and does clearing the query restore the full list? That is the core promise
 * of the search box for a real user with many threads.
 *
 * Search is FTS5 prefix matching over title + message content
 * (thread-store.ts searchThreads → buildFtsMatchExpression tokens + '*'), with
 * a case-insensitive LIKE fallback. Titles here are distinct multi-word names
 * so a leading-word query prefix-matches cleanly.
 */

const SCREENS = 'e2e/ux/__screens'


/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** Open the ⋯ actions menu for a row via right-click. */
async function openRowMenu(win: Page, title: string) {
  const row = threadRow(win, title).first()
  await row.click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Rename the (single) 'New thread' row to a distinct title. */
async function renameNewThreadTo(win: Page, to: string) {
  await newThread(win)
  await expect(threadRow(win, 'New thread').first()).toBeVisible({ timeout: 10000 })
  const menu = await openRowMenu(win, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = win.locator('.fl-thread-menu-input')
  await expect(input).toBeVisible()
  await input.fill(to)
  await input.press('Enter')
  await expect(threadRow(win, to).first()).toBeVisible({ timeout: 5000 })
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

test('search filters a multi-thread list to the matching subset and clears back', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Two threads with distinct, non-overlapping titles.
  const ALPHA = 'Payment refund flow'
  const BETA = 'Blueprint export bug'
  await renameNewThreadTo(window, ALPHA)
  await renameNewThreadTo(window, BETA)

  // Baseline: both rows present.
  await expect(threadRow(window, ALPHA).first()).toBeVisible()
  await expect(threadRow(window, BETA).first()).toBeVisible()

  const search = window.locator('.fl-thread-search input').first()

  // Query that matches only ALPHA → BETA must disappear.
  await search.fill('refund')
  await expect(threadRow(window, ALPHA).first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, BETA)).toHaveCount(0, { timeout: 5000 })
  await window.screenshot({ path: `${SCREENS}/threads-search-filter-alpha.png` })

  // Clear → the full list returns.
  await search.fill('')
  await expect(threadRow(window, ALPHA).first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, BETA).first()).toBeVisible({ timeout: 5000 })

  // Query that matches only BETA → ALPHA must disappear (proves it filters both
  // ways, not just hides everything-but-first).
  await search.fill('export')
  await expect(threadRow(window, BETA).first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, ALPHA)).toHaveCount(0, { timeout: 5000 })

  // Clear once more restores both.
  await search.fill('')
  await expect(threadRow(window, ALPHA).first()).toBeVisible({ timeout: 5000 })
  await expect(threadRow(window, BETA).first()).toBeVisible({ timeout: 5000 })

  expect(errors, errors.join(', ')).toHaveLength(0)
})
