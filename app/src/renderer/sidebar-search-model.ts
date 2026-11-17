/**
 * The sidebar's one search — threads and files in one box (polish, 2026-11-17,
 * the "Flow layout polish" canvas: "Search threads and files").
 *
 * Pure and DOM-free. It decides which files match, how they rank, and which
 * group comes first; `sidebar-search.ts` fetches and paints.
 *
 *   · threads come from the store's own search (title and what was said), in
 *     the store's order, kept to the projects the person is looking at
 *   · files match on their NAME first, then on their path, so typing a file's
 *     name finds that file before every file under a folder of that name
 *   · the group the open tab holds comes first: files on Files, threads otherwise
 *   · ON THREADS THE BOX FILTERS THE LIST IN PLACE (user, 2026-11-17): the
 *     list's own filter keeps every behaviour it had (the Archived group,
 *     multi-select under a filter, a renamed thread staying visible, arrow and
 *     Enter), and only the matching FILES show above it
 */

export type SidebarTab = 'threads' | 'files' | 'source-control' | 'worktrees'

export type SearchKind = 'threads' | 'files'

export interface ThreadHit {
  kind: 'thread'
  id: string
  title: string
  projectRoot: string
}

export interface FileHit {
  kind: 'file'
  rootPath: string
  relPath: string
  /** The file's own name — the part the eye looks for. */
  name: string
  /** The folder it lives in, root-relative ('' at the root). */
  folder: string
}

export interface SearchGroup {
  kind: SearchKind
  hits: ReadonlyArray<ThreadHit | FileHit>
}

export const MAX_THREAD_HITS = 6
export const MAX_FILE_HITS = 8

/** The words the search box and its results speak (forbidden-pattern #12: no paths or commands). */
export const SEARCH_COPY = {
  placeholder: 'Search threads and files',
  threads: 'Threads',
  files: 'Files',
  all: 'All',
  nothing: 'No threads or files match',
} as const

/** How a query shows on a tab: the thread list filtered in place with files
 *  above it, or the grouped results in the pane's place. */
export function searchModeFor(tab: SidebarTab): 'filter-list' | 'grouped' {
  return tab === 'threads' ? 'filter-list' : 'grouped'
}

/** Normalise what was typed: trimmed, case-folded; '' means "not searching". */
export function normaliseQuery(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Keep the store's thread matches that belong to the projects in view. */
export function threadHits(
  threads: ReadonlyArray<{ id: string; title: string; projectRoot: string }>,
  scopeRoots: readonly string[],
  limit = MAX_THREAD_HITS,
): ThreadHit[] {
  const inScope = scopeRoots.length === 0 ? null : new Set(scopeRoots)
  const hits: ThreadHit[] = []
  for (const thread of threads) {
    if (inScope !== null && !inScope.has(thread.projectRoot)) continue
    hits.push({ kind: 'thread', id: thread.id, title: thread.title, projectRoot: thread.projectRoot })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * Rank one root's files against the query. Name-prefix beats name-contains
 * beats path-contains; within a rank the shorter path wins (closer to the
 * root), then alphabetical, so the order never depends on the walk's order.
 */
export function fileHits(
  roots: ReadonlyArray<{ rootPath: string; relPaths: readonly string[] }>,
  query: string,
  limit = MAX_FILE_HITS,
): FileHit[] {
  const q = normaliseQuery(query)
  if (q === '') return []
  const scored: Array<{ hit: FileHit; rank: number }> = []
  for (const { rootPath, relPaths } of roots) {
    for (const relPath of relPaths) {
      const slash = relPath.lastIndexOf('/')
      const name = slash === -1 ? relPath : relPath.slice(slash + 1)
      const lowerName = name.toLowerCase()
      let rank: number
      if (lowerName.startsWith(q)) rank = 0
      else if (lowerName.includes(q)) rank = 1
      else if (relPath.toLowerCase().includes(q)) rank = 2
      else continue
      scored.push({
        hit: { kind: 'file', rootPath, relPath, name, folder: slash === -1 ? '' : relPath.slice(0, slash) },
        rank,
      })
    }
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.hit.relPath.length - b.hit.relPath.length ||
      a.hit.relPath.localeCompare(b.hit.relPath),
  )
  return scored.slice(0, limit).map((entry) => entry.hit)
}

/** The results, grouped, the open tab's kind first. Empty groups are left out. */
export function groupResults(
  threads: readonly ThreadHit[],
  files: readonly FileHit[],
  tab: SidebarTab,
  only: SearchKind | null = null,
): SearchGroup[] {
  const groups: SearchGroup[] = [
    { kind: 'threads', hits: threads },
    { kind: 'files', hits: files },
  ]
  if (tab === 'files') groups.reverse()
  return groups.filter((group) => group.hits.length > 0 && (only === null || group.kind === only))
}

/** The results in the order the keyboard walks them. */
export function flatHits(groups: readonly SearchGroup[]): Array<ThreadHit | FileHit> {
  return groups.flatMap((group) => group.hits)
}

/** Move the keyboard cursor, wrapping at both ends; -1 when there is nothing. */
export function moveCursor(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1
  if (current < 0) return delta === 1 ? 0 : count - 1
  return (current + delta + count) % count
}

/** What New makes on each tab, as its hover text says it. */
export function newActionFor(tab: SidebarTab): { label: string; event: 'flow:new-thread' | 'flow:new-file' } {
  return tab === 'files'
    ? { label: 'New file', event: 'flow:new-file' }
    : { label: 'New thread', event: 'flow:new-thread' }
}

/** A tab's label with its count, as a screen reader hears it. */
export function tabAccessibleName(label: string, count: number | null): string {
  if (count === null || count <= 0) return label
  return `${label}, ${String(count)} changed file${count === 1 ? '' : 's'}`
}

/** Everything else New can start, on its right-click menu — the open tab's own
 *  thing first. Each is a document event its owner already answers. */
export function newMenuFor(tab: SidebarTab): Array<{ label: string; icon: string; event: string }> {
  const thread = { label: 'New thread', icon: 'message', event: 'flow:new-thread' }
  const file = { label: 'New file', icon: 'file', event: 'flow:new-file' }
  const rest = [
    { label: 'New terminal', icon: 'terminal', event: 'flow:terminal-new' },
    { label: 'Ask the Blueprint', icon: 'sparkles', event: 'flow:ask-blueprint' },
  ]
  return [...(tab === 'files' ? [file, thread] : [thread, file]), ...rest]
}
