// Collision-aware project labels (#426). Projects were labeled by folder
// basename alone, so two roots that share a basename (e.g. ~/work/app and
// ~/oss/app) rendered identically in the switcher, its dropdown, and the
// threads-sidebar headers — a silent mis-target risk. This disambiguates such
// labels with the parent segment. Renderer context → no node:path; the split
// honors both separators because Windows roots arrive as `C:\Users\…` (#1688).

function trimTrailingSeparators(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/, '')
}

function lastSeparator(trimmed: string): number {
  return Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
}

/** The last path segment (folder basename), trailing separators trimmed. */
export function baseName(rootPath: string): string {
  const trimmed = trimTrailingSeparators(rootPath)
  const slash = lastSeparator(trimmed)
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** The name of the directory containing the root, or '' when there is none. */
function parentName(rootPath: string): string {
  const trimmed = trimTrailingSeparators(rootPath)
  const slash = lastSeparator(trimmed)
  if (slash <= 0) return ''
  return baseName(trimmed.slice(0, slash))
}

/**
 * A display label for `rootPath`, unique among `allRootPaths`: the basename on
 * its own, or `"<basename> — <parent>"` when another root shares that basename
 * (#426). Falls back to the bare basename when there is no parent segment (or if
 * the parent is empty). The full path should still be offered as a tooltip for
 * the rarer parent-also-collides case.
 */
export function projectLabel(rootPath: string, allRootPaths: readonly string[]): string {
  const base = baseName(rootPath)
  const collides = allRootPaths.some((other) => other !== rootPath && baseName(other) === base)
  if (!collides) return base
  const parent = parentName(rootPath)
  return parent ? `${base} — ${parent}` : base
}
