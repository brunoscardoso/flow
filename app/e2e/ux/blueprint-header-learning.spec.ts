import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * The blueprint header's two standing controls, after the "New Blueprint" CTA
 * was retired.
 *
 * "New Blueprint" promised creation and ran `derive()` — the same call Refresh
 * made (Refresh is built but never appended, so it wasn't even reachable) and
 * the same call the board already makes ITSELF via the one-shot `auto-derive`
 * pane whenever a project has no graph. On the empty board it advertised, in
 * loud primary blue, work that was already running.
 *
 * Its slot now opens the LEARNING panel. That panel had exactly one entry
 * point — the learn chip — which hides itself while `progress.total === 0`,
 * i.e. before anything has been learned. That is precisely when a user asks
 * "is it learning anything?", and there was no way to look.
 *
 * Deliberately independent of the board rendering nodes: these assertions are
 * about the HEADER, which exists on every pane that has a project, so a seeded
 * repo whose graph is still deriving does not make this spec flaky.
 */

test.afterAll(() => cleanupSeeds())

test('the header retires New Blueprint and offers Learning instead', async ({ window }) => {
  const root = await seedProject(window, 'flow-ux-header-learning-')
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()

  // GONE — not merely hidden. A hidden-but-present button would still be a
  // control someone could re-enable by flipping a display rule.
  await expect(
    window.locator('.flow-board-root .fb-header fl-button', { hasText: 'New Blueprint' }),
  ).toHaveCount(0)

  // PRESENT and reachable, with a project open.
  const learning = window
    .locator('.flow-board-root .fb-header fl-button')
    .filter({ hasText: 'Learn' })
  await expect(learning.first()).toBeVisible({ timeout: 30_000 })

  // And it does the one thing it claims: opens the learning panel — including
  // when the learn chip is hidden because nothing has been learned yet.
  await learning.first().click()
  await expect(window.locator('.fb-learn-panel')).toBeVisible({ timeout: 30_000 })

  await window.screenshot({ path: 'e2e/__screens/blueprint-header-learning.png' })
})
