// Persisted collapse state for the Source Control panel's sections (#693) —
// Staged Changes / Changes / Merge Changes / Commits each fold independently,
// VS Code-style. DOM-free so the persistence round-trip (defensive against a
// corrupt localStorage value) is unit-tested; git-panel.ts owns the rendering.

/** The foldable sections, keyed by their SourceControlSection kind + 'commits'. */
export type CollapsibleSection = 'merge' | 'staged' | 'changes' | 'commits'

/** localStorage key — versioned so a shape change can't crash on old data. */
export const COLLAPSED_SECTIONS_KEY = 'flow.git.collapsedSections.v1'

/** Parse the persisted collapsed-section list into a Set. A missing or corrupt
 *  value yields an empty set (all sections expanded) — never throws. */
export function parseCollapsedSections(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

/** Serialize the collapsed-section set for persistence (stable array order). */
export function serializeCollapsedSections(sections: ReadonlySet<string>): string {
  return JSON.stringify([...sections])
}

/** Toggle a section's collapsed state, returning a NEW set (immutable update). */
export function toggleSection(sections: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(sections)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * The storage key for one repo's section fold (#1143).
 *
 * The fold used to be stored under the bare section kind ('changes'), shared by
 * every repo group in a multi-root panel: folding repo A's CHANGES folded repo
 * B's too, leaving a section reading "CHANGES (2)" with no rows under it. The
 * GROUP fold was already namespaced (`root:<path>`, git-groups.ts) — the
 * sections simply never got the same treatment when the panel went multi-root.
 *
 * `section:<rootPath>:<kind>` can't collide with a `root:` group key, and the
 * rootPath is absolute, so two repos never share a fold.
 */
export function sectionCollapseKey(rootPath: string, section: CollapsibleSection): string {
  return `section:${rootPath}:${section}`
}

/**
 * Drop pre-#1143 bare section keys ('changes', 'commits', …) on load.
 *
 * They can't be migrated — the stored key never recorded WHICH repo folded the
 * section, and applying one repo's fold to all of them is the bug itself. So a
 * user carrying old state sees their sections expanded once, then folds are
 * remembered per repo from then on. `root:` group folds are untouched.
 */
export function dropLegacySectionKeys(sections: ReadonlySet<string>): Set<string> {
  const legacy = new Set<string>(['merge', 'staged', 'changes', 'commits'])
  return new Set([...sections].filter((key) => !legacy.has(key)))
}
