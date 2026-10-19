/**
 * UX sweep — flow 2 (Threads), round 19: the two menu affordances on a thread
 * row, crossed with the ⌘-click multi-selection (#730).
 *
 * A thread row offers the SAME actions through two entry points — the hover-
 * revealed ⋯ button and right-click on the row. (The ⋯ button was retired
 * 2026-09-04; right-click is now the only door — #1120's guard is skipped.)
 * Only ONE of them knows about the multi-selection:
 *
 *   - `contextmenu` (thread-sidebar.ts ~1041) branches: a row that is part of
 *     the selection opens `#openSelectionMenu` ("Archive N selected threads" /
 *     "Clear selection");
 *   - the ⋯ `click` handler (~1035) always calls `#openRowMenu` — the
 *     single-thread menu — no matter how many rows are selected.
 *
 * So the discoverable affordance silently acts on ONE thread while N are
 * selected, and nothing in the UI advertises right-click as the way in.
 *
 * No sibling flow-2 probe drives this seam: `threads-archive-all` drives
 * multi-select → right-click → archive, `threads-multiselect-search` crosses the
 * selection with the search filter, `threads-actions` drives the ⋯ menu with NO
 * selection live. None compares the two affordances on the same selected row.
 *
 * Guards here:
 *  1. LIVE — ⌘-click marks exactly the clicked rows, and right-click on a
 *     selected row opens the selection menu with the honest count.
 *  2. LIVE — the ⋯ button on an UNSELECTED row opens the single-thread menu
 *     (the correct behaviour when no selection covers that row).
 *  3. LIVE (#1120) — the ⋯ button on a SELECTED row opens the same selection
 *     menu right-click does (before the fix it opened the single-thread menu
 *     and its Archive hit 1 of N).
 *
 * Credential-free: threads.create + threads.update are immediate IPC.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

const TITLES = ['alpha one', 'beta two', 'gamma three']

function sidebarList(win: Page) {
  return win.locator('.fl-thread-list fl-list')
}
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}
function menu(win: Page) {
  return win.locator('.fl-thread-menu')
}

/** Thread-row titles, top-to-bottom, out of fl-list's shadow root. */
async function rowOrder(win: Page): Promise<string[]> {
  return sidebarList(win).evaluate((el) => {
    const shadow = (el as Element).shadowRoot
    const rows = shadow ? Array.from(shadow.querySelectorAll('.row')) : []
    return rows
      .map((row) => {
        const span = Array.from(row.querySelectorAll('span')).find((s) =>
          /^(alpha|beta|gamma) /.test(s.textContent ?? ''),
        )
        return span?.textContent ?? null
      })
      .filter((t): t is string => t !== null)
  })
}

/** Titles of the rows carrying the multi-select mark (`fl-row-marked`). */
async function selectedTitles(win: Page): Promise<string[]> {
  return sidebarList(win).evaluate((el) => {
    const shadow = (el as Element).shadowRoot
    const rows = shadow ? Array.from(shadow.querySelectorAll('.row')) : []
    const out: string[] = []
    for (const row of rows) {
      const marked = row.querySelector(':scope > .fl-row-marked') !== null
      if (!marked) continue
      const span = Array.from(row.querySelectorAll('span')).find((s) =>
        /^(alpha|beta|gamma) /.test(s.textContent ?? ''),
      )
      if (span?.textContent) out.push(span.textContent)
    }
    return out
  })
}

/** Right-click a row (menu is NOT dismissed — the caller inspects it). The
 *  row's ⋯ button was retired 2026-09-04; right-click is the one menu door. */
async function openRowMenu(win: Page, title: string): Promise<void> {
  expect((await rowOrder(win)).indexOf(title), `row "${title}" not found`).toBeGreaterThanOrEqual(0)
  await threadRow(win, title).first().click({ button: 'right' })
  await expect(menu(win)).toBeVisible({ timeout: 5000 })
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

async function seedWithSelection(win: Page): Promise<void> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  await createThreads(win, dir)
  await expect(threadRow(win, 'gamma three')).toBeVisible({ timeout: 10000 })
  // The per-project flow-settings overlay can land late and swallow clicks.
  await dismissFlowOverlay(win)

  // ⌘-click two of the three rows into the selection.
  await threadRow(win, 'alpha one').first().click({ modifiers: ['ControlOrMeta'] })
  await threadRow(win, 'beta two').first().click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(async () => (await selectedTitles(win)).sort(), { timeout: 8000 }).toEqual([
    'alpha one',
    'beta two',
  ])
}

test.afterAll(() => cleanupSeeds())

test('right-click on a ⌘-selected row opens the selection menu with the honest count (#730)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedWithSelection(window)

  await threadRow(window, 'alpha one').first().click({ button: 'right' })
  await expect(menu(window)).toBeVisible({ timeout: 5000 })
  await expect(
    menu(window).locator('.fl-thread-menu-item', { hasText: /^Archive 2 selected threads$/ }),
  ).toBeVisible()
  await expect(
    menu(window).locator('.fl-thread-menu-item', { hasText: /^Clear selection$/ }),
  ).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/threads-multiselect-contextmenu.png` })

  // "Clear selection" really clears it — the rows drop the accent bar.
  await menu(window).locator('.fl-thread-menu-item', { hasText: /^Clear selection$/ }).click()
  await expect.poll(() => selectedTitles(window), { timeout: 5000 }).toEqual([])

  expect(errors, errors.join(', ')).toEqual([])
})

test('right-click on an UNSELECTED row opens the single-thread menu', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedWithSelection(window)

  // 'gamma three' was never ⌘-clicked — its menu is a plain per-row menu.
  await openRowMenu(window, 'gamma three')
  await expect(menu(window).locator('.fl-thread-menu-item', { hasText: /^Rename$/ })).toBeVisible()
  await expect(menu(window).locator('.fl-thread-menu-item', { hasText: /^Delete$/ })).toBeVisible()
  await expect(
    menu(window).locator('.fl-thread-menu-item', { hasText: /selected thread/ }),
  ).toHaveCount(0)

  expect(errors, errors.join(', ')).toEqual([])
})

// #1120's hazard was two menu doors disagreeing; the ⋯ door was retired
// 2026-09-04 (6249e622), so right-click — guarded by the first test — is the
// only way in and there is nothing left to disagree with.
test.skip(
  'the ⋯ button on a SELECTED row must open the same selection menu right-click does (#1120)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await seedWithSelection(window)

    // The discoverable affordance on a row that IS part of the selection.
    await openRowMenu(window, 'alpha one')
    await window.screenshot({ path: `${SCREENS}/threads-multiselect-dots-menu.png` })

    // Before the #1120 fix this menu read "Pin | Rename | Add folder to
    // context… | Archive | Delete" — the selection was ignored, and its
    // Archive hit 1 of the 2 selected threads.
    await expect(
      menu(window).locator('.fl-thread-menu-item', { hasText: /^Archive 2 selected threads$/ }),
    ).toBeVisible({ timeout: 5000 })

    expect(errors, errors.join(', ')).toEqual([])
  },
)
