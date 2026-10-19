import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for PR #578 — "fix(blueprint): reveal feedback + rolled-up
 * two-way match (#566 #559)".
 *
 * #566: right-clicking "Reveal in Blueprint" on a path that NO module node owns
 * (docs, `flow/`, root config files) used to open the board and then silently
 * drill nowhere, leaving the reveal request stuck pending. #578 made
 * `#applyPendingReveal` distinguish graph-not-ready (keep pending) from
 * no-owning-module (clear + a *"No module on the map owns <path>"* toast) — so
 * the gesture is never a silent dead-click.
 *
 * The file-tree fires a `flow:reveal-in-blueprint` CustomEvent (a public DOM
 * contract; see editor/file-tree.ts + blueprint/index.ts) which the board's
 * `revealForPath` consumes. This probe seeds a real
 * `flow/brain/.structure/graph.json` (BlueprintObserver's fixed read path — no
 * CLI derive, no credentials) whose only module owns `src`, opens the board,
 * then dispatches the same event for an UNOWNED path (`README.md`) and asserts
 * the observable feedback toast. Before #578 no toast appeared. The #559
 * rolled-up reverse story↔board match needs a compiled story and is covered by
 * flow-model unit tests (`displayedNodeId` / `buildDisplayResolver`), so it is
 * intentionally out of scope for this DOM probe.
 */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
  edges: [],
}

/** Write graph.json into `<root>/flow/brain/.structure/` — the fixed path
 *  BlueprintObserver reads verbatim, so the board renders without a derive. */
function seedGraphFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
}

/** The board's own scoped root (blueprint-board.ts). */
const boardRoot = '.flow-board-root'

test.describe('PR #578 — reveal of an unowned path gives feedback (never a silent dead-click)', () => {
  test.afterAll(() => cleanupSeeds())

  test('revealing a path no module owns raises a "No module on the map owns …" toast', async ({
    window,
  }) => {
    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    // Open the board. (It used to confirm the seeded module card first; the
    // module code map that drew `.fb-node` cards is retired and the default
    // sheet is the feature Territory. The reveal path still reasons over the
    // structure graph, which is what was seeded, and decides once it is ready.)
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible()

    // Fire the same event the file-tree's "Reveal in Blueprint" menu item fires,
    // for a path OUTSIDE the only module (`src`). #566: this must surface a toast,
    // not silently no-op.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:reveal-in-blueprint', { detail: { relPath: 'README.md' } }),
      )
    })

    const toast = window.locator('.fl-flow-toast', {
      hasText: 'No module on the map owns README.md',
    })
    await expect(toast).toBeVisible({ timeout: 10_000 })
  })

  test('a reveal issued before the board has loaded still raises the toast once the graph arrives', async ({
    window,
  }) => {
    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    // The file-tree path: the board was never opened, so no graph is loaded and
    // the reveal is queued. Its retry used to live only in the module map's
    // renderer, which the default Territory sheet never runs — the request
    // stayed pending for ever and the click did nothing at all.
    await window.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('flow:reveal-in-blueprint', { detail: { relPath: 'README.md' } }),
      )
    })

    // The event itself opened the board (the reveal really ran)…
    await expect(window.locator(boardRoot)).toBeVisible()
    // …and the queued request resolved when the graph arrived.
    const toast = window.locator('.fl-flow-toast', {
      hasText: 'No module on the map owns README.md',
    })
    await expect(toast).toBeVisible({ timeout: 10_000 })
  })
})
