import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression for PR #520 — "budget node-card height so labels/ids don't clip
 * (#515)".
 *
 * Before #520 the v2 board sized cards with fixed height constants (module 68,
 * periphery 52) that were SHORTER than the rendered content (kind eyebrow +
 * label + mono id + optional sublabel), and `.fb-node` sets `overflow: hidden`
 * — so the bottom row of a 4-line card was sliced mid-glyph and unreadable.
 * #520 raised both card heights to 82 (a deterministic worst-case content
 * budget) and locked the four row line-heights, and added `title` attributes so
 * a horizontally-truncated value stays discoverable.
 *
 * This probe seeds a real `flow/brain/.structure/graph.json` (BlueprintObserver's
 * fixed read path — no CLI derive, no credentials) with:
 *   - a module that has a CHILD module (→ a 4th "N child modules" sublabel row,
 *     the worst-case card that clipped) and deliberately long label + id, and
 *   - a datastore periphery card (the kind that clipped worst at height 52),
 * then asserts the OBSERVABLE anti-clip invariant: each card's content
 * (`scrollHeight`) fits within its visible box (`clientHeight`). Before #520
 * the 4-row module card overflowed (scrollHeight > clientHeight); after, it
 * fits. Also asserts the label/id carry a `title` covering the full value.
 */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 2, filesTotal: 2, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    // Long label + long id → exercises horizontal ellipsis (title discoverability)
    // AND, via the child module below, the 4th sublabel row (worst-case height).
    {
      id: 'module:src/services/billing/subscription-lifecycle-manager',
      kind: 'module',
      label: 'subscription-lifecycle-manager',
      sourceFile: 'src/services/billing/subscription-lifecycle-manager',
      meta: { depth: 1 },
    },
    {
      id: 'module:src/services/billing/subscription-lifecycle-manager/inner',
      kind: 'module',
      label: 'inner',
      sourceFile: 'src/services/billing/subscription-lifecycle-manager/inner',
      meta: { depth: 2 },
    },
    {
      id: 'datastore:primary-postgres-analytics-warehouse',
      kind: 'datastore',
      label: 'primary-postgres-analytics-warehouse',
      sourceFile: 'src/db.ts',
    },
  ],
  edges: [
    {
      source: 'module:src/services/billing/subscription-lifecycle-manager',
      target: 'module:src/services/billing/subscription-lifecycle-manager/inner',
      relation: 'contains',
    },
    {
      source: 'module:src/services/billing/subscription-lifecycle-manager',
      target: 'datastore:primary-postgres-analytics-warehouse',
      relation: 'uses',
    },
  ],
}

const MODULE_ID = 'module:src/services/billing/subscription-lifecycle-manager'
const DATASTORE_ID = 'datastore:primary-postgres-analytics-warehouse'
const boardRoot = '.flow-board-root'

function seedGraphFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
}

test.describe('blueprint node-card height budget (#515 / PR #520)', () => {
  // RETIRED SURFACE (2026-10): the module code map (`.fb-node` cards drawn from a seeded structure graph) is retired — the board's default sheet is the feature Territory and a part opens the code storyline, so there is no module card to drive.
  test.skip(true, 'module code map retired — no .fb-node cards on the Territory')
  test.afterAll(() => cleanupSeeds())

  test('4-row module card and datastore card render their content without vertical clipping', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible()

    const moduleCard = window.locator(`.fb-node[data-node-id="${MODULE_ID}"]`)
    await expect(moduleCard).toBeVisible({ timeout: 10_000 })

    // The worst-case 4th row (the "N child modules" sublabel) is present — this is
    // the row that got sliced pre-#520.
    await expect(moduleCard.locator('.fb-node-sub')).toBeVisible()

    // Observable anti-clip invariant: the card's content height must fit inside
    // its visible box. `.fb-node` is `overflow: hidden` with a fixed height, so a
    // content overflow (the pre-#520 bug) shows up as scrollHeight > clientHeight.
    const moduleFits = await moduleCard.evaluate(
      (el) => el.scrollHeight <= el.clientHeight + 1,
    )
    expect(moduleFits, 'module card content overflows its fixed height (clipped)').toBe(true)

    // The datastore periphery card (height 52 pre-#520 — clipped worst) fits too.
    const datastoreCard = window.locator(`.fb-node[data-node-id="${DATASTORE_ID}"]`)
    await expect(datastoreCard).toBeVisible()
    const datastoreFits = await datastoreCard.evaluate(
      (el) => el.scrollHeight <= el.clientHeight + 1,
    )
    expect(datastoreFits, 'datastore card content overflows its fixed height (clipped)').toBe(
      true,
    )

    // The other half of #520: a horizontally-truncated label/id stays discoverable
    // via a `title` carrying the full value.
    await expect(moduleCard.locator('.fb-node-label')).toHaveAttribute(
      'title',
      'subscription-lifecycle-manager',
    )
    await expect(moduleCard.locator('.fb-node-id')).toHaveAttribute('title', MODULE_ID)

    expect(errors, `uncaught errors during card-height probe:\n${errors.join('\n')}`).toEqual([])
  })
})
