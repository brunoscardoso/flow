import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from '../ux/fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Regression spec for PR #497 — IDE auto-provisioning.
 *
 * The user-visible deliverable of #497 is the **"Plan-flow provisioning"**
 * section added to the per-project Flow settings overlay (phase 5): a status
 * line reporting whether/what version provisioned the active root, plus a
 * "Re-provision now" action. The provisioning ENGINE (decision core, owned-asset
 * boundary, migration, CLI shim) is exhaustively covered by unit + CLI-subprocess
 * tests; this spec guards only the observable UI surface — that the section
 * renders with a status line and an actionable button, and mounting it produces
 * no uncaught renderer errors.
 *
 * Asserts observable DOM only (never internals). The status text is matched
 * loosely against its documented shapes so a background provisioning sweep
 * (addRoot triggers one) can race to completion without flaking the probe.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

/** addRoot + setActiveProject WITHOUT dismissing the auto-opened flow overlay
 *  (mirrors ux/settings.spec.ts) — the first activation of an unconfigured
 *  project auto-opens the per-project Flow settings overlay. */
async function seedAndActivate(win: Page): Promise<string> {
  const dir = await seedProject(win)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  return dir
}

test.afterEach(() => cleanupSeeds())

test.describe('PR #497 — Flow settings "Plan-flow provisioning" section', () => {
  test('renders a status line and an actionable "Re-provision now" button', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)
    await expect(overlay.locator('.fl-settings-header')).toContainText('Flow settings')

    // The provisioning section is appended to the overlay body by
    // #renderProvisioningSection() — heading + status row + action button.
    const section = overlay.locator('.fl-settings-section', { hasText: 'Plan-flow provisioning' })
    await expect(section).toHaveCount(1)
    await expect(section.locator('.fl-settings-heading')).toHaveText('Plan-flow provisioning')

    // Status line: one of the documented shapes — "Not provisioned",
    // "v<version> · provisioned <date>", or "Unavailable — …". Matched loosely
    // so a background provision sweep completing mid-test can't flake it.
    // Scoped to the provisioning ROW: the section also holds a "Basic
    // discovery" row (#513 phase 2), with its own `.fl-fs-name`.
    const provisionRow = section.locator('.fl-fs-row', { hasText: 'Re-provision' })
    await expect(provisionRow).toHaveCount(1)
    const status = provisionRow.locator('.fl-fs-name')
    await expect(status).toHaveCount(1)
    await expect(status).toHaveText(/Not provisioned|provisioned|Unavailable/)

    // "Re-provision now" action is present and actionable for the (available)
    // seeded root.
    const button = provisionRow.locator('button.fl-settings-btn', { hasText: 'Re-provision' })
    await expect(button).toHaveCount(1)
    await expect(button).toBeEnabled()

    // Close cleanly.
    await window.keyboard.press('Escape')
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
