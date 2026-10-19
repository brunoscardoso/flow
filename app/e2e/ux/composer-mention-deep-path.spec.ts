import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): @-file mention DEEP-PATH insertion across a
 * MULTI-LEVEL directory descend, plus the backspace-back-up transition.
 *
 * `composer.spec.ts` covers a SINGLE descend and stops at `@src/` (it never
 * accepts a nested file). The user-facing promise of @-mentions is that the
 * agent receives the FULL project-relative path — `@src/renderer/foo.ts`, not a
 * truncated leaf. That path is computed by `rootRelative(projectRoot, entry.path)`
 * against a per-directory `#dirCache` keyed by relPath, re-run at each descend
 * (`#acceptMention` → `await this.#updateMention()`). If the cache keying or the
 * relative-path math were wrong at depth ≥ 2, the composer would insert a wrong
 * @-path and the agent would read the wrong file — a silent correctness bug no
 * existing test would catch.
 *
 * Also drives the reverse: after descending into `@src/renderer/`, BACKSPACE the
 * query back up to `@src` and confirm the popup re-lists the PARENT directory
 * (slash removed → dirPath='' → root listing), not a stale child listing.
 *
 * Driven against a seeded project with a real nested tree (no Claude account —
 * the @ autocomplete only calls project:listDir on a project root).
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

/** Build a real nested tree so the @-file autocomplete has depth to descend. */
function populate(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# root\n')
  mkdirSync(join(dir, 'src', 'renderer'), { recursive: true })
  mkdirSync(join(dir, 'src', 'main'), { recursive: true })
  writeFileSync(join(dir, 'src', 'renderer', 'composer.ts'), '// deep file\n')
  writeFileSync(join(dir, 'src', 'main', 'index.ts'), '// main\n')
}

async function openComposer(win: Page, title: string): Promise<string> {
  const root = await seedProject(win)
  populate(root)
  await activateProject(win, root)
  await createThread(win, root, title)
  // Select the thread so the composer mounts + binds.
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return root
}

test.afterAll(() => cleanupSeeds())

test('@-file: two-level descend then accept a nested file inserts the FULL relative path', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await openComposer(window, 'deep-path')
  const textarea = window.locator('.fl-composer-input textarea')
  const popup = window.locator(MENTION_POPUP)

  // ── Descend level 1: @src → pick src/ ──────────────────────────────────
  await textarea.click()
  await textarea.type('@src')
  await expect(popup).toBeVisible()
  await popup.locator('.fl-composer-mention-row', { hasText: /^src\/$/ }).click()
  await expect(textarea).toHaveValue('@src/')
  // Popup re-opens listing src's contents (main/, renderer/).
  await expect(popup).toBeVisible()
  await expect(popup.locator('.fl-composer-mention-row', { hasText: /^renderer\/$/ })).toBeVisible()

  // ── Descend level 2: type renderer → pick renderer/ ────────────────────
  await textarea.type('renderer')
  await expect(popup.locator('.fl-composer-mention-row', { hasText: /^renderer\/$/ })).toBeVisible()
  await popup.locator('.fl-composer-mention-row', { hasText: /^renderer\/$/ }).click()
  await expect(textarea).toHaveValue('@src/renderer/')
  await expect(popup).toBeVisible()

  // ── Accept the nested FILE: type composer → pick composer.ts ───────────
  await textarea.type('composer')
  const fileRow = popup.locator('.fl-composer-mention-row', { hasText: /^composer\.ts$/ })
  await expect(fileRow).toBeVisible()
  await fileRow.click()

  // The inserted mention MUST be the full project-relative path + trailing space,
  // and the popup must close (file, not directory).
  await expect(textarea).toHaveValue('@src/renderer/composer.ts ')
  await expect(popup).toBeHidden()

  await window.screenshot({ path: `${SCREENS}/composer-deep-path-inserted.png` })
  expect(errors, `pageerrors during deep-path mention: ${errors.join('\n')}`).toEqual([])
})

test('@-file: backspacing the slash after a descend re-lists the PARENT, not a stale child', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await openComposer(window, 'backspace-up')
  const textarea = window.locator('.fl-composer-input textarea')
  const popup = window.locator(MENTION_POPUP)

  // Descend into @src/renderer/ so the popup is listing renderer's children.
  await textarea.click()
  await textarea.type('@src')
  await expect(popup).toBeVisible()
  await popup.locator('.fl-composer-mention-row', { hasText: /^src\/$/ }).click()
  await textarea.type('renderer')
  await popup.locator('.fl-composer-mention-row', { hasText: /^renderer\/$/ }).click()
  await expect(textarea).toHaveValue('@src/renderer/')
  await expect(popup.locator('.fl-composer-mention-row', { hasText: /^composer\.ts$/ })).toBeVisible()

  // Backspace `@src/renderer/` (14 chars) down to `@src` (delete 10) → query
  // becomes `src` with no slash, which should re-list the ROOT filtered by "src"
  // (the `src/` directory itself), NOT renderer's stale children.
  for (let i = 0; i < '/renderer/'.length; i++) await window.keyboard.press('Backspace')
  await expect(textarea).toHaveValue('@src')
  await expect(popup).toBeVisible()
  // The parent-level listing shows the src/ directory again; it must NOT still
  // be showing renderer's child file.
  await expect(popup.locator('.fl-composer-mention-row', { hasText: /^src\/$/ })).toBeVisible()
  await expect(popup.locator('.fl-composer-mention-row', { hasText: /^composer\.ts$/ })).toHaveCount(0)

  expect(errors, `pageerrors during backspace-up: ${errors.join('\n')}`).toEqual([])
})
