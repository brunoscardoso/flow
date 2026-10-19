import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * #1067 — per-thread composer drafts: "When writing a prompt without
 * submitting, switching to a different thread, and then returning to the
 * original thread, the prompt that was written so far must not be lost."
 *
 * `setThread`'s switch branch used to DROP the draft outright (#688 teardown —
 * correct against misrouting, but destructive). Now the typed text is saved
 * per-thread on switch (and blur / debounced input, persisted in localStorage
 * so it also survives a relaunch) and restored into the textarea when the
 * thread is reopened — the composer analog of the editor's #955 dirty buffers.
 *
 * The #688 guarantee is preserved and pinned here: the draft NEVER follows the
 * user into the other thread — each thread restores only its own draft.
 *
 * Credential-free: `threads:create` + `project:add` need only a
 * project root; nothing is sent to an agent.
 */

const DRAFT_A = 'draft for thread A — do not lose me'
const DRAFT_B = 'a different draft, belonging to B'

const textarea = (win: Page) => win.locator(`${sel.composer} textarea`)

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

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test('an unsent draft survives a thread round-trip, per thread (#1067)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Persist A')
  await createThread(window, dir, 'Persist B')

  // Type a draft in A — do NOT send.
  await openThread(window, 'Persist A')
  const box = textarea(window)
  await box.click()
  await box.fill(DRAFT_A)
  await expect(box).toHaveValue(DRAFT_A)

  // Switch to B: opens with ITS OWN (empty) composer — A's draft must not
  // follow (#688 guarantee, unchanged). Type B's own draft.
  await openThread(window, 'Persist B')
  await expect(box, "A's draft must not leak into B (#688)").toHaveValue('')
  await box.click()
  await box.fill(DRAFT_B)

  // Return to A: the draft written for A is restored, not lost.
  await openThread(window, 'Persist A')
  await expect(box, "returning to A restores A's unsent draft (#1067)").toHaveValue(DRAFT_A)

  // And back to B: B's draft was saved on the switch away, too.
  await openThread(window, 'Persist B')
  await expect(box, "B's own draft is restored independently").toHaveValue(DRAFT_B)

  await window.screenshot({ path: 'e2e/ux/__screens/composer-draft-persistence.png' })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a cleared draft stays cleared after a round-trip (no resurrection)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Clear A')
  await createThread(window, dir, 'Clear B')

  await openThread(window, 'Clear A')
  const box = textarea(window)
  await box.click()
  await box.fill('temporary thought')
  // The user deletes their draft — an empty composer is a deliberate state.
  await box.fill('')

  await openThread(window, 'Clear B')
  await openThread(window, 'Clear A')
  await expect(box, 'a deliberately-cleared draft must not come back').toHaveValue('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
