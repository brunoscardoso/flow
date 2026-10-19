/**
 * Popup-menu keyboard navigation MATH (#1173, #1300) — DOM-free, so it
 * unit-tests under the node jest env; menu-keyboard.ts does the wiring.
 *
 * #1173 taught the thread-sidebar row menu that a popup must be keyboard-
 * operable. #1153 then re-implemented popup chrome from scratch for the
 * board's lane menu and inherited none of it — the same menu items, offering
 * the same moves for the same task, were mouse-only again. So the rule lives
 * in one place now (allowed-pattern #14): convention restated per popup
 * drifts, one code path cannot.
 */

/**
 * The next item index for an arrow/Tab step — wrapping, and entering from the
 * matching end when nothing in the menu is focused yet.
 */
export function nextMenuIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}
