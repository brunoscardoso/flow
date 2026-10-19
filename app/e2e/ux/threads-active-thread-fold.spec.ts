/**
 * UX sweep — flow 2 (Threads), round 17: the "Show N more" overflow fold (#71)
 * crossed with the CURRENTLY-OPEN thread.
 *
 * `threads-overflow.spec.ts` drives the fold's toggle (5 render, the 6th folds,
 * "Show N more" ⇄ "Show less") but never opens a folded thread.
 * `threads-collapsed-group.spec.ts` (#1010) drives the same reveal question on
 * the COLLAPSE channel (`#collapsedRoots`), and `threads-search-filter.spec.ts`
 * drives search narrowing without a selection. Nobody had asked what happens to
 * the thread that is OPEN IN THE COMPOSER when the recency fold re-applies.
 *
 * The seam: `capThreadList` (thread-grouping.ts) exempts PINNED items from the
 * cap but knows nothing about the active thread, and `#activeThreadId` is used
 * in exactly one place in the sidebar — the row's font-weight (#renderRow ~1000).
 * Neither `#groupRows` nor `setActiveThread` force-reveals the open thread, so
 * an open thread that is not among a project's 5 most-recent simply vanishes
 * from the sidebar while the composer stays live and bound to it.
 *
 * Guards here:
 *  1. LIVE — the fold is honest and the active marking works WHEN the row is
 *     rendered: 27 threads → 25 rows + "More" (2 folded); search bypasses the cap and
 *     reveals the oldest (#71/#75); opening it binds the composer; expanding the
 *     fold shows it carrying the active weight while its siblings do not.
 *  2. LIVE — the composer is torn down on a switch to a thread-less project and
 *     re-armed on the way back (ADR-002 / #405), with no uncaught errors.
 *  3. LIVE (#1042) — after clearing the search, the open thread's row must
 *     still be reachable in the sidebar (capThreadList now exempts the active
 *     thread from the cap, mirroring the pinned exemption).
 *  4. LIVE (#1042) — the same, with no search involved at all: a project
 *     round-trip restores the last-active thread (ADR-002) and the restored
 *     thread's row must be visible.
 *
 * Credential-free: threads.create + project:* are immediate IPC; no agent run.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

/** Oldest → newest. Only the 25 newest survive the fold (WORKSPACE_VISIBLE_LIMIT
 *  — the Workspace's one list raised the per-project five, 2026-10-06), so twenty
 *  fillers sit between the two that fold away and the five named newest. The
 *  fillers do not match `/^t\d /`, so `titleWeights` ignores them. */
const FILLERS = Array.from({ length: 20 }, (_, i) => `fill ${String(i + 1).padStart(2, '0')}`)
const TITLES = [
  't1 alpha',
  't2 bravo',
  ...FILLERS,
  't3 charlie',
  't4 delta',
  't5 echo',
  't6 foxtrot',
  't7 golf',
]
const OLDEST = TITLES[0]

/** The sidebar's own list — the command palette also renders an `fl-list`. */
function sidebarList(win: Page) {
  return win.locator('.fl-thread-list fl-list')
}
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}
function searchBox(win: Page) {
  return win.locator('input[aria-label="Search threads"]')
}
function composer(win: Page) {
  return win.locator('.fl-composer')
}
/** The fold row. Its label was "Show N more" until 2026-09-04 and is now a
 *  plain "More"; the count lives in its title, asserted where it is known. */
function foldHeader(win: Page) {
  return sidebarList(win).getByText(/^More$/)
}

/** Create threads oldest-first; the 60ms gap keeps `updated_at` strictly
 *  ordered (the sidebar sorts on it, ISO ms). */
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

/** Map every `tN …` row title to its computed font-weight. The sidebar marks the
 *  ACTIVE thread with the medium weight (500) and leaves the rest at 400 — rows
 *  live in fl-list's shadow root, so this walks into it. */
async function titleWeights(win: Page): Promise<Record<string, string>> {
  return sidebarList(win).evaluate((el) => {
    const out: Record<string, string> = {}
    const walk = (node: Element | ShadowRoot): void => {
      for (const span of Array.from(node.querySelectorAll('span'))) {
        const text = span.textContent ?? ''
        if (/^t\d /.test(text)) out[text] = getComputedStyle(span).fontWeight
      }
      // fl-list rows live in the host's shadow root — descend into every one,
      // including the host element this walk starts from.
      const shadow = (node as Element).shadowRoot
      if (shadow) walk(shadow)
      for (const child of Array.from(node.children)) walk(child)
    }
    walk(el)
    return out
  })
}

