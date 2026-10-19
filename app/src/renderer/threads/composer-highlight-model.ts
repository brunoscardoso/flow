// What the composer's highlight mirror must redo, and when.
//
// Copying the field's computed style (25 properties) and measuring its box
// forces a style recalc and a layout; doing it on every keystroke made typing
// pay for something that only changes when the field's SIZE, its FONT or the
// THEME changes. A keystroke changes the text and maybe the scroll — and the
// size, if the field autogrows, which the ResizeObserver reports on its own.

/** Why the mirror is being asked to catch up. */
export type HighlightTrigger =
  /** The text changed (typing, a paste, a `value` assignment, a command list). */
  | 'input'
  /** The field or its wrap changed size (autogrow, window width, a scrollbar). */
  | 'resize'
  /** Fonts loaded, the theme or the root's style changed. */
  | 'style'

export interface HighlightBoxWork {
  /** Copy the field's computed font, padding and borders onto the mirror. */
  copyStyle: boolean
  /** Place and size the mirror over the field's text box. */
  place: boolean
}

/**
 * The box work for one trigger. Highlighting turning ON always copies and
 * places — the mirror was hidden and may be stale from any earlier change.
 * While highlighting is off nothing is copied: it is redone when it turns on.
 */
export function highlightBoxWork(trigger: HighlightTrigger, active: boolean, turnedOn: boolean): HighlightBoxWork {
  if (!active) return { copyStyle: false, place: false }
  if (turnedOn) return { copyStyle: true, place: true }
  switch (trigger) {
    case 'input':
      return { copyStyle: false, place: false }
    case 'resize':
      return { copyStyle: false, place: true }
    case 'style':
      return { copyStyle: true, place: true }
  }
}
