/**
 * A button that is waiting for something (user report 2026-08-26: "its taking
 * long to show, and there is no loader").
 *
 * WHERE THE WAIT BELONGS. The control that was pressed, because that is where
 * the person is already looking. The alternative this replaced — putting an
 * empty dialog on screen and filling it in when the read lands — interrupts
 * without informing: a box that says nothing yet is not feedback, it is a
 * question the reader now has two of.
 *
 * IT KEEPS THE BUTTON'S SIZE. The label is replaced by a spinner AND the same
 * label, not by the spinner alone, so the row does not reflow under the
 * pointer mid-click — a control that shrinks while being pressed is how a
 * second click lands somewhere else.
 *
 * Shared rather than restated: two surfaces open the same slow dialog (Flow
 * settings and the git panel's landing block), and a wait implemented twice is
 * two behaviours that drift.
 *
 * NO UNIT TEST, and the reason is structural rather than a shortcut:
 * `tsconfig.test.json` includes only src/main, src/preload and src/shared, so
 * anything under src/renderer compiles for jest WITHOUT the DOM lib — this file
 * cannot name `HTMLButtonElement` or touch `document` there at all. A test was
 * written and deleted rather than left red. It is exercised through the two
 * controls that use it and verified on screen.
 */

/**
 * Put `button` into its waiting state. Returns the undo — call it when the
 * thing being waited for is on screen.
 *
 * Idempotent in the way that matters: a second call while already waiting is a
 * no-op, so a double-press cannot stack two spinners or leave one behind.
 */
export function beginButtonWait(button: HTMLButtonElement): () => void {
  if (button.dataset['waiting'] === 'true') return () => undefined
  const label = button.textContent ?? ''
  const wasDisabled = button.disabled

  button.dataset['waiting'] = 'true'
  button.disabled = true
  button.textContent = ''
  button.style.display = 'inline-flex'
  button.style.alignItems = 'center'
  button.style.gap = '6px'

  const spinner = document.createElement('fl-icon')
  spinner.setAttribute('name', 'spinner')
  spinner.setAttribute('size', '12')
  spinner.setAttribute('spin', '')
  spinner.setAttribute('aria-hidden', 'true')
  spinner.style.flex = 'none'
  const text = document.createElement('span')
  text.textContent = label
  button.append(spinner, text)

  // A screen reader gets no spinner, so the state is said in words. Removed
  // again by the undo — a control left announcing "busy" after it stopped
  // being busy is worse than one that never said so.
  button.setAttribute('aria-busy', 'true')

  let undone = false
  return () => {
    if (undone) return
    undone = true
    delete button.dataset['waiting']
    button.removeAttribute('aria-busy')
    button.disabled = wasDisabled
    button.style.removeProperty('display')
    button.style.removeProperty('align-items')
    button.style.removeProperty('gap')
    button.textContent = label
  }
}
