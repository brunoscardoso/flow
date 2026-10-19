// Archived-thread grouping for the sidebar (#482). Search used to flatten archived
// threads in with active ones — an archived match rendered as an ordinary row, no
// "Archived" section or badge, defeating the archive action's "hide/declutter"
// intent. These pure helpers partition threads and decide the Archived section's
// expanded state so search groups archived matches under the section (visible +
// distinguishable) instead of flattening them. DOM-free → unit-testable.

/** Split threads into active (archivedAt === null) and archived, preserving order. */
export function partitionByArchived<T extends { archivedAt: string | null }>(
  threads: readonly T[],
): { active: T[]; archived: T[] } {
  const active: T[] = []
  const archived: T[] = []
  for (const thread of threads) {
    ;(thread.archivedAt === null ? active : archived).push(thread)
  }
  return { active, archived }
}

/**
 * Whether the "Archived" section renders expanded. During a search it is forced
 * expanded so archived matches are visible (and clearly grouped as archived);
 * otherwise it honors the user's collapse toggle.
 */
export function archivedSectionExpanded(searching: boolean, userExpanded: boolean): boolean {
  return searching || userExpanded
}
