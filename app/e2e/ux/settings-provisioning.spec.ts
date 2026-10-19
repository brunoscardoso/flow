import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings), round 5. The prior settings
 * sweeps (#369/#399/#419, appearance, account binding, integrations, the Auto-PR
 * guardrail) never touched the Flow-settings overlay's **"Plan-flow provisioning"**
 * section — the ide-auto-provisioning surface added later. It carries two sibling
 * action buttons plus a live per-project config write path. This guards that
 * surface renders and its write path round-trips, and documents the one known
 * gap (tracked by #582).
 *
 * Findings this cycle:
 *  - "Run basic discovery" fires learn:answerBasicDiscovery (enqueues a background
 *    basic-discovery sync) with NO immediate feedback — no toast, no button
 *    change. That missing start-acknowledgement is exactly what open issue #582
 *    ("Basic-discovery start popup") specifies, so it is NOT re-filed here; the
 *    `test.fixme` below is a live tripwire that flips green when #582 lands.
 *  - "Re-provision now" showing no "Re-provisioning…" flip in E2E is an
 *    environment artifact, NOT a bug: provisioner.provisionRoot early-returns when
 *    no bundled CLI is present (the E2E app ships without one), so nothing runs.
 *    Not asserted here.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'
const OPEN_FLOW_SETTINGS = 'flow:open-flow-settings'

/** addRoot + setActiveProject; the flow overlay auto-opens for the fresh project. */
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

async function reopenFlowSettings(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(
    ([evt, root]) => document.dispatchEvent(new CustomEvent(evt, { detail: { rootPath: root } })),
    [OPEN_FLOW_SETTINGS, rootPath] as const,
  )
  await expect(win.locator(FLOW_OVERLAY)).toHaveCount(1)
}

test.afterEach(() => cleanupSeeds())

test.describe('flow-settings provisioning section', () => {
  test('renders the provisioning + basic-discovery rows for an active project', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    const section = overlay.locator('.fl-settings-section', { hasText: 'Plan-flow provisioning' })
    await expect(section).toHaveCount(1)
    // #1528: this asserted the literal string "Not provisioned" for a freshly
    // seeded root — which only held because the card was blind to
    // `provisioningState` and printed the never-run wording DURING the ~9s
    // automatic provision. It was passing on the bug. The honest line now
    // follows the run: "Setting up…" while it is in flight, then the stamp.
    const status = section.locator('.fl-fs-name').first()
    await expect(status).toHaveText(/Setting up…|Not provisioned|provisioned /)
    // Settle, so the rest of this test reads a stable card rather than racing it.
    await expect(status).toHaveText(/provisioned |Not provisioned/, { timeout: 30_000 })

    // Both sibling actions render and are actionable for a reachable known root.
    const reprov = section.locator('button', { hasText: 'Re-provision now' })
    const discover = section.locator('button', { hasText: 'Run basic discovery' })
    await expect(reprov).toHaveCount(1)
    await expect(discover).toHaveCount(1)
    // Enabled once nothing is in flight — #1528 disables it only while a
    // provision is actually running.
    await expect(reprov).toBeEnabled()
    await expect(discover).toBeEnabled()

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('Run basic discovery is wired without error (fire-and-forget enqueue)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    const section = overlay.locator('.fl-settings-section', { hasText: 'Plan-flow provisioning' })
    const discover = section.locator('button', { hasText: 'Run basic discovery' })

    // Clicking must not throw and must not tear down the overlay — the enqueue is
    // fire-and-forget on the main side (learn:answerBasicDiscovery).
    await discover.click()
    await window.waitForTimeout(500)
    await expect(overlay).toHaveCount(1)
    await expect(discover).toBeEnabled()

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  // #582 (open) — "Basic-discovery start popup". Clicking "Run basic discovery"
  // should announce that a sync started (a FlowNotification-style card / toast),
  // rather than being a silent action indistinguishable from a dead click.
  // Currently it produces zero feedback; this flips green when #582 lands.
  test.fixme('Run basic discovery surfaces a start notification (#582)', async ({ window }) => {
    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    const section = overlay.locator('.fl-settings-section', { hasText: 'Plan-flow provisioning' })
    await section.locator('button', { hasText: 'Run basic discovery' }).click()
    await expect(window.locator('.fl-flow-toast')).toHaveCount(1)
  })

  test('Autopilot toggle write round-trips across a close/reopen', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    const autopilot = () =>
      overlay.locator('.fl-fs-row', { hasText: 'Autopilot' }).locator('.fl-fs-toggle')

    await expect(autopilot()).toHaveAttribute('aria-checked', 'false')
    await autopilot().click()
    await expect(autopilot()).toHaveAttribute('aria-checked', 'true')

    // Close, then reopen for the same root — the live .flowconfig write must have
    // persisted (state is re-read from flow:state on open).
    await window.keyboard.press('Escape')
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)
    await reopenFlowSettings(window, dir)
    await expect(autopilot()).toHaveAttribute('aria-checked', 'true')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
