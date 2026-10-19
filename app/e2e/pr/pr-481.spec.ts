import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression guard for PR #481 (fixes #475): the onboarding wizard's
 * **Escape-to-close** must fire from ANY focus, not just when focus is inside
 * the overlay.
 *
 * The original bug: the Escape handler was bound to the overlay element, so
 * `keydown` only reached it while `document.activeElement` was inside the
 * overlay. On macOS a button click doesn't move focus to the button, so after
 * the very first interaction focus falls back to `<body>` — and Escape became a
 * dead key. The fix binds the handler to `document` (added on open, removed on
 * close), matching the sibling Settings overlay.
 *
 * This spec reproduces the exact failure condition deterministically: it drives
 * the wizard, then blurs the active element so focus lives on `<body>` (outside
 * the overlay) — the state the old overlay-bound listener could not hear — and
 * asserts Escape still dismisses the wizard back to an interactive shell.
 *
 * The base onboarding specs and `onboarding-reopen.spec.ts` deliberately did NOT
 * assert Escape while #475 was open (they dismiss via "Skip for now"); this is
 * the missing guard for that behavior.
 *
 * Uses the raw `app` fixture (fresh, credential-less userData) where the
 * "Welcome to Flow" wizard opens over the shell — the same surface the base
 * onboarding spec drives.
 */

test('Escape closes the wizard even when focus has fallen to <body> after an interaction', async ({
  app,
}) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const wizard = win.locator(sel.onboardingVisible)
  await expect(wizard).toHaveCount(1)

  // Interact with the wizard (advance a step), like a real user would before
  // reaching for Escape. After this, focus is no longer on the panel.
  // The runtime step now sits between Welcome and Connect: which agent
  // runs is chosen before whose account gets connected.
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose your agent')
  await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
  await expect(wizard.locator('.fl-settings-header')).toContainText('Connect a Claude account')

  // Force the exact broken condition: focus outside the overlay (on <body>).
  // With the old overlay-bound listener, a document-level Escape here never
  // reached the handler; with the fix (document-bound), it does.
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const activeIsBody = await win.evaluate(() => document.activeElement === document.body)
  expect(activeIsBody).toBe(true)

  await win.keyboard.press('Escape')

  // The wizard is dismissed and the shell is interactive — no trapped overlay.
  await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)
  await expect(win.locator(sel.threadSidebar)).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('Escape closes the wizard on the very first step (focus on <body>)', async ({ app }) => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  const wizard = win.locator(sel.onboardingVisible)
  await expect(wizard).toHaveCount(1)
  await expect(wizard.locator('.fl-settings-header')).toContainText('Welcome to Flow')

  // Even without stepping forward, once focus leaves the panel Escape must work.
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await win.keyboard.press('Escape')

  await expect(win.locator(sel.onboardingVisible)).toHaveCount(0)
  await expect(win.locator(sel.threadSidebar)).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
