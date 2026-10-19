import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, row actions performed UNDER an active search filter.
 *
 * Two shipped fixes established the product's contract here: an action the user
 * just performed must not leave its subject invisible behind a stale filter.
 *  - #386 — create clears the filter (a default-titled thread can never match).
 *  - #482 — archive keeps the subject visible, grouped under "Archived".
 *
 * Test 1 is the live guard for that contract across the three sibling actions
 * that all hold today (create / archive / still-matching rename).
 *
 * Test 2 is a `test.fixme` tripwire for #977: renaming a thread to a title that
 * no longer matches the live query is the ONE non-destructive action whose
 * subject silently vanishes — `#rename` (thread-sidebar.ts) never calls
 * `#clearSearch`, so the sidebar collapses to «No threads match “…”» with zero
 * rows while the renamed thread sits open in the composer (exactly #386's
 * failure mode, one action over). Verified non-vacuous: un-fixme'd against
 * current main it fails on the documented assertion, not on setup.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Create a thread the way a person does: "+" opens the new-thread PAGE (since
 * 2026-09-04), the description is its first message, and Create makes the
 * thread — titled "New thread" until its first turn names it. The first turn is
 * really sent, so the agent runs with no account (below).
 */
async function createThreadViaPage(win: Page): Promise<void> {
  await win.locator('fl-button[aria-label="New thread"]').click()
  await expect(win.locator('.fl-newthread')).toBeVisible({ timeout: 10000 })
  await win.locator('.fl-newthread-body').fill('Look at the project')
  await win.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  await expect(win.locator('.fl-newthread')).toBeHidden({ timeout: 10000 })
}

/** An EMPTY "New thread", made over the IPC the page ends in, and opened — for
 *  setup that is about the list, not about starting a conversation. */
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

// The page's Create sends a first message — never to the developer's account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })
function sidebarList(win: Page) {
  return win.locator('.fl-thread-sidebar fl-list').first()
}
/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}
function search(win: Page) {
  return win.locator('.fl-thread-search input')
}

/** Open a row's ⋯ actions menu via right-click (same menu as the button). */
async function openRowMenu(win: Page, title: string) {
  await threadRow(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function renameTo(win: Page, from: string, to: string): Promise<void> {
  const menu = await openRowMenu(win, from)
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  await win.locator('.fl-thread-menu-input').fill(to)
  await win.locator('.fl-thread-menu-input').press('Enter')
}

/** Make a thread and give it a known title (credential-free IPC path). */
async function makeThread(win: Page, title: string): Promise<void> {
  await newThread(win)
  await expect(threadRow(win, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await renameTo(win, 'New thread', title)
  await expect(threadRow(win, title).first()).toBeVisible({ timeout: 5000 })
}

test.afterAll(() => cleanupSeeds())

test('under an active filter, create/archive/still-matching-rename keep their subject visible', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await makeThread(window, 'Alpha report')
  await makeThread(window, 'Beta notes')

  // Filter down to the Alpha thread — Beta drops out of the list.
  await search(window).fill('Alpha')
  await expect(threadRow(window, 'Beta notes')).toHaveCount(0, { timeout: 6000 })
  await expect(threadRow(window, 'Alpha report').first()).toBeVisible()

  // (a) #386 — creating a thread under the filter clears it and shows the new row.
  await createThreadViaPage(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  expect(await search(window).inputValue()).toBe('')

  // (b) a rename that STILL matches the live query keeps the row on screen.
  await search(window).fill('Alpha')
  await expect(threadRow(window, 'Beta notes')).toHaveCount(0, { timeout: 6000 })
  await renameTo(window, 'Alpha report', 'Alpha revised')
  await expect(threadRow(window, 'Alpha revised').first()).toBeVisible({ timeout: 6000 })

  // (c) #482 — archiving under the filter keeps the subject visible, grouped
  //     under a forced-expanded "Archived" section rather than vanishing.
  const menu = await openRowMenu(window, 'Alpha revised')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Archive' }).click()
  await expect(sidebarList(window).getByText(/Archived \(1\)/i).first()).toBeVisible({
    timeout: 6000,
  })
  await expect(threadRow(window, 'Alpha revised').first()).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #977 — the residual sibling of #386: rename WAS the only non-destructive row
// action that could drop its own subject out of the filtered list, with no
// notice. Fixed: a non-matching rename clears the filter before the refresh.
test(
  'renaming under a filter never leaves the renamed thread invisible (#977)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await makeThread(window, 'Alpha report')
    await makeThread(window, 'Beta notes')

    await search(window).fill('Alpha')
    await expect(threadRow(window, 'Beta notes')).toHaveCount(0, { timeout: 6000 })
    await expect(threadRow(window, 'Alpha report').first()).toBeVisible()

    // Rename the only match to a title the live query cannot match.
    await renameTo(window, 'Alpha report', 'Quarterly summary')
    await window.waitForTimeout(1500)
    await window.screenshot({ path: `${SCREENS}/threads-rename-under-search.png` })

    // The renamed thread must still be reachable — either because the filter was
    // cleared (the #386 remedy) or because the subject is surfaced regardless.
    await expect(threadRow(window, 'Quarterly summary').first()).toBeVisible({ timeout: 6000 })
    // …and the sidebar must not read as "you have nothing" right after a rename.
    await expect(window.locator('.fl-thread-empty')).toBeHidden()

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
