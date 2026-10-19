// Cross-root @-mention scope model (multi-project threads, phase 6).
//
// The composer's @-file autocomplete iterates the active thread's scope roots
// instead of only the primary project. This module is the DOM-free decision
// core — which roots to search, how to merge/rank results across roots, and
// what text an accepted mention inserts — so it unit-tests under the node
// jest env while composer.ts stays the thin DOM shell.
//
// Single-root scope is byte-identical to today: one listDir request against
// the primary root, the same filter/sort (stable, so equal keys keep their
// listDir order), the same root-relative insertion.

import type { DirectoryEntry, ThreadScope } from '../../shared/ipc-contract'

/** The slice of a scope entry the mention search needs. */
export interface MentionRoot {
  rootPath: string
  /** Display name — prefixes results from non-primary roots. */
  name: string
  primary: boolean
}

/**
 * The roots a mention search iterates. Fail-soft: when the scope layer is
 * unavailable, describes a different thread, or has no available roots, the
 * search degrades to the thread's own primary root — exactly today's world.
 * Unavailable roots are skipped (their listDir would only error).
 */
export function mentionRoots(
  scope: ThreadScope | null,
  threadId: string,
  projectRoot: string,
): MentionRoot[] {
  const fallback: MentionRoot[] = [{ rootPath: projectRoot, name: '', primary: true }]
  if (!scope || scope.threadId !== threadId) return fallback
  const available = scope.roots.filter((root) => root.available)
  if (available.length === 0) return fallback
  return available.map((root) => ({
    rootPath: root.rootPath,
    name: root.name,
    primary: root.primary,
  }))
}

/** One listDir call the search plan wants: `dirPath` is root-relative. */
export interface MentionListRequest {
  root: MentionRoot
  dirPath: string
}

/**
 * Where to list for a mention query's directory part.
 *
 * - Absolute `dirPath` (descent after accepting a cross-root directory — the
 *   inserted mention text is the absolute path): resolves INTO the scope root
 *   containing it; outside every root → no requests (popup closes).
 * - Relative `dirPath`: one request per root at the same relative directory —
 *   with a single root this is exactly today's one request.
 */
export function mentionListRequests(
  dirPath: string,
  roots: readonly MentionRoot[],
): MentionListRequest[] {
  if (dirPath.startsWith('/')) {
    const root = roots.find(
      (candidate) =>
        dirPath === candidate.rootPath || dirPath.startsWith(`${candidate.rootPath}/`),
    )
    if (!root) return []
    const rel = dirPath === root.rootPath ? '' : dirPath.slice(root.rootPath.length + 1)
    return [{ root, dirPath: rel }]
  }
  return roots.map((root) => ({ root, dirPath }))
}

/** A ranked mention result, tagged with the root it came from. */
export interface ScopedMentionItem {
  entry: DirectoryEntry
  root: MentionRoot
}

/**
 * Filter + rank listDir results across roots and cap them. The comparator is
 * today's exactly — prefix matches, then directories, then name — extended
 * with scope order (primary first) as the final tie-break, so a single-root
 * scope sorts byte-identically (the extra keys compare equal and the sort is
 * stable).
 */
export function mergeMentionMatches(
  results: ReadonlyArray<{ root: MentionRoot; entries: readonly DirectoryEntry[] }>,
  needle: string,
  cap: number,
): ScopedMentionItem[] {
  const rootOrder = new Map(results.map((result, index) => [result.root.rootPath, index]))
  const items: ScopedMentionItem[] = []
  for (const { root, entries } of results) {
    for (const entry of entries) {
      if (entry.name.toLowerCase().includes(needle)) items.push({ entry, root })
    }
  }
  return items
    .sort((a, b) => {
      const aPrefix = a.entry.name.toLowerCase().startsWith(needle) ? 0 : 1
      const bPrefix = b.entry.name.toLowerCase().startsWith(needle) ? 0 : 1
      if (aPrefix !== bPrefix) {
        return aPrefix - bPrefix
      }
      if (a.entry.type !== b.entry.type) {
        return a.entry.type === 'directory' ? -1 : 1
      }
      const byName = a.entry.name.localeCompare(b.entry.name)
      if (byName !== 0) return byName
      return (rootOrder.get(a.root.rootPath) ?? 0) - (rootOrder.get(b.root.rootPath) ?? 0)
    })
    .slice(0, cap)
}

/**
 * The path text an accepted mention inserts. Primary-root entries keep
 * today's root-relative form. Cross-root entries insert the ABSOLUTE path —
 * unambiguous for the agent (whose cwd is the primary root) and re-parseable
 * by mentionListRequests for directory descent.
 */
export function mentionInsertionPath(item: ScopedMentionItem, primaryRootPath: string): string {
  if (item.root.rootPath === primaryRootPath) {
    return rootRelative(primaryRootPath, item.entry.path)
  }
  return item.entry.path
}

/** `absolutePath` relative to `rootPath` when nested inside it; else unchanged. */
export function rootRelative(rootPath: string, absolutePath: string): string {
  const base = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  return absolutePath.startsWith(base) ? absolutePath.slice(base.length) : absolutePath
}
