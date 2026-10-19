// LIVE guard (feature-blueprint): a roomy cell shows BOTH the counts it is made
// of and the percentage of it that is understood.
//
// Written because the percentage vanished from every cell on a wide window and
// 3,731 unit tests said nothing. The cause was one selector: the painter looked
// for `.fb-terr-cell-second` with a plain `querySelector`, which searches
// DESCENDANTS — and when the mark's host is the CELL, the second line it found
// lives inside the kicker and is not the cell's own child, so `insertBefore`
// threw and took the whole paint loop with it. Only a cell wide enough to HAVE
// a second line could trip it, which is why every small-window probe passed.
//
// The two must therefore be asserted TOGETHER on one roomy cell: either alone
// is exactly the state that shipped.
//
// Untracked probe — skipped wholesale when orbit-app is absent (CI).
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()

test('live: a roomy cell shows its counts and its percentage', async ({ app, window }) => {
  // OPT-IN ONLY (2026-10-09). This spec adds the user's REAL checkout to an app
  // running on a throwaway Flow folder; in a normal sweep it re-pointed the
  // checkout's flow/ link into that folder, which was then deleted — the user's
  // app launched on a dangling link. The CLI now refuses that takeover, and the
  // spec runs only when asked for, like learn-chats.
  test.skip(process.env['FLOW_LIVE_REAL_CHECKOUT'] !== '1', 'opt-in: set FLOW_LIVE_REAL_CHECKOUT=1 (uses a real checkout)')
  test.skip(LIVE_PROJECT === '', noLiveProject())
  test.setTimeout(360_000)

  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, LIVE_PROJECT)
  await activateProject(window, LIVE_PROJECT)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 180_000 })

  // WIDE ON PURPOSE. The defect needs cells roomy enough to carry a second
  // line, and the default test window is not.
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(2000, 1400)
  })
  await window.waitForTimeout(5000)

  const cells = await window.evaluate(() =>
    [...document.querySelectorAll('.fb-terr-cell')].map((el) => ({
      name: el.querySelector('.fb-terr-cell-name')?.textContent ?? '',
      second: el.querySelector('.fb-terr-cell-second')?.textContent ?? '',
      pct: el.querySelector('.fb-terr-progress-figure')?.textContent ?? '',
      roomy: el.classList.contains('fb-terr-roomy'),
    })),
  )

  // At least one cell carries both. Named neither by id nor by position: which
  // feature is biggest is the store's business, and pinning one would make this
  // fail on a re-derive rather than on the defect.
  const both = cells.filter((c) => c.roomy && c.second.length > 0 && /^\d+%$/.test(c.pct))
  expect(both.length, `cells with counts AND a percentage — saw ${JSON.stringify(cells)}`).toBeGreaterThan(0)

  // …and the percentage is never printed alone on a cell that should also be
  // saying what it is made of.
  for (const cell of cells) {
    if (cell.pct.length > 0 && cell.roomy) expect(cell.second.length).toBeGreaterThan(0)
  }
})
