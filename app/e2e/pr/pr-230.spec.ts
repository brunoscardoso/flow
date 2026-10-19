import { test, expect } from '../fixtures/electron'

/**
 * Regression for PR #230 — "surface integration token save/clear failures + fix
 * stuck hint (#217)".
 *
 * In the Integrations settings overlay, saving (`Connect` / `Update token` →
 * `setToken`) or clearing (`Disconnect` → `clearToken`) a provider credential
 * chained `.then(re-render).catch(console.error)`, so a rejection was a silent
 * dead click: no toast, no re-render, label unchanged, typed token still in the
 * field — a false sense of connection state for a security-adjacent action.
 * #230:
 *   - toasts on rejection via the `flow:notify` bridge, naming the provider
 *     (pure `tokenSaveFailedToast` / `tokenClearFailedToast`, imported at module
 *     scope by `integrations-settings-view.ts`);
 *   - disables the button during the in-flight write (no double-submit) and
 *     restores it on failure;
 *   - resets the transient "Fill every field" hint the moment the user edits a
 *     field, instead of leaving it stuck on the button.
 *
 * The failure toast itself needs a rejecting `setToken`/`clearToken` IPC call,
 * not drivable from a fresh, credential-less launch, and the toast builders are
 * fully covered by `settings-feedback.test.ts`. This spec guards the
 * headlessly-observable half: the overlay is reachable and renders. A
 * broken/renamed export from the new `./settings-feedback` import would crash
 * the integrations bundle, so the overlay rendering its provider sections and
 * Connect buttons proves that wiring resolved and the `#section` render path
 * #230 modified mounts without throwing.
 */
test.describe('PR #230 — Integrations overlay (settings-feedback import intact)', () => {
  test('renders the Integrations group on the settings page', async ({ window }) => {
    // NOT AN OVERLAY (2026-09-05). Integrations were a modal reached from
    // Settings by pressing a button — a door inside a door — and the provider
    // sections render on the page itself now. The import this case guards is
    // proved by those sections rendering at all.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))

    // Mounted — proof integrations-settings-view.ts's module-scope
    // `import { tokenSaveFailedToast, tokenClearFailedToast } from
    // './settings-feedback'` resolved and the view rendered without throwing.
    await expect(window.locator('.fl-settings-page')).toBeVisible({ timeout: 15_000 })
    await expect(window.locator('.fl-settings-tab.active')).toHaveText('Integrations')

    // The #section render path #230 modified mounts: a provider save button
    // (label from the `saveLabel` binding the fix reads/restores — "Connect"
    // when disconnected, "Update token" when a credential is already stored,
    // which on a developer machine with `gh` signed in is the GitHub case).
    const group = window.locator('.fl-settings-group:not([hidden])')
    await expect(group.locator('.fl-int-save').first()).toBeVisible({ timeout: 30_000 })
    // Three provider cards (GitHub, Jira, Azure DevOps), each headed by its name.
    // The group also holds the un-headed "close the remote ticket on Done"
    // preference (#1885), which is not a provider and is not counted here.
    await expect(group.locator('.fl-settings-section:has(.fl-settings-heading)')).toHaveCount(3)
  })
})
