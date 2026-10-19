import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 21: the composer's UNDO stack.
 *
 * Composer is the most-swept flow (20+ specs cover mentions, queue, drafts,
 * attachments, model/effort). What no spec touches is what happens to ⌘Z after
 * the composer writes the textarea for you. Every such write is a raw
 * `this.#textarea.value = …` assignment:
 *
 *   - `#acceptMention`  (composer.ts:1729) — accepting an @-file completion
 *   - `#acceptCommand`  (composer.ts:1518) — accepting a /-skill completion
 *   - `#insertNewline`  (composer.ts:1400) — Alt+Enter line break
 *   - `#recallHistory`  (composer.ts:949)  — ArrowUp message recall
 *
 * In Chromium a programmatic `.value =` assignment FLUSHES the field's native
 * undo stack. So after any of them, ⌘Z is a dead key — not just for the
 * insertion the user wants to take back (wrong file picked from the popup), but
 * for every character typed before it. Same defect class as the editor's
 * `model.setValue()` reload (#1096), on a different surface.
 *
 * Structure: the LIVE guards document the healthy half — the insertion itself
 * is correct, and the NATIVE line-break path (Shift+Enter) leaves undo fully
 * intact, which is the causation control proving the field's undo works and
 * only the programmatic writes break it. The `test.fixme` tripwires are the
 * target behavior and are red on current main — filed as #1214. Undo is
 * invoked through the renderer's own `execCommand('undo')`,
 * i.e. the same UndoStack the Edit ▸ Undo menu role drives (src/main/menu.ts),
 * so the result doesn't depend on CDP accelerator routing.
 *
 * No agent responses are needed or faked: @-completion only calls
 * `project:listDir` on a seeded project root.
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const SCREENS = 'e2e/ux/__screens'
/** Far more undos than the ~20 keystrokes each leg types — a stalled value is a
 *  flushed stack, not an impatient loop. */
const UNDO_PRESSES = 40

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

/** Seed a project with one mentionable file, create + select a thread. */
async function openComposer(win: Page, title: string): Promise<string> {
  const root = await seedProject(win)
  writeFileSync(join(root, 'README.md'), '# root\n')
  await activateProject(win, root)
  await createThread(win, root, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return root
}

/** Hold ⌘Z down, in effect: the textarea is focused first, since undo applies
 *  to the focused editable. */
async function undoRepeatedly(win: Page): Promise<void> {
  await win.locator('.fl-composer-input textarea').click()
  for (let i = 0; i < UNDO_PRESSES; i++) {
    await win.evaluate(() => document.execCommand('undo'))
  }
}

test.afterAll(() => cleanupSeeds())

// ── live guards ─────────────────────────────────────────────────────────────

test('LIVE: the NATIVE line break (Shift+Enter) leaves the composer fully undoable', async ({
  window,
}) => {
  // Causation control for the tripwires below: identical user intent (a
  // two-line draft), but the line break goes through the browser instead of
  // `#insertNewline` — and the whole draft walks back to empty.
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await openComposer(window, 'undo-native')
  const textarea = window.locator('.fl-composer-input textarea')
  await textarea.click()
  await textarea.type('one')
  await window.keyboard.press('Shift+Enter')
  await textarea.type('two')
  await expect(textarea).toHaveValue('one\ntwo')

  await undoRepeatedly(window)
  expect(await textarea.inputValue(), 'native typing is undoable back to empty').toBe('')
  expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([])
})

test('LIVE: accepting an @-file completion inserts the right text', async ({ window }) => {
  // The insertion path itself is healthy — the tripwire is about what it costs.
  await openComposer(window, 'undo-insert-ok')
  const textarea = window.locator('.fl-composer-input textarea')
  const popup = window.locator(MENTION_POPUP)

  await textarea.click()
  await textarea.type('please read @READ')
  await expect(popup).toBeVisible()
  await popup.locator('.fl-composer-mention-row', { hasText: /^README\.md$/ }).click()
  await expect(textarea).toHaveValue('please read @README.md ')
  await expect(popup).toBeHidden()
})

// ── tripwires (target behavior; red on current main) ─────────────────────────

test(
  'undo must survive an @-mention: ⌘Z after picking the wrong file must reach the text typed before it',
  async ({ window }) => {
    await openComposer(window, 'undo-mention')
    const textarea = window.locator('.fl-composer-input textarea')
    const popup = window.locator(MENTION_POPUP)

    await textarea.click()
    await textarea.type('please read @READ')
    await expect(popup).toBeVisible()
    await popup.locator('.fl-composer-mention-row', { hasText: /^README\.md$/ }).click()
    await expect(textarea).toHaveValue('please read @README.md ')
    // Typing continues after the insertion, so a stall proves the stack was
    // FLUSHED (these keystrokes are undoable, everything older is gone).
    await textarea.type('now')
    await expect(textarea).toHaveValue('please read @README.md now')

    await undoRepeatedly(window)
    await window.screenshot({ path: `${SCREENS}/composer-undo-after-mention.png` })

    // Today: stalls forever at 'please read @README.md ' — the user cannot take
    // back the wrong file, and 'please read @READ' is unreachable too.
    expect(
      await textarea.inputValue(),
      'undo must get back past the inserted mention',
    ).not.toContain('@README.md')
  },
)

test(
  'undo must survive Alt+Enter: the programmatic line break must not erase the draft history before it',
  async ({ window }) => {
    await openComposer(window, 'undo-alt-newline')
    const textarea = window.locator('.fl-composer-input textarea')
    await textarea.click()
    await textarea.type('one')
    await window.keyboard.press('Alt+Enter')
    await textarea.type('two')
    await expect(textarea).toHaveValue('one\ntwo')

    await undoRepeatedly(window)
    // Today: stalls at 'one\n' — the Shift+Enter control above reaches ''.
    expect(await textarea.inputValue(), 'undo must walk back past the line break').toBe('')
  },
)
