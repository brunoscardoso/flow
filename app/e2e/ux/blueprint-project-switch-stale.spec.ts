import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * REPRO: open project B, then open the Blueprint — and it still shows project
 * A's map.
 *
 * `setRoot` nulls `#snapshot` and refreshes, but only `if (this.#loaded)`, and
 * `ensureLoaded()` sets that flag on the FIRST tab open and never clears it
 * ("later opens reuse live state"). This probe drives the user's exact path
 * rather than reasoning about the flags: seed two projects whose feature boards
 * are distinguishable by name, look at A, switch to B with the tab closed, then
 * open the Blueprint and demand B.
 *
 * Asserts on FEATURE CARDS, not `.fb-node`: the board's level 1 is the feature
 * map now, so seeded module graphs are not what a fresh board draws.
 */

test.afterAll(() => cleanupSeeds())

/** Give a seeded repo one named feature so its board is identifiable. */
function seedFeature(root: string, slug: string, name: string): void {
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
      'Seeded by the project-switch probe.',
    ].join('\n'),
  )
}

async function openBlueprintTab(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
}

/** Close the Blueprint editor tab, so the next open is a fresh "open". */
async function closeBlueprintTab(window: Page): Promise<void> {
  const tab = window.locator('.fl-tab', { hasText: 'Blueprint' }).first()
  if ((await tab.count()) === 0) return
  await tab.hover()
  const close = tab.locator('.fl-tab-close')
  if ((await close.count()) > 0) await close.first().click()
  else await window.keyboard.press('Meta+w')
  await expect(window.locator('.flow-board-root')).toBeHidden()
}

test('switching projects does not leave the previous project on the board', async ({ window }) => {
  test.setTimeout(180_000)

  const projectA = await seedProject(window, 'flow-ux-switch-a-', (dir) =>
    seedFeature(dir, 'alpha-billing', 'Alpha Billing'),
  )
  const projectB = await seedProject(window, 'flow-ux-switch-b-', (dir) =>
    seedFeature(dir, 'bravo-reports', 'Bravo Reports'),
  )

  // Both projects land in this run's Default Workspace; wait for that, so the
  // board's first answer already holds both.
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
          const listed = await (window as unknown as { flow: any }).flow.workspaces.list()
          if (listed?.ok !== true) return 0
          return (listed.workspaces as Array<{ projects: Array<{ localPath: string | null }> }>).reduce(
            (count, workspace) => count + workspace.projects.filter((project) => project.localPath !== null).length,
            0,
          )
        }),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2)

  // Look at A first — this is what arms `#loaded`.
  await activateProject(window, projectA)
  await openBlueprintTab(window)
  const alpha = window.locator('.fb-terr-cell', { hasText: 'Alpha Billing' })
  await expect(alpha.first()).toBeVisible({ timeout: 120_000 })

  // The user's path: close the board, switch project, open the board again.
  await closeBlueprintTab(window)
  await activateProject(window, projectB)
  await openBlueprintTab(window)

  // THE BOARD OPENS AT THE WORKSPACE (decision workspace-blueprint): A's
  // features stand in A's own country there, by design. The claim is about
  // B's OWN board — so go into it, the way a person does.
  const bravoCountry = window.locator('.fb-ws-country', { hasText: basename(projectB) })
  await expect(bravoCountry.first(), "project B's country never rendered after the switch").toBeVisible({
    timeout: 120_000,
  })
  await bravoCountry.first().locator('.fb-ws-name').click()

  // ORDER MATTERS. Asserting A's ABSENCE first passes vacuously — the board is
  // briefly empty right after the tab opens, and the stale card lands a moment
  // later. Wait for B's board to actually arrive, THEN demand A is gone.
  const ownBoard = '.fb-territory:not(.fb-ws) .fb-terr-cell'
  await expect(
    window.locator(ownBoard, { hasText: 'Bravo Reports' }).first(),
    "project B's own feature never rendered after the switch",
  ).toBeVisible({ timeout: 120_000 })
  await expect(
    window.locator(ownBoard, { hasText: 'Alpha Billing' }),
    "project A's feature is still on the board after switching to B",
  ).toHaveCount(0)

  await window.screenshot({ path: 'e2e/__screens/blueprint-project-switch.png' })
})
