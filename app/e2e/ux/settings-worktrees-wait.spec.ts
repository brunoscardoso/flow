import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * The wait behind the Flow-settings door onto what a project holds on disk
 * (2026-08-26, rewritten 2026-09-11).
 *
 * Reported as "its taking long to show, and there is no loader". The surface
 * used to MOUNT and then read: an empty modal sat on screen for the length of
 * a `git status` plus a disk measurement per conversation — seconds on a
 * project holding several — and the button gave no sign it had been pressed.
 *
 * Two things are pinned here, and they are the two halves of the request:
 * the press is answered at once, and nothing is put on screen until there is
 * something to show.
 *
 * WHAT CHANGED, AND WHAT DID NOT. The ledger dialog this guarded is gone; the
 * Storage page replaced it, and it answers the press differently — not by
 * marking the button busy while an empty dialog waits, but by walking to a page
 * that is ON SCREEN, titled, and leaveable from the first frame, with the list
 * filling in when the read lands. That is the same promise kept a better way,
 * so the spec is rewritten rather than removed: a spec deleted with the surface
 * it guarded proves nothing about the surface that replaced it.
 *
 * THE READ IS HELD OPEN ON PURPOSE. On a one-conversation seed the inventory
 * returns far too fast for a waiting state to be observable, so a spec that
 * just clicked and looked would pass whether or not the page existed. Slowing
 * the channel is what makes the assertion mean anything.
 *
 * AND IT IS SLOWED IN MAIN, NOT IN THE RENDERER. `window.flow` is a
 * contextBridge proxy: assigning over `flow.threads.worktreeInventory` looks
 * like it works and silently does nothing, which is how this spec spent a while
 * asserting a race instead of a wait. Re-registering the channel's handler in
 * the main process holds the read for real, and keeps the whole renderer path —
 * button, preload, IPC, paint — genuinely exercised.
 */
const OPEN_FLOW_SETTINGS = 'flow:open-flow-settings'
const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

/** The Flow-settings row that is the one door onto this. */
const storageRow = (win: Page) =>
  win.locator('.fl-fs-row', { hasText: 'Files kept for conversations' })

test.afterAll(() => cleanupSeeds())

/** How long the inventory read is held open, in ms. */
const HELD_MS = 2500

test('Open answers at once, and the list arrives only when it is ready', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window, 'wait-probe-')
  await activateProject(window, root)

  await app.evaluate(({ ipcMain }, held) => {
    ipcMain.removeHandler('threads:worktreeInventory')
    ipcMain.handle('threads:worktreeInventory', (_event, request: { rootPath: string }) => {
      const entry = {
        threadId: 'held-1',
        threadTitle: 'A conversation whose files took a while to count',
        branch: 'thread/held',
        base: 'main',
        landed: true,
        changedFiles: 0,
        aheadCommits: 0,
        lastActiveAt: Date.now(),
        diskKb: 2048,
        onBase: false,
        busy: false,
        archived: false,
        drift: 'none',
        remote: null,
        remoteBranch: null,
        prBase: null,
        previouslyPushedAs: null,
        baseMayBeBehind: false,
      }
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              rootPath: request.rootPath,
              usage: { total: 1, cap: 10, unlanded: 0, atCap: false },
              entries: [entry],
              unreadable: false,
            }),
          held,
        ),
      )
    })
  }, HELD_MS)

  await window.evaluate(
    ([evt, path]) =>
      document.dispatchEvent(new CustomEvent(evt, { detail: { rootPath: path } })),
    [OPEN_FLOW_SETTINGS, root] as const,
  )
  await expect(window.locator(FLOW_OVERLAY)).toHaveCount(1)

  const openBtn = storageRow(window).locator('button')
  await expect(openBtn).toBeVisible({ timeout: 10000 })
  await openBtn.click()

  const page = window.locator('.fl-storage')
  const summary = window.locator('.fl-storage-head')
  const rows = window.locator('.fl-storage-row')

  // MID-READ. The press is answered: the page is on screen, it says what it
  // is, and the way back out of it works before the read has landed — which is
  // what somebody who pressed by accident wants.
  await expect(page).toBeVisible()
  await expect(page.locator('.fl-settings-heading')).toHaveText('Files kept for conversations')
  await expect(page.locator('.fl-storage-back')).toBeEnabled()
  // …and the second half of the ask: nothing that claims to be the answer is
  // on screen yet. (Non-vacuous: both locators are asserted PRESENT below, so
  // they really do match this page's summary and its rows.)
  await expect(summary).toHaveCount(0)
  await expect(rows).toHaveCount(0)
  await page.screenshot({ path: 'e2e/ux/__screens/btn-wait.png' })

  // AFTER.
  await expect(summary).toBeVisible({ timeout: 15000 })
  await expect(summary.locator('.fl-storage-count')).toHaveText('1 of 10 · 2 MB')
  await expect(rows).toHaveCount(1)

  // …and walking back leaves the door exactly as it was — no control stuck
  // reporting work that finished.
  await page.locator('.fl-storage-back').click()
  await expect(page).toHaveCount(0)
  await expect(storageRow(window).locator('button')).toBeEnabled()

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})
