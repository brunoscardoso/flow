import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7: Editor, same-basename tab identity.
 *
 * `src/index.ts` and `tests/index.ts` are an everyday pair in a real project
 * (also `page.tsx`, `README.md`, `types.ts`, …). The editor labels every tab with
 * `lastSegment(relPath)` (editor/index.ts openFile → tabs.add), and <fl-tabs>
 * renders the label with NO `title`/tooltip — so both tabs read exactly
 * "index.ts", same icon, same close aria-label. Nothing in the editor area shows
 * the path (no breadcrumb), so the two tabs are indistinguishable and the user
 * can edit/save/close the wrong file.
 *
 * The app already solved this class for projects: `projectLabel()`
 * (renderer/project-label.ts, #426) disambiguates same-basename roots with the
 * parent segment and notes the full path should be a tooltip. The tab strip never
 * adopted it.
 *
 * Guard 1 (live): the two files really are two independent tabs/buffers — content
 * follows the selected tab, no collision, no errors. This must never regress.
 * Guard 2 (tripwire, fixme #991): the tabs are distinguishable to a user — by
 * label text or by a path tooltip. Un-fixme when the disambiguation lands.
 */

/** Monaco's benign "Canceled" CancellationError on model dispose (tab close). */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

const SCREENS = 'e2e/ux/__screens'

/** Open a project file through the app's real `flow:open-file` channel — the same
 *  `openFile(rootPath, relPath)` a Files-tree row click calls. */
async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

interface TabView {
  label: string
  title: string | null
  ariaLabel: string | null
  closeLabel: string | null
  active: boolean
}

/** Read the editor tab strip out of <fl-tabs>'s (open) shadow root. */
async function readTabs(win: Page): Promise<TabView[]> {
  return win.evaluate(() => {
    const strip = document.querySelector('fl-tabs')
    const root = strip?.shadowRoot
    const buttons = Array.from(root?.querySelectorAll('button.tab') ?? [])
    return buttons.map((button) => ({
      label: (button.querySelector('span:not(.dirty-dot)') as HTMLElement | null)?.textContent ?? '',
      title: button.getAttribute('title'),
      ariaLabel: button.getAttribute('aria-label'),
      closeLabel: button.querySelector('.close')?.getAttribute('aria-label') ?? null,
      active: button.classList.contains('active'),
    }))
  })
}

/** Click the Nth editor tab (inside the shadow root). */
async function clickTab(win: Page, index: number): Promise<void> {
  await win.evaluate((i) => {
    const root = document.querySelector('fl-tabs')?.shadowRoot
    const buttons = Array.from(root?.querySelectorAll('button.tab') ?? [])
    ;(buttons[i] as HTMLElement | undefined)?.click()
  }, index)
}

async function seedTwoIndexFiles(win: Page): Promise<string> {
  const root = await seedProject(win, 'flow-ux-samename-', (dir) => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'src', 'index.ts'), "export const WHICH = 'SRC_INDEX_MARKER'\n")
    writeFileSync(join(dir, 'tests', 'index.ts'), "export const WHICH = 'TESTS_INDEX_MARKER'\n")
  })
  await activateProject(win, root)
  return root
}

test.describe('UX sweep flow 7 — editor tabs for two same-named files', () => {
  test.afterAll(() => cleanupSeeds())

  test('both files open as independent tabs and content follows selection', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))

    const root = await seedTwoIndexFiles(window)
    const lines = window.locator('.monaco-editor .view-lines')

    await openInEditor(window, root, 'src/index.ts')
    await expect(lines).toContainText('SRC_INDEX_MARKER', { timeout: 15000 })
    await openInEditor(window, root, 'tests/index.ts')
    await expect(lines).toContainText('TESTS_INDEX_MARKER', { timeout: 15000 })

    const tabs = await readTabs(window)
    expect(tabs).toHaveLength(2) // two distinct paths → two distinct tabs

    // Selecting either tab shows that file's own buffer — the tabs are wired to
    // the right models even though they look alike.
    await clickTab(window, 0)
    await expect(lines).toContainText('SRC_INDEX_MARKER', { timeout: 10000 })
    await clickTab(window, 1)
    await expect(lines).toContainText('TESTS_INDEX_MARKER', { timeout: 10000 })

    await window.screenshot({ path: `${SCREENS}/editor-tab-samename.png` })
    expect(appErrors(errors)).toEqual([])
  })

  // TRIPWIRE (#991) — un-fixme when same-basename tabs become distinguishable.
  test('a user can tell the two tabs apart (label or path tooltip)', async ({ window }) => {
    const root = await seedTwoIndexFiles(window)
    const lines = window.locator('.monaco-editor .view-lines')

    await openInEditor(window, root, 'src/index.ts')
    await expect(lines).toContainText('SRC_INDEX_MARKER', { timeout: 15000 })
    await openInEditor(window, root, 'tests/index.ts')
    await expect(lines).toContainText('TESTS_INDEX_MARKER', { timeout: 15000 })

    const tabs = await readTabs(window)
    expect(tabs).toHaveLength(2)
    const [first, second] = tabs
    const identity = (tab: TabView): string =>
      `${tab.label}|${tab.title ?? ''}|${tab.ariaLabel ?? ''}|${tab.closeLabel ?? ''}`
    // Either the labels differ (parent-segment disambiguation, like projectLabel())
    // or each tab carries its path as a tooltip. Today: identical on every channel.
    expect(identity(first)).not.toBe(identity(second))
  })
})
