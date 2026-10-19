import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from '../ux/fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression guard for PR #557 — "feat(threads): open the blueprint from chat
 * + story card".
 *
 * Before #557 the Blueprint board was reachable only from the status bar. #557
 * adds a chat-level entry point: a ghost **map** button on the composer control
 * row (beside attach/capture) that dispatches the same decoupled
 * `flow:open-blueprint` document event the status-bar button uses. That event
 * is what opens the board tab (blueprint/index.ts).
 *
 * This probe locks the composer entry point, which is deterministic headlessly
 * and needs no live CLI derive:
 *
 *   1. The composer control row exposes an "Open Blueprint" button once a thread
 *      is active (it was absent entirely before #557).
 *   2. Clicking it opens the Blueprint board from cold — proving the button is
 *      wired to a real listener, not a dead click.
 *
 * (The story card's own "Blueprint" button was retired on 2026-10-08 with the
 * board's discovery view; the composer button is the chat's way to the board.)
 *
 * Asserts observable DOM only (button presence + board visibility), never
 * internals. Seeds a real `flow/brain/.structure/graph.json` (BlueprintObserver's
 * fixed read path — no CLI derive, no credentials) so the board renders a real
 * card rather than an empty shell.
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

/** Create a thread in `root` via the same IPC the "+" button calls. */
async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

/** The board's own scoped root (blueprint-board.ts). */
const boardRoot = '.flow-board-root'
/** The composer's chat-level Blueprint button (#557). */
const composerBlueprintBtn = `${sel.composer} fl-button[aria-label="Open Blueprint"]`

test.describe('PR #557 — open the blueprint from the composer', () => {
  test.afterAll(() => cleanupSeeds())

  test('the composer control row exposes an "Open Blueprint" button', async ({ window }) => {
    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)
    await createThread(window, root, 'Composer blueprint entry')
    await window.getByText('Composer blueprint entry', { exact: true }).click()
    await expect(window.locator(sel.composer)).toBeVisible()

    // #557's addition: the map button rides the control row beside attach/capture.
    await expect(window.locator(composerBlueprintBtn)).toBeVisible()
  })

  test('clicking it opens the Blueprint board from cold', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)
    await createThread(window, root, 'Composer opens board')
    await window.getByText('Composer opens board', { exact: true }).click()
    await expect(window.locator(sel.composer)).toBeVisible()

    // Board starts unmounted — the button is the only trigger under test.
    await expect(window.locator(boardRoot)).toBeHidden()

    await window.locator(composerBlueprintBtn).click()

    // The decoupled flow:open-blueprint event opened the board tab.
    await expect(window.locator(boardRoot)).toBeVisible()
    // The board drew its own content, not an empty shell. Its default sheet is
    // the feature Territory now (the module code map with its `.fb-node` cards
    // is retired), and this seeded project has no features yet, so the sheet
    // offers the basic discovery that would name them.
    await expect(
      window.locator(boardRoot).getByText('No features yet', { exact: false }),
    ).toBeVisible({ timeout: 10_000 })

    expect(errors, errors.join(', ')).toHaveLength(0)
  })
})
