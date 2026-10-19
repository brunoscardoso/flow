import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor): tab-strip overflow scroll behavior.
 *
 * The editor tab strip (<fl-tabs>) is `overflow-x:auto` but never scrolls the
 * ACTIVE tab into view, and its render rebuilds all children (resetting
 * scrollLeft to 0) on every tab mutation. So once more files are open than fit
 * the strip width, opening a file (its tab is appended at the far right and made
 * active) leaves that tab entirely off-screen: the editor shows the file's
 * content while the visible strip shows only the leftmost tabs, none of them
 * highlighted as active. This is a real orientation/feedback bug at an ordinary
 * threshold (a ~770px pane fits ~4-8 tabs).
 *
 *  - Live guard (always green): opening more files than fit overflows the strip
 *    and Monaco still renders the just-opened file — the open path works.
 *  - fixme tripwire (#700): the just-opened active tab must be scrolled into
 *    view. Fails today (activeInView === false); flips green when a scroll-to-
 *    active lands in fl-tabs / editor-tabs.
 *
 * Driven via the decoupled `flow:open-file` event (the sidebar tree-click path
 * is #663/#664 activity-bar test debt); Monaco's benign "Canceled" on model
 * dispose is filtered — see editor.spec.ts for the rationale.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Open a file the decoupled way — same event blueprint rows / chat links use. */
async function openViaEvent(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }),
      )
    },
    { rootPath, relPath },
  )
}

/** Measure the tab strip (inside <fl-tabs> shadow) and the active tab's on-screen
 *  visibility relative to the strip's scroll viewport. */
async function stripState(win: Page) {
  return win.evaluate(() => {
    const flTabs = document.querySelector('.fl-shell fl-tabs') as HTMLElement | null
    const sr = flTabs?.shadowRoot as ShadowRoot | null | undefined
    const strip = sr?.querySelector('.strip') as HTMLElement | null | undefined
    const active = sr?.querySelector('.tab.active') as HTMLElement | null | undefined
    if (!strip) return null
    const s = strip.getBoundingClientRect()
    const a = active?.getBoundingClientRect() ?? null
    return {
      scrollLeft: strip.scrollLeft,
      overflowing: strip.scrollWidth > strip.clientWidth + 1,
      activeLabel: active?.textContent ?? null,
      activeInView: a ? a.left >= s.left - 1 && a.right <= s.right + 1 : null,
    }
  })
}

/** Seed N files and open them all in order; return their names. */
async function openManyFiles(win: Page, dir: string, n: number): Promise<string[]> {
  const names: string[] = []
  for (let i = 1; i <= n; i++) {
    const name = `overflow-probe-file-${String(i).padStart(2, '0')}.ts`
    writeFileSync(join(dir, name), `export const MARK_${i} = "marker-${i}"\n`)
    names.push(name)
  }
  await activateProject(win, dir)
  for (const name of names) {
    await openViaEvent(win, dir, name)
    await expect(tab(win, name)).toHaveCount(1, { timeout: 10000 })
  }
  return names
}

const FILE_COUNT = 30

test.afterAll(() => cleanupSeeds())

test('overflow live: opening more files than fit overflows the strip and still renders the active file', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await openManyFiles(window, dir, FILE_COUNT)

  // The just-opened file's content actually renders — the open path is not dead.
  await expect(window.locator('.monaco-editor .view-lines')).toContainText(
    `marker-${FILE_COUNT}`,
    { timeout: 15000 },
  )

  const st = await stripState(window)
  expect(st).not.toBeNull()
  // With 30 tabs in a ~770px pane the strip genuinely overflows.
  expect(st!.overflowing, 'strip should overflow with many tabs').toBe(true)

  await window.screenshot({ path: `${SCREENS}/editor-tab-overflow.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test.fixme(
  'overflow tripwire: the just-opened active tab is scrolled into view (#700 — no scroll-to-active today)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    const names = await openManyFiles(window, dir, FILE_COUNT)
    const last = names[names.length - 1]

    const st = await stripState(window)
    expect(st).not.toBeNull()
    expect(st!.overflowing).toBe(true)
    // The active tab is the file just opened...
    expect(st!.activeLabel).toContain(last)
    // ...and it MUST be visible in the strip. Today the strip stays at scrollLeft
    // 0 and the active tab is off-screen to the right — this assertion fails.
    expect(st!.activeInView, 'just-opened active tab must be scrolled into view').toBe(true)

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  },
)
