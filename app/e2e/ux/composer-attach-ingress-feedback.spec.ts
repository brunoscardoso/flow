import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 18: attachment-ingress feedback PARITY.
 *
 * A file reaches the composer three ways, and all three end in the same
 * `splitAttachmentFiles` → images / texts / rejected triage:
 *
 *   - picker  `fileInput.change`  (composer.ts:388) → always `#notifyRejectedAttachments`
 *   - drop    (composer.ts:313)   → notifies when images|texts|REJECTED is non-empty
 *   - paste   (composer.ts:286)   → notifies ONLY when images|texts is non-empty  ← #1085
 *
 * `#notifyRejectedAttachments` is documented "Loud (never silent) feedback for
 * refused attachment files (#772)", and #649 closed the same class of silent drop
 * for the image cap — so a refusal that reaches the user on one ingress and not on
 * the sibling is a regression, not a preference.
 *
 * Guards (live, green): the picker and drop paths refuse an unsupported `.pdf` out
 * loud; an empty IMAGE is refused out loud; and a SUPPORTED file pasted through the
 * synthetic ClipboardEvent lands its context chip — that last one is what makes a
 * silent paste attributable to the app rather than to the harness.
 *
 * Tripwires (now live): #1085 pasting the same `.pdf` used to say nothing —
 * fixed by folding picker/drop/paste onto one `#ingestAttachmentFiles` path;
 * #1086 an empty/whitespace-only text file used to attach nothing and say
 * nothing — fixed by routing `#addTextFiles` skips through the refusal notifier.
 *
 * Account-independent: `threads:create` + `project:add` need only a project
 * root; nothing is sent to an agent.
 */

const SCREENS = 'e2e/ux/__screens'

const UNSUPPORTED = {
  name: 'quarterly-report.pdf',
  type: 'application/pdf',
  content: '%PDF-1.4 not attachable',
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
async function openComposer(win: Page, title = 'Attach ingress'): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

/**
 * Fire the real paste/drop event carrying `file` at the composer, exactly as
 * Chromium does for ⌘V of a Finder-copied file / a Finder drag. Returns what the
 * app's handler could read off the event, so a no-op is never attributable to the
 * synthesis: `delivered` must be 1 for the assertion below it to mean anything.
 */
async function ingressFile(
  win: Page,
  how: 'paste' | 'drop',
  file: { name: string; type: string; content: string },
): Promise<{ delivered: number }> {
  return win.evaluate(
    ({ how, file }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([file.content], file.name, { type: file.type }))
      const target =
        how === 'paste'
          ? (document.querySelector('.fl-composer textarea') as HTMLElement)
          : (document.querySelector('.fl-composer-input') as HTMLElement)
      const event =
        how === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      const data =
        how === 'paste' ? (event as ClipboardEvent).clipboardData : (event as DragEvent).dataTransfer
      return { delivered: data ? data.files.length : 0 }
    },
    { how, file },
  )
}

const toasts = (win: Page) => win.locator('.fl-flow-toast')
const rejectToast = (win: Page) => toasts(win).filter({ hasText: "Couldn't attach file" })
const chips = (win: Page) => win.locator(`${sel.composer} .fl-composer-chip`)

// Each seeded project keeps background writers alive (watcher / first derive), so a
// straight `rmSync` can lose the race and throw ENOTEMPTY on a throwaway temp dir —
// a cleanup flake, never a product signal. Retry once, then let the OS reclaim it.
test.afterAll(async () => {
  try {
    cleanupSeeds()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      cleanupSeeds()
    } catch {
      /* temp dirs under os.tmpdir() — reclaimed by the OS */
    }
  }
})

test('a SUPPORTED file pasted into the composer lands a context chip', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const seen = await ingressFile(window, 'paste', {
    name: 'notes.md',
    type: 'text/markdown',
    content: '# hello from a pasted file',
  })

  // The handler really received the file — the paste wiring is live (#772).
  expect(seen.delivered).toBe(1)
  await expect(chips(window)).toHaveCount(1)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('DROPPING an unsupported file tells the user why nothing attached', async ({ window }) => {
  await openComposer(window)
  const seen = await ingressFile(window, 'drop', UNSUPPORTED)
  expect(seen.delivered).toBe(1)

  await expect(rejectToast(window)).toBeVisible({ timeout: 5000 })
  await expect(chips(window)).toHaveCount(0)
})

test('the PICKER refuses the same unsupported file out loud', async ({ window }) => {
  await openComposer(window)
  const p = join(tmpdir(), 'flow-ingress-report.pdf')
  writeFileSync(p, UNSUPPORTED.content)

  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(p)

  await expect(rejectToast(window)).toBeVisible({ timeout: 5000 })
  await expect(chips(window)).toHaveCount(0)
})

test('an EMPTY IMAGE is refused out loud ("Empty image") — the reject path reaches the user', async ({
  window,
}) => {
  await openComposer(window)
  const p = join(tmpdir(), 'flow-ingress-empty.png')
  writeFileSync(p, '')

  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(p)

  await expect(toasts(window).filter({ hasText: 'Could not attach image' })).toBeVisible({
    timeout: 5000,
  })
})

// #1085 (fixed) — the paste guard used to omit `|| files.rejected.length > 0`, so a
// paste whose files were ALL unsupported never reached `#notifyRejectedAttachments`.
// All three ingresses now share one `#ingestAttachmentFiles` path, so the refusal
// notice is structurally unavoidable.
test('PASTING an unsupported file gives the same refusal notice as dropping it', async ({
  window,
}) => {
  await openComposer(window)
  const seen = await ingressFile(window, 'paste', UNSUPPORTED)
  expect(seen.delivered).toBe(1)

  await expect(rejectToast(window)).toBeVisible({ timeout: 5000 })
  await window.screenshot({ path: `${SCREENS}/composer-paste-unsupported.png` })
})

// #1086 (fixed) — `#addTextFiles` used to drop an empty/whitespace-only text file
// with a bare `continue`: no chip and no notice, while the empty-IMAGE test above
// shows the sibling path toasts "Empty image". Skips are now collected and routed
// through the same refusal notifier ("… is empty (nothing to attach)"); a 0-byte
// text file is even classified `text-empty` up front so all ingresses refuse it.
test('an EMPTY text file is refused out loud instead of vanishing', async ({ window }) => {
  await openComposer(window)
  const p = join(tmpdir(), 'flow-ingress-empty.md')
  writeFileSync(p, '   \n\n  \n')

  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(p)

  await expect(chips(window)).toHaveCount(0) // nothing attached — correct
  await expect(toasts(window).first()).toBeVisible({ timeout: 5000 }) // …but say so
  await window.screenshot({ path: `${SCREENS}/composer-empty-text.png` })
})
