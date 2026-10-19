// LIVE probe: THE COLD START — a project the IDE has never seen.
//
// Every other live probe drives an already-provisioned root (orbit-app,
// plan-flow), so they all assume the state whose creation is the risky part.
// This one starts from a repo with no `.claude/` and no `flow/` and asserts the
// chain a real user walks on day one:
//
//   add the project → provisioning → derive → feature bootstrap → the BOARD
//   SHOWS FEATURES → learn one from code → the curated view is GENERATED
//
// The first half is free and deterministic (no model): it proves the board is
// populated on day one rather than showing an empty state that tells the user to
// go run a CLI verb. The second half spends model time and is gated behind
// FLOW_LIVE_LEARN, matching learn-chats.spec.ts.
//
//   FLOW_COLD_ROOT=/path/to/virgin/clone npx playwright test e2e/live-cold-start-probe.spec.ts
//   FLOW_COLD_ROOT=... FLOW_LIVE_LEARN=1 npx playwright test e2e/live-cold-start-probe.spec.ts
//
// USE A CLONE, NEVER A REAL WORKING REPO. Adding a root PROVISIONS it — the
// probe writes `.claude/` and `flow/` into whatever path it is given.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { activateProject } from './ux/fixtures/seed'

const ROOT = process.env['FLOW_COLD_ROOT'] ?? ''

/** Feature markdown files the bootstrap wrote, if any. */
function featureFiles(root: string): string[] {
  const dir = join(root, 'flow', 'brain', 'features')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
}

/** Generated curated-view artifacts, if any. */
function viewFiles(root: string): string[] {
  const dir = join(root, 'flow', 'brain', '.structure', 'feature-views')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
}

test('cold start: a brand-new project lands on a populated feature board', async ({ window }) => {
  test.skip(ROOT === '' || !existsSync(ROOT), 'set FLOW_COLD_ROOT to a virgin clone')
  test.setTimeout(600_000)
  await window.setViewportSize({ width: 1700, height: 1050 })

  // THE USER'S ACTION. addRoot is the same IPC the "Add project" button calls,
  // so provisioning and the first derive run exactly as they would for a human.
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, ROOT)
  await activateProject(window, ROOT)
  await window.locator(statusButtonByText('Blueprint')).click()

  // THE ASSERTION THAT MATTERS. A card means provisioning, derive and the lazy
  // feature bootstrap all completed for a repo that had none of them a minute
  // ago. An empty board here is the exact failure this probe exists to catch,
  // and it is invisible to every unit test because it needs the real chain.
  const cards = window.locator('.fb-terr-cell')
  await expect(cards.first()).toBeVisible({ timeout: 300_000 })
  const names = await window.locator('.fb-terr-cell-name').allTextContents()
  expect(names.length).toBeGreaterThan(0)

  // The board and the store agree — a card rendered from nothing on disk would
  // be a lie the user cannot see through.
  expect(featureFiles(ROOT).length).toBeGreaterThan(0)
  console.log('COLD_START:' + JSON.stringify({ cards: names.length, names, files: featureFiles(ROOT) }))

  await window.screenshot({ path: 'e2e/__screens/cold-start-board.png' })
})

test('cold start: learning a feature generates its curated view', async ({ window }) => {
  test.skip(ROOT === '' || !existsSync(ROOT), 'set FLOW_COLD_ROOT to a virgin clone')
  test.skip(
    process.env['FLOW_LIVE_LEARN'] !== '1',
    'opt-in: set FLOW_LIVE_LEARN=1 (spends model time)',
  )
  test.setTimeout(3_600_000)
  await window.setViewportSize({ width: 1700, height: 1050 })

  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, ROOT)
  await activateProject(window, ROOT)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 300_000 })

  const viewsBefore = viewFiles(ROOT).length
  await window.locator('.fb-terr-cell').first().click()
  await expect(window.locator('.fb-brief-bar')).toBeVisible({ timeout: 60_000 })
  const learn = window.locator('.fb-brief-learn', { hasText: 'Learn this feature' })
  await expect(learn).toBeVisible()
  await learn.click()

  // WAIT ON THE ARTIFACTS, not on the board — a board element can predate this
  // run, an artifact written during it cannot. Done when the feature markdown
  // carries a learned marker AND a curated view exists that did not before.
  const deadline = 50 * 60 * 1000
  const started = await window.evaluate(() => performance.now())
  let learned = false
  let drew = false
  for (;;) {
    const files = featureFiles(ROOT)
    learned = files.some((f) => {
      const text = readFileSync(join(ROOT, 'flow', 'brain', 'features', f), 'utf-8')
      return text.includes('## Learned') || text.includes('<!-- learned:')
    })
    drew = viewFiles(ROOT).length > viewsBefore
    if (learned && drew) break
    const now = await window.evaluate(() => performance.now())
    if (now - started > deadline) break
    await window.waitForTimeout(15_000)
  }
  console.log('COLD_LEARN:' + JSON.stringify({ learned, drew, views: viewFiles(ROOT) }))

  // ASSERT THE OUTCOME. Without these the probe is a stopwatch: it would wait
  // fifty minutes, log whatever it found and report green.
  expect(learned, 'the learn pass wrote nothing back to the feature file').toBe(true)
  expect(drew, 'learning a feature did not generate its curated view').toBe(true)

  // And the generated view actually draws — the artifact existing is not the
  // same as the board being able to render it.
  await expect(window.locator('.fb-curated-card').first()).toBeVisible({ timeout: 120_000 })
  await window.screenshot({ path: 'e2e/__screens/cold-start-learned.png' })
})
