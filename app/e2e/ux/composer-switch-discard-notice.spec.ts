import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 22: what a thread SWITCH silently destroys.
 *
 * `setThread` (composer.ts:646) tears down the composer's transient per-thread
 * state on a genuine switch so nothing can misroute into the new thread (#688 for
 * chips/attachments, #472 for the queue). That teardown is correct. What this probe
 * drives is the FEEDBACK the teardown owes the user — and the asymmetry #1067
 * introduced when it made the TEXT survive a switch:
 *
 *   setThread (switch branch)                         restored on return?
 *   ─────────────────────────────────────────────────────────────────────
 *   #textarea.value = this.#loadDraft(thread.id)      YES  (#1067)
 *   this.#setChips(clearChips())                      no   — silent
 *   this.#setContextChips([])                         no   — silent
 *   this.#setAttachments([])                          no   — silent
 *   this.#setQueue([])                                no   — silent
 *
 * Two user harms, both driven below:
 *
 *  1. MISLEADING CONTEXT — attach an image, type a sentence ABOUT it, glance at
 *     another thread, come back: the sentence is faithfully restored, so the
 *     composer reads as "nothing was lost", but the image is gone. The next Enter
 *     sends "compare these two screenshots" with zero screenshots attached. Every
 *     sibling attachment drop in this composer is announced out loud — the 8-image
 *     cap (#649), an unsupported paste (#1085), an empty text file (#1086) — so a
 *     silent drop here is the odd one out, not the house style.
 *
 *  2. A BROKEN PROMISE — a QUEUED prompt (#472) is a message the user already
 *     committed: the input was cleared and its draft explicitly zeroed
 *     (`#saveDraft(thread.id, '')`, composer.ts:784) against the contract that it
 *     auto-sends when the turn finishes. Reading another thread while you wait is
 *     precisely the behaviour queueing exists to enable — and it silently cancels
 *     the queue. The turn ends, the follow-up never runs, and nothing ever said so.
 *     (Verified locally: the text is still ⬆-recallable from the per-thread history,
 *     so this is not data loss — but ⬆ can only help a user who KNOWS the prompt was
 *     cancelled, and nothing tells them. Cf. #397, where a promised agent-redo that
 *     never happened was filed on exactly that reasoning.) The composer even ships an
 *     explicit per-pill ✕ ("Remove from queue"), so cancelling is a deliberate,
 *     affordance-backed act everywhere except here.
 *
 * Account-independent: `project:add` + `threads:create` need only a project
 * root, and `working` is driven by emitting the real `threads:stream` status event
 * the agent-manager would send (same technique as composer-prompt-queue.spec.ts).
 * Nothing is sent to an agent.
 *
 * Shape: one LIVE guard on the ground truth (text restores, teardown runs, no uncaught
 * errors) plus two `test.fixme` tripwires for the filed bugs — #1327 (attachment) and
 * #1328 (queue) — which flip to live guards the moment either is fixed.
 */

const SCREENS = 'e2e/ux/__screens'

/** A minimal valid 1×1 PNG (accepted by validateAttachment). */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const TEXT_ABOUT_THE_IMAGE = 'Compare the attached screenshot with the mock and list the diffs'
const QUEUED_PROMPT = 'then run the migration and report the row counts'

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

const textarea = (win: Page) => win.locator(`${sel.composer} textarea`)
const attachmentChips = (win: Page) => win.locator('.fl-composer-attachment')
const queueItems = (win: Page) => win.locator(`${sel.composer} .fl-composer-queue-item`)
const toasts = (win: Page) => win.locator('.fl-flow-toast')

/** Open a thread by its sidebar row title and wait for the composer to rebind. */
async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

/**
 * LIVE guard — the ground truth both tripwires below stand on, and worth holding on
 * its own: a thread round-trip restores the leaving thread's typed text (#1067) while
 * the switch-teardown path genuinely runs (the attachment does not follow), with no
 * uncaught errors. If either half regresses, the two findings stop describing reality.
 */
test('a thread round-trip restores the text and runs the switch teardown (attachment does not follow)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Round Alpha')
  await createThread(window, dir, 'Round Beta')

  await openThread(window, 'Round Alpha')
  const ta = textarea(window)
  await ta.fill(TEXT_ABOUT_THE_IMAGE)
  const pngPath = join(tmpdir(), 'flow-switch-roundtrip-probe.png')
  writeFileSync(pngPath, PNG_1x1)
  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(pngPath)
  await expect(attachmentChips(window)).toHaveCount(1, { timeout: 5000 })
  // Let the debounced per-thread draft save (400ms) land before switching.
  await window.waitForTimeout(700)

  // Leaving the thread tears the transient state down: no chip follows into Beta.
  await openThread(window, 'Round Beta')
  await expect(ta).toHaveValue('')
  await expect(attachmentChips(window)).toHaveCount(0)

  // Returning restores Alpha's text (#1067) but NOT its attachment (#688).
  await openThread(window, 'Round Alpha')
  await expect(ta, "#1067 restores thread A's draft text on return").toHaveValue(
    TEXT_ABOUT_THE_IMAGE,
  )
  await expect(attachmentChips(window), 'the attachment does not come back (#688)').toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// TRIPWIRE — open bug #1327. Remove `.fixme` once the switch discard is announced
// (or once attachments ride the per-thread draft store alongside the text).
test.fixme('an attachment dropped by a thread switch is announced — the restored text must not imply it survived', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Attach Alpha')
  await createThread(window, dir, 'Attach Beta')

  // ── Thread A: type a sentence ABOUT an image, and attach the image ────────
  await openThread(window, 'Attach Alpha')
  const ta = textarea(window)
  await ta.fill(TEXT_ABOUT_THE_IMAGE)
  const pngPath = join(tmpdir(), 'flow-switch-discard-probe.png')
  writeFileSync(pngPath, PNG_1x1)
  await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(pngPath)
  await expect(attachmentChips(window)).toHaveCount(1, { timeout: 5000 })
  await expect(ta).toHaveValue(TEXT_ABOUT_THE_IMAGE)

  // Let the debounced per-thread draft save (400ms) land before switching, so the
  // restore below is testing #1067's store and not a timing artifact.
  await window.waitForTimeout(700)

  // ── Glance at thread B, then come straight back to A ─────────────────────
  await openThread(window, 'Attach Beta')
  await expect(attachmentChips(window)).toHaveCount(0)
  const toastsAfterLeaving = await toasts(window).count()

  await openThread(window, 'Attach Alpha')

  // The TEXT is faithfully restored (#1067) — this is the trap, and it must hold
  // for the finding to be about feedback rather than about draft persistence.
  await expect(ta, "#1067 restores thread A's draft text on return").toHaveValue(
    TEXT_ABOUT_THE_IMAGE,
  )
  // The attachment is NOT restored (deliberate, #688).
  await expect(attachmentChips(window), 'the attachment does not come back').toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/composer-switch-discard-attachment.png` })

  // EXPECTED user experience: the app says the attachment was dropped — the same
  // out-loud refusal every sibling attachment drop already gives (#649/#1085/#1086).
  // Either a toast at drop time, or the returned-to composer showing/naming the loss.
  const notified =
    (await toasts(window).count()) > toastsAfterLeaving ||
    (await window.locator(`${sel.composer}`).innerText()).toLowerCase().includes('attach')
  expect(
    notified,
    'switching away silently discarded the attachment while restoring the text that describes it — ' +
      'the composer comes back looking intact and the next Enter sends a message about an image that is gone',
  ).toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// TRIPWIRE — open bug #1328. Remove `.fixme` once the switch either announces the
// cancellation or keeps the queue per-thread so the advertised auto-send still fires.
test.fixme('a QUEUED prompt cancelled by a thread switch says so — its promised auto-send will never fire', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  const queueThread = await createThread(window, dir, 'Queue Alpha')
  await createThread(window, dir, 'Queue Beta')

  await openThread(window, 'Queue Alpha')

  // Drive the thread into `working` with the real status stream event, so the
  // composer's Send becomes "Queue" (#472).
  await app.evaluate(
    ({ BrowserWindow }, { threadId }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('threads:stream', { kind: 'status', threadId, status: 'working' })
    },
    { threadId: queueThread },
  )
  await expect(
    window.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' }),
  ).toBeVisible()

  // Commit a prompt to the queue: the input clears and a pill holds the message.
  const ta = textarea(window)
  await ta.click()
  await ta.fill(QUEUED_PROMPT)
  await ta.press('Enter')
  await expect(queueItems(window)).toHaveCount(1)
  await expect(ta).toHaveValue('')

  await window.screenshot({ path: `${SCREENS}/composer-switch-discard-queued.png` })

  // ── Glance at thread B, then come straight back ──────────────────────────
  const toastsBefore = await toasts(window).count()
  await openThread(window, 'Queue Beta')
  await openThread(window, 'Queue Alpha')

  // The pill is gone (deliberate, #472) — and the composer is back to a resting
  // idle-looking input with nothing standing in for the cancelled message.
  await expect(queueItems(window), 'the queue pill does not come back').toHaveCount(0)

  await window.screenshot({ path: `${SCREENS}/composer-switch-discard-queued-after.png` })

  // EXPECTED: a message the user already committed is either still queued, handed
  // back as the draft it was cleared into, or its cancellation is announced. Any one
  // of the three tells the user the promised auto-send is off; all three failing
  // leaves them waiting for a follow-up that will never run.
  const restoredAsDraft = (await ta.inputValue()).includes(QUEUED_PROMPT)
  const announced = (await toasts(window).count()) > toastsBefore
  expect(
    restoredAsDraft || announced,
    'the queued prompt was cancelled by the switch with no notice — the composer reads as if ' +
      'nothing is pending, and the follow-up the user was promised will never be sent',
  ).toBe(true)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
