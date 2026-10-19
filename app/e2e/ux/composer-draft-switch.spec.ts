import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): an unsent draft leaks across a thread switch.
 *
 * The composer is a SINGLETON (`threads/index.ts:51` — one `new Composer(...)`).
 * `selectThread` re-binds it to the clicked thread via `composer.setThread(thread)`
 * (`index.ts:128`). `setThread` (`composer.ts:465`) deliberately tears down the
 * OTHER transient per-thread state on a genuine switch — it drops the queued
 * prompts ("Queued prompts belong to the thread they were composed for — drop
 * them on a switch so they can't misroute into a different thread", #472), resets
 * model/effort, clears the next-step suggestion, and closes the @/ popups — BUT it
 * NEVER clears `#textarea.value` (nor the pending `#attachments` / context chips).
 *
 * So a half-typed message for thread A silently follows the user to thread B and
 * rebinds to it: the draft the user wrote for A now sits in B's composer, and the
 * next Enter sends it into the WRONG thread — exactly the misroute the queue is
 * dropped to prevent (#472). This is the same draft-leak-across-context class the
 * app already fixed on its sibling surfaces — the task board (#591) and the review
 * panel (#281) — but never in the composer.
 *
 * Driven against a seeded project (no Claude account — `threads:create` +
 * `project:add` need only a project root; nothing is sent).
 */

const DRAFT_FOR_A = 'half-written question meant only for thread A'

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

const textarea = (win: Page) => win.locator(`${sel.composer} textarea`)

test.afterAll(() => cleanupSeeds())

// Fixed in #688: setThread now clears the textarea (+ attachments + chips) on a
// genuine switch, so a draft written for A never follows the user into B.
test('an unsent draft typed in thread A does NOT follow the user into thread B', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Thread A')
  await createThread(window, dir, 'Thread B')

  // Open thread A and type a draft — do NOT send it.
  await window.getByText('Thread A', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  const ta = textarea(window)
  await ta.fill(DRAFT_FOR_A)
  await expect(ta).toHaveValue(DRAFT_FOR_A)

  // Switch to thread B (a genuine thread switch — the composer rebinds to B).
  await window.getByText('Thread B', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  // EXPECTED user experience: thread B opens with an empty composer. The draft
  // written for A belongs to A, not B — sending here must not misroute it.
  // ACTUAL (bug): setThread never clears the textarea, so A's draft is now sitting
  // in B's composer, bound to B — one Enter away from being sent to the wrong thread.
  await expect(ta, 'thread B should open with an empty composer, not A\'s leaked draft').toHaveValue('')

  // Screenshot the observed state (draft visible under thread B) for the issue.
  await window.screenshot({ path: join(__dirname, '__screens', 'composer-draft-switch.png') })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Contrast guard: the app DOES deliberately drop the sibling per-thread state on
// a switch — the model/effort selection resets to the new thread's own values.
// This proves setThread's switch-teardown path runs; the draft is simply omitted
// from it. (Both threads are fresh with no stored model, so both read 'auto'.)
test('the model selector resets to the new thread on switch — the switch-teardown path runs', async ({
  window,
}) => {
  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Model A')
  await createThread(window, dir, 'Model B')

  await window.getByText('Model A', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  const model = window.locator(`${sel.composer} .fl-composer-model-select, ${sel.composer} select`).first()

  await window.getByText('Model B', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  // The model selector rebinds to B's own value (both fresh → 'auto'): teardown ran.
  await expect(model).toHaveValue('auto')
})
