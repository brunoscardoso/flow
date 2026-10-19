import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 10. Guards a seam no existing settings spec touches: the flow-settings
 * number field's READ-time clamp.
 *
 * The #369 spec (settings.spec.ts) drives clamping through the input's own
 * `change` handler (`resolveNumberInput`). This probe drives the OTHER, distinct
 * code path — `readValues → clampNumber` — which coerces an out-of-range value
 * that arrives from OUTSIDE the input:
 *
 *  - an external `/flow max_verify_retries=99` write while the panel is open
 *    (the live `onStateChanged` reconcile path), and
 *  - the same on a fresh open (`flow.state()` at open time).
 *
 * The user-facing invariant: the settings overlay must NEVER surface an
 * out-of-range value for `max_verify_retries` (valid range 1..5), regardless of
 * whether the clamp happens main-side or renderer-side. A CLI user who runs
 * `/flow max_verify_retries=99` (or hand-edits `.flowconfig`) and then opens the
 * GUI must see a sane, in-range number — not a raw 99 they could re-save.
 *
 * Drove GREEN — no product bug found this cycle; kept as a stabilization guard.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

/** addRoot + setActiveProject; the flow overlay auto-opens for the unconfigured project. */
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

/** Mirror an external `/flow <key>=<value>` write (setConfig → flow:stateChanged). */
async function externalWrite(win: Page, root: string, key: string, value: string): Promise<void> {
  await win.evaluate(
    async ({ r, k, v }) => {
      await (
        window as unknown as {
          flow: {
            flow: {
              setConfig(a: { rootId: string; updates: Record<string, string> }): Promise<unknown>
            }
          }
        }
      ).flow.flow.setConfig({ rootId: r, updates: { [k]: v } })
    },
    { r: root, k: key, v: value },
  )
}

/** Re-open the flow-settings overlay for a known root (post-onboarding). */
async function reopenFlowSettings(win: Page, root: string): Promise<void> {
  await win.evaluate(
    (r) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-flow-settings', { detail: { rootPath: r } }),
      ),
    root,
  )
  await expect(win.locator(FLOW_OVERLAY)).toHaveCount(1)
}

test.afterEach(() => cleanupSeeds())

test.describe('flow 11 — flow-settings number field never shows an out-of-range value', () => {
  test('an external out-of-range max_verify_retries clamps live and on reopen', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    const num = overlay.locator('input[type="number"][data-field-key="max_verify_retries"]')
    await expect(num).toHaveValue('2') // ships defaulting to 2

    // (1) LIVE reconcile: an external write ABOVE max (99) while the panel is open
    // must render the clamped ceiling (5), never the raw 99 — the read path
    // (readValues → clampNumber) coerces it, distinct from the input's own
    // change handler which never fired here.
    await externalWrite(window, root, 'max_verify_retries', '99')
    await expect(num).toHaveValue('5', { timeout: 4000 })

    // (2) LIVE reconcile: an external write BELOW min (0) clamps up to the floor (1).
    await externalWrite(window, root, 'max_verify_retries', '0')
    await expect(num).toHaveValue('1', { timeout: 4000 })

    // (3) READ-time (open) path: close and reopen — flow.state() re-reads whatever
    // is on disk and must STILL surface an in-range value (the on-disk 0 → 1),
    // never a blank or the raw stored number.
    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await reopenFlowSettings(window, root)

    const num2 = window.locator(FLOW_OVERLAY).locator('input[type="number"][data-field-key="max_verify_retries"]')
    const reopened = await num2.inputValue()
    expect(Number(reopened), `reopened value "${reopened}" must be in [1,5]`).toBeGreaterThanOrEqual(1)
    expect(Number(reopened), `reopened value "${reopened}" must be in [1,5]`).toBeLessThanOrEqual(5)
    expect(reopened.trim(), 'reopened number field must never be blank').not.toBe('')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
