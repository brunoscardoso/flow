/**
 * REVEAL A FOLDER IN THE TREE (plan feature-home-folders, FR-8) — PURE.
 *
 * The mirror of the tree's "Reveal in Blueprint": a feature card's folder row
 * asks the tree to show that folder. The tree expands every ancestor, one
 * listing at a time, then selects the folder itself. This module only answers
 * WHICH folders those are — from the root down, the folder last — so the walk
 * is testable without a DOM.
 *
 * `.` (and `''`) is the project root: nothing to expand, the root row is the
 * answer. A path that tries to leave the root (`..`) answers null — the tree
 * never walks outside the project it shows.
 */

/** The event a board row dispatches and the tree answers. */
export const REVEAL_IN_TREE_EVENT = 'flow:reveal-in-tree'

/** What the event carries. `relPath` is repo-relative; `.` is the root. */
export interface RevealInTreeDetail {
  rootPath: string
  relPath: string
}

/** The folder's own relative path, normalized — `''` for the root, null when it leaves the root. */
export function normalizeRevealPath(relPath: string): string | null {
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) return null
  return segments.join('/')
}

/**
 * Every folder to expand, root-down, ending with the folder itself:
 * `src/components/automations` → `['src', 'src/components', 'src/components/automations']`.
 * Empty for the root; null for a path outside it.
 */
export function revealChain(relPath: string): string[] | null {
  const normalized = normalizeRevealPath(relPath)
  if (normalized === null) return null
  if (normalized === '') return []
  const segments = normalized.split('/')
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

/** A `flow:reveal-in-tree` detail, or null when the event carries something else. */
export function readRevealDetail(detail: unknown): RevealInTreeDetail | null {
  if (typeof detail !== 'object' || detail === null) return null
  const record = detail as Record<string, unknown>
  const rootPath = record['rootPath']
  const relPath = record['relPath']
  if (typeof rootPath !== 'string' || rootPath.length === 0 || typeof relPath !== 'string') return null
  return { rootPath, relPath }
}
