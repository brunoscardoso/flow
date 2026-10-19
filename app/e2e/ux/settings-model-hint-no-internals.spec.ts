import { test, expect } from '../fixtures/electron'

/**
 * The Model settings hint names the place a person can act, not a file.
 *
 * It used to read "A project can override this in its flow/.flowconfig
 * (provider: …)" — a file path and a config key in UI text, which is
 * forbidden-pattern #12. The app already offers the real action: the Runtime
 * select in a project's Flow settings pins its provider. So the hint points
 * there.
 */
const SETTINGS_PAGE = '.fl-settings-page'

test('the Model settings hint points at Flow settings, not a config file', async ({ window }) => {
  await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  const page = window.locator(SETTINGS_PAGE)
  await expect(page).toBeVisible()

  const section = page.locator('.fl-settings-section', {
    has: window.locator('.fl-settings-heading', { hasText: 'Model settings' }),
  })
  // Positive first: the section and its hint really rendered.
  await expect(section).toHaveCount(1)
  const hint = section.locator('.fl-settings-hint').first()
  await expect(hint).toContainText('The agent runtime new threads use.')
  await expect(hint).toContainText('Flow settings')

  const text = (await hint.textContent()) ?? ''
  expect(text).not.toContain('flowconfig')
  expect(text).not.toContain('provider:')
})
