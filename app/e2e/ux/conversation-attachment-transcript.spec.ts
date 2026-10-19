import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4 (conversation), round 19: the IMAGE-ATTACHMENT side of the
 * transcript (`.fl-conv-attachments` / `.fl-conv-attachment-thumb`, #456).
 *
 * Prior flow-4 rounds drove text, markdown, tool cards, permission/question
 * cards, streaming scroll, the error card and reader state — none drove what the
 * user actually SEES after sending an image, even though the composer has a
 * first-class screenshot-capture button feeding it.
 *
 * The transcript has two independent render paths for the same bubble:
 *   - optimistic echo (`echoUserMessage`) — bytes in hand, `img.src` set inline;
 *   - history row (`#loadHistory` → `userBubble`) — the row carries only metadata,
 *     so bytes are fetched lazily through the `attachments:read` channel.
 * Only the second is asserted here, deliberately: it is the one a user hits on
 * every revisit, and it is deterministic with OR without a Claude account —
 * `AgentManager.sendMessage` persists the message + attachments (agent-manager.ts
 * :305-310) BEFORE `ensureSession()`, so an account-less run still stores a real
 * row, while the echo bubble is rolled back on the failed send (#279).
 *
 * Guards (live, green):
 *  - RENDER-FROM-HISTORY: after a thread round-trip both attachments come back as
 *    thumbnails whose bytes actually decoded, at their true aspect ratio, capped
 *    by the 220×160 CSS box.
 *  - DEGRADE: with the bytes gone from disk (`attachments:read` → null) the rows
 *    still render, still name the file via alt text, and raise no pageerror —
 *    a missing image must not blank or break the transcript.
 */

const SCREENS = 'e2e/ux/__screens'

interface ThumbShape {
  css: string
  natural: string
  hasSrc: boolean
  alt: string
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/** Attachment metadata persisted for a thread's messages. */
async function persistedAttachmentCount(win: Page, threadId: string): Promise<number> {
  return win.evaluate(async (id) => {
    const rows = (await (
      window as unknown as {
        flow: {
          messages: { list(i: { threadId: string }): Promise<{ attachments?: unknown[] }[]> }
        }
      }
    ).flow.messages.list({ threadId: id })) as { attachments?: unknown[] }[]
    return rows.reduce((n, r) => n + (r.attachments?.length ?? 0), 0)
  }, threadId)
}

async function thumbShapes(win: Page): Promise<ThumbShape[]> {
  return win.locator('.fl-conv-attachments .fl-conv-attachment-thumb').evaluateAll((els) =>
    els.map((el) => {
      const img = el as HTMLImageElement
      const r = img.getBoundingClientRect()
      return {
        css: `${Math.round(r.width)}x${Math.round(r.height)}`,
        natural: `${img.naturalWidth}x${img.naturalHeight}`,
        hasSrc: img.getAttribute('src') !== null,
        alt: img.alt,
      }
    }),
  )
}

/** Leave the thread and come back — forces a full `#loadHistory` rebuild. */
async function roundTrip(win: Page, away: string, back: string): Promise<void> {
  await win.getByText(away, { exact: true }).first().click()
  await expect(win.locator('.fl-conv-user')).toHaveCount(0)
  await win.getByText(back, { exact: true }).first().click()
  await expect(win.locator('.fl-conv-user')).toHaveCount(1)
}

test.afterAll(() => cleanupSeeds())

test('image attachments re-render from history, and degrade safely when the bytes are gone', async ({
  window,
  userDataDir,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Attachment transcript')
  await createThread(window, dir, 'Other thread')
  await window.getByText('Attachment transcript', { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  // Two real PNGs with different aspect ratios — screenshots of the app itself,
  // i.e. exactly what the capture button produces.
  const wide = join(tmpdir(), 'flow-conv-attach-wide.png')
  const tall = join(tmpdir(), 'flow-conv-attach-tall.png')
  await window.screenshot({ path: wide })
  await window.screenshot({ path: tall, clip: { x: 0, y: 0, width: 300, height: 900 } })

  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles([wide, tall])
  await expect(window.locator('.fl-composer-attachment')).toHaveCount(2, { timeout: 5000 })

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.fill('why is the sidebar empty here?')
  await textarea.press('Enter')

  // Both attachments are persisted with the message, account or not.
  await expect
    .poll(() => persistedAttachmentCount(window, threadId), { timeout: 20_000 })
    .toBe(2)

  // ── RENDER-FROM-HISTORY ──────────────────────────────────────────────────
  await roundTrip(window, 'Other thread', 'Attachment transcript')
  await expect
    .poll(async () => (await thumbShapes(window)).filter((t) => t.natural !== '0x0').length, {
      timeout: 15_000,
    })
    .toBe(2)

  const restored = await thumbShapes(window)
  await window.screenshot({ path: `${SCREENS}/conv-attach-history.png` })
  // Bytes really decoded (a src-less <img> reports 0x0), and the CSS box honours
  // the 220×160 cap without distorting either aspect ratio.
  for (const t of restored) {
    expect(t.hasSrc).toBe(true)
    const [nw, nh] = t.natural.split('x').map(Number)
    const [cw, ch] = t.css.split('x').map(Number)
    expect(nw).toBeGreaterThan(0)
    expect(cw).toBeLessThanOrEqual(220)
    expect(ch).toBeLessThanOrEqual(160)
    expect(cw / ch).toBeCloseTo(nw / nh, 1)
  }
  expect(restored.map((t) => t.alt)).toEqual([
    'flow-conv-attach-wide.png',
    'flow-conv-attach-tall.png',
  ])

  // ── DEGRADE: bytes gone from disk (attachments:read → null) ───────────────
  rmSync(join(userDataDir, 'attachments', threadId), { recursive: true, force: true })
  await roundTrip(window, 'Other thread', 'Attachment transcript')
  await window.waitForTimeout(1500)

  const orphaned = await thumbShapes(window)
  await window.screenshot({ path: `${SCREENS}/conv-attach-missing-bytes.png` })
  // The rows survive the missing file: still two of them, still naming the file,
  // and the message text is untouched.
  expect(orphaned).toHaveLength(2)
  expect(orphaned.every((t) => t.hasSrc === false)).toBe(true)
  expect(orphaned.map((t) => t.alt)).toEqual([
    'flow-conv-attach-wide.png',
    'flow-conv-attach-tall.png',
  ])
  await expect(window.locator('.fl-conv-user-body')).toHaveText('why is the sidebar empty here?')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #1138 (fixed): a transcript thumbnail is capped at 220×160, so it is an
// AFFORDANCE, not the image — the bytes live in userData/attachments/, out of
// reach of the file tree and the editor, so without a viewer there is no route
// to them at all. The thumbnail now advertises itself (pointer cursor, title,
// button role) and opens `.fl-image-viewer` at full size on click/Enter, with
// Escape and backdrop-click as the ways back out.
test('clicking a transcript image opens it at full size', async ({ window }) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Attachment viewer')
  await window.getByText('Attachment viewer', { exact: true }).first().click()

  const shot = join(tmpdir(), 'flow-conv-attach-view.png')
  await window.screenshot({ path: shot })
  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles([shot])
  await expect(window.locator('.fl-composer-attachment')).toHaveCount(1, { timeout: 5000 })
  await window.locator(`${sel.composer} textarea`).press('Enter')
  await expect.poll(() => persistedAttachmentCount(window, threadId), { timeout: 20_000 }).toBe(1)

  const thumb = window.locator('.fl-conv-attachments .fl-conv-attachment-thumb').first()
  // The affordance should read as clickable...
  await expect(thumb).toHaveCSS('cursor', 'pointer')
  // ...and clicking it should surface the image larger than its 220×160 cap.
  const capped = (await thumb.boundingBox())?.width ?? 0
  await thumb.click()
  const opened = window.locator('.fl-conv-attachments .fl-conv-attachment-thumb, .fl-image-viewer img')
  await expect
    .poll(async () => Math.max(...(await opened.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width)))))
    .toBeGreaterThan(capped)

  // The viewer must be dismissible, or a full-screen overlay traps the app.
  const viewer = window.locator('.fl-image-viewer')
  await expect(viewer).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // ...and the keyboard can reach it without a mouse at all.
  await thumb.focus()
  await window.keyboard.press('Enter')
  await expect(viewer).toBeVisible()
  // A click on the image itself must NOT dismiss — only the backdrop does.
  await window.locator('.fl-image-viewer img').click()
  await expect(viewer).toBeVisible()
  await window.locator('.fl-image-viewer-close').click()
  await expect(viewer).toBeHidden()
  // Focus comes back to the thumbnail that opened it.
  await expect(thumb).toBeFocused()
})
