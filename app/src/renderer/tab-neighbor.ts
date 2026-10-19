// Shared tab-strip neighbor logic (#408). When the ACTIVE tab closes, focus
// should move to an ADJACENT tab — the one to its right, else the one to its
// left — not jump to the first/oldest. Both the editor and terminal tab strips
// use this so they behave identically. Pure → unit-testable.

/**
 * The id to activate once `id` closes, among the given ordered ids: the one to
 * its right, else the one to its left, else null (strip becomes empty). `id`
 * itself is expected to still be present in `orderedIds` — call BEFORE removing
 * it. Returns null when `id` isn't found.
 */
export function neighborOf(orderedIds: readonly string[], id: string): string | null {
  const index = orderedIds.indexOf(id)
  if (index === -1) return null
  return orderedIds[index + 1] ?? orderedIds[index - 1] ?? null
}
