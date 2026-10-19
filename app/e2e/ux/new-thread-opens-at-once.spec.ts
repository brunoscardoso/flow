/**
 * CREATE OPENS THE THREAD, AND THE LOADER STARTS WITH IT.
 *
 * Reported 2026-09-17 against the live app: "when we are creating a new thread
 * we are not selecting the new thread automatic and we are not showing the
 * loader, the loader take some time to apears".
 *
 * What was happening is an ORDER, not a missing feature. `#createThread` did
 * its whole setup first — the skip-permissions write, then `prepareWorktree`,
 * which cuts a git checkout and takes seconds — and only THEN selected the
 * thread and started the first turn. So the row appeared in the list (the
 * create broadcast put it there), unselected, beside an empty column, for the
 * entire length of a git operation. Every visible thing arrived at the end.
 *
 * THIS SPEC IS A CLOCK, and that is the only way to catch it. Every assertion
 * below passes eventually on the old code too — the thread does get selected,
 * the bubble does appear. What was wrong is WHEN. So `prepareWorktree` is held
 * open for `HELD_MS` and the assertions are given a budget well under it: they
 * can only pass if the selection and the echo happen while the checkout is
 * still being cut.
 *
 * Nothing reaches an agent: `threads:sendMessage` is answered here, so the
 * first turn is accepted and never spawns a session.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED, cleanupCheckouts, seedCommittedRepo, settleWorktree } from './fixtures/worktree'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** How long the checkout is held open — the wait a person used to stare at. */
const HELD_MS = 8_000
/**
 * How long the thread may take to be on screen.
 *
 * Generously more than the handful of round trips it costs (create, list, get,
 * history) and decisively less than `HELD_MS`, so this cannot pass by waiting
 * the hold out.
 */
const OPEN_BUDGET_MS = 3_000

const ASK = 'Summarise the export pipeline'

/** The description box on the new-thread page. */
const body = (win: Page) => win.locator('.fl-newthread-body')
/** The branch chip that asks for a worktree of this thread's own. */
const chip = (win: Page) => win.locator('.fl-newbranch-chip')

test('a created thread is open, with its loader running, while its checkout is still being cut', async ({
  window,
  app,
}) => {
  test.setTimeout(180_000)

  const project = await seedCommittedRepo(window, 'flow-newthread-instant-')
  await activateProject(window, project)
  await settleWorktree(window, project)

  // THE SLOW STEP, MADE SLOW ON PURPOSE. A real `git worktree add` on a seeded
  // one-commit repo is fast enough to hide the bug this spec exists for; the
  // machines that reported it were cutting checkouts of real repositories.
  // Replacing the handler is also what keeps the spec off git entirely — what
  // is under test is the ORDER the renderer does things in, not the checkout.
  await app.evaluate(({ ipcMain }, held: number) => {
    const marks = globalThis as unknown as { __flowHeld?: { asked: number; answered: number } }
    marks.__flowHeld = { asked: 0, answered: 0 }
    ipcMain.removeHandler('threads:prepareWorktree')
    ipcMain.handle('threads:prepareWorktree', async () => {
      marks.__flowHeld!.asked += 1
      await new Promise((resolve) => setTimeout(resolve, held))
      marks.__flowHeld!.answered += 1
      return { status: 'ready', detail: 'held open by the test' }
    })
    // The first turn is ACCEPTED and goes nowhere — the echo under test is the
    // renderer's own, and a real session would only add noise and an account.
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', () => ({ ok: true }))
  }, HELD_MS)

  await window.locator('fl-button[aria-label="New thread"]').click()
  await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 20_000 })
  await body(window).fill(ASK)

  // ASK FOR A WORKTREE OF ITS OWN — the switch is what makes `prepareWorktree`
  // run at all, and therefore what made Create slow.
  await chip(window).click()
  const menu = window.locator('.fl-fmenu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-wt-track').click()
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  const startedAt = Date.now()
  await window.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()

  // 1. THE CONVERSATION IS ON SCREEN. The page is hidden, not removed — its
  //    column is swapped back — so this reads hidden rather than a count.
  await expect(window.locator('.fl-newthread')).toBeHidden({ timeout: OPEN_BUDGET_MS })

  // 2. THE MESSAGE IS THERE, echoed rather than waited for.
  // The body, not the bubble: the bubble carries its "You" attribution too.
  await expect(window.locator('.fl-conv-user-body')).toHaveText(ASK, { timeout: OPEN_BUDGET_MS })

  // 3. AND THE LOADER IS RUNNING — the half the report named. `hidden` is a
  //    property, not a class, so this asserts the element is actually visible.
  await expect(window.locator('.fl-conv-activity')).toBeVisible({ timeout: OPEN_BUDGET_MS })

  // 4. The row is the OPEN one, not merely present. `.fl-row-current` is the
  //    decoration <fl-list> paints on the active row; a created-but-unselected
  //    thread has a row with no mark at all.
  await expect(window.locator('fl-list .fl-row-current')).toHaveCount(1, {
    timeout: OPEN_BUDGET_MS,
  })

  const elapsed = Date.now() - startedAt

  // THE POSITIVE, BEFORE THE CLOCK (allowed-pattern #28). Four assertions about
  // things happening early prove nothing if the slow step never ran — a chip
  // that quietly failed to ask for a worktree would sail through all of them.
  // So: the checkout WAS asked for, and it had NOT come back.
  const held = await app.evaluate(
    () => (globalThis as unknown as { __flowHeld: { asked: number; answered: number } }).__flowHeld,
  )
  expect(held.asked, 'no worktree was ever asked for — the switch did not take').toBe(1)
  expect(held.answered, 'the checkout had already finished, so this proved nothing').toBe(0)

  // …and the whole of it landed inside the hold.
  expect(elapsed, 'the thread only opened once the checkout was done').toBeLessThan(HELD_MS)
})
