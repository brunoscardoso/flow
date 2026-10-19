import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11: Settings / flow-settings overlays
 * (open, forms, close, validation). Drives BOTH settings surfaces:
 *  - the per-project **Flow settings** overlay (the .flowconfig editor), which
 *    auto-opens the first time an unconfigured project becomes active;
 *  - the app-level **Settings** overlay (accounts + model routing + onboarding
 *    re-entry), dispatched by the titlebar via `flow:open-settings`.
 *
 * Covers:
 *  - the Auto-PR ⇒ push+commit dependency guardrail and its inverse
 *    (push OFF clears PR, disables the Target-branch field);
 *  - #369 (now FIXED, PR #371): the "Max verify retries" number field reverts a
 *    cleared entry to its effective value and clamps out-of-range input into
 *    [1, 5] — asserted positively (was a `test.fail` guard before the fix);
 *  - the main Settings overlay: accounts empty state, model-routing edit that
 *    persists across a close/reopen, "Reset to suggested", and the "Getting
 *    Started…" affordance that closes Settings and opens the onboarding wizard.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

/** addRoot + setActiveProject WITHOUT dismissing the auto-opened flow overlay. */
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

/** Toggle button in the flow-settings overlay, located by its row label. */
function toggleByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label }).locator('.fl-fs-toggle')
}

// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'

/** Open the Settings page on `group` (the page remembers the last group). */
async function openSettings(win: Page, group = 'Models'): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible()
  await win.locator('.fl-settings-tab', { hasText: group }).click()
  await expect(win.locator('.fl-settings-tab.active')).toHaveText(group)
}

/** Close the Settings tab from the tab strip — a page does not close on Escape. */
async function closeSettings(win: Page): Promise<void> {
  await win.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close').first().click()
  await expect(win.locator(SETTINGS_OVERLAY)).toBeHidden()
}

test.afterEach(() => cleanupSeeds())

