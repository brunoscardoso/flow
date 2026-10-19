// One Escape dismisses ONE thing.
//
// A board modal listens for Escape on `document`, in the bubble phase; the
// shell's "leave the expanded right side" listens on `window`, after it. The
// modal's handler removed its overlay, so by the time the shell asked "is a
// modal open?" the answer was no, nothing had said the key was handled, and
// one keystroke closed the dialog AND collapsed the expanded right side.
// Claiming the key — `preventDefault` (the shell's `handled`) and
// `stopPropagation` — before closing is the contract `fl-tabs`' menus follow.

/** The parts of a KeyboardEvent this needs (testable without a DOM). */
export interface EscapeKeyEvent {
  key: string
  preventDefault(): void
  stopPropagation(): void
}

/**
 * Close a modal on Escape, claiming the key first. Answers whether it did.
 * Any other key is left alone.
 */
export function dismissOnEscape(event: EscapeKeyEvent, close: () => void): boolean {
  if (event.key !== 'Escape') return false
  event.preventDefault()
  event.stopPropagation()
  close()
  return true
}
