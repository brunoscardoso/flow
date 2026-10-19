import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Regression for PR #137 — the live "· using <model>" indicator in the composer
 * (part of #129). The PR added a `.fl-composer-model-indicator` span next to the
 * model picker that reads the SDK-resolved model (accurate even for `auto`) and
 * is shown ONLY while the turn is `working`, hidden when idle.
 *
 * The indicator only populates+shows once a turn emits a `system/init` model
 * event, which needs a project + Claude account to run an agent — out of reach
 * for a fresh, credential-less E2E launch (see e2e/README.md "Known gate"). The
 * `modelLabel` mapping (`claude-opus-4-8` → "Opus 4.8", `auto` → "Auto", …) is
 * covered by `model-label.test.ts`.
 *
 * What IS observable headlessly — and what this spec guards — is the wiring the
 * PR added to the composer: the indicator element must be MOUNTED in the
 * composer controls (a throw while building it would take the whole composer
 * down) and must default to HIDDEN with no active turn, so an idle thread never
 * shows a stale "using <model>" chip. This pins both facts so a regression in
 * the composer render path or the idle-visibility default fails loudly here.
 */
test.describe('PR #137 — live "using <model>" composer indicator', () => {
  test('the model indicator is mounted in the composer and hidden while idle', async ({
    window,
  }) => {
    // Composer is mounted (gated/hidden until a thread is active — see
    // composer.spec.ts), and so is the indicator the PR added inside it.
    const composer = window.locator(sel.composer)
    await expect(composer).toBeAttached()

    const indicator = window.locator(sel.composerModelIndicator)
    await expect(indicator).toBeAttached()

    // No turn is working on a fresh launch, so the indicator must be hidden —
    // it carries the `hidden` attribute by default (not just via the gated
    // composer being display:none).
    await expect(indicator).toHaveAttribute('hidden', '')
    await expect(indicator).toBeHidden()
  })
})
