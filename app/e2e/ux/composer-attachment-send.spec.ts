import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): an IMAGE attachment is sendable content, so the
 * Send affordance must reflect that — the same way a context chip (cmd+L) or a
 * blueprint chip already lights Send up with no typed text (#456, #152).
 *
 * The composer has two "is there anything to send?" checks that must agree:
 *   - `#send()` counts attachments (`… || this.#attachments.length > 0`), so an
 *     image-only message actually sends.
 *   - `#syncEnabled()` (drives the Send button's disabled state) calls
 *     `hasSendableContent(text, chips, contextChips)` — which has NO attachment
 *     parameter — so it dims Send for an image-only composer (#541).
 *
 * Driven against a seeded project (no Claude account — `threads:create` +
 * `project:add` need only a project root); the image is fed to the same
 * hidden file input the attach-image button clicks.
 */

/** A minimal valid 1×1 PNG (accepted by validateAttachment). */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

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

/** Seed a project, activate it, create + open a thread → composer visible. */
async function openComposer(win: Page, title = 'Attachment send'): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

/** Attach a real PNG via the composer's hidden file input; returns its locator. */
async function attachImage(win: Page): Promise<void> {
  const pngPath = join(tmpdir(), 'flow-attachment-send-probe.png')
  writeFileSync(pngPath, PNG_1x1)
  await win.locator(`${sel.composer} input[type="file"]`).setInputFiles(pngPath)
  await expect(win.locator('.fl-composer-attachment')).toBeVisible({ timeout: 5000 })
}

/** True when the Send `<fl-button>`'s inner button is actually disabled. */
async function sendDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${sel.composer} fl-button[variant="primary"]`)
    .evaluate((el) => (el as unknown as { disabled: boolean }).disabled)
}

test.afterAll(() => cleanupSeeds())

test('attaching an image renders a thumbnail chip, and Enter sends the image-only message', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await expect(textarea).toHaveValue('')

  await attachImage(window)
  // The image is the only content — the textarea stays empty.
  await expect(textarea).toHaveValue('')

  // `#send()` counts attachments, so Enter must dispatch the image-only message:
  // the attachment chip clears once the send is committed (optimistic path).
  await textarea.click()
  await textarea.press('Enter')
  await expect(window.locator('.fl-composer-attachment')).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// KNOWN BUG (#541): `#syncEnabled()` gates the Send button on
// `hasSendableContent(text, chips, contextChips)` — which omits `#attachments` —
// so an image-only composer dims Send (opacity 0.45, cursor default,
// pointer-events none), falsely signalling the image can't be sent, even though
// `#send()` treats it as sendable and a context/blueprint chip correctly enables
// Send. Remove `.fixme` once `hasSendableContent` (and its `#syncEnabled` caller)
// factor in the attachment count.
test.fixme('Send is enabled (not dimmed) when the only content is an image attachment', async ({
  window,
}) => {
  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)

  // Empty composer → Send is a guarded (disabled) affordance.
  await expect(textarea).toHaveValue('')
  expect(await sendDisabled(window)).toBe(true)

  // Attach an image with no typed text — this is sendable content on its own.
  await attachImage(window)
  await expect(textarea).toHaveValue('')

  // Send must be enabled, mirroring chip-only sends (#456/#152).
  expect(await sendDisabled(window)).toBe(false)

  // Removing the only attachment returns Send to its disabled resting state.
  await window.locator('.fl-composer-attachment .fl-composer-chip-dismiss').click()
  await expect(window.locator('.fl-composer-attachment')).toBeHidden()
  expect(await sendDisabled(window)).toBe(true)
})
