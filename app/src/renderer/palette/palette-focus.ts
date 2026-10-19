// Focus ownership across a command-palette open/close cycle (#1100).
//
// The palette is keyboard-first by its own footer ("Esc to close"), but closing
// it left `document.activeElement` on `<body>`: everything typed next went
// nowhere — not the terminal, not the editor, not the composer — until the user
// noticed and clicked. This is the capture/restore half of the app's focus
// convention (#1045: a rebuild never STEALS focus; #1093: capture before the
// wipe, restore after), applied to an overlay rather than a rebuild.
//
// Two rules, both DOM-free and unit-tested here:
//   * CAPTURE — remember only a real element that is not `<body>` and not
//     inside the palette itself (re-entrant opens must not "restore" onto the
//     palette input the previous open focused).
//   * RESTORE — only on the CANCEL paths (Escape, backdrop click). Activation
//     closes first so the action's own focus() wins (open-file focuses the
//     editor); restoring there would yank focus straight back off it. And only
//     onto an element still connected to the document — a target the action or
//     a rebuild removed is not refocusable.

/** The minimum an element must expose for the rules below (keeps this DOM-free). */
export interface FocusTarget {
  isConnected: boolean
}

export interface CaptureInput<T extends FocusTarget> {
  /** `document.activeElement`, or null. */
  active: T | null
  /** `document.body` — never a useful restore target. */
  body: T | null
  /** True when `active` lives inside the palette overlay. */
  insidePalette: boolean
}

/** Why the palette is closing — only a cancel restores focus. */
export type CloseReason = 'cancel' | 'activate'

/**
 * The element to remember when the palette opens, or null when there is
 * nothing worth restoring to.
 */
export function focusToCapture<T extends FocusTarget>(input: CaptureInput<T>): T | null {
  const { active, body, insidePalette } = input
  if (active === null) return null
  if (body !== null && active === body) return null
  if (insidePalette) return null
  return active
}

/**
 * The element to focus when the palette closes, or null to leave focus alone.
 */
export function focusToRestore<T extends FocusTarget>(
  captured: T | null,
  reason: CloseReason,
): T | null {
  if (reason !== 'cancel') return null
  if (captured === null || !captured.isConnected) return null
  return captured
}
