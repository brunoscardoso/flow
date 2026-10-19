import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { enterProject } from './fixtures/territory'

/**
 * The Blueprint's default view is the feature board — "what this project does"
 * (#1221). Its graph was fetched ONCE per app run and never invalidated
 * (#1306), so:
 *
 *  1. switching projects left the PREVIOUS project's capabilities on screen,
 *     while the titlebar, sidebar and terminal all followed the switch; and
 *  2. within one project the board was frozen for the whole session — editing
 *     or deleting a `flow/brain/features/*.md` is the DOCUMENTED correction
 *     mechanism, and the board never noticed. Only a relaunch moved it.
 *
 * Fixed by invalidating the snapshot on project switch and on
 * `blueprint:changed`, and by watching `flow/brain/features/` at all — nothing
 * did before, so no file event in the store ever reached the renderer.
 */

/** A feature markdown file in the shape the store reads. */
function featureDoc(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'kind: core',
    '---',
    '',
    `${name} does a thing this project cares about.`,
    '',
  ].join('\n')
}

async function seedWithFeatures(
  window: Page,
  prefix: string,
  features: Record<string, string>,
): Promise<string> {
  const root = await seedProject(window, prefix)
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  for (const [slug, name] of Object.entries(features)) {
    writeFileSync(join(dir, `${slug}.md`), featureDoc(name))
  }
  return root
}

/**
 * The board's default view is the TERRITORY now (the card grid — `.fb-feature-
 * board` / `.fb-feature-name` — was replaced by it): a feature is a cell, named
 * by `.fb-terr-cell-name`. The freshness contract is unchanged.
 */
async function openBlueprint(window: Page): Promise<void> {
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await expect(window.locator('.flow-board-root .fb-territory').first()).toBeVisible({ timeout: 60_000 })
}

const cell = (window: Page, name: string) =>
  window.locator('.fb-terr-cell .fb-terr-cell-name', { hasText: name })

test.afterAll(() => cleanupSeeds())
test.slow() // seeds and provisions two projects

test('the feature board follows the active project (#1306)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const projectA = await seedWithFeatures(window, 'flow-ux-featsw-a-', {
    billing: 'Billing',
    chat: 'Chat Engine',
  })
  const projectB = await seedWithFeatures(window, 'flow-ux-featsw-b-', {
    inventory: 'Inventory',
    shipping: 'Shipping',
  })

  await activateProject(window, projectA)
  await openBlueprint(window)
  await expect(cell(window, 'Billing')).toBeVisible({ timeout: 60_000 })
  await expect(cell(window, 'Chat Engine')).toBeVisible()

  // The switch every other surface honours.
  await activateProject(window, projectB)
  // Editor tabs belong to the SCOPE on screen since f6ef9977 (a project, or a
  // conversation in it), so project B has its own tab set and the Blueprint is
  // opened there — the stale-snapshot question is what THAT board draws.
  await openBlueprint(window)
  // In a Workspace of two the board's root is the WORKSPACE sheet, which
  // draws every project's countries by design; the claim is about the active
  // project's own level, so go into it the way a person does.
  await enterProject(window, basename(projectB))
  await expect(cell(window, 'Inventory')).toBeVisible({ timeout: 60_000 })
  await expect(cell(window, 'Shipping')).toBeVisible()
  // …and project A's capabilities are gone, not merely outnumbered. Clicking a
  // leaked card used to fail with a raw CLI refusal.
  await expect(cell(window, 'Billing')).toHaveCount(0)

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})

test('the feature board notices a feature added or removed on disk (#1306)', async ({ window }) => {
  const root = await seedWithFeatures(window, 'flow-ux-featlive-', { orders: 'Orders' })
  await activateProject(window, root)
  await openBlueprint(window)
  await expect(cell(window, 'Orders')).toBeVisible({ timeout: 60_000 })

  // Editing the markdown IS the documented correction mechanism.
  const dir = join(root, 'flow', 'brain', 'features')
  writeFileSync(join(dir, 'payments.md'), featureDoc('Payments'))
  await expect(cell(window, 'Payments')).toBeVisible({ timeout: 30_000 })

  rmSync(join(dir, 'orders.md'), { force: true })
  await expect(cell(window, 'Orders')).toHaveCount(0, { timeout: 30_000 })
})

test('an empty feature board offers a route that works (#1307)', async ({ window }) => {
  const root = await seedProject(window, 'flow-ux-featempty-')
  await activateProject(window, root)
  await openBlueprint(window)

  const empty = window.locator('.fb-terr-empty')
  await expect(empty).toBeVisible({ timeout: 60_000 })

  // The old instruction — `features seed` — is a guaranteed no-op in exactly
  // this state: it adopts files that already exist, and an un-adopted file
  // already renders here. It must not be what the board tells you to do.
  await expect(empty).not.toContainText('features seed')

  // And an IDE should OFFER the route, not name a command (forbidden-pattern
  // #12 — the board used to print `features discover`): a button that runs it.
  await expect(empty.getByRole('button', { name: 'Run basic discovery' })).toBeVisible()
})
