import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 6. The existing settings specs cover the Auto-PR guardrail, #369 number
 * clamping, accounts empty state, the Low-effort routing row, theme, this-project
 * binding, and integrations "Fill every field". This spec guards the settings
 * form behaviors those never touch — all of which drove GREEN (no new bug found
 * this cycle; these are stabilization guards):
 *
 *  - the FULL set of flow-settings toggles round-trips across a close/reopen
 *    (phase_isolation / wave_execution / learn_auto / model_routing, all
 *    default-on → off) — not just the PR guardrail;
 *  - a Conversation files text field persists a typed value across reopen;
 *  - an EXTERNAL `/flow` config write reconciles LIVE into the open panel
 *    (the documented onStateChanged path — previously undriven end-to-end);
 *  - the Medium and High model-routing rows persist across reopen and Reset
 *    restores their suggested defaults (the sibling spec only proves Low).
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'

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

/**
 * THE FIELD THIS EXERCISE USES.
 *
 * It was 'Base branch' until the worktree-management surfaces were removed and
 * that row went with them. The exercise was never about the base branch: it is
 * about a live-edited text field in this panel — no Save button, so a typed
 * value that does not reach the project's settings is silently lost. Of the
 * text fields left, this one sits in the same Conversation files section the old row
 * did, so the walk below is the same walk.
 */
const TEXT_FIELD = 'Prepare a new conversation'

/** Toggle button in the flow-settings overlay, located by its row label. */
function toggleByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label }).locator('.fl-fs-toggle')
}

async function openMainSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
  // Model routing lives in the Models group. Settings is a tabbed page now, so
  // a section is reachable only in the group that is showing.
  const tab = win.locator('.fl-settings-tab', { hasText: 'Models' })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/**
 * Leave the Settings PAGE and come back.
 *
 * Escape used to close it; a tab does not answer Escape. What this exercise is
 * really about is whether the values survive a re-render, and the honest way to
 * ask that now is to close the tab and reopen it — which is also what a person
 * does.
 */
async function reopenMainSettings(win: Page): Promise<void> {
  const close = win.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close')
  if ((await close.count()) > 0) await close.first().click()
  await expect(win.locator(SETTINGS_OVERLAY)).toBeHidden()
  await openMainSettings(win)
}

test.afterEach(() => cleanupSeeds())

test.describe('flow-settings overlay — forms & reconciliation', () => {
  test('every toggle round-trips across a close/reopen', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    // Ships: all four default-on toggles ON. Model routing joined them in
    // #1957 (`7688badc`), mirroring the CLI's DEFAULT_CONFIG.
    await expect(toggleByLabel(overlay, 'Phase isolation')).toHaveAttribute('aria-checked', 'true')
    await expect(toggleByLabel(overlay, 'Wave execution')).toHaveAttribute('aria-checked', 'true')
    await expect(toggleByLabel(overlay, 'Auto re-learn on change')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // NO "Lavish" ROW. The engine was retired (#1807) — plan review is native
    // now — so nothing reads `engines.lavish` and it is not a setting. This
    // line asserted a control that had stopped existing, which is why the whole
    // case has been red since.
    await expect(toggleByLabel(overlay, 'Model routing')).toHaveAttribute('aria-checked', 'true')

    // Flip all four.
    await toggleByLabel(overlay, 'Phase isolation').click()
    await toggleByLabel(overlay, 'Wave execution').click()
    await toggleByLabel(overlay, 'Auto re-learn on change').click()
    await toggleByLabel(overlay, 'Model routing').click()

    // Close + reopen — every flip must have persisted to .flowconfig.
    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await reopenFlowSettings(window, root)

    const o2 = window.locator(FLOW_OVERLAY)
    await expect(toggleByLabel(o2, 'Phase isolation')).toHaveAttribute('aria-checked', 'false')
    await expect(toggleByLabel(o2, 'Wave execution')).toHaveAttribute('aria-checked', 'false')
    await expect(toggleByLabel(o2, 'Auto re-learn on change')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(toggleByLabel(o2, 'Model routing')).toHaveAttribute('aria-checked', 'false')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('a Conversation files text field persists a typed value across reopen', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)

    // This field is the project's own from the first frame — nothing resolves
    // it through the person's defaults — so there is nothing to take over
    // before typing into it. It being editable IS the first assertion.
    const setup = overlay
      .locator('.fl-fs-row', { hasText: TEXT_FIELD })
      .locator('input[type="text"]')
    await expect(setup).toBeEnabled()
    await setup.fill('release-x')
    await setup.blur()

    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await reopenFlowSettings(window, root)

    const setup2 = window
      .locator(FLOW_OVERLAY)
      .locator('.fl-fs-row', { hasText: TEXT_FIELD })
      .locator('input[type="text"]')
    await expect(setup2).toHaveValue('release-x')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('an external /flow config write reconciles live into the open panel', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    const autopilot = toggleByLabel(overlay, 'Autopilot')
    await expect(autopilot).toHaveAttribute('aria-checked', 'false')

    // Mirror an external `/flow autopilot=true` edit (setConfig → flow:stateChanged
    // rebroadcast). The OPEN panel must reflect it with no user interaction.
    await window.evaluate(async (r) => {
      await (
        window as unknown as {
          flow: {
            flow: {
              setConfig(a: { rootId: string; updates: Record<string, string> }): Promise<unknown>
            }
          }
        }
      ).flow.flow.setConfig({ rootId: r, updates: { autopilot: 'true' } })
    }, root)

    await expect(autopilot).toHaveAttribute('aria-checked', 'true', { timeout: 4000 })

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})

test.describe('Settings overlay — model routing (Medium/High)', () => {
  test('Medium and High rows persist across reopen, and Reset restores defaults', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await openMainSettings(window)
    const med = window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for Medium effort"]')
    const high = window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for High effort"]')
    await med.selectOption('opus')
    await high.selectOption('haiku')

    await reopenMainSettings(window)

    await expect(
      window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for Medium effort"]'),
    ).toHaveValue('opus')
    await expect(
      window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for High effort"]'),
    ).toHaveValue('haiku')

    // Reset returns Medium → sonnet, High → opus (their suggested defaults).
    await window.locator(SETTINGS_OVERLAY).locator('button', { hasText: 'Reset to suggested' }).click()
    await expect(
      window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for Medium effort"]'),
    ).toHaveValue('sonnet')
    await expect(
      window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for High effort"]'),
    ).toHaveValue('opus')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
