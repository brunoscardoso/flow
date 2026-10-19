import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): a queued prompt's pill must say WHAT is queued.
 *
 * An image is sendable content on its own (#456/#541), so pasting/attaching a
 * screenshot and hitting Enter while the agent works queues an ATTACHMENT-ONLY
 * prompt. `queuePreview` reads only the serialized text content, and the pill
 * renders no thumbnail/count — so the pill reads "(empty)" with an empty tooltip.
 * Queue two screenshots and both pills are identical: "Send now" and ✕ become a
 * coin flip, and the text pill next to them gives no hint an image is attached
 * either (#1046).
 *
 * No Claude account needed — `threads:create` + `project:add` only need a
 * project root, and `working` is injected on the real `threads:stream` channel.
 */

const SCREENS = 'e2e/ux/__screens'

/** A minimal valid 1×1 PNG (accepted by validateAttachment). */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return t.id
    },
    { root, title },
  )
}

/** Attach a real PNG through the composer's hidden file input. */
async function attachImage(win: Page, name: string): Promise<void> {
  const png = join(tmpdir(), name)
  writeFileSync(png, PNG_1x1)
  await win.locator(`${sel.composer} input[type="file"]`).setInputFiles(png)
  await expect(win.locator('.fl-composer-attachment')).toHaveCount(1)
}

/** Seed a project + thread, open it, and drive the thread into `working`. */
async function openWorkingThread(
  app: { evaluate: (fn: unknown, arg: unknown) => Promise<unknown> },
  win: Page,
  title: string,
): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  await app.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ BrowserWindow }: any, { threadId }: { threadId: string }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('threads:stream', { kind: 'status', threadId, status: 'working' })
    },
    { threadId },
  )
  await expect(win.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' })).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('a TEXT prompt queued while working is identified by its pill (live guard)', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openWorkingThread(app, window, 'QueuePreviewText')
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('rebase onto main and re-run the suite')
  await textarea.press('Enter')

  const items = window.locator(`${sel.composer} .fl-composer-queue-item`)
  await expect(items).toHaveCount(1)
  await expect(window.locator(`${sel.composer} .fl-composer-queue-preview`).first()).toHaveText(
    'rebase onto main and re-run the suite',
  )
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('an image attaches, queues, and clears the composer (live guard)', async ({ app, window }) => {
  await openWorkingThread(app, window, 'QueuePreviewImage')
  const textarea = window.locator(`${sel.composer} textarea`)

  await attachImage(window, 'flow-ux-queue-preview-a.png')
  // An image alone is sendable content, so Enter QUEUES it while working.
  await textarea.click()
  await textarea.press('Enter')
  await expect(window.locator(`${sel.composer} .fl-composer-queue-item`)).toHaveCount(1)
  // The composer hands the attachment over to the queue (chip cleared).
  await expect(window.locator('.fl-composer-attachment')).toHaveCount(0)
})

// #1046 — fixed: an attachment-only queued prompt must be identifiable in the
// queue (a count/name/thumbnail — anything but "(empty)").
test(
  'an attachment-only queued prompt says what it is (#1046)',
  async ({ app, window }) => {
    await openWorkingThread(app, window, 'QueuePreviewGhost')
    const textarea = window.locator(`${sel.composer} textarea`)
    const items = window.locator(`${sel.composer} .fl-composer-queue-item`)

    await attachImage(window, 'flow-ux-queue-preview-b.png')
    await textarea.click()
    await textarea.press('Enter')
    await expect(items).toHaveCount(1)

    await attachImage(window, 'flow-ux-queue-preview-c.png')
    await textarea.press('Enter')
    await expect(items).toHaveCount(2)
    await window.screenshot({ path: `${SCREENS}/composer-queue-attachment-preview.png` })

    const first = (await items.first().innerText()).trim()
    const second = (await items.nth(1).innerText()).trim()
    // Not "(empty)" — the pill must name the attachment somehow…
    expect(first).not.toContain('(empty)')
    // …and a thumbnail would do it too, if that is the chosen fix.
    const thumbs = await items.first().locator('img').count()
    expect(first.length > 0 || thumbs > 0).toBe(true)
    // Two queued screenshots must be tellable apart before you click ✕ or "Send now".
    expect(second).not.toBe(first)
  },
)
