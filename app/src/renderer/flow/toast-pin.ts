/**
 * Whether an arriving toast may scroll the stack to itself (#1458). Pure and
 * DOM-free so the rule is unit-tested rather than inferred from a layout.
 *
 * #1036 made the toast stack scroll instead of compressing its cards, and
 * pinned it to the newest arrival so the arrival is the one in view. That is
 * right for the ordinary case and wrong for the one that matters most: a
 * blocked task's sticky card carries the ONLY in-app way to answer it, and the
 * pin had no exemption for the element the user is currently typing into. A
 * burst of routine heartbeat chatter — exactly what a running plan produces,
 * and exactly when tasks block — scrolled the reply box out of the window while
 * it kept focus and kept swallowing keystrokes. Scrolling it back by hand did
 * not help either: the next toast yanked it away again.
 *
 * So the newest toast wins only when it is not taking something away:
 *
 *  - **Focus inside the stack** means the user is mid-interaction there. Moving
 *    it under those conditions is the bug, whatever the scroll position.
 *  - **Already scrolled away from the bottom** means the user chose what to
 *    look at. Re-pinning would undo a deliberate scroll, the same rule a chat
 *    transcript follows.
 *
 * Neither applies to the ordinary case — no focus, stack sitting at the bottom
 * (which includes every stack too short to scroll) — so routine toasts behave
 * exactly as they did.
 */

/** Slack for fractional scroll positions from zoom / device pixel ratios. */
export const PIN_BOTTOM_SLACK_PX = 4

export interface ToastPinInput {
  /** Stack metrics as measured BEFORE the new card is appended. */
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  /** Whether the stack currently contains the focused element. */
  holdsFocus: boolean
}

export function shouldPinToNewest(input: ToastPinInput): boolean {
  if (input.holdsFocus) return false
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight
  return distanceFromBottom <= PIN_BOTTOM_SLACK_PX
}
