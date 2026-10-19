import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * The activity-bar rail switches the side panel between Threads / Files / Source
 * Control (#335, post-#674 — the former .fl-sidetabs Files|Source-Control strip is
 * now rail switch-items). Threads is active on fresh launch; clicking Source Control
 * switches the active item, and its Changes|Phases view-mode toggle swaps the visible
 * sub-body (Phases mounts the folded-in review surface).
 */
test.describe('files / source control side panel (activity-bar rail)', () => {
  test('exactly one rail switch-item is active, defaulting to Threads', async ({ window }) => {
    const active = window.locator('.fl-activity-bar .fl-rail-item.active')
    await expect(active).toHaveCount(1)
    await expect(window.locator('[data-rail-item="threads"]')).toHaveClass(/active/)
  })

  test('Source Control → Phases activates the rail item and mounts the review body', async ({
    window,
  }) => {
    const sc = window.locator('[data-rail-item="source-control"]')
    await sc.click()
    await expect(sc).toHaveClass(/active/)
    await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
    await expect(window.locator('.fl-review')).toBeAttached()
  })

  test('can switch back to Files', async ({ window }) => {
    await window.locator('[data-rail-item="source-control"]').click()
    const files = window.locator('[data-rail-item="files"]')
    await files.click()
    await expect(files).toHaveClass(/active/)
  })
})
