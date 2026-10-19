import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Learning-progress instrument (#582): the blueprint board's learning STATUS
 * PANEL. It shows overall percentage + per-module rows computed from the
 * snapshot (graph depth-1 modules + learning-state), and opens via the
 * `flow:open-learning-panel` deep-link that the "Basic discovery started ·
 * Open blueprint" notification dispatches. This probe seeds a graph + a
 * learning-state and drives that deep-link.
 */

// A three-root depth-1 spine (keeps the depth-1 view) + one child module.
const GRAPH = {
  version: 1,
  derivedAt: '2026-07-17T00:00:00Z',
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    // NOTE: not named `test` — that segment is on the built-in learning ignore
    // list (#learn-ignore) and would drop out of the panel's counts.
    { id: 'module:core', kind: 'module', label: 'core', sourceFile: 'core', meta: { depth: 1 } },
  ],
  edges: [],
}

// 1 of 3 depth-1 modules learned → 33%; one learning, one queued (active).
const LEARNING_JSONL = [
  { module: 'module:src', status: 'learned', notedAt: '2026-07-17T00:00:00Z' },
  { module: 'module:lib', status: 'learning', notedAt: '2026-07-17T00:01:00Z' },
  { module: 'module:core', status: 'queued', notedAt: '2026-07-17T00:02:00Z' },
]
  .map((e) => JSON.stringify(e))
  .join('\n')

/** Seeded once the project sits in its Workspace: the migration's copy drops
 *  `graph.json` (generated) and the first derive rewrites it from the repo. */
async function seedLearning(window: import('@playwright/test').Page, root: string): Promise<void> {
  const dir = await waitForLinkedStructure(window, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  writeFileSync(join(dir, 'learning-state.jsonl'), `${LEARNING_JSONL}\n`)
}

test.afterAll(() => cleanupSeeds())

test('the learning status panel opens via the deep-link and shows progress (#582)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window)
  await activateProject(window, root)
  await seedLearning(window, root)

  // The notification's "Open blueprint" action dispatches this deep-link.
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })

  // The panel appears with the overall percentage (1/3 learned = 33%).
  const panel = window.locator('.fb-learn-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.fb-lp-facts').first()).toContainText('1 of 3 modules', { timeout: 15_000 })
  await expect(panel.locator('.fb-lp-facts').first()).toContainText('33%')
  // A progress bar renders.
  await expect(panel.locator('.fb-lp-overall .fb-learn-bar-fill')).toBeVisible()
  // Per-module rows: the learning module surfaces (active-first ordering).
  // Rows render the prefix-NORMALIZED module path (`module:lib` → `lib`,
  // learn-progress-model normalizeModuleRef), not the raw graph id.
  await expect(panel.locator('.fb-learn-row', { hasText: 'lib' })).toBeVisible()

  // Close it via the header ✕.
  await panel.locator('.fb-learn-panel-close').click()
  await expect(panel).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
