/**
 * The pure core of the shared tab bar (`tab-bar.ts`): where Arrow/Home/End
 * moves focus within a row of tabs. DOM-free so the node-env suite can test
 * the movement rule — the glue around it is four attribute writes.
 */

/**
 * Where the key moves focus within `count` tabs, given the focused index.
 * Arrows wrap, because a row of tabs has no natural cliff. `null` means the
 * key is not the bar's to handle (typing must pass through), or focus is not
 * on a tab at all.
 */
export function roveTab(count: number, current: number, key: string): number | null {
  if (count <= 0 || current < 0 || current >= count) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  return null
}
