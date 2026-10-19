/**
 * Corpus-browser view model (changes-discovery-view #1532) — PURE, no DOM.
 *
 * Maps the persisted corpus index (`blueprint:corpusIndex`) plus the browser's
 * UI state onto render-ready rows: tab split, text search, date sort, date
 * range, and the feature pre-filter a feature node opens the browser with.
 * The board consumes the derived view and does nothing but paint it, so every
 * rule below is unit-testable without a renderer.
 *
 * SEARCH CONTRACT
 * ===============
 * Matching is the learn filter's contract (`blueprint-board.ts`,
 * `#renderLearnModuleRows`): trim the query, lowercase both sides, literal
 * `includes` substring match — no tokenizing, no fuzziness. A blank query
 * matches everything. The corpus search widens WHAT is matched (name, path
 * basename, feature slug), never HOW.
 *
 * UNDATED ENTRIES SORT LAST — IN BOTH DIRECTIONS
 * ==============================================
 * Legacy index records may lack `created`/`indexed`. "No date" is missing
 * information, not an extreme value: flipping the sort direction must not
 * teleport legacy docs from one end of the list to the other as if they were
 * the oldest or the newest thing in the project. They pin to the bottom
 * either way, flagged `undated` so the renderer can say so instead of
 * printing a blank. An active date range EXCLUDES them — a doc with no date
 * on the active field cannot be shown to fall inside `[from, to]`.
 *
 * THE "NO FEATURE" GROUP IS A PARTITION, NOT A FILTER
 * ===================================================
 * Unparented entries (`featureSlug: null`) always derive into their own
 * explicit group rather than being dropped or silently interleaved — the
 * feature blueprint's rule that unparented changes are counted, never lost.
 * The partition is unconditional; under an active feature pre-filter the
 * group is simply empty, because `null` never equals a requested slug.
 */
import type { BlueprintCorpusIndexEntry } from '../../shared/ipc-contract'

/** Which tab is showing. `changes` ⇔ kind `change`; `discoveries` ⇔ `discovery`. */
export type CorpusBrowserTab = 'changes' | 'discoveries'

/** Which date the list sorts by — and the field the date range applies to. */
export type CorpusDateField = 'created' | 'indexed'

export type CorpusSortDirection = 'asc' | 'desc'

/** The browser's whole UI state — everything the derivation reads. */
export interface CorpusBrowserState {
  tab: CorpusBrowserTab
  /** Raw search input; trimming/lowercasing is the model's job. */
  search: string
  sortField: CorpusDateField
  sortDirection: CorpusSortDirection
  /** Inclusive `YYYY-MM-DD` bounds on the active sort field; null = open end. */
  dateFrom: string | null
  dateTo: string | null
  /** Feature pre-filter (opened from a feature node); null = all features. */
  featureSlug: string | null
}

/** One render-ready row. `entry` is carried whole; the flags are derived. */
export interface CorpusBrowserRow {
  entry: BlueprintCorpusIndexEntry
  /** No usable date on the ACTIVE sort field — render a "no date" cue. */
  undated: boolean
  /** Passthrough for the archive badge. */
  archived: boolean
  /** The active sort field's value, for the date column. Null when undated. */
  date: string | null
}

/** The derived view: state in → these out. The board only paints. */
export interface CorpusBrowserView {
  /** Visible parented rows, in final sort order. */
  rows: CorpusBrowserRow[]
  /** Visible unparented rows (`featureSlug: null`), same sort — the explicit
   *  "no feature" group, rendered after `rows`. */
  noFeatureRows: CorpusBrowserRow[]
  /** Entries on the active tab before search/date/feature filters — lets the
   *  board render "N of M" and tell "empty index" from "filters hid it all". */
  totalInTab: number
}

/** Fresh state — newest first by created date, optionally pre-filtered to the
 *  feature node the browser was opened from. */
export function initialCorpusBrowserState(featureSlug: string | null = null): CorpusBrowserState {
  return {
    tab: 'changes',
    search: '',
    sortField: 'created',
    sortDirection: 'desc',
    dateFrom: null,
    dateTo: null,
    featureSlug,
  }
}

/** Clear the feature pre-filter (the chip's ×). Pure — returns a new state. */
export function clearFeatureFilter(state: CorpusBrowserState): CorpusBrowserState {
  return { ...state, featureSlug: null }
}

const TAB_KIND: Record<CorpusBrowserTab, BlueprintCorpusIndexEntry['kind']> = {
  changes: 'change',
  discoveries: 'discovery',
}

/** Per-tab totals over the whole index, for the tab badges. Both kinds are
 *  counted EXPLICITLY — never one derived by subtracting the other from a
 *  total, so an unknown `kind` inflates neither badge. */
export function countCorpusTabs(entries: BlueprintCorpusIndexEntry[]): {
  changes: number
  discoveries: number
} {
  let changes = 0
  let discoveries = 0
  for (const entry of entries) {
    if (entry.kind === 'change') changes += 1
    else if (entry.kind === 'discovery') discoveries += 1
  }
  return { changes, discoveries }
}

