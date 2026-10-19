// LIVE probe (feature-blueprint): the SETTLED stage never shows the feature
// board under an open brief.
//
// Reported twice ("inside of chat has everything again"). The damaging surface
// is #renderFeatureBoard, and it now refuses to paint while a brief is open —
// guarding the point of damage rather than the caller I happened to reason
// about. Measures the settled state after each step: transient states inside a
// single render task are not user-visible and are not what broke.
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()

// The leak reproduced only via the DRILLED feature-board state — open a
// parent's children as cards, then open one. That state no longer exists: a
// card has exactly one action (open its brief) and children are reached from
// the brief's Changes row, so there is no second board to leave underneath a
// brief. The earlier fixes (scope set before paint, the #renderFeatureBoard
// guard, atomic bar+stage) all stand; removing the mode removed the last way
// in.
test('live: the feature board never sits under an open brief', async ({ window }) => {
  test.skip(LIVE_PROJECT === '', noLiveProject())
  test.setTimeout(420_000)

  await window.evaluate(async (p) => {
    await (window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } })
      .flow.project.add({ path: p })
  }, LIVE_PROJECT)
  await activateProject(window, LIVE_PROJECT)
  await window.locator(statusButtonByText('Blueprint')).click()

  const board = window.locator('.fb-terr-cell')
  await expect(board.first()).toBeVisible({ timeout: 120_000 })

  const settled = async (label: string): Promise<{ bar: number; feat: number }> => {
    await window.waitForTimeout(6000)
    const state = await window.evaluate(() => ({
      bar: document.querySelectorAll('.fb-brief-bar').length,
      feat: document.querySelectorAll('.fb-terr-cell').length,
    }))
    expect(state.bar > 0 && state.feat > 0, `${label}: feature board under an open brief`).toBe(false)
    return state
  }

  // Level-1 feature, then back — twice, since the leak needed a round trip.
  await board.filter({ hasText: 'Chats' }).first().click()
  expect((await settled('open Chats')).bar).toBe(1)
  await window.locator('.fb-brief-exit').click()
  await settled('back from Chats')

  await board.filter({ hasText: 'Home' }).first().click()
  expect((await settled('open Home')).bar).toBe(1)
  await window.locator('.fb-brief-exit').click()
  await settled('back from Home')

  // The child path — where it reproduced. Children are now reached from the
  // brief's Changes row, not a drill chip: the card has one meaning.
  await board.filter({ hasText: 'Chats' }).first().click()
  await settled('open Chats again')
  await window.locator('.fb-brief-change').first().click()
  const child = await settled('open a drilled child')
  expect(child.bar).toBe(1)
  expect(child.feat).toBe(0)

  // A file-anchored change record is learnable: its anchors reach modules via
  // their parent directories, which is what made this the one feature with the
  // most known about it and no Learn button.
  await expect(window.locator('.fb-brief-intro-title')).toHaveText('Chat Session Cache Rework')
  await expect(window.locator('.fb-brief-learn')).toContainText('Learn this feature')
})
