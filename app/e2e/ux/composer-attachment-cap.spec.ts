import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the per-message image-attachment cap.
 *
 * The composer caps a single message at `MAX_ATTACHMENTS_PER_MESSAGE` (8) images
 * (`image-attachment.ts`). `addAttachment` enforces it by returning the array
 * UNCHANGED once the cap is reached — so `#addImageFiles` silently drops the 9th+
 * image. Unlike the sibling reject paths (bad type / oversized / empty), which
 * dispatch a `flow:notify` error toast ("Could not attach image"), the cap path
 * emits NOTHING: no toast, no chip, no console line. A user who selects 10
 * screenshots at once sees only 8 appear and the other 2 vanish with no
 * explanation.
 *
 * Driven against a seeded project (no Claude account — `threads:create` +
 * `project:add` need only a project root). Images are fed through the
 * composer's hidden file input; distinct leading bytes give distinct attachment
 * ids (the id fingerprint is the first bytes of the base64), so none dedup.
 */

const MAX_ATTACHMENTS = 8

/** Write N distinct .png files (distinct bytes → distinct attachment ids). */
function makeDistinctImages(count: number): string[] {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    // Content need only be non-empty + carry an image/png mime (from the .png
    // extension). validateAttachment checks type + size, not pixel bytes; the
    // distinct prefix keeps every id unique so none collide/dedup.
    // The id fingerprint is the FIRST bytes of the base64, so the distinct token
    // must lead — a shared prefix would collide every id and dedup to one.
    const p = join(tmpdir(), `flow-attach-cap-${i}.png`)
    writeFileSync(p, `${String.fromCharCode(65 + i).repeat(48)}-flow-attach-cap-${i}`)
    paths.push(p)
  }
  return paths
}

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
async function openComposer(win: Page, title = 'Attachment cap'): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

const attachmentChips = (win: Page) => win.locator(`${sel.composer} .fl-composer-attachment`)
const errorToasts = (win: Page) =>
  win.locator('.fl-flow-toast', { hasText: 'Could not attach image' })

test.afterAll(() => cleanupSeeds())

test('the composer accepts exactly the 8-image cap in a single selection', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const fileInput = window.locator(`${sel.composer} input[type="file"]`)

  await fileInput.setInputFiles(makeDistinctImages(MAX_ATTACHMENTS))
  await expect(attachmentChips(window)).toHaveCount(MAX_ATTACHMENTS)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a rejected attachment (wrong image subtype) surfaces an error toast — the feedback path exists', async ({
  window,
}) => {
  await openComposer(window)
  const fileInput = window.locator(`${sel.composer} input[type="file"]`)

  // Must be a type that routes through the IMAGE reject path so the toast reads
  // "Could not attach image". A .bmp is classified as an image (mime image/bmp
  // starts with image/) yet is NOT in ALLOWED_IMAGE_TYPES, so validateAttachment
  // rejects it → #addImageFiles dispatches the "Could not attach image" toast.
  // (A .txt is NOT usable here anymore: since #772 text files are a supported
  // attachment class that folds into a context chip — no reject, no toast.)
  const badPath = join(tmpdir(), 'flow-attach-cap-notimage.bmp')
  writeFileSync(badPath, 'definitely not a supported image subtype')
  await fileInput.setInputFiles(badPath)

  // The app HAS an attach-feedback machinery: bad type → a visible error toast.
  await expect(errorToasts(window).first()).toBeVisible({ timeout: 5000 })
  await expect(attachmentChips(window)).toHaveCount(0)
})

// Fixed in #649: `addAttachmentWithOutcome` distinguishes cap-reached from
// duplicate, and `#addImageFiles` raises one aggregated "Image limit reached"
// toast per batch — the same flow:notify machinery every sibling reject path
// (bad type / size / empty) already uses. This attaches 8, then a 9th, and
// asserts the feedback toast appears.
test('exceeding the cap surfaces feedback instead of silently dropping', async ({
  window,
}) => {
  await openComposer(window)
  const fileInput = window.locator(`${sel.composer} input[type="file"]`)

  await fileInput.setInputFiles(makeDistinctImages(MAX_ATTACHMENTS))
  await expect(attachmentChips(window)).toHaveCount(MAX_ATTACHMENTS)

  // A 9th distinct image, over the cap. The chip count must not grow (cap is
  // enforced) — but the user MUST be told why the image didn't attach.
  const ninth = join(tmpdir(), 'flow-attach-cap-ninth.png')
  writeFileSync(ninth, `${'Z'.repeat(48)}-flow-attach-cap-ninth`)
  await fileInput.setInputFiles(ninth)

  await expect(attachmentChips(window)).toHaveCount(MAX_ATTACHMENTS) // still capped
  // Expected (currently fails — the drop is silent): some feedback toast appears.
  await expect(window.locator('.fl-flow-toast')).toBeVisible({ timeout: 3000 })
})
