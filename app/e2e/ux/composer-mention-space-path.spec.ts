import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 24: the @-file popup vs. a path that
 * contains a SPACE.
 *
 * The composer's mention session is delimited by whitespace:
 *
 *     const MENTION_RE = /(^|\s)@([\w./-]*)$/      (composer.ts:120)
 *
 * but the popup's own listing is not — `mergeMentionMatches` happily offers
 * `design docs/` for the needle `design`, and `#acceptMention` writes the raw
 * name into the textarea (`@${relPath}${isDir ? '/' : ' '}`, composer.ts:1796)
 * with no quoting or escaping. The moment that insertion lands, MENTION_RE can
 * no longer see the reference the composer just wrote: everything before the
 * space is a finished mention, and everything after it is ordinary prose.
 *
 * For a FILE that costs the reference its meaning (`@design notes.md` is an
 * `@design` mention followed by the word `notes.md`). For a DIRECTORY it also
 * dead-ends the interaction, which is what the tripwire below drives, because
 * that half is observable inside the app with no agent involved:
 *
 *   @src   → accept → `@src/`          → popup lists index.ts   (control)
 *   @design → accept → `@design docs/` → popup CLOSES, and typing the rest of
 *                                        the filename never reopens it
 *
 * So the popup offers an item that, once picked, silently ends the completion
 * session and leaves a reference the app itself cannot re-parse — while an
 * ordinary folder next to it keeps completing normally. Sibling asymmetry in
 * the same widget, of the kind #1123/#1124 were filed on.
 *
 * Test 1 (live guards) pins the behaviour that DOES work, so the tripwire cannot
 * pass vacuously: an ordinary directory descends and lists its contents, and the
 * space-named directory is genuinely offered by the popup.
 * Test 2 (test.fixme tripwire) is the open bug — confirmed RED against main.
 *
 * Credential-free: nothing is sent; this is the composer's own autocomplete.
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const SCREENS = 'e2e/ux/__screens'

function populate(dir: string): void {
  mkdirSync(join(dir, 'design docs'), { recursive: true })
  writeFileSync(join(dir, 'design docs', 'tokens.md'), '# tokens\n')
  writeFileSync(join(dir, 'design docs', 'spacing.md'), '# spacing\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), '// x\n')
  writeFileSync(join(dir, 'README.md'), '# readme\n')
}

async function openThread(win: Page, title: string): Promise<void> {
  const dir = await seedProject(win, 'flow-ux-spacepath-', populate)
  await activateProject(win, dir)
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root: dir, title },
  )
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('the @-popup descends an ordinary directory and offers a space-named one', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await openThread(window, 'Mention control')
  const textarea = window.locator(`${sel.composer} textarea`)
  const popup = window.locator(MENTION_POPUP)

  // Control: an ordinary directory. Accepting it inserts `@src/` and the popup
  // stays open on the folder's contents — the composer's descend contract.
  await textarea.click()
  await textarea.fill('open @src')
  await expect(popup).toBeVisible({ timeout: 8000 })
  await window.keyboard.press('Enter')
  await expect(textarea).toHaveValue('open @src/')
  await expect(popup).toBeVisible()
  await expect(popup).toContainText('index.ts')

  // ...and the space-named directory really is offered by the same popup, so
  // the tripwire below is about what ACCEPTING it does, not about discovery.
  await textarea.fill('open @design')
  await expect(popup).toBeVisible({ timeout: 8000 })
  await expect(popup).toContainText('design docs/')
  await window.screenshot({ path: `${SCREENS}/composer-space-path-offered.png` })

  expect(errors, errors.join(', ')).toEqual([])
})

test.fixme(
  'accepting a space-named directory must keep the completion alive',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    await openThread(window, 'Mention space path')
    const textarea = window.locator(`${sel.composer} textarea`)
    const popup = window.locator(MENTION_POPUP)

    await textarea.click()
    await textarea.fill('open @design')
    await expect(popup).toBeVisible({ timeout: 8000 })
    await expect(popup).toContainText('design docs/')
    await window.keyboard.press('Enter')
    await window.waitForTimeout(800)

    const inserted = await textarea.inputValue()
    await window.screenshot({ path: `${SCREENS}/composer-space-path-deadend.png` })

    // Either the insertion is escaped/quoted so the session survives, or the
    // popup stays open on the folder's contents. Today: neither — the value is
    // `open @design docs/` and the popup is gone.
    const stillCompleting = await popup.isVisible()
    if (!stillCompleting) {
      // Last chance: typing the rest of the filename should bring it back.
      await textarea.click()
      await textarea.type('tok')
      await window.waitForTimeout(600)
    }
    expect(
      stillCompleting || (await popup.isVisible()),
      `the @-popup dead-ended on a space-named path (value="${inserted}")`,
    ).toBe(true)

    expect(errors, errors.join(', ')).toEqual([])
  },
)
