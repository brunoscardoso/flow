/**
 * SIGNING IN CHANGES WHO YOU ARE AND NOTHING ELSE.
 *
 * That is two claims, and they need different proofs:
 *
 *  · the surfaces exist and behave — Settings shows a state, the wizard offers
 *    a step and lets you straight past it
 *  · the app does not behave differently for it — which is an ABSENCE, and an
 *    absence is only evidence when the alternative was reachable
 *
 * A full round trip through GitHub is not driveable here: it needs a real OAuth
 * app, a real browser and a real person. What IS driveable is everything either
 * side of it: nobody is signed in on a fresh profile, so this pins the
 * signed-out state every new install starts in.
 *
 * THIS SPEC NEEDS A CONFIGURED PROVIDER, AND THAT IS NOW PER-MACHINE. The
 * endpoint and GitHub client id used to be committed in app/build-config.json
 * (c1534e24, "one sign-in state"). They were moved to the git-ignored
 * app/.flow-build.local.json when the repo was published: a clone must not
 * inherit someone else's OAuth app, and `configuredProvider` treats an absent
 * value as "no sign-in", which is the right answer for a fork. The committed
 * file is blank, so `authAvailable()` is false on a fresh clone and the first
 * assertion below fails there rather than skipping. That is deliberate — a
 * skip would read as coverage — but it means this spec is a check on a
 * configured machine, not on an unconfigured one.
 */
import { test, expect } from '../fixtures/electron'

const PAGE = '.fl-settings-page'

async function openAppTab(window: import('@playwright/test').Page): Promise<void> {
  await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await expect(window.locator(PAGE)).toBeVisible({ timeout: 30_000 })
  await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
}

test('Settings shows an Account section, honestly, signed out', async ({
  window,
}) => {
  test.setTimeout(120_000)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(1000)
  await openAppTab(window)

  // SCOPED TO THE VISIBLE PANEL, and matched on the heading exactly. "Account"
  // also appears in the Models tab (the Claude logins), which is hidden here —
  // a looser selector resolved to that one and waited out its timeout on a
  // section that was never going to be shown.
  const section = window
    .locator('.fl-settings-group:not([hidden]) .fl-settings-section')
    .filter({ has: window.locator('.fl-settings-heading', { hasText: /^Account$/ }) })
    .first()
  await expect(section).toBeVisible({ timeout: 30_000 })

  // SIGNED OUT, WITH A PROVIDER: exactly one way in, and no claim that signing
  // in is unavailable. (Not clicked — it opens a real browser to GitHub.)
  await expect(section.locator('button', { hasText: 'Sign in with GitHub' })).toHaveCount(1)
  await expect(section).not.toContainText("isn't available in this build")

  // …and it never promises sync, which does not exist.
  await expect(section).not.toContainText(/sync/i)
})

test('the channels answer, and say nothing about a token', async ({ window }) => {
  test.setTimeout(120_000)
  const answers = await window.evaluate(async () => {
    const s = (window as unknown as { flow: Record<string, any> }).flow.settings
    return {
      who: await s.whoAmI(),
      available: await s.authAvailable(),
      signOut: await s.signOut(),
    }
  })
  // POSITIVE BEFORE ABSENCE: the channels really are wired and answering.
  // The provider is compiled in from app/build-config.json, so sign-in is
  // available; nobody has used it on this fresh profile.
  expect(answers.available).toBe(true)
  expect(answers.who).toBeNull()
  expect(answers.signOut).toHaveProperty('detail')
  // SIGN-OUT SAYS WHAT IT DID — and with nobody signed in, it says so rather
  // than claiming to have removed something.
  expect(String(answers.signOut.detail)).toMatch(/already signed out/i)
  expect(JSON.stringify(answers)).not.toMatch(/\btoken\b/i)
})

/**
 * THE WIZARD STEP IS NOT DRIVEN HERE, and the reason is the harness rather than
 * the feature: `e2e/fixtures/electron.ts` DISMISSES the first-run wizard before
 * handing a spec its window, because every other spec needs a clean shell. There
 * is no way to reopen it from a bundled renderer.
 *
 * Its one load-bearing claim — that Next is never blocked by the sign-in step —
 * is pinned in `wizard-controller.test.ts` instead, with a plant: giving the
 * step a `canAdvance` case that returns false fails that suite. Writing a spec
 * here that skipped itself would have looked like coverage and been none.
 */

test('signing in gates nothing — every surface works signed out', async ({ window }) => {
  test.setTimeout(120_000)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(800)

  // Nobody is signed in…
  const who = await window.evaluate(async () =>
    (window as unknown as { flow: Record<string, any> }).flow.settings.whoAmI(),
  )
  expect(who).toBeNull()

  // …and the app's surfaces still open. These are the things a gate would take
  // away first, so their working IS the claim.
  await openAppTab(window)
  await expect(window.locator('.fl-settings-section', { hasText: 'Privacy' })).toBeVisible()
  await expect(window.locator('.fl-settings-section', { hasText: 'Appearance' })).toBeVisible()
  const close = window.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close')
  if ((await close.count()) > 0) await close.first().click()

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
  await expect(window.locator('.fl-term-host:not([hidden])').first()).toBeVisible({
    timeout: 30_000,
  })
})
