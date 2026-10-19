import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Monaco raises an internal `CancellationError` (message: "Canceled") when a text
 * model is disposed while its `WordHighlighter` still has a pending delayer —
 * i.e. on ordinary tab close. It escapes to `pageerror`, but it is Monaco-internal
 * noise: the close/reopen/empty flows all complete correctly, nothing surfaces to
 * the user, and no state is corrupted (verified by driving the app — reopen after
 * close re-renders, rapid close empties cleanly). The editor guard must catch REAL
 * app errors, so it filters this one benign message rather than red-flag on it.
 * Stack: Delayer.cancel → Delayer.dispose → WordHighlighter2.dispose (model dispose).
 */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/**
 * UX sweep — flow 7: Editor (open file, tabs, Monaco, dirty/save, close).
 *
 * Drives the real editor surface against a seeded project whose files exist on
 * disk, opened the way a user opens them: clicking a row in the Files tree.
 * Asserts the deterministic, credential-less editor UX — a file opens into a
 * tab and Monaco renders its content; a second file adds a second tab and both
 * switch; editing marks the tab dirty and cmd+S clears it and writes to disk;
 * closing a tab activates a neighbor; closing the last tab returns to the clean
 * empty editor. LSP/diff/conflict paths need a live agent and are out of scope
 * for a credential-less probe.
 */

const SCREENS = 'e2e/ux/__screens'

/** Click a file-tree row by its filename, scoped to the visible Files side-panel
 *  pane. Post-#674 the default rail is Threads, so switch to Files unless it's
 *  already active (clicking the active rail item collapses the sidebar); and
 *  self-heal against the per-project flow-settings overlay that can auto-open just
 *  after activation and cover the tree on slow cold Electron launches. */
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

/** The editor tab strip button whose visible label matches `name`. */
function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs:not(.fl-term-tabs) .tab', { hasText: name })
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

test.afterAll(() => cleanupSeeds())

test('open: clicking a tree file opens a tab and Monaco renders its content', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbeta-marker line\n')
  await activateProject(window, dir)

  // The Files tree lists the seeded files; open one the user way — a click.
  await openFromTree(window, 'alpha.ts')

  // A tab appears for it and Monaco mounts with the file's real content.
  await expect(tab(window, 'alpha.ts')).toBeVisible()
  await expect(tab(window, 'alpha.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'alpha-marker')

  await window.screenshot({ path: `${SCREENS}/editor-open-file.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('tabs: a second file adds a second tab and clicking tabs switches content', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbeta-marker line\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')
  await openFromTree(window, 'beta.md')
  await expectEditorShows(window, 'beta-marker')

  // Both tabs present; the newly opened one is active.
  await expect(tab(window, 'alpha.ts')).toBeVisible()
  await expect(tab(window, 'beta.md')).toBeVisible()
  await expect(tab(window, 'beta.md')).toHaveClass(/active/)

  // Clicking back to the first tab restores its content and active state.
  await tab(window, 'alpha.ts').click()
  await expect(tab(window, 'alpha.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'alpha-marker')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('dirty + save: editing marks the tab dirty and cmd+S clears it and writes disk', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')

  // Type into Monaco like a user: focus the editor, go to end, add a line.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nexport const ADDED = "typed-by-probe"')

  // The tab must show a dirty indicator (the strip renders a .dirty-dot).
  const dirtyDot = tab(window, 'alpha.ts').locator('.dirty-dot')
  await expect(dirtyDot).toBeVisible()

  // cmd+S saves through project:writeFile; the dirty dot clears on success.
  await window.keyboard.press('ControlOrMeta+s')
  await expect(dirtyDot).toHaveCount(0, { timeout: 8000 })

  // The change reached disk — read it back through the real IPC bridge.
  const onDisk = await window.evaluate(async (p) => {
    const rel = 'alpha.ts'
    const res = (await (
      window as unknown as {
        flow: {
          project: {
            readFile(i: { rootPath: string; relPath: string }): Promise<{ content: string }>
          }
        }
      }
    ).flow.project.readFile({ rootPath: p, relPath: rel })) as { content: string }
    return res.content
  }, dir)
  expect(onDisk).toContain('typed-by-probe')

  await window.screenshot({ path: `${SCREENS}/editor-dirty-saved.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('close: closing a tab activates a neighbor; closing the last returns to empty', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbeta-marker line\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')
  await openFromTree(window, 'beta.md')
  await expectEditorShows(window, 'beta-marker')

  // Close the active (beta) tab → alpha becomes the active neighbor + shows.
  await tab(window, 'beta.md').locator('.close').click()
  await expect(tab(window, 'beta.md')).toHaveCount(0)
  await expect(tab(window, 'alpha.ts')).toHaveClass(/active/)
  await expectEditorShows(window, 'alpha-marker')

  // Close the last remaining tab → the strip empties (hidden) and no tab shows.
  await tab(window, 'alpha.ts').locator('.close').click()
  await expect(window.locator('.fl-shell fl-tabs:not(.fl-term-tabs) .tab')).toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/editor-empty.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('reopen: a file closed then reopened re-renders its content (model disposed cleanly)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
  writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbeta-marker line\n')
  await activateProject(window, dir)

  await openFromTree(window, 'alpha.ts')
  await expectEditorShows(window, 'alpha-marker')
  await openFromTree(window, 'beta.md')
  await expectEditorShows(window, 'beta-marker')

  // Close beta (its model is disposed), then reopen it from the tree. Closing a
  // tab disposes the Monaco model; a fresh open must rebuild it — a disposed
  // model leaking into the map would blank the editor or throw on reopen.
  await tab(window, 'beta.md').locator('.close').click()
  await expect(tab(window, 'beta.md')).toHaveCount(0)
  await expectEditorShows(window, 'alpha-marker')

  await openFromTree(window, 'beta.md')
  await expect(tab(window, 'beta.md')).toHaveClass(/active/)
  await expectEditorShows(window, 'beta-marker')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('binary: opening a binary file shows a read-only placeholder, not garbage', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  // PNG magic bytes + null bytes — the file-read classifies this as binary.
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1,
    0, 0, 0, 1, 0,
  ])
  writeFileSync(join(dir, 'image.png'), png)
  await activateProject(window, dir)

  await openFromTree(window, 'image.png')
  await expect(tab(window, 'image.png')).toBeVisible()
  // A clear placeholder — never the raw binary bytes.
  await expectEditorShows(window, 'binary file')

  // The placeholder is read-only: typing changes nothing and never dirties the tab.
  await window.locator('.monaco-editor').click()
  await window.keyboard.type('SHOULD_NOT_APPEAR')
  await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('SHOULD_NOT_APPEAR')
  await expect(tab(window, 'image.png').locator('.dirty-dot')).toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/editor-binary.png` })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
