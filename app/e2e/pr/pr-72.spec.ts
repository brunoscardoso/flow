import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'

/**
 * Regression for PR #72 — "board reads graph from either location — fixes derive
 * after cull". The Blueprint board must open and render its view chrome without
 * throwing on the graph read. Example of the per-PR spec the QA heartbeat
 * generates (see flow/pr-verify-runbook.md); happy-path since #72 was a fix.
 */
test.describe('PR #72 — blueprint board graph read', () => {
  test('Blueprint opens and renders its view without erroring', async ({ app }) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await dismissOnboarding(window)

    await window.locator(statusButtonByText('Blueprint')).click()

    const root = window.locator(sel.blueprintRoot)
    await expect(root).toBeVisible()
    // Header chrome renders, i.e. the view mounted successfully rather than
    // leaving an empty root behind. `.bpv-title` belonged to the retired
    // BlueprintView (#1814); the live board's header is appended
    // unconditionally in its constructor (blueprint-board.ts:1258/1421).
    await expect(root.locator(sel.blueprintHeader)).toBeVisible()
    // Renderer stayed alive (a graph-read throw would blank the shell).
    await expect(window.locator(sel.shell)).toBeVisible()
  })
})
