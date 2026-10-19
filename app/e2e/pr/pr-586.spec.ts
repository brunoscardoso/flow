/**
 * Regression for PR #586 — "Markdown preview toggle for .md files" (#575).
 *
 * A `.md`/`.markdown` file gains a floating Preview/Edit pill (⌘⇧V) that swaps
 * the Monaco source buffer for a scrollable rendered pane. The pill and pane
 * follow the ACTIVE tab: shown for a markdown file, hidden for a non-markdown
 * file (and non-file views). The preview renders from the live buffer via the
 * shared sanitized `renderMarkdown`, so its output is REAL heading/list DOM —
 * an `<h1>` that Monaco's tokenized source view never produces.
 *
 * This spec drives the real editor against a seeded throwaway project and
 * asserts the observable behavior a user sees:
 *   - opening a `.md` file surfaces a pill reading "Preview" (source mode);
 *   - clicking it flips the label to "Source" and reveals a rendered `<h1>`
 *     (proof the markdown was actually rendered, not just shown as source);
 *   - clicking again returns to "Preview" and hides the rendered pane;
 *   - opening a non-markdown file (`.txt`) hides the pill entirely.
 *
 * Observable-behavior only (pill label + rendered DOM presence); never asserts
 * internals. Complements the unit tests in markdown-preview.test.ts (which cover
 * the pure isMarkdownPath/previewToggleLabel helpers).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The editor panel scopes every markdown-preview selector below. */
const EDITOR = '#fl-panel-editor'
/** The floating Preview/Source pill — the only labelled fl-button in the editor body. */
const previewPill = (win: Page, label: 'Preview' | 'Source') =>
  win.locator(`${EDITOR} fl-button`).filter({ hasText: label })

/** Dispatch the app's real open-file event (no native picker needed). */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }),
      )
    },
    { rootPath, relPath },
  )
}

test.afterAll(() => cleanupSeeds())

test.describe('PR #586 — Markdown preview toggle (#575)', () => {
  test('a .md file toggles between source and a rendered preview; a non-md file hides the pill', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-md-preview-')
    // A markdown file with a heading — rendered, it becomes a real <h1> the
    // Monaco source view never produces, so it's an unambiguous "rendered" probe.
    writeFileSync(join(dir, 'README.md'), '# Hello QA\n\nSome **markdown** body.\n')
    // A plain-text file to prove the pill is markdown-only.
    writeFileSync(join(dir, 'notes.txt'), 'just text\n')

    await activateProject(window, dir)

    // Open the markdown file → the pill appears reading "Preview" (source mode).
    await openFile(window, dir, 'README.md')
    await expect(previewPill(window, 'Preview')).toBeVisible({ timeout: 6000 })

    // No rendered heading yet — we're still showing the Monaco source buffer.
    await expect(window.locator(`${EDITOR} h1`)).toHaveCount(0)

    // Toggle preview ON → label flips to "Source" and the rendered <h1> appears.
    await previewPill(window, 'Preview').click()
    await expect(previewPill(window, 'Source')).toBeVisible()
    await expect(window.locator(`${EDITOR} h1`, { hasText: 'Hello QA' })).toBeVisible({
      timeout: 6000,
    })

    // Toggle preview OFF → label returns to "Preview" and the rendered pane hides.
    await previewPill(window, 'Source').click()
    await expect(previewPill(window, 'Preview')).toBeVisible()
    await expect(window.locator(`${EDITOR} h1`)).toBeHidden()

    // Open a non-markdown file → the pill is hidden for it (markdown-only chrome).
    await openFile(window, dir, 'notes.txt')
    await expect(previewPill(window, 'Preview')).toBeHidden({ timeout: 6000 })
    await expect(previewPill(window, 'Source')).toBeHidden()

    expect(errors).toEqual([])
  })
})
