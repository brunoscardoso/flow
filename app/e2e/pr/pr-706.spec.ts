import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression spec for PR #706 — blueprint connections (usage map).
 *
 * Guards the delivered click-neighborhood behavior end to end on the REAL
 * BlueprintBoard: clicking a module node lights its usage neighborhood
 * (dependents emphasized via .fb-lit-dependent, dependencies via .fb-lit) and
 * dims the rest of the board, and the popover grows a Connections section with
 * "Used by (N)" / "Uses (M)" rows carrying per-connection counts. Dismissing
 * the popover with Escape clears the whole decoration again.
 *
 * Fixture-seeded like blueprint-decoration.spec.ts: a real
 * flow/brain/.structure/graph.json is written to disk so BlueprintObserver
 * renders the board deterministically without a CLI derive. Three depth-1
 * module nodes keep selectInitialFocus (flow-model.ts) from auto-descending
 * (`depthOne.length > 2` → no dominant root), so every node stays a top-level
 * card the click can reach. Assertions are on observable classes/rows only.
 */

/** module:hub is imported by two modules (its dependents) and itself uses one
 *  integration (its dependency) — so a click on hub yields both a non-empty
 *  "Used by" and a non-empty "Uses". Three depth-1 modules block auto-descend. */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 4, filesTotal: 4, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src/hub', kind: 'module', label: 'hub', sourceFile: 'src/hub', meta: { depth: 1 } },
    { id: 'module:src/api', kind: 'module', label: 'api', sourceFile: 'src/api', meta: { depth: 1 } },
    { id: 'module:src/web', kind: 'module', label: 'web', sourceFile: 'src/web', meta: { depth: 1 } },
    { id: 'integration:smtp', kind: 'integration', label: 'SMTP', sourceFile: 'src/hub/mailer.ts' },
  ],
  edges: [
    { source: 'module:src/api', target: 'module:src/hub', relation: 'imports' },
    { source: 'module:src/web', target: 'module:src/hub', relation: 'imports' },
    { source: 'module:src/hub', target: 'integration:smtp', relation: 'uses' },
  ],
}

/** Write graph.json into BlueprintObserver's fixed read path. */
function seedGraphFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
}

test.describe('PR #706: blueprint click-neighborhood + connections panel', () => {
  // RETIRED SURFACE (2026-10): the module code map (`.fb-node` cards drawn from a seeded structure graph) is retired — the board's default sheet is the feature Territory and a part opens the code storyline, so there is no module card to drive.
  test.skip(true, 'module code map retired — no .fb-node cards on the Territory')
  test.afterAll(() => cleanupSeeds())

  test('clicking a module lights its neighborhood + shows Used-by/Uses; Escape clears it', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()

    const hub = window.locator('.fb-node[data-node-id="module:src/hub"]')
    const api = window.locator('.fb-node[data-node-id="module:src/api"]')
    const web = window.locator('.fb-node[data-node-id="module:src/web"]')
    await expect(hub).toBeVisible({ timeout: 10_000 })
    await expect(api).toBeVisible()
    await expect(web).toBeVisible()

    // Before any click: no neighborhood decoration on the board.
    await expect(hub).not.toHaveClass(/fb-lit/)
    await expect(api).not.toHaveClass(/fb-lit-dependent/)

    // Click hub → its usage neighborhood lights: hub itself lit, its two
    // dependents (api, web — who import it) emphasized, dependency lit too.
    await hub.click()
    const popover = window.locator('.fb-popover')
    await expect(popover).toBeVisible()
    await expect(hub).toHaveClass(/fb-lit/, { timeout: 5_000 })
    await expect(api).toHaveClass(/fb-lit-dependent/)
    await expect(web).toHaveClass(/fb-lit-dependent/)

    // Connections section: "Used by (2)" (api + web) and "Uses (1)" (smtp),
    // each row carrying its per-connection count.
    const connections = popover.locator('.fb-popover-connections')
    await expect(connections).toBeVisible()
    await expect(connections.locator('.fb-popover-heading', { hasText: 'Used by (2)' })).toBeVisible()
    await expect(connections.locator('.fb-popover-heading', { hasText: 'Uses (1)' })).toBeVisible()
    const usedByRows = connections.locator('.fb-popover-conn-row')
    await expect(usedByRows.filter({ hasText: 'api' })).toBeVisible()
    await expect(usedByRows.filter({ hasText: 'web' })).toBeVisible()
    await expect(usedByRows.filter({ hasText: 'SMTP' })).toBeVisible()
    // A count chip is rendered on the connection rows (usage strength).
    await expect(connections.locator('.fb-popover-conn-count').first()).toHaveText('1')

    // Escape dismisses the popover AND clears the neighborhood decoration —
    // the board returns to its calm, undecorated state.
    await window.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(hub).not.toHaveClass(/fb-lit/, { timeout: 5_000 })
    await expect(api).not.toHaveClass(/fb-lit-dependent/)
    await expect(web).not.toHaveClass(/fb-lit-dependent/)

    expect(errors, `uncaught errors during neighborhood flow:\n${errors.join('\n')}`).toEqual([])
  })
})