test.describe('flow-settings overlay', () => {
  test('Auto-PR guardrail forces push + commit, and push-off reverses it', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    // The Git & PR toggles moved off the per-project Flow settings overlay onto
    // the unified Settings page's Conversation files group (88edc2a8) — one
    // door for this project's publishing behaviour. Dismiss the auto-opened
    // overlay and drive them where a person now finds them.
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(1)
    await window.keyboard.press('Escape')
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)
    await openSettings(window, 'Conversation files')
    const overlay = window.locator(`${SETTINGS_OVERLAY} .fl-settings-group:not([hidden])`)

    const prToggle = toggleByLabel(overlay, 'Auto-create PR')
    const pushToggle = toggleByLabel(overlay, 'Auto-push when done')
    const commitToggle = toggleByLabel(overlay, 'Auto-commit per task')
    // (A "Base branch" row used to sit beside these and was asserted untouched
    // by the cascade; it left the UI with the worktree settings in e2c822db.)

    // Start: everything off.
    await expect(prToggle).toHaveAttribute('aria-checked', 'false')

    // Turning Auto-PR on must force push + commit on (dependency guardrail).
    await prToggle.click()
    await expect(prToggle).toHaveAttribute('aria-checked', 'true')
    await expect(pushToggle).toHaveAttribute('aria-checked', 'true')
    await expect(commitToggle).toHaveAttribute('aria-checked', 'true')

    // Turning push back off must clear Auto-PR.
    await pushToggle.click()
    await expect(pushToggle).toHaveAttribute('aria-checked', 'false')
    await expect(prToggle).toHaveAttribute('aria-checked', 'false')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  // #369 (fixed, PR #371) — the "Max verify retries" number field must never be
  // left blank or out of range: a cleared entry reverts to its effective value
  // and an out-of-range entry clamps into [min, max] = [1, 5]. Before the fix
  // this was a `test.fail` guard; it is now a positive regression assertion.
  test('Max verify retries reverts a cleared entry and clamps out of range (#369)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    const num = overlay.locator('input[type="number"][data-field-key="max_verify_retries"]')
    await expect(num).toHaveValue('2') // ships defaulting to 2

    // Set a non-default effective value (3), so we can prove clear reverts to the
    // *effective* value, not the hard-coded default.
    await num.fill('3')
    await num.blur()
    await expect(num).toHaveValue('3')

    // Clearing writes no diff (no state echo) — the view must restore the display
    // itself, to the effective value (3), never blank.
    await num.fill('')
    await num.blur()
    await expect(num).toHaveValue('3')

    // Below min clamps up to 1; above max clamps down to 5.
    await num.fill('0')
    await num.blur()
    await expect(num).toHaveValue('1')
    await num.fill('99')
    await num.blur()
    await expect(num).toHaveValue('5')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})

/**
 * The app-level Settings overlay (`flow:open-settings`) — accounts, model
 * routing, and the onboarding re-entry point. No account/credentials needed:
 * a fresh launch shows the empty accounts state, and model routing is a pure
 * local map. Guards that the routing edits persist, Reset works, and Getting
 * Started is a live affordance (not a dead click).
 */

test.describe('Settings overlay (accounts + model routing)', () => {
  test('opens with the accounts empty state and the three routing rows', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await openSettings(window)
    const overlay = window.locator(SETTINGS_OVERLAY)
    // A fresh userData dir has no Claude account → the empty-state hint shows.
    await expect(overlay.locator('.fl-settings-empty', { hasText: 'No accounts yet' })).toBeVisible()
    // Model routing ships one row per effort level with a suggested default.
    await expect(overlay.locator('select[aria-label="Model for Low effort"]')).toHaveValue('haiku')
    await expect(overlay.locator('select[aria-label="Model for Medium effort"]')).toHaveValue(
      'sonnet',
    )
    await expect(overlay.locator('select[aria-label="Model for High effort"]')).toHaveValue('opus')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('a routing edit persists across reopen, and Reset restores suggestions', async ({
    window,
  }) => {
    await openSettings(window)
    const low = window.locator(SETTINGS_OVERLAY).locator('select[aria-label="Model for Low effort"]')
    await low.selectOption('opus')

    // Close and reopen — the edited routing must have persisted.
    await closeSettings(window)
    await openSettings(window)
    const low2 = window
      .locator(SETTINGS_OVERLAY)
      .locator('select[aria-label="Model for Low effort"]')
    await expect(low2).toHaveValue('opus')

    // "Reset to suggested" returns Low → haiku (its default).
    await window.locator(SETTINGS_OVERLAY).locator('button', { hasText: 'Reset to suggested' }).click()
    await expect(low2).toHaveValue('haiku')
  })

  test('"Getting Started…" opens the onboarding wizard as the only dialog', async ({ window }) => {
    await openSettings(window, 'App')
    await window.locator(SETTINGS_OVERLAY).locator('button', { hasText: 'Getting Started' }).click()
    // The first-run wizard (its own .fl-wizard-body) opens. Settings is a TAB
    // now, not a modal, so it stays in the editor area underneath; what must
    // not happen is two dialogs stacked — the wizard is the only overlay up.
    await expect(
      window.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'),
    ).toBeVisible()
    await expect(window.locator('.fl-settings-overlay:not([hidden])')).toHaveCount(1)
  })
})

/**
 * Appearance selector (#399) — the app-theme <select> (Light / Dark / System)
 * that drives the single `<html data-theme>` signal every surface follows. The
 * existing Settings tests never touch it; this guards that picking a theme both
 * (a) restamps `<html data-theme>` live and (b) survives a close/reopen.
 */
test.describe('Settings overlay (appearance)', () => {
  const htmlTheme = (win: Page) =>
    win.evaluate(() => document.documentElement.dataset['theme'])

  test('theme selector restamps <html data-theme> and persists across reopen', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await openSettings(window, 'App')
    const theme = window.locator(SETTINGS_OVERLAY).locator('select[aria-label="App theme"]')
    await expect(theme).toHaveCount(1)

    // Light → the whole app must stamp data-theme=light immediately.
    await theme.selectOption('light')
    await expect.poll(() => htmlTheme(window)).toBe('light')
    // Dark → data-theme=dark.
    await theme.selectOption('dark')
    await expect.poll(() => htmlTheme(window)).toBe('dark')

    // Close + reopen: the chosen mode must have persisted (localStorage), not
    // reset to the default.
    await closeSettings(window)
    await openSettings(window, 'App')
    await expect(
      window.locator(SETTINGS_OVERLAY).locator('select[aria-label="App theme"]'),
    ).toHaveValue('dark')
    await expect.poll(() => htmlTheme(window)).toBe('dark')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})

/**
 * The "This project" account-binding section only renders when a project is
 * active — so the credential-less Settings tests above (no seeded project)
 * never exercise it. Seed + activate a throwaway project, then assert the
 * section renders with its account <select> and a non-broken resolution hint.
 */
test.describe('Settings overlay (this-project account binding)', () => {
  test('renders the account-binding select for the active project', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    // The per-project flow overlay auto-opens first — dismiss it before Settings.
    await window.keyboard.press('Escape')
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)

    await openSettings(window)
    const section = window
      .locator(SETTINGS_OVERLAY)
      .locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
    await expect(section).toHaveCount(1)
    await expect(section.locator('select.fl-settings-select')).toHaveCount(1)
    // With no accounts, the project falls back to the default account — the hint
    // must say so (not a blank/broken line).
    await expect(section.locator('.fl-settings-hint')).toContainText('default account')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})

// Integrations is a group of the Settings PAGE (not an overlay since
// 2026-09-05); `flow:open-integrations` opens the page on that group. Only the
// visible group is searched, so a provider name in another tab cannot match.
const INT_OVERLAY = '.fl-settings-page .fl-settings-group:not([hidden])'

test.describe('integrations overlay', () => {
  // Jira needs all three fields; a partial fill + Connect must give visible
  // feedback ("Fill every field"), never a silent no-op, and editing any field
  // must clear that hint back to the action label. Jira is deterministic (it is
  // never CLI-connected), unlike GitHub/Azure which vary with the local gh/az
  // login — so the gating guard rides on Jira.
  test('empty/partial Connect surfaces feedback, and editing clears it', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await window.evaluate(() =>
      document.dispatchEvent(new CustomEvent('flow:open-integrations')),
    )
    const overlay = window.locator(INT_OVERLAY).first()
    await overlay.waitFor({ state: 'visible', timeout: 15_000 })

    const jira = overlay.locator('.fl-settings-section', { hasText: 'Jira' })
    await jira.locator('.fl-int-heading').waitFor({ state: 'visible', timeout: 8000 })
    // Integration secrets live in ~/.flow/credentials.json, OUTSIDE the
    // per-test userData dir, so a machine with Jira really connected shows it
    // connected here too. The empty-form case needs a disconnected Jira; never
    // touch a real stored credential to get one.
    const pill = jira.locator('.fl-int-pill')
    await expect(pill).not.toHaveText(/Checking/)
    test.skip(
      !/^Not connected$/.test((await pill.innerText()).trim()),
      'Jira is connected on this machine (~/.flow/credentials.json is shared with e2e)',
    )
    await expect(pill).toHaveText('Not connected')

    const jiraSave = jira.locator('.fl-int-save')
    await expect(jiraSave).toHaveText('Connect')
    // Fill only Site — the other two required fields stay blank.
    await jira.locator('.fl-int-field', { hasText: 'Site' }).locator('input').fill('team.atlassian.net')
    await jiraSave.click()
    await expect(jiraSave).toHaveText('Fill every field')
    // Editing any field clears the hint back to the action label.
    await jira.locator('.fl-int-field', { hasText: 'Account email' }).locator('input').fill('a@b.com')
    await expect(jiraSave).toHaveText('Connect')

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })


  // #419 — a GitHub/Azure connection can come purely from the gh/az CLI login
  // (pill: "Connected · via gh CLI"), with no stored token. The panel still
  // offers a "Disconnect" button, but clicking it only clears a stored
  // credential (there is none) and re-renders identically — a silent no-op with
  // no feedback. Expected: a Disconnect click on a connected provider should
  // change the visible state (or the button shouldn't be offered / should give
  // feedback for CLI-derived connections). Marked test.fail until fixed.
  //
  // Skips unless GitHub is CLI-connected in the environment (CI without gh auth
  // reports "Not connected" — nothing to disconnect, so nothing to assert).
  test.fail('Disconnect on a connected provider changes its state (#419)', async ({ window }) => {
    await window.evaluate(() =>
      document.dispatchEvent(new CustomEvent('flow:open-integrations')),
    )
    const overlay = window.locator(INT_OVERLAY).first()
    await overlay.waitFor({ state: 'visible', timeout: 15_000 })

    const gh = overlay.locator('.fl-settings-section', { hasText: 'GitHub' })
    await gh.locator('.fl-int-heading').waitFor({ state: 'visible', timeout: 8000 })
    const pill = gh.locator('.fl-int-pill')
    const before = await pill.innerText()
    test.skip(!before.includes('via gh CLI'), 'GitHub not connected via gh CLI in this env')

    await gh.locator('.fl-int-disconnect').click()
    await window.waitForTimeout(1500)

    // Expected once fixed: Disconnect produces a visible change (state or feedback),
    // rather than re-rendering byte-for-byte identically.
    await expect(pill).not.toHaveText(before)
  })
})
