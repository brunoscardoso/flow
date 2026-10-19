import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 25.
 *
 * The flow-settings overlay has 26 committed specs. `settings-provisioning`
 * renders the provisioning card for a SETTLED root; nothing had ever looked at
 * it during the window it is most likely to be seen — the ~9s in which the
 * automatic provisioner is still running, which is exactly when this panel
 * AUTO-OPENS (the per-project onboarding shows it the first time a project is
 * selected).
 *
 * The root record carries `provisioningState: 'provisioning'` and the sidebar
 * row renders it as a "setting up…" pill. The settings card, reading the same
 * record, ignores that field entirely: `provisioningStatusText` branches only
 * on `available` and `provisionedAt`, so it reports the running provision as
 * "Not provisioned" — the same words a never-run or failed one gets — and
 * `canReprovision` leaves "Re-provision now" enabled, while the main-side
 * handler returns instantly on its in-flight guard
 * (`provisioner.ts`: `if (this.inFlight.has(root.id)) return`). Clicking it
 * therefore does nothing at all and says nothing at all.
 *
 * Measured (this spec's own numbers, 1440×900, fresh userData):
 *   in-flight click → "Re-provisioning…" NEVER appears, stamp unchanged by it
 *   settled  click → "Re-provisioning…" for ~4.3s, stamp advances 7.6s later
 *
 * Test 1 holds the bug (#1528, fixme). Test 2 is the green guard: the same
 * action on a settled root really does run and really does report, so the
 * fixme is about the in-flight case alone and not about a broken button.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

interface RootRecord {
  rootPath: string
  provisioningState?: string
  provisionedAt?: string | null
}

async function roots(win: Page): Promise<RootRecord[]> {
  return win.evaluate(async () =>
    (
      window as unknown as { flow: { project: { list(): Promise<unknown[]> } } }
    ).flow.project.list(),
  ) as Promise<RootRecord[]>
}

async function activate(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, rootPath)
}

/** The provisioning card's row ("<status>  [Re-provision now]"). */
function provRow(win: Page) {
  return win.locator(FLOW_OVERLAY).locator('.fl-fs-row').filter({ hasText: 'provision' }).first()
}

function reprovisionButton(win: Page) {
  return win.locator(FLOW_OVERLAY).locator('button', { hasText: /Re-provision/ }).first()
}

/** Click Re-provision; report whether the in-progress label ever appeared. */
async function clickAndWatchLabel(win: Page): Promise<{ sawLabel: boolean; ms: number }> {
  const button = reprovisionButton(win)
  const started = Date.now()
  await button.click()
  let sawLabel = false
  for (let i = 0; i < 140; i++) {
    const label = (await button.textContent().catch(() => '')) ?? ''
    if (label.includes('Re-provisioning')) sawLabel = true
    else if (sawLabel) break
    await win.waitForTimeout(50)
  }
  return { sawLabel, ms: Date.now() - started }
}

test.afterEach(() => cleanupSeeds())

test.describe('flow 11 — the provisioning card while a provision is running', () => {
  // #1528. During the automatic provision the card must not present a state and
  // an action that are both untrue: either it names the run (anything but the
  // "Not provisioned" a never-run project gets), or it disables the button that
  // the main process will discard. Today it does neither.
  test(
    '#1528: an in-flight provision is reported as "Not provisioned", with a live no-op button',
    async ({ window }) => {
      test.setTimeout(120_000)
      const dir = await seedProject(window, 'flow-ux-prov-inflight-')
      await activate(window, dir)

      // The per-project onboarding opens this panel by itself, mid-provision.
      await expect(window.locator(FLOW_OVERLAY)).toHaveCount(1)
      const record = (await roots(window)).find((r) => r.rootPath === dir)
      expect(record?.provisioningState, 'precondition: provision still running').toBe(
        'provisioning',
      )

      const status = await provRow(window).innerText()
      expect(
        status,
        'the card reports a RUNNING provision as "Not provisioned" — the same words a never-run one gets',
      ).not.toContain('Not provisioned')

      // The contract this test's own preamble states is EITHER/OR: name the run,
      // or disable the button the main process will discard. As written it
      // required BOTH — and Playwright cannot click a disabled control at all,
      // so a fix that took the disable branch could only ever time out here.
      // Assert the branch that was actually taken.
      const disabled = await reprovisionButton(window).isDisabled()
      if (disabled) {
        // Nothing to click: the dead click is gone, which is the whole ask.
        expect(disabled).toBe(true)
      } else {
        const before = (await roots(window)).find((r) => r.rootPath === dir)?.provisionedAt ?? null
        const watched = await clickAndWatchLabel(window)
        const after = (await roots(window)).find((r) => r.rootPath === dir)?.provisionedAt ?? null
        expect(
          watched.sawLabel || before !== after,
          'the click neither ran anything nor said anything (no "Re-provisioning…", no state change)',
        ).toBe(true)
      }
    },
  )

  // The green half: on a settled root the same button genuinely re-runs the
  // provision AND reports it. Guards the affordance a fix must preserve.
  test('a settled root: Re-provision reports "Re-provisioning…" and re-stamps the root', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await seedProject(window, 'flow-ux-prov-settled-')
    await activate(window, dir)
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(1)

    // Let the automatic provision finish first.
    await expect
      .poll(
        async () =>
          (await roots(window)).find((r) => r.rootPath === dir)?.provisionedAt ? 'ready' : 'pending',
        { timeout: 90_000, intervals: [500] },
      )
      .toBe('ready')
    const settled = (await roots(window)).find((r) => r.rootPath === dir)?.provisionedAt ?? null
    expect(settled).not.toBeNull()

    // The card now names the stamp it just got.
    await expect(provRow(window)).toContainText('provisioned')
    await window.waitForTimeout(800)

    const watched = await clickAndWatchLabel(window)
    expect(watched.sawLabel, 'the button reports the run it started').toBe(true)

    // …and the run really happens: the stamp advances.
    await expect
      .poll(
        async () => (await roots(window)).find((r) => r.rootPath === dir)?.provisionedAt ?? null,
        { timeout: 60_000, intervals: [500] },
      )
      .not.toBe(settled)

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
