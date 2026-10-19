// Pure helpers for multi-project threads (#45) — DOM-free so they unit-test
// under the CJS node jest. The picker UI (thread-sidebar) and the badge use
// these; the badge label and primary/extra split live here.

/** Last path segment of a root, for a compact display name. */
export function projectName(rootPath: string): string {
  const segments = rootPath.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? rootPath
}

/** Badge label for a multi-project thread, e.g. "+car +frontend"; '' when none. */
export function badgeLabel(extraRoots: readonly string[]): string {
  if (extraRoots.length === 0) return ''
  return extraRoots.map((root) => `+${projectName(root)}`).join(' ')
}

export interface RootSplit {
  /** cwd / account / sidebar home. */
  primary: string | null
  /** Extra projects (deduped, primary removed, order preserved). */
  additional: string[]
}

/**
 * Split a user's selected roots into primary + additional. The primary is the
 * first selection (or `preferredPrimary` when it's among the selection); the
 * rest become additional (deduped, primary excluded).
 */
export function splitRoots(
  selection: readonly string[],
  preferredPrimary: string | null = null,
): RootSplit {
  const unique = [...new Set(selection.filter(Boolean))]
  if (unique.length === 0) return { primary: null, additional: [] }
  const primary =
    preferredPrimary && unique.includes(preferredPrimary) ? preferredPrimary : unique[0]
  return { primary, additional: unique.filter((root) => root !== primary) }
}
