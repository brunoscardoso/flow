// LIVE probe (feature-view #3): drive the REAL orbit-app project and prove
// that opening Chat Session Cache Rework draws the CURATED VIEW — components with
// human titles and connections that carry their label on the canvas — rather
// than the anchor subgraph of directories.
//
// The anchor subgraph is what the user saw and rejected ("this is not even
// similar to the html that I shared"). It cannot be unit-tested away: the
// artifact is generated, the board reads it over IPC, and the failure is
// visual. So this drives the real board against the real generated view and
// asserts the two things that make it a different artifact — human titles and
// LABELLED wires.
//
// Untracked probe — skipped wholesale when orbit-app is absent (CI).
import { existsSync } from 'node:fs'
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()
const VIEW = `${LIVE_PROJECT}/flow/brain/.structure/feature-views/chat-session-cache-rework.json`

test('live: a generated view draws curated components and labelled wires', async ({ window }) => {
  test.skip(LIVE_PROJECT === '', noLiveProject())
  // A MISSING ARTIFACT IS A FAILURE, not a skip. The probe exists to prove the
  // board draws a generated view; skipping when there is none to draw turns
  // "the pipeline stopped writing views" into a green run.
  expect(existsSync(VIEW), `no generated view at ${VIEW} — run the pipeline first`).toBe(true)
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

  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })

  // Reach the change record through the feature that owns it — the same path a
  // reader takes, not a direct call into the board.
  await window.locator('.fb-terr-cell', { hasText: 'Chats' }).first().click()
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })
  await window.locator('.fb-brief-change', { hasText: 'Chat Session Cache Rework' }).first().click()

  // THE CURATED STAGE. Its presence is the whole assertion: the anchor subgraph
  // renders `.fb-node` cards, this renders `.fb-curated-card`.
  const cards = window.locator('.fb-curated-card')
  await expect(cards.first()).toBeVisible({ timeout: 60_000 })
  expect(await cards.count()).toBeGreaterThanOrEqual(4)

  // Human titles, never directory paths — the difference the user named, whose
  // symptom was cards reading `sdk/chat`, `api/chat`, `/spaces/chats`. The test
  // is for a BARE PATH, not for any slash: "Apollo/Pothos GraphQL" is prose.
  const titles = await window.locator('.fb-curated-title').allTextContents()
  const looksLikeAPath = /^\/?[a-z0-9_.\-[\]]+\/[a-z0-9_./\-[\]*]+$/
  for (const title of titles) expect(title.trim()).not.toMatch(looksLikeAPath)
  // And they are short enough to read on a card.
  for (const title of titles) expect(title.trim().split(/\s+/).length).toBeLessThanOrEqual(6)

  // EVERY wire carries its label ON THE CANVAS. A diagram of unlabelled arrows
  // between four boxes explains nothing the four titles did not already say.
  const labels = await window.locator('.fb-curated-wire-label').allTextContents()
  expect(labels.length).toBeGreaterThanOrEqual(4)
  for (const label of labels) expect(label.trim().length).toBeGreaterThan(0)

  // THE CHROME comes from the artifact: its title, its kicker, and a band that
  // exists only because the artifact wrote one.
  const bar = window.locator('.fb-brief-bar')
  await expect(bar.locator('.fb-brief-intro-title')).toHaveText('Chat Session Cache Rework')
  await expect(bar.locator('.fb-curated-kicker')).toContainText('Level 0')
  await expect(bar.locator('.fb-curated-band-problem')).toContainText('Known issue')
  await expect(bar.locator('.fb-brief-slot').first()).toBeVisible()

  // ONE ROW OF CHIPS, no competing statistics. The learnings moved out of a
  // bare "Show N more" link and into the chip row; the facts line is gone,
  // because every number in it was either a visible card or another chip.
  await expect(bar.locator('.fb-brief-slot', { hasText: 'What we learned' })).toBeVisible()
  await expect(bar.locator('.fb-brief-more')).toHaveCount(0)
  await expect(bar.locator('.fb-brief-counts')).toHaveCount(0)
  await expect(bar.locator('.fb-brief-ledger')).toHaveCount(0)
  await window.screenshot({ path: 'e2e/__screens/curated-view-live.png', fullPage: false })

  // TWO WORLDS. The artifact names components that change and wires that
  // retire, so the switch is offered and flipping it repaints rather than
  // re-lays-out: every card holds its exact position.
  const before = await cards.first().boundingBox()
  await window.locator('.fb-brief-switch button', { hasText: 'After' }).click()
  await expect(window.locator('.fb-curated-band-guarantee')).toContainText('Unchanged')
  const after = await window.locator('.fb-curated-card').first().boundingBox()
  expect(after?.x).toBe(before?.x)
  expect(after?.y).toBe(before?.y)
  await window.screenshot({ path: 'e2e/__screens/curated-view-after.png', fullPage: false })
  await window.locator('.fb-brief-switch button', { hasText: 'Today' }).click()

  // THE PHASE LADDER. Selecting a rung lights what that phase touches and DIMS
  // the rest — it never filters, because the layout must not move and "this
  // phase leaves it alone" is half the answer.
  const rungs = window.locator('.fb-curated-rung')
  await expect(rungs.first()).toHaveText(/All phases/)
  expect(await rungs.count()).toBeGreaterThan(1)

  const total = await cards.count()
  await rungs.nth(1).click()
  await expect(window.locator('.fb-curated-card.fb-curated-dim').first()).toBeVisible()
  expect(await window.locator('.fb-curated-card').count()).toBe(total) // dimmed, not removed

  // Clicking the selected rung clears it — the way out is the way in.
  await rungs.nth(1).click()
  await expect(window.locator('.fb-curated-card.fb-curated-dim')).toHaveCount(0)
  await window.screenshot({ path: 'e2e/__screens/curated-view-phase.png', fullPage: false })

  // RESIZE. The board's `#relayout` positions cards from the DERIVED map and
  // hides any card that map does not contain — which is every curated card,
  // since a component is named `bff` rather than `module:src/app/api/chat`. It
  // is ResizeObserver-driven, so a fixed-size probe never fired it and the
  // first real window resize set `display: none` on all ten cards, leaving
  // labelled wires floating over an empty grid.
  await window.setViewportSize({ width: 1600, height: 1000 })
  await window.waitForTimeout(1200)
  expect(await window.locator('.fb-curated-card').count()).toBe(total)
  const shown = await window.locator('.fb-curated-card').first().boundingBox()
  expect(shown?.width ?? 0).toBeGreaterThan(0)
  await window.screenshot({ path: 'e2e/__screens/curated-view-wide.png', fullPage: false })

  // DRAG THE BACKGROUND to move around. The stage's own pan handler is inert
  // here (it returns early unless the code map is open), so this stage had
  // scrollbars and nothing else — which on a picture wider than its pane reads
  // as stuck.
  const scroll = window.locator('.fb-curated-scroll')
  const box = await scroll.boundingBox()
  const startLeft = await scroll.evaluate((el) => el.scrollLeft)
  await window.mouse.move((box?.x ?? 0) + 60, (box?.y ?? 0) + (box?.height ?? 200) - 40)
  await window.mouse.down()
  await window.mouse.move((box?.x ?? 0) - 240, (box?.y ?? 0) + (box?.height ?? 200) - 40, { steps: 12 })
  await window.mouse.up()
  expect(await scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(startLeft)

  // BACK / FORWARD in the board header, not the brief bar. Back walks ONE
  // destination — to the Chats brief this change record was opened from, not
  // all the way out to the feature board.
  const back = window.locator('.fb-nav-btn[aria-label="Back"]')
  const forward = window.locator('.fb-nav-btn[aria-label="Forward"]')
  await back.click()
  await expect(window.locator('.fb-brief-intro-title')).toHaveText('Chats', { timeout: 30_000 })
  await forward.click()
  await expect(window.locator('.fb-brief-intro-title')).toHaveText('Chat Session Cache Rework', {
    timeout: 30_000,
  })
  await expect(window.locator('.fb-curated-card').first()).toBeVisible({ timeout: 30_000 })

  // A second Back reaches the feature board, and Forward is still live there.
  await back.click()
  await back.click()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 30_000 })
  await expect(forward).toBeEnabled()

  // Walk forward to where we were — the rest of this probe reads the diagram.
  await forward.click()
  await forward.click()
  await expect(window.locator('.fb-curated-card').first()).toBeVisible({ timeout: 30_000 })

  // Clicking a component opens its drawer with the artifact's own prose.
  await cards.first().click()
  const drawer = window.locator('.fb-brief-drawer')
  await expect(drawer).toBeVisible({ timeout: 15_000 })
  await expect(drawer).toContainText('What it is')

  // A code excerpt states the file and the exact lines it was read from —
  // that provenance is what lets a reader check it instead of trusting the box.
  // NOT CONDITIONAL. Every component of this view carries a code excerpt, and
  // a block that quietly skips when it finds none is a pass that proves
  // nothing — the failure mode this whole surface exists to avoid.
  const provenance = drawer.locator('.fb-curated-code-src')
  await expect(provenance.first()).toContainText(/:\d+-\d+$/)
  await expect(drawer.locator('.fb-curated-code').first()).not.toBeEmpty()

  // Learn stays reachable — the drawer REPLACES the popover on this stage, so
  // it must not quietly drop what the popover was reachable for.
  await expect(drawer.locator('.fb-brief-drawer-actions')).toContainText('Learn this feature')

  // OPENING THE CODE takes over pane 2 — and leaves a ‹ that brings the drawer
  // back exactly as it was. Both actions live INSIDE the drawer, so without
  // this the reader presses a button in a panel and that panel is what
  // disappears, with no way back to it.
  // Also unconditional: an excerpt implies an openable source file.
  const openCode = drawer.locator('.fb-brief-learn', { hasText: 'Open the code' })
  await expect(openCode).toBeVisible()
  {
    const heading = (await drawer.locator('h2').first().textContent())?.trim() ?? ''
    await openCode.click()
    await expect(window.locator('.fb-peek-drawer')).toBeVisible({ timeout: 20_000 })
    const paneBack = window.locator('.fb-peek-drawer .fb-pane-back')
    await expect(paneBack).toBeVisible()
    await paneBack.click()
    await expect(window.locator('.fb-brief-drawer')).toBeVisible({ timeout: 15_000 })
    await expect(window.locator('.fb-brief-drawer h2').first()).toHaveText(heading)
  }
  await window.screenshot({ path: 'e2e/__screens/curated-view-drawer.png', fullPage: false })
})
