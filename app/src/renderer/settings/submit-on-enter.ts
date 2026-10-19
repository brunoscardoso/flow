/**
 * Enter submits, in the settings family (#1396) — one code path.
 *
 * Every text field in `src/renderer/settings/` ignored Enter. There is no
 * `<form>` and no keydown handler there except the overlays' Escape listeners,
 * while 20 other surfaces in the renderer do handle it.
 *
 * The user-visible case: Settings → Model settings → Accounts. Type a name,
 * press Enter, and nothing happens — no account, no "signing in…", and not
 * even the `Enter an account name first.` hint the BUTTON shows for a blank
 * field (#834). Total silence, on the primary action of the overlay's first
 * section.
 *
 * Wiring the input to the BUTTON (rather than to a copy of its logic) is the
 * point: validation, the disabled state and the feedback contract stay in one
 * place, so Enter and the click can never disagree about what happens.
 *
 * The DECISION is pure and DOM-free (so it unit-tests under the node jest
 * env); submit-on-enter-dom.ts is the wiring.
 */

/**
 * Whether this keydown should fire the section's primary action.
 *
 * Not while the button is disabled — an in-flight sign-in must not be
 * re-fired — and not during IME composition, where Enter commits a candidate
 * rather than submitting anything.
 */
export function shouldSubmitOnEnter(state: {
  key: string
  isComposing: boolean
  disabled: boolean
}): boolean {
  return state.key === 'Enter' && !state.isComposing && !state.disabled
}
