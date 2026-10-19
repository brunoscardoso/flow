import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 9, rotation item "integrations".
 *
 * INTEGRATIONS MOVED OFF THE BOARD (2026-09-04) and into the app's own
 * settings, where every other account is configured; the board's toolbar is
 * gone entirely and its two verbs live on Todo's column head. The affordance is
 * now a section press in Settings, which dispatches the same
 * `flow:open-integrations` the singleton IntegrationsSettingsView listens for.
 *
 * What this still guards is unchanged: the press surfaces the overlay with all
 * three provider sections (GitHub / Jira / Azure DevOps) and closes cleanly —
 * not a dead click. No credentials required.
 */

test.afterAll(() => cleanupSeeds())

test('the Integrations group renders every provider, on the settings page', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)

  // ONE EVENT, NO DOOR TO PRESS. Integrations were a modal reached from
  // Settings by pressing a button — a door inside a door — and the provider
  // sections render on the page itself now.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))

  await expect(window.locator('.fl-settings-page')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-settings-tab.active')).toHaveText('Integrations')

  // All three providers, each with its own save affordance — not a dead click.
  const group = window.locator('.fl-settings-group:not([hidden])')
  for (const provider of ['GitHub', 'Jira', 'Azure DevOps']) {
    await expect(group.locator('.fl-settings-heading', { hasText: provider })).toBeVisible({
      timeout: 30_000,
    })
  }
  // One connect action per provider ("Connect" / "Update token"). A connected
  // provider also carries a "Save list" button of the same class (its custom
  // list query, 2026-09-07), which is not a provider.
  await expect(
    group.locator('.fl-int-save').filter({ hasText: /^(Connect|Update token)$/ }),
  ).toHaveCount(3)

  // AZURE ASKS FOR ITS PLACE. It has no "everything of mine, everywhere"
  // endpoint, so a query is scoped to one project — and until those fields
  // existed, the board's Remote column could only tell a person that Azure
  // "needs an organisation and project" with nowhere to say them.
  const azure = group.locator('.fl-settings-section', { hasText: 'Azure DevOps' })
  await expect(azure.locator('.fl-int-field', { hasText: 'Organisation' })).toBeVisible()
  await expect(azure.locator('.fl-int-field', { hasText: 'Project' })).toBeVisible()

  await window.screenshot({ path: 'e2e/ux/__screens/settings-integrations.png' })

  expect(errors).toEqual([])
})
