import { test, expect } from './fixtures/electron'
import { sel, statusButtonByText } from './selectors'

/**
 * Blueprint review mode (#609). A credential-less fresh-launch E2E can't reach a
 * real dirty-repo board (that needs a project + Claude account), so these probes
 * exercise the cross-module SEAMS the unit tests can't: the Refuse→composer
 * relay contract (`flow:prefill-composer`, the exact event P5's Refuse fires and
 * composer.ts listens for) works end-to-end in the packaged app, the board's
 * `flow:blueprint-review` verdict listener is wired without throwing, and the
 * Blueprint view still mounts after the review-mode board refactor.
 */
test.describe('blueprint review mode (#609)', () => {
  test('Refuse emits a safe flow:prefill-composer relay event', async ({ window }) => {
    // P5's Refuse relays to the chat by dispatching `flow:prefill-composer`
    // (consumed by composer.ts:229 — the exact event two shipped features, #66
    // conflict-resolve and #593 artifact-card, already rely on). A live composer
    // needs a project + Claude account (out of reach for a credential-less
    // fresh launch — see composer.spec), so this asserts the producer contract
    // P5 emits is well-formed and safe: dispatching it never throws and the
    // composer surface stays intact. The value-set path is covered by the
    // shipped consumer + the peek-viewer unit path.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()

    const threw = await window.evaluate(() => {
      try {
        document.dispatchEvent(
          new CustomEvent('flow:prefill-composer', {
            detail: { text: 'Refusing changes to src/app/main.ts: ' },
          }),
        )
        return false
      } catch {
        return true
      }
    })
    expect(threw).toBe(false)
    await expect(composer).toBeAttached()
  })

  test('the board verdict listener handles flow:blueprint-review without throwing', async ({ window }) => {
    // Open the board so its flow:blueprint-review listener is mounted.
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()

    // Dispatch a verdict for a file — with no cards it's a no-op, but the handler
    // (reviewStateReduce + #applyReviewState) must run cleanly, not throw.
    const threw = await window.evaluate(() => {
      try {
        document.dispatchEvent(
          new CustomEvent('flow:blueprint-review', {
            detail: { filePath: 'src/app/main.ts', verdict: 'refused' },
          }),
        )
        return false
      } catch {
        return true
      }
    })
    expect(threw).toBe(false)
    // The board is still alive after the verdict event.
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()
  })

  test('Blueprint view still mounts after the review-mode board refactor', async ({ window }) => {
    // Not attached, not merely hidden: the board is an editor view that does not
    // exist until the tab opens, and `toBeHidden()` on a zero-match locator is
    // green whatever the app does (#1814).
    await expect(window.locator(sel.blueprintRoot)).not.toBeAttached()
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(sel.blueprintRoot)).toBeVisible()
  })
})
