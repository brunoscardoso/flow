// Content-search view model — the DOM-free brain of the file-explorer search
// panel. It owns debounce, the stale-guard (drop a superseded query's late
// result, mirroring palette-sources' StaleGuard), the per-root fan-out over the
// injected searchContent IPC, and the flattening of results into display rows.
// Everything is injected (searchContent, the root list, the clock, the timer),
// so it unit-tests node-env with fakes — the DOM view stays thin.

import type { ContentSearchResult } from '../../shared/ipc-contract'

/** A [start, end) character range within a preview line to highlight. */
export interface HighlightRange {
  start: number
  end: number
}

/** A flattened row for the results list — either a file header or one match. */
export type SearchDisplayRow =
  | {
      kind: 'file'
      rootPath: string
      relPath: string
      /** Number of matches shown under this file. */
      matchCount: number
    }
  | {
      kind: 'match'
      rootPath: string
      relPath: string
      /** 1-based line. */
      line: number
      /** 1-based column (from the backend's 0-based column + 1). */
      column: number
      preview: string
      highlights: HighlightRange[]
    }

export type SearchState = 'idle' | 'searching' | 'empty' | 'results'

/** The full view the panel renders on each update. */
export interface SearchView {
  state: SearchState
  query: string
  rows: SearchDisplayRow[]
  /** True when any root's result hit a cap. */
  truncated: boolean
  /** Total matches across all files (for the truncation/summary line). */
  totalMatches: number
  /** Number of files with matches. */
  fileCount: number
}

export type SearchContentFn = (req: {
  rootPath: string
  query: string
}) => Promise<ContentSearchResult>

// Opaque handle so a test can inject its own scheduler (a manual timer) without
// depending on the ambient setTimeout return type (Timeout in node, number in
// the DOM). The real default below uses setTimeout/clearTimeout.
type TimerHandle = unknown

export interface SearchViewModelDeps {
  /** The IPC search call (window.flow.project.searchContent). */
  searchContent: SearchContentFn
  /** The roots to search — the active thread scope's roots. */
  getRoots: () => string[]
  /** Emitted on every view change (idle/searching/empty/results). */
  onUpdate: (view: SearchView) => void
  /** Debounce window in ms (default 300). */
  debounceMs?: number
  /** Injectable timer (default setTimeout) — tests drive it synchronously. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

const DEFAULT_DEBOUNCE_MS = 300

const EMPTY_VIEW: SearchView = {
  state: 'idle',
  query: '',
  rows: [],
  truncated: false,
  totalMatches: 0,
  fileCount: 0,
}

/** All [start,end) ranges of `query` within `preview` (case-insensitive unless
 *  caseSensitive). Pure — used by the row builder and unit-tested directly. */
export function computeHighlights(
  preview: string,
  query: string,
  caseSensitive = false,
): HighlightRange[] {
  if (query === '') return []
  const hay = caseSensitive ? preview : preview.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: HighlightRange[] = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    ranges.push({ start: at, end: at + needle.length })
    from = at + needle.length
  }
  return ranges
}

/** Flatten per-root results into file-header + match display rows. Pure —
 *  deterministic order (roots as given, files as the backend sorted them). */
export function flattenResults(
  query: string,
  perRoot: Array<{ rootPath: string; result: ContentSearchResult }>,
  caseSensitive = false,
): { rows: SearchDisplayRow[]; totalMatches: number; fileCount: number; truncated: boolean } {
  const rows: SearchDisplayRow[] = []
  let totalMatches = 0
  let fileCount = 0
  let truncated = false
  for (const { rootPath, result } of perRoot) {
    if (result.truncated) truncated = true
    for (const file of result.files) {
      fileCount += 1
      rows.push({
        kind: 'file',
        rootPath,
        relPath: file.relPath,
        matchCount: file.matches.length,
      })
      for (const match of file.matches) {
        totalMatches += 1
        rows.push({
          kind: 'match',
          rootPath,
          relPath: file.relPath,
          line: match.line,
          column: match.column + 1,
          preview: match.preview,
          highlights: computeHighlights(match.preview, query, caseSensitive),
        })
      }
    }
  }
  return { rows, totalMatches, fileCount, truncated }
}

export class SearchViewModel {
  #deps: Required<Pick<SearchViewModelDeps, 'searchContent' | 'getRoots' | 'onUpdate'>> &
    Pick<SearchViewModelDeps, never>
  #debounceMs: number
  #setTimer: (fn: () => void, ms: number) => TimerHandle
  #clearTimer: (handle: TimerHandle) => void
  #timer: TimerHandle | null = null
  /** Stale-guard: bumped on every runQuery so a superseded fan-out is dropped. */
  #generation = 0
  #query = ''

  constructor(deps: SearchViewModelDeps) {
    this.#deps = deps
    this.#debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** Debounced entry point — called on each input change. An empty/whitespace
   *  query resets to idle immediately (no fan-out). */
  runQuery(query: string): void {
    this.#query = query
    // A new query invalidates any in-flight fan-out and any pending debounce.
    this.#generation += 1
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer)
      this.#timer = null
    }
    if (query.trim() === '') {
      this.#deps.onUpdate({ ...EMPTY_VIEW })
      return
    }
    this.#deps.onUpdate({ ...EMPTY_VIEW, state: 'searching', query })
    const generationAtSchedule = this.#generation
    this.#timer = this.#setTimer(() => {
      this.#timer = null
      void this.#execute(query, generationAtSchedule)
    }, this.#debounceMs)
  }

  /** Cancel any pending/in-flight query and reset to idle. */
  reset(): void {
    this.#generation += 1
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer)
      this.#timer = null
    }
    this.#query = ''
    this.#deps.onUpdate({ ...EMPTY_VIEW })
  }

  get query(): string {
    return this.#query
  }

  async #execute(query: string, generation: number): Promise<void> {
    const roots = this.#deps.getRoots()
    const perRoot = await Promise.all(
      roots.map((rootPath) =>
        this.#deps
          .searchContent({ rootPath, query })
          .then((result) => ({ rootPath, result }))
          .catch(() => ({ rootPath, result: { files: [], truncated: false } as ContentSearchResult })),
      ),
    )
    // Superseded by a newer query while we were awaiting — drop this result.
    if (generation !== this.#generation) return

    const { rows, totalMatches, fileCount, truncated } = flattenResults(query, perRoot)
    this.#deps.onUpdate({
      state: totalMatches === 0 ? 'empty' : 'results',
      query,
      rows,
      truncated,
      totalMatches,
      fileCount,
    })
  }
}
