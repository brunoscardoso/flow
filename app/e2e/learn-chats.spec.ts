import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'
const LIVE_PROJECT = liveRoot()
// COSTS MONEY AND ~40 MINUTES. This drives the real learn+draw+parts pipeline
// against live models, so it is opt-in by an explicit env flag rather than by
// whether a directory happens to exist. It matches `**/*.spec.ts` like every
// other spec, and without this gate a plain `npx playwright test` on a machine
// that has orbit-app would silently start a forty-minute paid run.
//
//   FLOW_LIVE_LEARN=1 npx playwright test e2e/learn-chats.spec.ts
test('learn chats end to end', async ({ window }) => {
  test.skip(process.env['FLOW_LIVE_LEARN'] !== '1', 'opt-in: set FLOW_LIVE_LEARN=1 (spends model time)')
  test.skip(LIVE_PROJECT === '', noLiveProject())
  test.setTimeout(3_600_000)
  await window.setViewportSize({ width: 1700, height: 1050 })
  await window.evaluate(async (p) => {
    await (window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }).flow.project.add({ path: p })
  }, LIVE_PROJECT)
  await activateProject(window, LIVE_PROJECT)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })
  await window.locator('.fb-terr-cell', { hasText: 'Chats' }).first().click()
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 30_000 })
  const learn = window.locator('.fb-brief-learn', { hasText: 'Learn this feature' })
  await expect(learn).toBeVisible()
  await learn.click()
  // WAIT ON THE ARTIFACT, not on the board. The previous version waited for a
  // curated card — which already existed from an earlier run — so it passed in
  // a minute and killed the app partway through the pass. The pipeline's own
  // output is the only honest signal that it finished.
  const FEATURE = `${LIVE_PROJECT}/flow/brain/features/chats.md`
  const learnedParts = (): number => {
    const text = readFileSync(FEATURE, 'utf-8')
    const parts = text.slice(text.indexOf('## Parts'))
    return text.includes('## Parts') ? (parts.match(/^### /gm) ?? []).length : 0
  }
  const deadline = 50 * 60 * 1000
  const started = await window.evaluate(() => performance.now())
  // Done when the parts region stops changing — the pass rewrites it after
  // every part, so a quiet interval means the loop finished rather than that
  // some fixed time elapsed.
  let previous = ''
  let quiet = 0
  for (;;) {
    const region = (() => {
      const text = readFileSync(FEATURE, 'utf-8')
      const at = text.indexOf('## Parts')
      return at === -1 ? '' : text.slice(at)
    })()
    const hasLearnings = region.includes('<!-- learned:')
    quiet = region === previous ? quiet + 1 : 0
    previous = region
    if (hasLearnings && quiet >= 8) break // ~2 minutes unchanged
    const now = await window.evaluate(() => performance.now())
    if (now - started > deadline) break
    await window.waitForTimeout(15_000)
  }
  const md = readFileSync(FEATURE, 'utf-8')
  const region = md.slice(md.indexOf('## Parts'))
  const named = region.match(/^### .+$/gm) ?? []
  const learnings = (region.match(/<!-- learned:/g) ?? []).length
  console.log('CHATS_PARTS:' + JSON.stringify({ parts: named, learnings }))

  // ASSERT THE OUTCOME. Without this the probe reported green after fifty
  // minutes that produced ten named parts and zero learnings — it waited, timed
  // out, logged, and passed. A test with no assertion after its wait is a
  // stopwatch, not a test.
  expect(named.length).toBeGreaterThan(0)
  expect(learnings, 'parts were named but nothing was learned about any of them').toBeGreaterThan(0)
  await window.screenshot({ path: 'e2e/__screens/chats-feature-view.png' })
})
