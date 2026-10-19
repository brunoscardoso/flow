import { test, expect } from './fixtures/electron'
import { sel } from './selectors'

/**
 * Conversation area first-run state. The composer only becomes visible once a
 * thread is active (which needs a project + Claude account — out of reach for a
 * fresh-launch, credential-less E2E run). So this asserts the empty state a
 * first-run user actually sees and that the composer stays gated until then.
 */
test.describe('conversation first-run state', () => {
  test('shows the empty conversation and gates the composer', async ({ window }) => {
    await expect(window.locator(sel.conversation)).toBeAttached()
    await expect(window.locator('.fl-conv-empty')).toBeAttached()

    // Composer is mounted but hidden with no active thread.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()
    await expect(composer).toBeHidden()
  })
})
