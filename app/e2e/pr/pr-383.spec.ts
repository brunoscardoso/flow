import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Regression for PR #383 — "lock the effort control under Auto model routing (#332)".
 *
 * In Auto mode plan-flow model routing picks the model from the effort tier
 * (`resolveAutoModel()` maps {low,medium,high} → model), but the effort selector
 * stayed user-editable — so the USER, not the routing, was really choosing the
 * tier and the routing "forced" nothing. #383 disables the effort <select> in
 * Auto mode (with a routing tooltip) and omits `effort` from the pushed model
 * selection in Auto, so a manual effort can't drive Auto through the back door.
 * Pinning a concrete model (Opus/Sonnet/Haiku) exposes effort exactly as before.
 *
 * The effort-lock is observable with just a project + a thread (no Claude
 * account needed — `threads:create` needs only a project root), so this drives
 * the real composer and asserts the `disabled` state the fix protects. The pure
 * predicate is unit-tested in `effort-control.test.ts`; this guards the wired-up
 * DOM: Auto → effort locked (tooltip cites routing); a pinned model → effort
 * enabled; switching back to Auto → locked again.
 */
const EFFORT = `${sel.composer} select[aria-label="Effort"]`
const MODEL = `${sel.composer} select[aria-label="Model"]`

// Since 2026-09-04 the selects are hidden behind one model+effort menu: they
// still hold the state (assertions read them), but a person reaches them
// through the menu, so actions go through it.
async function pickModel(win: Page, choice: string): Promise<void> {
  await win.locator(`${sel.composer} .fl-me-trigger`).click()
  await win.locator(`${sel.composer} .fl-me-row`, { hasText: 'Model' }).click()
  await win.locator(`${sel.composer} .fl-me-choice`, { hasText: choice }).first().click()
}

/** Create a thread in `root` with an explicit title via the real IPC bridge. */
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
async function openComposer(win: Page, title = 'Effort-lock probe'): Promise<void> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

test.describe('PR #383 — effort selector locks under Auto model routing (#332)', () => {
  test.afterAll(() => cleanupSeeds())

  test('Auto locks the effort selector; pinning a model unlocks it', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await openComposer(window)
    const effort = window.locator(EFFORT)
    const model = window.locator(MODEL)

    // A fresh thread defaults to Auto → routing owns effort, so it's locked with
    // an explanatory tooltip pointing at model routing (was editable before #383).
    await expect(model).toHaveValue('auto')
    await expect(effort).toBeDisabled()
    await expect(effort).toHaveAttribute('title', /model routing/i)

    // Pin a concrete model → effort becomes the user's to choose again (#147).
    await pickModel(window, 'Opus')
    await expect(model).toHaveValue('opus')
    await expect(effort).toBeEnabled()
    await expect(effort).toHaveAttribute('title', 'Effort')

    // Back to Auto → routing reclaims the tier, effort locks again.
    await pickModel(window, 'Auto')
    await expect(model).toHaveValue('auto')
    await expect(effort).toBeDisabled()
    await expect(effort).toHaveAttribute('title', /model routing/i)

    expect(errors, errors.join(', ')).toHaveLength(0)
  })
})
