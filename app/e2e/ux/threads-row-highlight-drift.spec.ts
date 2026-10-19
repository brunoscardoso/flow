/**
 * UX sweep — flow 2 (Threads), round 17: the sidebar's row highlight vs. the
 * thread that is actually open.
 *
 * The sidebar marks the open thread TWICE, through two independent mechanisms:
 *  - identity-based — `#renderRow` gives the row whose `thread.id` matches
 *    `#activeThreadId` the medium font-weight (thread-sidebar.ts ~1000);
 *  - position-based — `fl-list` remembers the clicked ROW INDEX in
 *    `#selectedIndex` and paints `.row.selected` (the raised background) at that
 *    index (fl-list.ts:29 / :258 / :262).
 *
 * `set items` only resets the cursor when it falls off the end
 * (`if (this.#selectedIndex >= value.length) this.#selectedIndex = -1`,
 * fl-list.ts:116) — it is never re-derived from the item it pointed at. So any
 * re-render that REORDERS the list while keeping it at least as long leaves the
 * raised highlight sitting on a different thread than the open one, and the two
 * markers disagree.
 *
 * No sibling flow-2 probe asserts the highlight at all: `threads-actions`,
 * `threads-unpin-reorder` and `threads-collapsed-group` check ordering, glyphs
 * and row presence; `threads-select-follows-project` checks the font-weight
 * marker only.
 *
 * Guards here:
 *  1. LIVE — opening a thread marks it BOTH ways (raised row + medium weight on
 *     the same title), and the markers agree.
 *  2. LIVE — a reorder triggered by pinning does what it should to the ORDER
 *     (the pinned thread floats to the top) and leaves the identity-based
 *     marker on the still-open thread.
 *  3. LIVE (#1043) — after that reorder the raised `.selected` row must still
 *     be the open thread, not whatever now occupies the old row index (the
 *     sidebar now re-derives the cursor from the active thread's identity on
 *     every render).
 *
 * Credential-free: threads.create + the row menu's Pin are immediate IPC.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

/** Oldest → newest; four threads keeps the list under the fold (limit 5). */
const TITLES = ['t1 alpha', 't2 bravo', 't3 charlie', 't4 delta']

function sidebarList(win: Page) {
  return win.locator('.fl-thread-list fl-list')
}
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}

interface SidebarMarkers {
  /** Title of the row carrying fl-list's raised `.selected` background. */
  highlighted: string | null
  /** Title carrying the sidebar's medium font-weight (the active thread). */
  weighted: string | null
  /** Row titles top-to-bottom (thread rows only). */
  order: string[]
}

/** Read both "this is the open thread" markers out of fl-list's shadow root. */
async function markers(win: Page): Promise<SidebarMarkers> {
  return sidebarList(win).evaluate((el) => {
    const shadow = (el as Element).shadowRoot
    const rows = shadow ? Array.from(shadow.querySelectorAll('.row')) : []
    const titleOf = (row: Element): string | null => {
      for (const span of Array.from(row.querySelectorAll('span'))) {
        const text = span.textContent ?? ''
        if (/^t\d /.test(text)) return text
      }
      return null
    }
    const weightOf = (row: Element): string => {
      for (const span of Array.from(row.querySelectorAll('span'))) {
        if (/^t\d /.test(span.textContent ?? '')) return getComputedStyle(span).fontWeight
      }
      return '400'
    }
    const threadRows = rows.filter((row) => titleOf(row) !== null)
    const selected = threadRows.find((row) => row.classList.contains('selected'))
    const weighted = threadRows.find((row) => Number(weightOf(row)) >= 500)
    return {
      highlighted: selected ? titleOf(selected) : null,
      weighted: weighted ? titleOf(weighted) : null,
      order: threadRows.map((row) => titleOf(row) as string),
    }
  })
}

/** Open a thread's right-click menu and click one of its items. */
async function rowMenu(win: Page, title: string, item: RegExp): Promise<void> {
  await threadRow(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await menu.locator('.fl-thread-menu-item', { hasText: item }).first().click()
  await expect(menu).toBeHidden({ timeout: 5000 })
}

async function createThreads(win: Page, root: string): Promise<void> {
  for (const title of TITLES) {
    await win.evaluate(
      async ({ root, title }: { root: string; title: string }) => {
        const flow = (
          window as unknown as {
            flow: {
              threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
            }
          }
        ).flow
        await flow.threads.create({ projectRoot: root, title })
      },
      { root, title },
    )
    await win.waitForTimeout(60)
  }
}

/** Park the pointer off the list so `:hover` can't be mistaken for `.selected`. */
async function parkPointer(win: Page): Promise<void> {
  await win.mouse.move(1400, 700)
  await win.waitForTimeout(200)
}

test.afterAll(() => cleanupSeeds())

test('opening a thread marks it both ways and the two markers agree', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThreads(window, dir)
  await expect(threadRow(window, 't4 delta')).toBeVisible({ timeout: 10000 })

  // Newest-first, no fold.
  expect((await markers(window)).order).toEqual(['t4 delta', 't3 charlie', 't2 bravo', 't1 alpha'])

  await threadRow(window, 't3 charlie').first().click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 8000 })
  await parkPointer(window)

  const opened = await markers(window)
  expect(opened.weighted).toBe('t3 charlie')
  expect(opened.highlighted).toBe('t3 charlie')

  expect(errors).toEqual([])
})

test('pinning a sibling reorders the list and keeps the active-thread weight on the open thread', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThreads(window, dir)
  await expect(threadRow(window, 't4 delta')).toBeVisible({ timeout: 10000 })

  await threadRow(window, 't3 charlie').first().click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 8000 })
  await parkPointer(window)

  // Pin the OLDEST thread — it floats to the top, shifting every row below it.
  await rowMenu(window, 't1 alpha', /^Pin$/)
  await parkPointer(window)
  await expect
    .poll(async () => (await markers(window)).order[0], { timeout: 8000 })
    .toBe('t1 alpha')

  // The open thread has not changed, so the identity-based marker must not move.
  expect((await markers(window)).weighted).toBe('t3 charlie')

  expect(errors).toEqual([])
})

test(
  'the raised row highlight must follow the OPEN thread across a reorder (#1043)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await createThreads(window, dir)
    await expect(threadRow(window, 't4 delta')).toBeVisible({ timeout: 10000 })

    await threadRow(window, 't3 charlie').first().click()
    await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 8000 })
    await parkPointer(window)
    await window.screenshot({ path: `${SCREENS}/threads-highlight-before-reorder.png` })

    await rowMenu(window, 't1 alpha', /^Pin$/)
    await parkPointer(window)
    await expect
      .poll(async () => (await markers(window)).order[0], { timeout: 8000 })
      .toBe('t1 alpha')
    await window.screenshot({ path: `${SCREENS}/threads-highlight-after-reorder.png` })

    // fl-list's cursor is positional, so it now paints whatever moved into the
    // old row index ('t4 delta') and the two markers contradict each other.
    const after = await markers(window)
    expect(after.highlighted).toBe('t3 charlie')
    expect(after.highlighted).toBe(after.weighted)

    expect(errors).toEqual([])
  },
)
