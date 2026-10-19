// One definition of "a modal overlay is open", shared by every consumer (#1002).
//
// #525 gated the shell's capture-phase panel shortcuts while a modal owns the
// keyboard, and #683 gated the terminal's autofocus for the same reason. Both
// guards asked the same question by enumerating ONE class:
//
//   shell.ts          `document.querySelector('.fl-settings-overlay:not([hidden])')`
//   terminal-panel.ts `isModalOverlayOpen()` — the identical query
//
// The tasks-board modals ("New task" / task detail) use a different class, so
// they opted out of the isolation BY ACCIDENT and every #525 symptom was still
// live on them: ⌃` revealed the docked terminal behind the modal, xterm stole
// focus from the title input, the user's next keystrokes landed on a live shell
// prompt (one Enter from executing them), and Escape was swallowed — the modal
// became keyboard-uncloseable, mouse-only.
//
// The fix is a CONVENTION SET AT CREATION rather than an ever-growing class
// list: a modal marks its overlay element via `markModalOverlay()`, and the
// shell shortcut guard, the terminal focus guard and the document-level focus
// trap all ask this module. The invariant lives in one code path
// (allowed-pattern #14) — a new modal can only opt out by visibly forgetting
// one call, instead of silently by picking a class nobody updated the guards
// for.
//
// Marked overlays may either be REMOVED from the DOM on close (the board
// modals, release notes) or kept and toggled `hidden` (the settings family), so
// the selector filters on `[hidden]`.

const MODAL_OVERLAY_ATTR = 'data-fl-modal'

/** Matches every OPEN modal overlay, whatever its own styling class is. */
export const MODAL_OVERLAY_SELECTOR = `[${MODAL_OVERLAY_ATTR}]:not([hidden])`

/**
 * Declare `overlay` a modal surface: while it is open, global panel shortcuts
 * are inert, the terminal will not steal focus, and Tab is contained inside it.
 * Call it where the overlay element is created.
 */
export function markModalOverlay(overlay: HTMLElement): void {
  overlay.setAttribute(MODAL_OVERLAY_ATTR, '')
}

/** The topmost open modal overlay — overlays stack in DOM order on body. */
export function topmostModalOverlay(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>(MODAL_OVERLAY_SELECTOR)
  return overlays.length > 0 ? (overlays[overlays.length - 1] ?? null) : null
}

/** True while any modal overlay is open and owns the keyboard. */
export function isModalOverlayOpen(): boolean {
  return topmostModalOverlay() !== null
}
