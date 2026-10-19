import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the "More" overflow fold (#71) + the
 * search-box Escape-to-clear affordance.
 *
 * The sibling probes cover create/search/delete (`threads.spec.ts`), the
 * row-action surface (`threads-actions.spec.ts`), the archive⇄active⇄search
 * lifecycle (`threads-archive-search.spec.ts`) and the multi-project chooser
 * (`threads-multiproject-picker.spec.ts`). None of them drive the list past
 * its cap, so the count-based fold (`capThreadList`; the Workspace list's
 * WORKSPACE_VISIBLE_LIMIT = 25) and its "More" ⇄ "Less" toggle were entirely
 * un-probed — yet a real user who keeps working hits it constantly.
 *
 * This drives:
 *  - 26 bare threads → exactly 25 rows render, the 26th folds under a "More"
 *    header (not silently dropped).
 *  - Clicking the fold header expands to all 26 and relabels "Less".
 *  - Clicking again collapses back to 25 + "More".
 *  - The search box: typing a no-match query shows the empty hint, then pressing
 *    Escape inside the box clears the query and restores the list (the sidebar's
 *    own keydown-Escape clear at thread-sidebar.ts:130).
 *
 * Credential-free: `threads.create` is immediate IPC.
 */

const SCREENS = 'e2e/ux/__screens'


/** Every thread row's title span (all default to "New thread"). */
function threadRows(win: Page) {
  return win.locator('fl-list').getByText('New thread', { exact: true })
}

function foldHeader(win: Page, text: string | RegExp) {
  return win.locator('fl-list').getByText(text)
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

/** The Workspace list's cap (WORKSPACE_VISIBLE_LIMIT in thread-grouping.ts). */
const LIMIT = 25

test.afterAll(() => cleanupSeeds())

test('overflow: a thread past the cap folds under "More" and toggles open/closed', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // (The empty state names the Workspace the list belongs to since 2026-10-06.)
  await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet')

  // Fill the list to exactly its cap — 25, the Workspace list's limit
  // (WORKSPACE_VISIBLE_LIMIT; the per-project five went with the flat list,
  // 2026-10-06). Made in one IPC batch: this is about the fold, not creation.
  await window.evaluate(
    async ({ root, count }: { root: string; count: number }) => {
      const flow = (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow
      for (let i = 0; i < count; i += 1) await flow.threads.create({ projectRoot: root, title: 'New thread' })
    },
    { root: dir, count: LIMIT },
  )
  await expect(threadRows(window)).toHaveCount(LIMIT, { timeout: 10000 })
  // No overflow control at exactly the cap.
  //
  // The fold's label was `▸ SHOW N MORE` until 2026-09-04 and is now a plain
  // `More` / `Less`: the caret duplicated the word, and the count was a number
  // nobody acts on — you press it either way. The count survives in the title
  // attribute, which is what this asserts so the information is still pinned.
  await expect(foldHeader(window, /^More$/)).toHaveCount(0)

  // One more thread must NOT be silently dropped — it folds under "More"
  // while the visible list stays capped.
  await newThread(window)
  const showMore = foldHeader(window, /^More$/)
  await expect(showMore).toBeVisible({ timeout: 10000 })
  await expect(showMore).toHaveAttribute('title', 'Show 1 more thread')
  await expect(threadRows(window)).toHaveCount(LIMIT)
  await window.screenshot({ path: `${SCREENS}/threads-overflow-folded.png` })

  // Expand → all of them visible, header relabels "Less".
  await showMore.click()
  await expect(threadRows(window)).toHaveCount(LIMIT + 1, { timeout: 5000 })
  await expect(foldHeader(window, /^Less$/)).toBeVisible()

  // Collapse → back to the cap + "More".
  await foldHeader(window, /^Less$/).click()
  await expect(threadRows(window)).toHaveCount(LIMIT, { timeout: 5000 })
  await expect(foldHeader(window, /^More$/)).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('search: Escape inside the search box clears the query and restores the list', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRows(window).first()).toBeVisible({ timeout: 10000 })

  const search = window.locator('.fl-thread-search input').first()
  await search.fill('zzzz-no-such-thread-xyzzy')

  const emptyHint = window.locator('.fl-thread-empty')
  await expect(emptyHint).toContainText('No threads match', { timeout: 5000 })

  // Escape inside the box clears it (thread-sidebar.ts:130) — the thread returns.
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(threadRows(window).first()).toBeVisible({ timeout: 5000 })
  await expect(emptyHint).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
