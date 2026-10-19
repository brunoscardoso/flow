import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the multi-project new-thread chooser (#45/#131).
 *
 * Sibling probes cover create/search/delete and the row-action surface against a
 * SINGLE seeded project. With 2+ open projects the "New thread" button no longer
 * one-shot-creates — it opens a "Projects for this thread" chooser overlay so the
 * user can pick a primary + additional projects. That surface was otherwise
 * un-probed; this drives its real dismiss/create UX:
 *
 *  - The chooser opens at 2 projects (not the single-project fast path).
 *  - "Start thread" with a selection creates a persisted thread and closes it.
 *  - Cancel closes it without creating a thread (the project group headers, not
 *    the "No threads yet" hint, are the empty surface once a project is open).
 *  - Backdrop-click closes it without creating a thread.
 *  - Unchecking every project then "Start thread" must NOT create a phantom,
 *    primary-less thread (splitRoots guards it) — the chooser stays open.
 *
 * The `Escape` path is a KNOWN bug pinned as `test.fixme` below.
 *
 * Credential-free: `threads.create` is immediate IPC.
 */

const SCREENS = 'e2e/ux/__screens'

function newThreadBtn(win: Page) {
  return win.locator('fl-button[aria-label="New thread"]')
}
function chooser(win: Page) {
  // The overlay has no class; locate it by its heading text.
  return win.getByText('Projects for this thread', { exact: true })
}
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

test.afterAll(() => cleanupSeeds())

// RETIRED SURFACE. Since 2026-09-04 "+" opens the new-thread PAGE for any number
// of projects, and the "Projects for this thread" chooser this file drives no
// longer exists in the renderer (nothing renders that heading). A thread's extra
// projects are attached by the first-prompt context gate or by a person after
// the first turn. Kept, skipped, so the history of what it guarded stays here.
test.skip(true, 'the multi-project "Projects for this thread" chooser was retired with the new-thread page (2026-09-04)')

test('two projects: New thread opens the chooser and Start creates a thread', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-projA-')
  await seedProject(window, 'flow-ux-projB-')
  await activateProject(window, dirA)

  // No fast-path create — the chooser appears (single-project would create directly).
  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  // Two checkboxes (one per available project); the active project is preselected.
  const boxes = window.locator('input[type="checkbox"]')
  await expect(boxes).toHaveCount(2)
  const checked = await boxes.evaluateAll(
    (els) => els.filter((e) => (e as HTMLInputElement).checked).length,
  )
  expect(checked).toBeGreaterThanOrEqual(1)

  await window.getByRole('button', { name: 'Start thread' }).click()

  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await expect(chooser(window)).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('chooser: Cancel closes it without creating a thread', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-projA-')
  await seedProject(window, 'flow-ux-projB-')
  await activateProject(window, dirA)

  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  await window.getByRole('button', { name: 'Cancel' }).click()
  await expect(chooser(window)).toHaveCount(0)
  // No thread was created (with a project open, the group headers are the empty
  // surface — the "No threads yet" hint only shows with zero roots).
  await expect(threadRow(window, 'New thread')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('chooser: backdrop-click closes it without creating a thread', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-projA-')
  await seedProject(window, 'flow-ux-projB-')
  await activateProject(window, dirA)

  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  // Click the backdrop well outside the centered panel (top-left of the overlay).
  await window.mouse.click(60, 300)
  await expect(chooser(window)).toHaveCount(0, { timeout: 3000 })
  await expect(threadRow(window, 'New thread')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('chooser: uncheck-all then Start does not create a phantom thread', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-projA-')
  await seedProject(window, 'flow-ux-projB-')
  await activateProject(window, dirA)

  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  const boxes = window.locator('input[type="checkbox"]')
  const n = await boxes.count()
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i)
    if (await box.isChecked()) await box.uncheck()
  }

  await window.getByRole('button', { name: 'Start thread' }).click()
  await window.waitForTimeout(500)
  // splitRoots → no primary → early return: no primary-less thread is created.
  await expect(threadRow(window, 'New thread')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * KNOWN BUG (filed via the QA UX sweep): the multi-project new-thread chooser
 * cannot be dismissed with Escape, unlike every other overlay in the app (the
 * settings/flow overlays, the row-actions menu, etc. all close on Escape).
 * `#promptProjectSelection` wires only a backdrop `mousedown` dismiss — there is
 * no keydown/Escape listener — so a keyboard user's reflexive Escape does
 * nothing and the modal just sits there (Cancel / backdrop-click are the only
 * exits). Same class as the onboarding-wizard Escape dead key (#475).
 *
 * Flip to `test` when a document- or overlay-level Escape handler is added.
 */
test.fixme('chooser: Escape dismisses it like every other overlay', async ({ window }) => {
  const dirA = await seedProject(window, 'flow-ux-projA-')
  await seedProject(window, 'flow-ux-projB-')
  await activateProject(window, dirA)

  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  await window.keyboard.press('Escape')
  await expect(chooser(window)).toHaveCount(0, { timeout: 3000 })
  await expect(threadRow(window, 'New thread')).toHaveCount(0)
})

test('a thread created with BOTH projects checked persists its additionalRoots', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-mrA-')
  await seedProject(window, 'flow-ux-mrB-')
  await activateProject(window, dirA)

  await newThreadBtn(window).click()
  await expect(chooser(window)).toBeVisible({ timeout: 5000 })

  // Check BOTH projects so the thread spans two roots (the active one is
  // preselected; ensure the other is checked too).
  const boxes = window.locator('input[type="checkbox"]')
  await expect(boxes).toHaveCount(2)
  for (let i = 0; i < 2; i++) {
    const box = boxes.nth(i)
    if (!(await box.isChecked())) await box.check()
  }

  await window.getByRole('button', { name: 'Start thread' }).click()
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  await expect(chooser(window)).toHaveCount(0)

  // STORE: the created thread spans two roots — its additionalRoots holds the
  // non-primary project (the multi-root linkage actually persisted, not just UI).
  const additionalRoots = await window.evaluate(async (root) => {
    const api = (window as unknown as {
      flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ title: string; additionalRoots: string[] }>> } }
    }).flow
    const threads = await api.threads.list({ projectRoot: root })
    return (threads.find((t) => t.title === 'New thread') ?? threads[0])?.additionalRoots ?? null
  }, dirA)
  expect(additionalRoots).toHaveLength(1)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
