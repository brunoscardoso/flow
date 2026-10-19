import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): @-file mention KEYBOARD NAV + MID-TEXT insertion.
 *
 * The @-file autocomplete has live coverage for the happy path (composer.spec.ts:
 * open → insert the DEFAULT first item, descend a directory, Escape/backspace
 * dismiss). Two real user interactions have ZERO end-to-end coverage:
 *
 *  1. ArrowDown to pick a NON-first item, then accept it. Every existing @ test
 *     accepts `#mentionItems[0]`; the arrow-key path (#onKeydown ArrowDown/Up →
 *     #mentionSelected wrap → #renderMentionPopup → Enter accepts the SELECTED
 *     item) is never driven. A regression that inserts item[0] regardless of
 *     selection would pass every current test.
 *  2. Mid-text insertion — @ typed with the caret in the MIDDLE of existing text.
 *     #acceptMention splices `value.slice(0,start) + insertion + value.slice(end)`;
 *     the trailing text after the caret must survive. Existing tests only ever
 *     mention at the end of the input, so the slice-preservation is unguarded.
 *
 * Driven against a seeded project with real files (no Claude account needed —
 * the @ autocomplete only calls project:listDir on a project root).
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'

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

/** Populate the seeded repo with several files whose names share a prefix so the
 *  @-autocomplete yields a multi-row, deterministically-ordered list. */
function populateFiles(dir: string): void {
  // alpha.md, beta.md, gamma.md — none is a directory, so ordering is pure
  // prefix-then-alpha. With an empty query they list alphabetically.
  writeFileSync(join(dir, 'alpha.md'), '# alpha\n')
  writeFileSync(join(dir, 'beta.md'), '# beta\n')
  writeFileSync(join(dir, 'gamma.md'), '# gamma\n')
}

async function openComposer(win: Page, title: string): Promise<string> {
  const dir = await seedProject(win)
  populateFiles(dir)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return dir
}

test.afterAll(() => cleanupSeeds())

test('@-file: ArrowDown selects the SECOND row and Enter inserts THAT file (not item[0])', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window, 'Mention arrow-nav probe')
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('@')

  const popup = window.locator(MENTION_POPUP)
  await expect(popup).toBeVisible()
  const rows = popup.locator('.fl-composer-mention-row')
  // alpha, beta, gamma — AFTER the directories, which list first: the
  // provisioner scaffolds `.claude/`, `flow/` and `loops/` into every project,
  // so row[1] is a FOLDER, and accepting a folder descends into it (the popup
  // stays open on its children) rather than inserting anything. Navigate to the
  // SECOND FILE row instead: still a non-first row, reached only by ArrowDown.
  await expect(rows.first()).toBeVisible()
  await expect(popup).toContainText('gamma.md')
  const texts = (await rows.allInnerTexts()).map((text) => text.trim())
  const fileRows = texts.flatMap((text, index) => (text.endsWith('/') ? [] : [index]))
  expect(fileRows.length, `at least two file rows in ${JSON.stringify(texts)}`).toBeGreaterThanOrEqual(2)
  const firstText = texts[fileRows[0]!]!
  const target = fileRows[1]!
  const secondText = texts[target]!
  expect(target, 'the target is not item[0]').toBeGreaterThan(0)

  for (let step = 0; step < target; step += 1) await textarea.press('ArrowDown')
  await expect(rows.nth(target)).toHaveClass(/selected/)
  await textarea.press('Enter')

  const value = await textarea.inputValue()
  // The inserted token is the SELECTED row's path — not item[0], not the first file.
  expect(value).toContain(`@${secondText}`)
  expect(value).not.toContain(`@${firstText}`)
  expect(value).not.toContain(`@${texts[0]}`)
  await expect(popup).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('@-file: mention inserted mid-text preserves the trailing text after the caret', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window, 'Mention mid-text probe')
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()

  // Type a full sentence, then move the caret back into the middle and open an @
  // mention there. The text AFTER the caret ("please") must survive the splice.
  await textarea.type('review  please')
  // Caret currently at end. Move left 6 (over "please") then 1 more so we sit
  // right after the double space: "review @|please".
  for (let i = 0; i < 6; i += 1) await textarea.press('ArrowLeft')
  await textarea.type('@al')

  const popup = window.locator(MENTION_POPUP)
  await expect(popup).toBeVisible()
  await expect(popup.locator('.fl-composer-mention-row', { hasText: 'alpha.md' })).toBeVisible()
  await textarea.press('Enter')

  const value = await textarea.inputValue()
  // The mention landed in the middle and BOTH sides are intact.
  expect(value).toContain('@alpha.md')
  expect(value.startsWith('review ')).toBeTruthy()
  expect(value.endsWith('please')).toBeTruthy()
  await expect(popup).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
