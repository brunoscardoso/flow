import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the Send affordance's enabled/disabled state.
 *
 * The composer's primary Send button must honestly reflect whether a send is
 * possible: enabled when there's sendable content, disabled (dimmed, inert)
 * when the input is empty or whitespace-only — the way this app's other guarded
 * submit affordances behave. Driven against a seeded project (no Claude account
 * needed — `threads:create` only needs a project root); the composer only
 * mounts visibly once a thread is active, so we create + open one first.
 */

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

/** Seed a project, activate it, create + open a thread → composer visible. */
async function openComposer(win: Page, title = 'Send affordance'): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

/** True when the Send `<fl-button>`'s inner button is actually disabled. */
async function sendDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${sel.composer} fl-button[variant="primary"]`)
    .evaluate((el) => (el as unknown as { disabled: boolean }).disabled)
}

test.afterAll(() => cleanupSeeds())

test('Send is enabled and reachable once real text is typed', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)

  await textarea.click()
  await textarea.type('a real message')
  expect(await sendDisabled(window)).toBe(false)

  // Reaching the send path commits the draft — the input clears immediately
  // (the optimistic-echo path), proving Send with content is not a dead click.
  await window.locator(`${sel.composer} fl-button[variant="primary"]`).click()
  await expect(textarea).toHaveValue('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('Shift+Enter inserts a newline (contrast with the swallowed plain Enter)', async ({
  window,
}) => {
  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('   ')
  await textarea.press('Shift+Enter')
  await expect(textarea).toHaveValue('   \n')
})

// KNOWN BUG (#430): the Send button never disables on empty/whitespace input —
// `#syncEnabled()` only disables on `!hasThread || sending`, ignoring content —
// so it renders as a full-color primary button that is a dead click, and plain
// Enter on a whitespace-only composer is swallowed (no newline, no send). This
// guard asserts the expected behavior (Send disabled with nothing to send).
// Remove `.fixme` once `#syncEnabled()` factors in the sendable-content check.
test.fixme('Send is disabled when the input is empty or whitespace-only', async ({ window }) => {
  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)

  // Empty: nothing to send → Send must be disabled.
  await expect(textarea).toHaveValue('')
  expect(await sendDisabled(window)).toBe(true)

  // Whitespace-only: still nothing to send → still disabled.
  await textarea.click()
  await textarea.type('    ')
  expect(await sendDisabled(window)).toBe(true)

  // Real content flips it enabled.
  await textarea.fill('hello')
  expect(await sendDisabled(window)).toBe(false)
})
