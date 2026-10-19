/**
 * A feature reference → its slug, by the store's id grammar: `feature:<slug>`,
 * or inside a Workspace `feature:<project>::<slug>` (the project is shown
 * separately where it matters — never glued onto the name as `backend::orders`).
 * A bare slug is returned as it is.
 */
export function featureSlugOfRef(ref: string): string {
  const id = ref.startsWith('feature:') ? ref.slice('feature:'.length) : ref
  const separator = id.lastIndexOf('::')
  return separator === -1 ? id : id.slice(separator + 2)
}
