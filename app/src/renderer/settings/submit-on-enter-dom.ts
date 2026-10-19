/**
 * Enter-submits wiring for the settings family (#1396). The decision lives in
 * submit-on-enter.ts, DOM-free so it unit-tests; this needs a real DOM.
 */
import { shouldSubmitOnEnter } from './submit-on-enter'

/**
 * Make Enter on `input` do what `button` does. Ignores the key while the
 * button is disabled (an in-flight action must not be re-fired) and during IME
 * composition (Enter commits a candidate — it is not a submit).
 */
export function submitOnEnter(input: HTMLInputElement, button: HTMLElement): void {
  input.addEventListener('keydown', (event) => {
    const disabled =
      button.hasAttribute('disabled') || (button as HTMLButtonElement).disabled === true
    if (!shouldSubmitOnEnter({ key: event.key, isComposing: event.isComposing, disabled })) return
    event.preventDefault()
    button.click()
  })
}