/** Open the oldest (folded-away) thread the way a real user finds it: search. */
async function openOldestViaSearch(win: Page): Promise<void> {
  await searchBox(win).fill('alpha')
  await expect(threadRow(win, OLDEST).first()).toBeVisible({ timeout: 8000 })
  await threadRow(win, OLDEST).first().click()
  await expect(composer(win)).toBeVisible({ timeout: 8000 })
  await win.waitForTimeout(600) // let selectThread's IPC round-trip settle
}

test.afterAll(() => cleanupSeeds())

test('the overflow fold is honest and the open thread is marked active once its row renders (#71)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  await createThreads(window, dir)
  await expect(threadRow(window, 't7 golf')).toBeVisible({ timeout: 10000 })

  // 27 threads → the 25 newest render, the 2 oldest fold (not dropped).
  await expect(foldHeader(window)).toBeVisible({ timeout: 10000 })
  await expect(foldHeader(window)).toHaveAttribute('title', 'Show 2 more threads')
  await expect(threadRow(window, OLDEST)).toHaveCount(0)

  // Search bypasses the cap entirely (#75) — this is how a user reaches an old
  // thread, and it must keep working.
  await openOldestViaSearch(window)

  // Expanding the fold surfaces it, and it reads as the active thread: medium
  // weight on the open row, base weight on every sibling.
  await searchBox(window).fill('')
  await expect(foldHeader(window)).toBeVisible({ timeout: 10000 })
  await foldHeader(window).click()
  await expect(threadRow(window, OLDEST).first()).toBeVisible({ timeout: 8000 })
  await window.waitForTimeout(400) // let fl-list finish painting the expanded rows
  const weights = await titleWeights(window)
  expect(weights[OLDEST]).toBe('500')
  expect(weights['t7 golf']).toBe('400')
  expect(weights['t2 bravo']).toBe('400')

  expect(errors).toEqual([])
})

test('switching to a thread-less project tears the composer down and coming back re-arms it (ADR-002/#405)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-A-')
  const dirB = await seedProject(window, 'flow-ux-B-')
  await activateProject(window, dirA)

  await createThreads(window, dirA)
  await expect(threadRow(window, 't7 golf')).toBeVisible({ timeout: 10000 })
  await openOldestViaSearch(window)
  await searchBox(window).fill('')

  // B has no threads → the armed thread is cleared and the composer torn down.
  await activateProject(window, dirB)
  await expect(composer(window)).toBeHidden({ timeout: 10000 })

  // Back in A → A's last-active thread is restored and the composer re-arms.
  await activateProject(window, dirA)
  await expect(composer(window)).toBeVisible({ timeout: 10000 })

  expect(errors).toEqual([])
})

test(
  'clearing the search must not fold the OPEN thread out of the sidebar (#1042)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await createThreads(window, dir)
    await expect(threadRow(window, 't7 golf')).toBeVisible({ timeout: 10000 })

    await openOldestViaSearch(window)
    await window.mouse.move(1400, 700) // park the pointer off the list (no hover row)
    await window.screenshot({ path: `${SCREENS}/threads-fold-open-under-search.png` })

    // Clear the search: the fold re-applies. The thread the composer is bound to
    // must remain reachable — the sidebar force-expands the Archived section
    // under search (#482) and clears the filter on create (#386) for exactly
    // this reason; the recency fold got neither.
    await searchBox(window).fill('')
    await expect(foldHeader(window)).toBeVisible({ timeout: 10000 })
    await expect(composer(window)).toBeVisible()
    await window.mouse.move(1400, 700) // park the pointer off the list (no hover row)
    await window.screenshot({ path: `${SCREENS}/threads-fold-active-hidden.png` })

    await expect(threadRow(window, OLDEST).first()).toBeVisible({ timeout: 8000 })
    expect(errors).toEqual([])
  },
)

test(
  'a project round-trip restoring the last-active thread must show its row (#1042)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dirA = await seedProject(window, 'flow-ux-A-')
    const dirB = await seedProject(window, 'flow-ux-B-')
    await activateProject(window, dirA)
    await createThreads(window, dirA)
    await expect(threadRow(window, 't7 golf')).toBeVisible({ timeout: 10000 })

    await openOldestViaSearch(window)
    await searchBox(window).fill('')

    // No search is active from here on — just a plain project round-trip.
    await activateProject(window, dirB)
    await expect(composer(window)).toBeHidden({ timeout: 10000 })
    await activateProject(window, dirA)
    await expect(composer(window)).toBeVisible({ timeout: 10000 })
    await window.mouse.move(1400, 700) // park the pointer off the list (no hover row)
    await window.screenshot({ path: `${SCREENS}/threads-fold-roundtrip-hidden.png` })

    // The restored, composer-bound thread must be visible in the sidebar.
    await expect(threadRow(window, OLDEST).first()).toBeVisible({ timeout: 8000 })
    expect(errors).toEqual([])
  },
)
