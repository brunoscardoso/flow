import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'
import { openSettings as openSettingsGroup } from './fixtures/settings'

/**
 * UX sweep — flow 0 (onboarding), re-entry surface: the manual **"Getting
 * Started…"** affordance in the app-level Settings overlay, which closes Settings
 * and re-opens the first-run wizard (`startOnboarding`). The base onboarding spec
 * covers first launch; this guards the *re-open* path, which a real user hits
 * whenever they revisit setup after dismissing it.
 *
 * A re-opened wizard must behave like a fresh one: reset to the Welcome step with
 * only the first indicator dot active and Back hidden, and dismiss cleanly back to
 * an interactive shell — never a stale mid-step or a trapped overlay.
 *
 * Dismissal here uses "Skip for now" (the always-reliable path). Escape is *not*
 * asserted because it currently dies once focus leaves the overlay — filed
 * separately (#475); the per-click overlay leak is filed as #474. This spec
 * guards only the behaviors that hold on current main.
 */

// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'

/** "Getting Started…" is about Flow itself, so it lives in the App group. */
async function openSettings(win: Page): Promise<void> {
  await openSettingsGroup(win, 'App')
}

/** Open Settings and click "Getting Started…" to re-open the onboarding wizard. */
async function reopenViaGettingStarted(win: Page): Promise<void> {
  await openSettings(win)
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  // The wizard takes over. (Settings is an editor TAB now, not the overlay it
  // was — it stays open behind the wizard rather than closing.)
  await expect(win.locator(WIZARD)).toBeVisible()
}

test('"Getting Started…" re-opens the wizard on the Welcome step, freshly reset', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await reopenViaGettingStarted(window)

  const wizard = window.locator(WIZARD)
  // A re-opened wizard is a fresh run: Welcome step, first dot only, Back hidden.
  await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')
  const dots = await wizard
    .locator('.fl-wizard-dot')
    .evaluateAll((ds) => ds.map((d) => d.getAttribute('data-active')))
  // One dot per step (eight since the agent, sign-in and Workspace steps).
  expect(dots[0]).toBe('true')
  expect(dots.slice(1).every((dot) => dot === 'false'), JSON.stringify(dots)).toBe(true)
  expect(dots.length).toBeGreaterThan(1)
  const backVisibility = await wizard
    .locator('.fl-wizard-btn', { hasText: 'Back' })
    .evaluate((b) => (b as HTMLElement).style.visibility)
  expect(backVisibility).toBe('hidden')
  // Next is ungated on Welcome — a live affordance, not a dead/disabled button.
  await expect(wizard.locator('.fl-wizard-btn', { hasText: 'Next' })).toBeEnabled()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('re-opened wizard advances to Connect then Skip dismisses to an interactive shell', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await reopenViaGettingStarted(window)
  const wizard = window.locator(WIZARD)

  // Step forward so dismissal is exercised from a non-first step (not just Welcome).
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')

  // "Skip for now" must close the re-opened wizard and hand back an interactive
  // shell — no trapped overlay, no leftover dimming that blocks the sidebar.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
  await expect(window.locator(WIZARD)).toHaveCount(0)
  await expect(window.locator(sel.threadSidebar)).toBeVisible()
  // The sidebar's "New thread" control is clickable — proof the shell isn't
  // occluded by a lingering visible overlay.
  await expect(window.locator(sel.newThread)).toBeEnabled()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