/** Last path segment — search matches the filename a user sees in `flow/`. */
function corpusPathBasename(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

/**
 * The learn filter's matching contract, widened to the corpus fields: trimmed
 * lowercase literal substring over name, path basename, and feature slug.
 * Blank query matches everything.
 */
export function matchesCorpusSearch(entry: BlueprintCorpusIndexEntry, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (query === '') return true
  if (entry.name.toLowerCase().includes(query)) return true
  if (corpusPathBasename(entry.path).toLowerCase().includes(query)) return true
  return entry.featureSlug !== null && entry.featureSlug.toLowerCase().includes(query)
}

/**
 * The feature-store ref a corpus doc resolves to — `plan_chat_engine_v1.md` →
 * `chat-engine`. Mirrors the CLI pair `CORPUS_NAME` + `slugifyFeatureName`
 * (`src/cli/blueprint/feature-discover.ts` walks the same filenames through the
 * same two steps; separate runtimes, no shared import, so the grammar is
 * re-declared here on purpose — the ipc-contract precedent). The slug is a
 * full ref for the doc's change record: `blueprint brief --feature <id|slug>`
 * resolves slugs exactly as it resolves ids. Null when the filename does not
 * follow the corpus convention, so a caller can fall back honestly instead of
 * pressing a ref that resolves nothing.
 */
export function corpusDocRef(path: string): string | null {
  const base = corpusPathBasename(path).replace(/\.md$/, '')
  const match = /^(?:plan|discovery|brainstorm)_(.+?)(?:_v\d+)?$/.exec(base)
  if (match === null) return null
  const slug = match[1]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : null
}

/** The active field's value, or null when absent (legacy record). */
export function corpusEntryDate(
  entry: BlueprintCorpusIndexEntry,
  field: CorpusDateField,
): string | null {
  const value = field === 'created' ? entry.created : entry.indexed
  return value ?? null
}

/** `YYYY-MM-DD` day key for inclusive range comparison, normalized to the
 *  UTC day. Git `%aI` dates carry author-local offsets while pass timestamps
 *  are UTC — slicing the raw string would bucket the two inconsistently; an
 *  unparsable value yields null and the entry counts as undated. */
function corpusDayKey(value: string | null): string | null {
  if (value === null) return null
  if (Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString().slice(0, 10)
}

/** Inclusive `[from, to]` check on day precision; null bounds are open. */
function withinDateRange(day: string, from: string | null, to: string | null): boolean {
  if (from !== null && day < from.slice(0, 10)) return false
  if (to !== null && day > to.slice(0, 10)) return false
  return true
}

/** Sort comparator source: epoch millis, or null when undated. */
function corpusSortTime(row: CorpusBrowserRow): number | null {
  if (row.date === null) return null
  const parsed = Date.parse(row.date)
  if (Number.isNaN(parsed)) return null
  return parsed
}

/**
 * The main derivation: full index + UI state → visible rows and the "no
 * feature" group, filtered, sorted, and flagged. Deterministic — ties on the
 * sort date break by name, then path.
 */
export function deriveCorpusBrowserView(
  entries: BlueprintCorpusIndexEntry[],
  state: CorpusBrowserState,
): CorpusBrowserView {
  const kind = TAB_KIND[state.tab]
  const inTab = entries.filter((entry) => entry.kind === kind)

  const rangeActive = state.dateFrom !== null || state.dateTo !== null
  const visible: CorpusBrowserRow[] = []
  for (const entry of inTab) {
    if (state.featureSlug !== null && entry.featureSlug !== state.featureSlug) continue
    if (!matchesCorpusSearch(entry, state.search)) continue
    const date = corpusEntryDate(entry, state.sortField)
    const day = corpusDayKey(date)
    if (rangeActive) {
      // A doc with no date on the active field cannot fall inside the range.
      if (day === null) continue
      if (!withinDateRange(day, state.dateFrom, state.dateTo)) continue
    }
    visible.push({ entry, undated: day === null, archived: entry.archived, date })
  }

  const directionSign = state.sortDirection === 'asc' ? 1 : -1
  const sorted = [...visible].sort((a, b) => {
    const timeA = corpusSortTime(a)
    const timeB = corpusSortTime(b)
    // Undated pins last in BOTH directions — missing data is not a value.
    if (timeA === null && timeB !== null) return 1
    if (timeA !== null && timeB === null) return -1
    if (timeA !== null && timeB !== null && timeA !== timeB) {
      return (timeA - timeB) * directionSign
    }
    const byName = a.entry.name.localeCompare(b.entry.name)
    if (byName !== 0) return byName
    return a.entry.path.localeCompare(b.entry.path)
  })

  return {
    rows: sorted.filter((row) => row.entry.featureSlug !== null),
    noFeatureRows: sorted.filter((row) => row.entry.featureSlug === null),
    totalInTab: inTab.length,
  }
}
