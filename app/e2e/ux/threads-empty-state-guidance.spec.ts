import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the sidebar's empty state.
 *
 * The thread sidebar owns the only first-run guidance in the chat column: the
 * conversation pane deliberately renders a blank surface when no thread is open
 * ("Clean, Zed-like empty state … new threads start from the sidebar's + button"
 * — conversation-pane.ts `setThread`), so the sidebar's `.fl-thread-empty` hint
 * is what a user with nothing open actually reads.
 *
 * Test 1 is the live guard: the hint element is a real, toggling surface — up on
 * a project-less launch, gone once a thread exists. That keeps the tripwire below
 * honest (it fails on the state, never on a missing/never-rendered element).
 *
 * Test 2 is a `test.fixme` tripwire for #978: `#renderRows` shows the hint only
 * when `rows.length === 0`, and every project root always pushes a group-header
 * row — so the hint is suppressed in the exact case it describes (a project open
 * with zero threads) and shown in the case it misdescribes (no project at all,
 * where the blocker is "open a project"). Verified non-vacuous: un-fixme'd
 * against current main it fails on the documented assertion, not on setup.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Make an EMPTY thread called "New thread" in the active project and open it —
 * what the toolbar "+" used to do. Since 2026-09-04 "+" opens the new-thread
 * PAGE, whose Create sends a first message; this spec is about the sidebar's
 * empty state, so the thread is made over the same IPC the page ends in.
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
function sidebarList(win: Page) {
  return win.locator('.fl-thread-sidebar fl-list').first()
}
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}

test.afterAll(() => cleanupSeeds())

test('the sidebar empty hint is a live, toggling surface (project-less launch → thread)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // A fresh launch has no project: the hint is up, and it names the ACTUAL
  // blocker — opening a project — not threads (#978; the sidebar's own
  // Add-project button was removed in #128, so it points at the titlebar).
  const hint = window.locator('.fl-thread-empty')
  await expect(hint).toBeVisible({ timeout: 10000 })
  await expect(hint).toHaveText('Open a project to start — Add project… in the Workspace menu')

  // The conversation pane contributes no guidance of its own — its empty state
  // (including the "Open Project" CTA) is force-hidden by `setThread`, which is
  // why the sidebar hint is the whole story. Guard that assumption explicitly so
  // this spec notices if the CTA is ever revived.
  await expect(window.locator('.fl-conv-empty')).toBeHidden()

  // Once a project has a thread, the hint stands down.
  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await expect(hint).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #978 — the hint WAS inverted: suppressed by the always-present group-header
// row in the one state it was written for. Fixed: the gate counts content
// (thread/task/fold) rows, so a zero-thread project shows "No threads yet".
test(
  'a project with zero threads gets an empty state, not a blank panel (#978)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await window.waitForTimeout(1500)
    await window.screenshot({ path: `${SCREENS}/threads-empty-project-zero-threads.png` })

    // The project is open and has no threads — the one state "No threads yet"
    // exists to describe. The sidebar must say something, and say THAT.
    await expect(window.locator('.fl-thread-empty')).toBeVisible({ timeout: 6000 })
    // (The empty state names the Workspace the list belongs to since 2026-10-06.)
    await expect(window.locator('.fl-thread-empty')).toHaveText('No threads in Default yet')

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
