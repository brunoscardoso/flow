import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from '../ux/fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Regression for PR #394 — "feat(graphify): always-on by default + relocate
 * output out of the user's repo (#142)".
 *
 * Graphify became an always-on backbone dependency: there is no longer any user
 * consent/opt-in, so the Settings → Engines "Graphify (code graph)" toggle was
 * removed (`FLOW_SETTINGS_SECTIONS`). Lavish followed it (#1807 retired lavish,
 * #1808 stopped writing any `engines.*` key), so the Engines section is gone
 * entirely. A regression that re-surfaced a Graphify toggle would
 * reintroduce the confusing "off means disabled" state #142 set out to kill —
 * users could think they'd turned graphify off when the CLI derive ignores the
 * value entirely.
 *
 * The pure model is covered by `flow-settings-model.test.ts`; this spec guards
 * the headlessly observable DOM: from a fresh launch, seeding an unconfigured
 * project auto-opens the per-project Flow settings overlay (the .flowconfig
 * editor). It must render no "Graphify" row, no "Lavish" row, and no Engines
 * section at all.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

/** Row locator in the flow-settings overlay, matched by its label text. */
function rowByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label })
}

/** Seed + activate a project WITHOUT dismissing the auto-opened flow overlay. */
async function seedAndActivate(win: Page): Promise<void> {
  const dir = await seedProject(win)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
}

test.afterEach(() => cleanupSeeds())

test.describe('PR #394 — Graphify toggle removed from Settings → Engines (#142)', () => {
  test('Flow settings offers no engine toggles — neither Graphify nor Lavish', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)
    await expect(overlay.locator('.fl-settings-header')).toContainText('Flow settings')

    // The panel rendered its rows (so the absences below are not vacuous).
    await expect(rowByLabel(overlay, 'Model routing')).toHaveCount(1)

    // Graphify is always-on under the hood (#142) — its toggle must be gone.
    await expect(rowByLabel(overlay, 'Graphify')).toHaveCount(0)
    // Lavish is retired (#1807) — no toggle, and no Engines section to hold one.
    await expect(rowByLabel(overlay, 'Lavish')).toHaveCount(0)
    await expect(overlay.locator('.fl-settings-heading', { hasText: 'Engines' })).toHaveCount(0)

    await window.keyboard.press('Escape')
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
