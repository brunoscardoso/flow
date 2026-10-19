import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the send interaction model.
 *
 * Two things guarded end-to-end here, both currently proven only by DOM-free
 * unit tests (`composer-keys`, `composer-send`) — never against the real,
 * built composer:
 *
 *  1. The Enter-to-send model (#139): a bare Enter SENDS; Shift+Enter inserts a
 *     newline; and an Enter pressed while the @-mention popup is open ACCEPTS the
 *     highlighted item instead of sending. This is a recently-flipped interaction
 *     (the composer used to send on ⌘/Ctrl+Enter), so it is exactly the kind of
 *     wiring that silently reverts — a regression would leave every user unable to
 *     send with the key the placeholder advertises ("⏎ to send").
 *  2. Chip-only sends: an attached context (cmd+L → `flow:add-to-chat`) or
 *     blueprint (`flow:blueprint-selected`) reference is sendable content on its
 *     own — Send must enable with a chip and no typed text, and disable again when
 *     the chip is removed (#430/#152). These event bridges have no other E2E guard.
 *
 * Driven against a seeded project (no Claude account — `threads:create` +
 * `project:listDir` need only a project root). The composer only mounts once a
 * thread is active, so each test seeds a project and opens a thread first.
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'

/** Create a thread in `root` via the same IPC the "+" button calls. */
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

/** Seed a project with a browsable file, activate it, open a thread → composer up. */
async function openComposer(win: Page, title = 'Enter-send probe'): Promise<string> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return dir
}

/** True when the Send `<fl-button>`'s inner button is actually disabled. */
async function sendDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${sel.composer} fl-button[variant="primary"]`)
    .evaluate((el) => (el as unknown as { disabled: boolean }).disabled)
}

test.afterAll(() => cleanupSeeds())

test('plain Enter sends: input clears and the message echoes into the transcript', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('hello via enter')

  // The placeholder advertises "⏎ to send" — a bare Enter must commit the draft.
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('')
  await expect(window.getByText('hello via enter', { exact: true })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('Shift+Enter inserts a newline and does NOT send', async ({ window }) => {
  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('first')
  await textarea.press('Shift+Enter')
  await textarea.type('second')

  // Newline inserted; the draft is intact (no send fired).
  await expect(textarea).toHaveValue('first\nsecond')
})

test('Enter while the @-mention popup is open accepts the mention, not a send', async ({
  window,
}) => {
  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  const popup = window.locator(MENTION_POPUP)

  await textarea.click()
  await textarea.type('@READ')
  await expect(popup).toBeVisible()

  // Enter with the popup up must pick the highlighted file (insert `@README.md `),
  // close the popup, and leave the draft in place — never send it away.
  await textarea.press('Enter')
  await expect(popup).toBeHidden()
  await expect(textarea).toHaveValue('@README.md ')
})

test('a context chip (cmd+L) is sendable on its own: Send enables, then disables on remove', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  // Nothing typed, no chip → Send is a guarded (disabled) affordance.
  expect(await sendDisabled(window)).toBe(true)

  // A terminal selection attaches as a badge the way cmd+L does.
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:add-to-chat', {
        detail: { source: 'terminal', text: 'line A\nline B', label: 'Terminal' },
      }),
    )
  })
  const chip = window.locator('.fl-composer-chip')
  await expect(chip).toBeVisible()
  // Chip is sendable content even with no typed text (#152/#430).
  expect(await sendDisabled(window)).toBe(false)

  // Removing the only chip returns Send to its disabled resting state.
  await window.locator('.fl-composer-chip-dismiss').click()
  await expect(chip).toBeHidden()
  expect(await sendDisabled(window)).toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a blueprint reference chip attaches as a pill and makes the composer sendable', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  expect(await sendDisabled(window)).toBe(true)

  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:blueprint-selected', {
        detail: { nodeId: 'mod:src/index.ts', label: 'index.ts', kind: 'module' },
      }),
    )
  })
  const chip = window.locator('.fl-composer-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('index.ts')
  expect(await sendDisabled(window)).toBe(false)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
