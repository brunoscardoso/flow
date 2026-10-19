import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression for #700 — the editor tab strip (`<fl-tabs>`) must scroll the
 * ACTIVE tab into view. `#render()` rebuilds every tab button on each mutation,
 * which resets the strip's `scrollLeft` to 0; without a scroll-into-view step,
 * opening the Nth file (its tab appended far right and made active) leaves that
 * tab entirely off-screen — the editor shows its content while the visible strip
 * highlights nothing.
 *
 * Drives the real editor: seed many files, open them all via `flow:open-file`,
 * then reach into the fl-tabs shadow root and assert the active tab is within the
 * strip's visible scroll window.
 */

const FILE_COUNT = 30

/** Measure the fl-tabs strip: whether the active tab lies inside the visible
 *  horizontal scroll window. Reaches into the component's shadow root. */
async function activeTabInView(win: Page): Promise<{
  overflowing: boolean
  activeInView: boolean
  activeLabel: string | null
}> {
  return win.evaluate(() => {
    const tabsEl = document.querySelector('.fl-shell fl-tabs')
    const strip = tabsEl?.shadowRoot?.querySelector('.strip') as HTMLElement | null
    const active = strip?.querySelector('.tab.active') as HTMLElement | null
    if (!strip || !active) {
      return { overflowing: false, activeInView: false, activeLabel: null }
    }
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    const viewLeft = strip.scrollLeft
    const viewRight = strip.scrollLeft + strip.clientWidth
    return {
      overflowing: strip.scrollWidth > strip.clientWidth,
      // Fully within the visible window (small tolerance for sub-pixel rounding).
      activeInView: left >= viewLeft - 1 && right <= viewRight + 1,
      activeLabel: active.textContent?.trim() ?? null,
    }
  })
}

test.afterAll(() => cleanupSeeds())

test('opening a file past the strip width scrolls its active tab into view (#700)', async ({
  window,
}) => {
  const dir = await seedProject(window)
  for (let i = 1; i <= FILE_COUNT; i++) {
    const n = String(i).padStart(2, '0')
    writeFileSync(join(dir, `overflow-probe-file-${n}.ts`), `export const MARK_${n} = "marker-${n}"\n`)
  }
  await activateProject(window, dir)

  // Open every file the way the app does — the flow:open-file event. Each open
  // appends a tab and makes it active; the last one (…file-30) ends up active.
  for (let i = 1; i <= FILE_COUNT; i++) {
    const n = String(i).padStart(2, '0')
    await window.evaluate(
      ({ rootPath, relPath }) => {
        document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
      },
      { rootPath: dir, relPath: `overflow-probe-file-${n}.ts` },
    )
  }

  // The last-opened tab is active and Monaco shows its content.
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('marker-30', {
    timeout: 15000,
  })

  // The strip overflows (30 tabs » pane width) and the active tab is on-screen.
  await expect
    .poll(async () => (await activeTabInView(window)).activeInView, { timeout: 5000 })
    .toBe(true)

  const measured = await activeTabInView(window)
  expect(measured.overflowing).toBe(true) // guards that this actually tests the overflow path
  expect(measured.activeLabel).toContain('overflow-probe-file-30')
})
