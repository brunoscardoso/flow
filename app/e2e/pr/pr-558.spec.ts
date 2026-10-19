import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for PR #558 — "feat(blueprint): shortcut, hint,
 * reveal-in-blueprint, two-way story↔board".
 *
 * This probe covers the two additions of #558 whose observable behavior is
 * deterministic headlessly and independent of a live CLI derive:
 *
 *   1. **⌘/Ctrl+Shift+B opens the Blueprint board** (shell.ts keydown). Shift
 *      disambiguates from the plain ⌘B sidebar toggle. Before #558 there was no
 *      keyboard path to the board at all.
 *   2. **The board legend spells out the node gestures** (blueprint-board.ts
 *      `#buildLegend`): a `.fb-legend-hint` row reading "Click a node for
 *      details · ⊕ references it in chat". Before #558 the legend was only the
 *      symbol key, and the click/⊕ gestures were undiscoverable.
 *
 * Seeds a real `flow/brain/.structure/graph.json` (BlueprintObserver's fixed
 * read path — no CLI derive, no credentials) so the board renders
 * deterministically, then asserts observable DOM only (never internals). The
 * reveal-in-blueprint file-tree action and the two-way story↔board reveal are
 * intentionally out of scope here — they need a seeded file tree / compiled
 * story and are more flake-prone; this guard locks the two stable surfaces.
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

test.describe('PR #558 — blueprint shortcut + legend interaction hint', () => {
  test.afterAll(() => cleanupSeeds())

  test('⌘⇧B opens the Blueprint board from cold', async ({ window }) => {
    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    // Board starts unmounted.
    await expect(window.locator(boardRoot)).toBeHidden()

    // ⌘/Ctrl+Shift+B (Shift disambiguates from the ⌘B sidebar toggle) opens it.
    await window.keyboard.press('ControlOrMeta+Shift+B')
    await expect(window.locator(boardRoot)).toBeVisible()
    // The board drew its own content, not an empty shell. Its default sheet is
    // the feature Territory now (the module code map with its `.fb-node` cards
    // is retired), and this seeded project has no features yet, so the sheet
    // offers the basic discovery that would name them.
    await expect(
      window.locator(boardRoot).getByText('No features yet', { exact: false }),
    ).toBeVisible({ timeout: 10_000 })
  })

  // #558's legend-hint half retired with the legend itself (chrome cleanup,
  // 2026-07-27) — the shortcut half above remains the PR's guard.
})
