/**
 * THE PRIVACY SECTION, THROUGH THE CONTROL A PERSON USES.
 *
 * The section's whole claim is that somebody can come here, see what is being
 * sent, and change their mind. None of that is provable from a unit test: the
 * copy model is pure and tested beside itself, but whether the section is
 * REACHABLE — mounted, in the right tab, wired to the store — is exactly the
 * class of bug that shipped three times in this feature's neighbourhood, each
 * time with a green suite behind it.
 *
 * So this opens Settings the way a person does, clicks the real switch, and
 * asserts the consequence: the list of what is sent appears when sharing is on
 * and is gone when it is off, and the answer survives a reopen.
 */
import { test, expect } from '../fixtures/electron'

// SETTINGS IS A PAGE, not an overlay — it moved into the editor area with its
// groups behind tabs, and a spec written against the old selector waits out its
// timeout on a screen that is actually open.
const PAGE = '.fl-settings-page'

async function openAppTab(window: import('@playwright/test').Page): Promise<void> {
  // Through the real button, whose click is what dispatches the open event.
  await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await expect(window.locator(PAGE)).toBeVisible({ timeout: 30_000 })
  await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
}

test('the privacy section shows what is sent, and the switch changes it', async ({ window }) => {
  test.setTimeout(180_000)

  // The first-run overlay auto-opens on a fresh profile; it owns the keyboard
  // until it is dismissed, so the click below would land on nothing.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(1000)

  await openAppTab(window)

  const section = window.locator('.fl-settings-section', { hasText: 'Privacy' }).first()
  await expect(section).toBeVisible({ timeout: 30_000 })

  const toggle = section.locator('input[type="checkbox"]')
  // THE SWITCH IS LIVE. A section that mounted but whose consent never loaded
  // leaves this disabled for ever, which looks identical to a working one in a
  // screenshot and is the failure this waits out rather than races.
  await expect(toggle).toBeEnabled({ timeout: 30_000 })

  // WHAT NEVER LEAVES is shown in every state — it is what somebody checks
  // BEFORE agreeing, so it cannot be behind the agreement.
  const never = section.locator('.fl-settings-privacy-never li')
  await expect(never.first()).toBeVisible()
  await expect(section).toContainText('Never sent')
  const neverCount = await never.count()
  expect(neverCount).toBeGreaterThan(0)

  // ── ON ───────────────────────────────────────────────────────────────────
  if (!(await toggle.isChecked())) await toggle.check()
  await expect(toggle).toBeChecked()
  // The derived list of what IS sent appears only now.
  await expect(section.locator('.fl-settings-privacy-line').first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(section).toContainText('About this installation')
  // THE DISCLOSURE IS DERIVED, and this is what that buys. `identityId` was
  // added to the contract for sign-in and nobody edited this panel — if the
  // list were hand-written, the app would now be collecting a field it does not
  // mention. The wording comes from the allowlist, so it cannot fall behind it.
  await expect(section).toContainText('once you sign in')
  await expect(section).toContainText('About how you use it')
  await expect(section).toContainText('sharing')

  // …and the store agrees — not just the pixel.
  await expect
    .poll(async () => window.evaluate(async () =>
      (window as unknown as { flow: Record<string, any> }).flow.settings.getTelemetryConsent(),
    ), { timeout: 30_000 })
    .toBe(true)

  // ── OFF ──────────────────────────────────────────────────────────────────
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  // POSITIVE BEFORE ABSENCE (allowed-pattern #28): the promise list is still
  // there, so "the sent-list is gone" is a real disappearance and not the whole
  // section having unmounted underneath the assertion.
  await expect(section.locator('.fl-settings-privacy-never li').first()).toBeVisible()
  await expect(section.locator('.fl-settings-privacy-line')).toHaveCount(0)
  await expect(section).not.toContainText('About how you use it')

  await expect
    .poll(async () => window.evaluate(async () =>
      (window as unknown as { flow: Record<string, any> }).flow.settings.getTelemetryConsent(),
    ), { timeout: 30_000 })
    .toBe(false)

  // ── AND IT STUCK ─────────────────────────────────────────────────────────
  // Reopened from scratch, because the section reads its own value on mount and
  // a panel that only remembered within one paint is the bug a person finds by
  // coming back to check.
  // Closed from the TAB STRIP — Settings is a page and has no dismiss key of
  // its own; Escape leaves it open, which is how this step first failed.
  const close = window
    .locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' })
    .locator('.close')
  if ((await close.count()) > 0) await close.first().click()
  await expect(window.locator(PAGE)).toBeHidden({ timeout: 30_000 })
  await openAppTab(window)
  const reopened = window.locator('.fl-settings-section', { hasText: 'Privacy' }).first()
  await expect(reopened.locator('input[type="checkbox"]')).toBeEnabled({ timeout: 30_000 })
  await expect(reopened.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect(reopened).toContainText('not sending')
})
