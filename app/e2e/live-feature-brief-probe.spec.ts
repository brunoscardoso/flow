// LIVE probe (feature-blueprint): drive the REAL orbit-app project — whose
// flow/brain/features/ holds 19 mined capabilities and 7 change records — and
// prove that CLICKING A FEATURE CARD OPENS ITS BRIEF.
//
// Written because "clicking a feature does nothing" survived two source-level
// fixes. The cause was invisible to unit tests and to a synthetic `.click()`:
// #stage's pan handler took `setPointerCapture` on pointerdown, so pointerup
// and click RETARGETED to the stage and the card's own handler never ran. Only
// a trusted pointer sequence reproduces it, which is what this drives.
//
// Untracked probe — skipped wholesale when orbit-app is absent (CI).
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()

test('live: clicking a feature card opens its brief', async ({ window }) => {
  test.skip(LIVE_PROJECT === '', noLiveProject())
  test.setTimeout(360_000)

  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, LIVE_PROJECT)
  await activateProject(window, LIVE_PROJECT)
  await window.locator(statusButtonByText('Blueprint')).click()

  const cards = window.locator('.fb-terr-cell')
  await expect(cards.first()).toBeVisible({ timeout: 120_000 })

  // Level 1 is capabilities, not work items — the whole point of the board.
  const names = await window.locator('.fb-terr-cell-name').allTextContents()
  expect(names).toContain('Playbooks')
  expect(names).toContain('Chats')

  // A card WITH children is the case that regressed repeatedly: drilling used
  // to eat its click, then the pan handler ate it for every card, and then a
  // stale rebuild fingerprint left the feature list under the brief. Children
  // are reached from the brief's Changes row now — the card has ONE action.
  const parent = window.locator('.fb-terr-cell', { hasText: 'Chats' })
  await expect(parent.first()).toBeVisible()
  const parentName =
    (await parent.first().locator('.fb-terr-cell-name').textContent())?.trim() ?? ''

  await parent.first().click()

  // Assert the OUTCOME: the brief opens, on the feature that was clicked.
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.fb-brief-intro-title')).toHaveText(parentName)

  // Identity is present even when no anchor resolves — that is what stops the
  // drawer reading as "nothing is known about this feature".
  await expect(window.locator('.fb-brief-intro')).toContainText('Changes:')
  await expect(window.locator('.fb-brief-ledger')).toContainText('anchor(s) resolved')
})
