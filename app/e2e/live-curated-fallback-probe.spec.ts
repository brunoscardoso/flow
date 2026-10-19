// LIVE probe (feature-view #7.2): a feature with NO generated view must still
// render exactly what it rendered before — the derived subgraph of whatever its
// anchors resolve to.
//
// This is the guarantee that makes the curated view safe to ship half-adopted.
// One feature in a project will have an artifact and thirty will not, and the
// thirty must not degrade: the curated stage is an ADDITION, not a replacement
// for the only picture most features will ever have.
//
// Untracked probe — skipped wholesale when orbit-app is absent (CI).
import { existsSync, readdirSync } from 'node:fs'
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()
const VIEWS = `${LIVE_PROJECT}/flow/brain/.structure/feature-views`

test('live: a feature with no generated view keeps the derived subgraph', async ({ window }) => {
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
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })

  // Pick a feature that genuinely has no view RIGHT NOW. Naming one was wrong:
  // views get generated as the project is used, so a hardcoded choice quietly
  // becomes a feature that does have one, and the probe fails on drift rather
  // than on a regression.
  const drawn = new Set(
    (existsSync(VIEWS) ? readdirSync(VIEWS) : [])
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/(\.prev)?\.json$/, '')),
  )
  const slug = (name: string): string =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const names = await window.locator('.fb-terr-cell-name').allTextContents()
  const undrawn = names.map((n) => n.trim()).find((n) => n.length > 0 && !drawn.has(slug(n)))
  // A legitimate skip — the guarantee is about features WITHOUT a view, and a
  // project where every feature has one cannot exercise it. Named, so a
  // skipped run is never mistaken for a proven one.
  if (undrawn === undefined) {
    // eslint-disable-next-line no-console
    console.log(`SKIP: all ${String(names.length)} features on this board already have a view`)
  }
  test.skip(undrawn === undefined, 'every feature on this board has a generated view')

  await window.locator('.fb-terr-cell', { hasText: undrawn as string }).first().click()
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })

  // THE OLD STAGE, unchanged: derived nodes, and none of the curated chrome.
  await expect(window.locator('.fb-curated-card')).toHaveCount(0)
  await expect(window.locator('.fb-curated-kicker')).toHaveCount(0)
  await expect(window.locator('.fb-curated-band')).toHaveCount(0)

  // The brief still says who it is about and what it can prove — that payload
  // never depended on a generated view.
  await expect(window.locator('.fb-brief-intro-title')).toHaveText(undrawn as string)
  await expect(window.locator('.fb-brief-ledger')).toContainText('anchor(s) resolved')

  // LEARNINGS ARE BEHIND A CHIP, never a bullet list in the header. They were
  // five paragraphs above a diagram nobody could see yet, and a duplicate of
  // the chip a row below.
  // Only the ABSENCE is asserted: the feature picked here is whichever one has
  // no view yet, and it may have nothing learned either — a chip that depends
  // on the data would fail on drift rather than on a regression.
  await expect(window.locator('.fb-brief-learnings')).toHaveCount(0)
  await expect(window.locator('.fb-brief-more')).toHaveCount(0)

  // NO "Generate view" BUTTON. Drawing a feature is part of finishing its plan
  // — /execute-plan writes the view at archive time.
  await expect(window.locator('.fb-brief-learn', { hasText: 'Generate view' })).toHaveCount(0)
})
