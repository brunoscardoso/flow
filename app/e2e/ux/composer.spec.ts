import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3: Composer (input, @-file & /-skill mentions, send affordance,
 * gating without account). Drives the real composer against a seeded project
 * (no Claude account — `threads:create` + `project:listDir`/`listCommands`
 * need only a project root) and asserts the expected user experience.
 *
 * The composer only mounts visibly once a thread is active, so each test seeds
 * a project, creates a thread through the same `threads:create` IPC the "+"
 * button calls, and selects it to reveal the composer.
 */

const SCREENS = 'e2e/ux/__screens'

/** File-mention popup only (the command popup shares `.fl-composer-mentions`). */
const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const COMMAND_POPUP = '.fl-composer-commands'

/** Create a thread in `root` with an explicit title via the real IPC bridge. */
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

/** Populate the seeded repo with browsable files + slash-command skills so the
 *  @-file and /-skill autocompletes have real content to surface. */
function populateRepo(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# Seeded repo\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  writeFileSync(
    join(commandsDir, 'brainstorm.md'),
    '---\ndescription: Explore an idea\n---\nBrainstorm body\n',
  )
  writeFileSync(
    join(commandsDir, 'discovery-plan.md'),
    '---\ndescription: Gather requirements\n---\nDiscovery body\n',
  )
}

/** Seed a project, populate it, activate it, create + open a thread → composer up. */
async function openComposer(win: Page, title = 'Composer probe'): Promise<string> {
  const dir = await seedProject(win)
  populateRepo(dir)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return dir
}

test.afterAll(() => cleanupSeeds())

test('input: the composer accepts typing and shows an enabled Send button', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)

  const textarea = window.locator(`${sel.composer} textarea`)
  await expect(textarea).toBeEnabled()
  await textarea.click()
  await textarea.type('hello from the composer')
  await expect(textarea).toHaveValue('hello from the composer')

  // Send affordance is present and labelled while idle (Interrupt is hidden).
  const send = window.locator(`${sel.composer} fl-button[variant="primary"]`)
  await expect(send).toBeVisible()
  await expect(send).toContainText('Send')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('@-file: typing @ opens the file autocomplete and inserts the picked path', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('@READ')

  const popup = window.locator(MENTION_POPUP)
  await expect(popup).toBeVisible()
  const readme = popup.locator('.fl-composer-mention-row', { hasText: 'README.md' })
  await expect(readme).toBeVisible()
  await readme.click()

  // Picking a file inserts `@<relpath> ` and closes the popup.
  await expect(textarea).toHaveValue('@README.md ')
  await expect(popup).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('@-file: picking a directory descends one level and keeps completing', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('@src')

  const popup = window.locator(MENTION_POPUP)
  await expect(popup).toBeVisible()
  const srcDir = popup.locator('.fl-composer-mention-row', { hasText: /^src\/$/ })
  await expect(srcDir).toBeVisible()
  await srcDir.click()

  // Directory pick appends a trailing slash and re-opens listing its contents.
  await expect(textarea).toHaveValue('@src/')
  await expect(popup.locator('.fl-composer-mention-row', { hasText: 'index.ts' })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// The POSITIVE /-skill insertion path (#391 — picking a /-skill must insert
// exactly `/<name> ` with no stray trailing char) is now a live regression guard
// in `composer-command-insert.spec.ts`, covering both mouse-pick and keyboard
// Enter-accept. #391 was fixed by deriving the replacement span from the live
// value at accept time (`computeCommandInsertion`), immune to the cold-cache race.

test('@-file: Escape and deleting the @ both dismiss the autocomplete cleanly', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  const popup = window.locator(MENTION_POPUP)

  // Escape closes the popup but leaves the typed text — the user keeps editing.
  await textarea.click()
  await textarea.type('@READ')
  await expect(popup).toBeVisible()
  await textarea.press('Escape')
  await expect(popup).toBeHidden()
  await expect(textarea).toHaveValue('@READ')

  // Deleting back past the '@' also tears the popup down (no orphaned overlay).
  await textarea.type(' @src')
  await expect(popup).toBeVisible()
  for (let i = 0; i < 4; i++) await textarea.press('Backspace')
  await expect(popup).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('/-skill: deleting the slash dismisses the command autocomplete', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  const popup = window.locator(COMMAND_POPUP)

  await textarea.click()
  await textarea.type('/br')
  await expect(popup).toBeVisible()
  await textarea.press('Backspace')
  await textarea.press('Backspace')
  await textarea.press('Backspace')
  await expect(popup).toBeHidden()
  await expect(textarea).toHaveValue('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('send: an accepted send clears the input and shows an optimistic echo', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('drive the send affordance')

  const send = window.locator(`${sel.composer} fl-button[variant="primary"]`)
  await send.click()

  // The message is committed the instant Send is pressed: the input clears and
  // the user's text is echoed into the transcript (optimistic bubble) — the
  // user must see immediate feedback, never a blank pane.
  await expect(textarea).toHaveValue('')
  await window.waitForTimeout(400)
  await window.screenshot({ path: `${SCREENS}/composer-after-send.png` })
  await expect(window.getByText('drive the send affordance', { exact: true })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
