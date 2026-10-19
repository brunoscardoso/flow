import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callBoard } from '../board-hook'

/**
 * REPRO: basic discovery reports "Added 32 feature(s) to the board" and the
 * board keeps showing the two it already had.
 *
 * `#featureGraph` is fetched lazily ONLY while it is null, and nothing
 * invalidated it when the feature store changed — so the board rendered
 * whatever features existed the first time it drew, for the rest of the
 * session. Observed live on orbit-core: the CLI's own feed returned 34 core
 * nodes while the board drew 2.
 *
 * This drives the real path: open the board, add features on disk the way
 * discovery does, fire the change notification the watcher fires, and demand
 * the new ones appear.
 */

test.afterAll(() => cleanupSeeds())

function writeFeature(root: string, slug: string, name: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      'anchors: []',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the features-refresh probe.',
    ].join('\n'),
  )
}

test('features added while the board is open actually appear on it', async ({ window }) => {
  test.setTimeout(180_000)

  const root = await seedProject(window, 'flow-ux-feat-refresh-', (dir) =>
    writeFeature(dir, 'first-capability', 'First Capability'),
  )
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(
    window.locator('.fb-terr-cell', { hasText: 'First Capability' }).first(),
  ).toBeVisible({ timeout: 120_000 })

  // What basic discovery does: more features land in the store, then the
  // blueprint watcher tells the board the root changed.
  writeFeature(root, 'second-capability', 'Second Capability')
  await callBoard(window, 'handleChanged', [root])

  // THE ASSERTION. Without the re-fetch the board keeps drawing only the
  // feature it first saw, exactly as the user reported.
  await expect(
    window.locator('.fb-terr-cell', { hasText: 'Second Capability' }).first(),
    'a feature added while the board was open never appeared',
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    window.locator('.fb-terr-cell', { hasText: 'First Capability' }).first(),
  ).toBeVisible()
})
