import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, WHAT the search box matches (as opposed to WHEN
 * and WHERE the filter applies).
 *
 * Twelve prior thread-search issues (#326 #386 #482 #75 #977 #1010 #1042 #1082
 * #1121 #1172 #1211 #1325) are all about the *lifecycle* of the filter — when
 * it clears, which rows it hides, what the empty state says. None of them ever
 * asked whether a query that is plainly readable in a title actually matches.
 * The sibling `threads-search-filter.spec.ts` even sidesteps the question in a
 * comment ("Titles here are distinct multi-word names so a leading-word query
 * prefix-matches cleanly").
 *
 * The store searches via FTS5 (`ThreadStore.searchThreads` →
 * `buildFtsMatchExpression`, thread-store.ts): user text is split into runs of
 * `[\p{L}\p{N}_%]`, each token double-quoted with a `*` prefix flag, ANDed.
 * The index (migrations.ts v2) uses `unicode61 tokenchars '_%'`. Two consequences
 * a user meets immediately:
 *
 *  1. Matching is PREFIX-PER-TOKEN, never substring, and `_` does not split —
 *     so `user_store migration` is the tokens {user_store, migration} and the
 *     contiguous visible phrase `store migration` matches NOTHING. Same for
 *     camelCase: `PaymentService` is one token, so `Service` finds nothing.
 *     The LIKE substring scan survives in the code but is unreachable for any
 *     query containing an indexable token.
 *
 *  2. #977's rename guard (`shouldClearSearchOnThreadRename`) decides whether to
 *     clear the filter using a case-insensitive SUBSTRING test, its comment
 *     claiming it mirrors "the store's LIKE/FTS search on titles". It does not
 *     (the guard was authored 2026-07-29, twenty days after FTS landed). Rename
 *     a matching thread to a title that still *contains* the query inside a
 *     larger token and the guard keeps the filter armed while the store stops
 *     matching — the exact vanishing act #977 was filed to stop.
 *
 * Credential-free: thread create + rename + search are immediate IPC.
 *
 * Guards below are LIVE controls (green on main — so the tripwires cannot pass
 * vacuously). The `test.fixme` cases are the confirmed defects.
 */

const SCREENS = 'e2e/ux/__screens'


/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

function searchBox(win: Page) {
  return win.locator('.fl-thread-search input').first()
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
  await expect(input).toBeVisible()
  await input.fill(to)
  await input.press('Enter')
}

async function makeThread(win: Page, title: string) {
  await newThread(win)
  await expect(threadRow(win, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await renameTo(win, 'New thread', title)
  await expect(threadRow(win, title).first()).toBeVisible({ timeout: 5000 })
}

/** Type a query and wait past the sidebar's search debounce. */
async function search(win: Page, query: string) {
  await searchBox(win).fill(query)
  await win.waitForTimeout(900)
}

/** Titles the store itself returns for a query — ground truth, bypassing the sidebar. */
async function backendMatches(win: Page, query: string): Promise<string[]> {
  return (await win.evaluate(async (q) => {
    const r = await (
      window as unknown as {
        flow: { threads: { search(a: { query: string }): Promise<unknown> } }
      }
    ).flow.threads.search({ query: q })
    return ((r as { threads?: { title: string }[] })?.threads ?? []).map((t) => t.title)
  }, query)) as string[]
}

const SNAKE = 'user_store migration'
const CAMEL = 'PaymentService cleanup'


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

test('search: leading-token queries match, and clearing restores the list', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await makeThread(window, SNAKE)
  await makeThread(window, CAMEL)

  // CONTROL — the search box works for every query that starts a token, in both
  // directions, case-insensitively. Without this the tripwire below would pass
  // on an app whose search is simply broken.
  await search(window, 'user_store')
  await expect(threadRow(window, SNAKE).first()).toBeVisible()
  await expect(threadRow(window, CAMEL)).toHaveCount(0)

  await search(window, 'migration')
  await expect(threadRow(window, SNAKE).first()).toBeVisible()

  await search(window, 'USER_STORE') // case-insensitive
  await expect(threadRow(window, SNAKE).first()).toBeVisible()

  await search(window, 'Payment')
  await expect(threadRow(window, CAMEL).first()).toBeVisible()
  await expect(threadRow(window, SNAKE)).toHaveCount(0)

  await search(window, 'cleanup')
  await expect(threadRow(window, CAMEL).first()).toBeVisible()

  await search(window, '')
  await expect(threadRow(window, SNAKE).first()).toBeVisible()
  await expect(threadRow(window, CAMEL).first()).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test.fixme(
  'search: a phrase copied verbatim out of a thread title finds nothing (FTS prefix-per-token)',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    await makeThread(window, SNAKE)
    await makeThread(window, CAMEL)

    // `store migration` is a contiguous, visible substring of `user_store migration`.
    await search(window, 'store migration')
    await window.screenshot({ path: `${SCREENS}/threads-search-phrase-nomatch.png` })
    expect(await backendMatches(window, 'store migration')).toContain(SNAKE)
    await expect(threadRow(window, SNAKE).first()).toBeVisible()

    // camelCase: `Service` is plainly readable inside `PaymentService`.
    await search(window, 'Service')
    expect(await backendMatches(window, 'Service')).toContain(CAMEL)
    await expect(threadRow(window, CAMEL).first()).toBeVisible()

    // Inverse harm: punctuation is discarded, so a one-letter residue wildcards.
    // `C++` must not surface a thread that has nothing to do with C++.
    expect(await backendMatches(window, 'C++')).not.toContain(CAMEL)
  },
)

test('rename under a filter: a genuinely non-matching new title clears the filter (#977)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await makeThread(window, 'store migration notes')
  await makeThread(window, 'store cleanup sweep')

  await search(window, 'store')
  await expect(threadRow(window, 'store migration notes').first()).toBeVisible()

  // CONTROL — #977's fix in the case it was written for: the new title shares
  // nothing with the query, so the guard clears the filter and the renamed
  // thread stays on screen.
  await renameTo(window, 'store migration notes', 'quarterly invoice audit')
  await expect(threadRow(window, 'quarterly invoice audit').first()).toBeVisible({ timeout: 5000 })
  await expect(searchBox(window)).toHaveValue('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test.fixme(
  'rename under a filter: the thread still vanishes when the query survives inside a bigger token (#977 hole)',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    await makeThread(window, 'store migration notes')
    await makeThread(window, 'store cleanup sweep') // sibling match keeps the list populated

    await search(window, 'store')
    await expect(threadRow(window, 'store migration notes').first()).toBeVisible()
    await expect(threadRow(window, 'store cleanup sweep').first()).toBeVisible()

    // `user_store migration notes` still CONTAINS "store", so the guard leaves
    // the filter armed — but `store` is no longer a token prefix, so the store
    // drops it. The sibling row stays, so not even the no-match hint fires.
    await renameTo(window, 'store migration notes', 'user_store migration notes')
    await window.waitForTimeout(1200)
    await window.screenshot({ path: `${SCREENS}/threads-rename-vanish-under-filter.png` })

    await expect(threadRow(window, 'user_store migration notes').first()).toBeVisible()
  },
)
