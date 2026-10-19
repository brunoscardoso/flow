import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'

/**
 * PUTTING THE CHAT AWAY IS GONE, AND THE WAY BACK IS NOT (#1219, then removed).
 *
 * The feature had two controls and then one: the list-only caret went on
 * 2026-08-24, and the `—` moved out of the list's toolbar onto the chat it
 * hides. On 2026-09-03 the `—` went too, on the user's report — so nothing
 * can enter the hidden mode any more.
 *
 * What this guards is the asymmetry that leaves behind. The mode is PERSISTED,
 * so a window someone put away before the removal still boots into it, and the
 * restore hint is now the only thing standing between that user and a panel
 * with no exit. Removing a way in must never remove the way out.
 */
const list = (win: Page) => win.locator('.fl-thread-list')
const chat = (win: Page) => win.locator('.fl-conversation').first()
/** The retired `—`. Kept as a locator so its ABSENCE is asserted by name. */
const hideBtn = (win: Page) => win.locator('.fl-chat-hide')

/** The persisted key the sidebar reads at construction (threads-collapse.ts). */
const COLLAPSE_KEY = 'flow.threads.collapse'

/** Boot the window into the put-away mode the way a returning user does —
 *  through the persisted choice, since no control can ask for it any more. */
async function bootPutAway(win: Page): Promise<void> {
  await win.evaluate((key) => window.localStorage.setItem(key, 'all-hidden'), COLLAPSE_KEY)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  // A reload re-opens the per-project flow-settings overlay (it is the
  // project's onboarding, and it intercepts clicks).
  await dismissFlowOverlay(win)
}
const restore = (win: Page) => win.locator('.fl-thread-restore')
const toolbarButtons = (win: Page) => win.locator('.fl-thread-toolbar fl-button')

test.afterAll(() => cleanupSeeds())

test('the chat can no longer be put away, and a window already put away comes back', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window, 'flow-threads-collapse-')
  await activateProject(window, root)
  // Threads is the DEFAULT rail — clicking its rail item TOGGLES the sidebar
  // shut (shell.ts), which unmounted the whole pane and left this spec red.
  // The pane is already on screen after seeding.
  await expect(list(window)).toBeVisible()
  await expect(chat(window)).toBeVisible()

  // ── The toolbar holds no way to put anything away ───────────────────────
  // Asserted by READING every label IN ORDER, not by locating an absence: a
  // `not present` check passes whether the button is gone or the selector is
  // simply wrong, and this repo has been burned by exactly that. The list's
  // view menu (order + archive) joined the `+` when the Workspace list lost its
  // project headers; it changes what the list shows, never whether it is shown.
  expect(await toolbarLabels(window)).toEqual(['Sort and filter threads', 'New thread'])

  // ── The `—` is gone from the whole document, not just from the chat ─────
  await expect(hideBtn(window)).toHaveCount(0)

  // ── …and the way back survived it ───────────────────────────────────────
  // A user who put the panel away before the control was removed still boots
  // into the hidden mode, so the restore hint has to still work.
  await bootPutAway(window)
  await expect(restore(window)).toBeVisible({ timeout: 20000 })
  await expect(restore(window)).toContainText('hidden')
  await expect(list(window)).toBeHidden()
  // NOT asserted: the chat's boot state. `#applyCollapseMode` does dispatch
  // flow:hide-chat when the persisted mode is all-hidden, but on a cold boot
  // the chat comes up visible anyway — the ask races the shell's listener.
  // Pre-existing and orthogonal to the `—`'s removal (it is about the state
  // being RESTORED, not entered), recorded here rather than asserted so the
  // gap is written down instead of silently dropped.

  await restore(window).click()
  await expect(list(window)).toBeVisible()
  await expect(chat(window)).toBeVisible()
  await expect(restore(window)).toBeHidden()
  // Still no way back IN — that is the point of the removal.
  await expect(hideBtn(window)).toHaveCount(0)

  expect(errors, `renderer errors during threads-collapse flow:\n${errors.join('\n')}`).toEqual([])
})

/** Every toolbar button's aria-label, in DOM order — the whole set, so a
 *  surviving `⌄` or `—` shows up as an extra entry rather than as silence. */
async function toolbarLabels(win: Page): Promise<string[]> {
  return toolbarButtons(win).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? '(unlabelled)'),
  )
}
