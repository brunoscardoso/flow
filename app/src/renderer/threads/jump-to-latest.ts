/**
 * The "back to the live end" control (#1330) — pure, DOM-free.
 *
 * Scrolling up mid-turn does the right thing: auto-follow stops (#823) and you
 * stay where you are. Then the app abandons you there. The pane exposed ZERO
 * controls — no jump-to-latest, no "new messages ↓" pill, no unread badge —
 * and nothing said the conversation had moved on without you. The only ways
 * back were dragging the scrollbar to the bottom yourself, or switching
 * threads and switching back.
 */

export interface JumpToLatestState {
  /** Auto-follow is engaged (the view is at, or near, the live end). */
  pinned: boolean
  /** Distance in px from the bottom of the scroller. */
  distanceFromBottom: number
  /** Messages appended since the user unpinned. */
  missed: number
}

export interface JumpToLatestView {
  visible: boolean
  label: string
  /** Announced to assistive tech; the label alone reads as a bare arrow. */
  ariaLabel: string
}

/**
 * How far from the bottom before the control is worth showing. Small enough
 * that it appears as soon as the live end is genuinely off screen, large
 * enough that a few pixels of streaming jitter never flashes it.
 */
export const JUMP_VISIBLE_THRESHOLD_PX = 120

export function jumpToLatestView(state: JumpToLatestState): JumpToLatestView {
  const visible = !state.pinned && state.distanceFromBottom > JUMP_VISIBLE_THRESHOLD_PX
  // Naming the count answers the second half of the complaint — that nothing
  // told the user the conversation had moved on at all.
  const missed = Math.max(0, Math.trunc(state.missed))
  const label = missed > 0 ? `${missed} new ↓` : 'Jump to latest ↓'
  return {
    visible,
    label,
    ariaLabel:
      missed > 0
        ? `${missed} new message${missed === 1 ? '' : 's'} — jump to the latest`
        : 'Jump to the latest message',
  }
}
