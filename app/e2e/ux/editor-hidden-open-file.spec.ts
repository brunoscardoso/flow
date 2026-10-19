import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor), round 17: opening a file while the editor area is
 * HIDDEN (⌘⌥D).
 *
 * Every file-open source in the app funnels through `openFile()`
 * (`editor/index.ts`) — the Files tree, ⌘P quick-open, `flow:open-file` from the
 * Source Control panel / conflict review cards, `flow:open-file-path` from chat
 * markdown links. `openFile` adds the tab and announces `flow:editor-file-opened`,
 * but it never dispatches `flow:show-editor` — the shell event whose own comment
 * reads "surfaces that open an editor-area tab (Blueprint, Board, **a file**)
 * dispatch this so they still appear when the user has hidden the editor (⌘⌥D);
 * otherwise the tab opens into a hidden host" (`shell.ts`).
 *
 * #1057 (fixed): `openFile()` (and `openView()`) now dispatch `flow:show-editor`
 * at the funnel, so every file-open source reveals a ⌘⌥D-hidden editor area.
 * The other tests guard the surrounding contract: the reveal mechanism works for
 * the Blueprint, the visible-editor baseline renders, and the hidden state is
 * persisted across restarts.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Click a file-tree row by filename (same self-healing recipe as editor.spec.ts). */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

/**
 * What the user can actually SEE of the editor area. ⌘⌥D removes the whole
 * editor stack from the DOM, so `.monaco-editor` and the tab strip disappear
 * entirely — a far stronger observable than a CSS class.
 */
async function editorAreaState(win: Page): Promise<{
  monacoOnScreen: boolean
  tabStripOnScreen: boolean
  renderedText: string | null
}> {
  return win.evaluate(() => {
    const box = (el: Element | null): boolean => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 10 && r.height > 10
    }
    const monaco = document.querySelector('.monaco-editor')
    const strip = document.querySelector('.fl-shell fl-tabs')
    const lines = document.querySelector('.monaco-editor .view-lines') as HTMLElement | null
    return {
      monacoOnScreen: box(monaco),
      tabStripOnScreen: box(strip),
      renderedText: lines?.innerText?.trim() ?? null,
    }
  })
}

/** Seed a project with two files and open the first one into a visible editor. */
async function seedWithOpenFile(win: Page): Promise<string> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.ts'), 'export const BETA = "beta-marker"\n')
  await activateProject(win, dir)
  await openFromTree(win, 'alpha.ts')
  await expect(win.locator('.monaco-editor .view-lines')).toContainText('alpha-marker', {
    timeout: 15000,
  })
  return dir
}

/** Hide the editor area with the real shortcut and confirm it is gone. */
async function hideEditorArea(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+Alt+d')
  await expect
    .poll(async () => (await editorAreaState(win)).monacoOnScreen, { timeout: 8000 })
    .toBe(false)
}

test.afterAll(() => cleanupSeeds())

test('baseline: with the editor visible, clicking a tree file renders it', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedWithOpenFile(window)
  await openFromTree(window, 'beta.ts')

  await expect(window.locator('.monaco-editor .view-lines')).toContainText('beta-marker', {
    timeout: 15000,
  })
  const state = await editorAreaState(window)
  expect(state.monacoOnScreen).toBe(true)
  expect(state.tabStripOnScreen).toBe(true)
  expect(appErrors(errors)).toEqual([])
})

test('the reveal mechanism works — the Blueprint brings a hidden editor area back (control for #1057)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedWithOpenFile(window)
  await hideEditorArea(window)

  const hidden = await editorAreaState(window)
  expect(hidden.monacoOnScreen).toBe(false)
  expect(hidden.tabStripOnScreen).toBe(false)

  // The Blueprint DOES dispatch flow:show-editor before opening its tab, so the
  // editor host comes back. This is the exact call the file path is missing.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await expect
    .poll(async () => (await editorAreaState(window)).monacoOnScreen, { timeout: 10000 })
    .toBe(true)

  expect(appErrors(errors)).toEqual([])
})

test('⌘⌥D persists the hidden editor into the layout store (the dead state survives a restart)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedWithOpenFile(window)
  await hideEditorArea(window)

  // Persisted as panelLayout.editorVisible — per SCOPE now (a project root plus
  // the thread on screen, thread-layout-store.ts), under
  // `flow.shell.layout.scoped.v1`; the per-root v5 record is read-only, the
  // migration fallback. The write is debounced, so poll rather than read once.
  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const raw = window.localStorage.getItem('flow.shell.layout.scoped.v1')
          if (!raw) return 'no-store'
          try {
            const store = JSON.parse(raw) as {
              entries?: Record<string, { value?: { panelLayout?: { editorVisible?: boolean } } }>
            }
            const flags = Object.values(store.entries ?? {}).map(
              (entry) => entry.value?.panelLayout?.editorVisible,
            )
            return flags.includes(false) ? false : flags.length ? 'all-true' : 'no-roots'
          } catch {
            return 'unparseable'
          }
        }),
      { timeout: 10000 },
    )
    .toBe(false)
  expect(appErrors(errors)).toEqual([])
})

test(
  'clicking a tree file while the editor is hidden reveals the editor and renders the file (#1057)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await seedWithOpenFile(window)
    await hideEditorArea(window)

    // The ordinary "open a file" gesture: click a row in the Files tree.
    await openFromTree(window, 'beta.ts')
    await window.waitForTimeout(1500)
    await window.screenshot({ path: `${SCREENS}/editor-hidden-file-click.png` })

    const after = await editorAreaState(window)
    // Today: nothing appears — no editor, no tab strip, no toast, no console error.
    // The tab IS created into the detached host (proved by the Blueprint control).
    expect(after.monacoOnScreen).toBe(true)
    expect(after.renderedText).toContain('beta-marker')
    expect(appErrors(errors)).toEqual([])
  },
)

test(
  '⌘P quick-open while the editor is hidden reveals the editor and renders the file (#1057)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
    writeFileSync(join(dir, 'gamma.ts'), 'export const GAMMA = "gamma-marker"\n')
    await activateProject(window, dir)
    await openFromTree(window, 'alpha.ts')
    await expect(window.locator('.monaco-editor .view-lines')).toContainText('alpha-marker', {
      timeout: 15000,
    })
    await hideEditorArea(window)

    await window.keyboard.press('ControlOrMeta+p')
    const panel = window.locator('.fl-palette-panel')
    await expect(panel).toBeVisible({ timeout: 5000 })
    // Fill the input explicitly (keyboard.type can land outside the palette
    // while the editor host is detached) and click the gamma.ts row rather than
    // blind-Enter — the blended content search can rank a content match (e.g. a
    // graphify manifest mentioning "gamma.ts") above the file itself. The row
    // click exercises the same flow:open-file → openFile funnel #1057 is about.
    await panel.locator('.fl-palette-input').fill('gamma')
    const gammaRow = window.locator('.fl-palette-row', { hasText: 'gamma.ts' }).first()
    await gammaRow.waitFor({ state: 'visible', timeout: 8000 })
    await gammaRow.click()
    await window.waitForTimeout(1500)

    const after = await editorAreaState(window)
    expect(after.monacoOnScreen).toBe(true)
    expect(after.renderedText).toContain('gamma-marker')
    expect(appErrors(errors)).toEqual([])
  },
)
