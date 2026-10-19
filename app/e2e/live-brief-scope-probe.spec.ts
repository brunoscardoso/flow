// LIVE probe (feature-blueprint): clicking a feature must open ITS BRIEF —
// not the code map.
//
// Reported behaviour: "when I click on the feature, it's opening the code
// graph, I didn't ask for that". The cause was structural, not a stray call:
// #render had only two modes (feature board | full code map), so
// #openFeatureBrief set `codeMapOpen = true` to get any nodes on the stage for
// the brief to decorate. Once anchors actually resolved, that stage stopped
// being empty and the whole 330-directory import graph appeared.
//
// Runs against the real orbit-app; skipped wholesale when absent (CI).
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()

test('live: clicking a feature opens its brief, NOT the code map', async ({ window }) => {
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
  const featureCount = await cards.count()

  // Pick a feature whose anchors resolve, so there IS structure to draw —
  // that is the case that regressed into showing the whole map.
  const target = window.locator('.fb-terr-cell', { hasText: 'Chats' }).first()
  await expect(target).toBeVisible()
  const name = (await target.locator('.fb-terr-cell-name').textContent())?.trim() ?? ''

  await target.click()

  // The brief opened, on the feature that was clicked.
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.fb-brief-intro-title')).toHaveText(name)

  // THE ASSERTION THAT MATTERS: the code map did not open behind it.
  const codeMapLabel = await window.locator('.fb-codemap-label, [data-fb="codemap-label"]').first().textContent().catch(() => null)
  if (codeMapLabel !== null) expect(codeMapLabel).not.toContain('Hide code map')

  // The stage is SCOPED — a handful of components, not the whole repository.
  // orbit-app derives 367 module nodes; Chats claims 5 anchors.
  const stageCards = window.locator('.fb-node')
  const drawn = await stageCards.count()
  expect(drawn).toBeGreaterThan(0)
  expect(drawn).toBeLessThan(40)
  // Sanity: the feature board itself had ~19 cards, so "scoped" is not just
  // "the feature board again".
  expect(featureCount).toBeGreaterThan(10)

  // THE CONTROL, not just the key. A keyboard-only exit is not a way back —
  // and this button used to clear the decoration WITHOUT clearing the scope,
  // leaving a scoped stage with no bar and no exit at all.
  const back = window.locator('.fb-brief-exit')
  await expect(back).toBeVisible()
  await expect(back).toHaveText('← All features')
  await back.click()
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fb-brief-bar')).toBeHidden()
  expect(await cards.count()).toBe(featureCount)

  // …and Escape does the same, from a second open.
  await target.click()
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press('Escape')
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })

  // Reopening after a round trip still works — state is not left half-torn.
  await target.click()
  await expect(window.locator('.fb-brief-intro-title')).toHaveText(name, { timeout: 30_000 })
})
