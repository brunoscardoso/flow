import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for PR #553 — auto-descend degenerate single-root boards
 * (Fixes #537). `selectInitialFocus` (src/renderer/blueprint/flow-model.ts) plus
 * the one-shot `#autoDescendApplied` gate in blueprint-board.ts default a
 * DEGENERATE top level (≤2 displayable module roots) to the dominant root's
 * children — so a single-`src/` repo no longer renders one useless card. A
 * multi-root repo (>2 depth-1 modules) must still hold the depth-1 view, and
 * Esc from the auto-descended view must pop to ROOT and STAY there (the
 * one-shot never re-fires while the user hasn't drilled).
 *
 * Fixture-seeded exactly like blueprint.spec.ts: a real
 * `flow/brain/.structure/graph.json` written to disk before the project is
 * activated, so main's BlueprintObserver renders the board deterministically
 * (no CLI derive, no basic-graph fallback timing). Assertions observe only the
 * rendered board (cards by `data-node-id`, the breadcrumb rail) — never board
 * internals.
 */

/** DEGENERATE top level: a single depth-1 `src` root owning three child
 *  modules. `selectInitialFocus` must pick `module:src` (the dominant — and
 *  only — root) so the board opens ON its children (api / db / ui), NOT on the
 *  lone `src` card. One integration is wired in to prove periphery still shows
 *  through the auto-descend. */
const GRAPH_DEGENERATE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:src/api', kind: 'module', label: 'api', sourceFile: 'src/api', meta: { depth: 2 } },
    { id: 'module:src/db', kind: 'module', label: 'db', sourceFile: 'src/db', meta: { depth: 2 } },
    { id: 'module:src/ui', kind: 'module', label: 'ui', sourceFile: 'src/ui', meta: { depth: 2 } },
    { id: 'integration:stripe', kind: 'integration', label: 'Stripe', sourceFile: 'src/api/stripe.ts' },
  ],
  edges: [
    { source: 'module:src', target: 'module:src/api', relation: 'contains' },
    { source: 'module:src', target: 'module:src/db', relation: 'contains' },
    { source: 'module:src', target: 'module:src/ui', relation: 'contains' },
    { source: 'module:src/api', target: 'integration:stripe', relation: 'uses' },
  ],
}

/** NON-degenerate top level: three bare depth-1 roots. `selectInitialFocus`
 *  returns null here (`depthOne.length > 2`), so the board holds depth-1 and
 *  shows all three root cards with no breadcrumb. */
const GRAPH_MULTIROOT = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    { id: 'module:cli', kind: 'module', label: 'cli', sourceFile: 'cli', meta: { depth: 1 } },
  ],
  edges: [],
}

/** Write graph.json into `<root>/flow/brain/.structure/` (BlueprintObserver's
 *  fixed read path). */
function seedGraph(root: string, graph: unknown): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph))
}

/** The board's own scoped root (blueprint-board.ts). */
const boardRoot = '.flow-board-root'

test.describe('PR #553 — auto-descend degenerate single-root board (#537)', () => {
  // RETIRED SURFACE (2026-10): the module code map (`.fb-node` cards drawn from a seeded structure graph) is retired — the board's default sheet is the feature Territory and a part opens the code storyline, so there is no module card to drive.
  test.skip(true, 'module code map retired — no .fb-node cards on the Territory')
  test.afterAll(() => cleanupSeeds())

  test('degenerate single root opens on the dominant root’s children (ROOT › src)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraph(root, GRAPH_DEGENERATE)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible()

    // Auto-descend: the board opens focused INTO `src`, so its three children
    // render at the top level and the lone `src` card is NOT shown.
    await expect(window.locator('.fb-node[data-node-id="module:src/api"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(window.locator('.fb-node[data-node-id="module:src/db"]')).toBeVisible()
    await expect(window.locator('.fb-node[data-node-id="module:src/ui"]')).toBeVisible()
    await expect(window.locator('.fb-node[data-node-id="module:src"]')).toHaveCount(0)

    // The breadcrumb rail proves we descended: ROOT › src.
    const breadcrumb = window.locator('.fb-breadcrumb')
    await expect(breadcrumb).toBeVisible()
    await expect(breadcrumb.locator('.fb-crumb-current')).toHaveText('src')

    expect(errors, `uncaught errors during auto-descend:\n${errors.join('\n')}`).toEqual([])
  })

  test('Esc pops the auto-descend to ROOT and stays there (one-shot never re-fires)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraph(root, GRAPH_DEGENERATE)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator('.fb-node[data-node-id="module:src/api"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(window.locator('.fb-breadcrumb')).toBeVisible()

    // Focus the board (its keydown guard ignores Escape otherwise, #517), then Esc.
    await window.locator('.fb-stage').click({ position: { x: 5, y: 5 } })
    await window.keyboard.press('Escape')

    // Back at ROOT: the single `src` card shows, breadcrumb is gone, and the
    // auto-descend does NOT re-fire (children are rolled back up).
    await expect(window.locator('.fb-node[data-node-id="module:src"]')).toBeVisible()
    await expect(window.locator('.fb-breadcrumb')).toHaveCount(0)
    await expect(window.locator('.fb-node[data-node-id="module:src/api"]')).toHaveCount(0)

    expect(errors, `uncaught errors during Esc-to-root:\n${errors.join('\n')}`).toEqual([])
  })

  test('multi-root board holds the depth-1 view (no auto-descend, no breadcrumb)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraph(root, GRAPH_MULTIROOT)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible()

    // All three depth-1 roots render at the top level; no breadcrumb (not descended).
    await expect(window.locator('.fb-node[data-node-id="module:src"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(window.locator('.fb-node[data-node-id="module:lib"]')).toBeVisible()
    await expect(window.locator('.fb-node[data-node-id="module:cli"]')).toBeVisible()
    await expect(window.locator('.fb-breadcrumb')).toHaveCount(0)

    expect(errors, `uncaught errors during multi-root render:\n${errors.join('\n')}`).toEqual([])
  })
})
