/**
 * The commit log's header and paging state (#1335) — pure, DOM-free.
 *
 * `Commits (N)` printed a capped PAGE SIZE while sitting in the same grammar
 * as `Changes (N)` and `Staged Changes (N)`, which really are exact. So every
 * repo with more than 100 commits read `COMMITS (100)` forever — a page
 * wearing a total's clothes — and there was no route to anything older,
 * because the `before` cursor `GitManager.log` has always accepted was never
 * forwarded through the IPC channel.
 */

/** How many commits one page asks for. */
export const LOG_PAGE_SIZE = 100

export interface CommitLogWindow {
  /** Section label — a count only when it is genuinely the whole history. */
  label: string
  /** Whether an "older" affordance should be offered. */
  canLoadOlder: boolean
}

/**
 * Describe the loaded window.
 *
 * A page that came back FULL means git had at least that many to give, so the
 * total is unknown and the label says "latest N" instead of claiming N. A
 * short page is the end of the history: then, and only then, the count is a
 * fact and reads like its exact siblings.
 *
 * `exhausted` is the same conclusion reached by observation instead of by
 * arithmetic (#1438). A repo whose history is EXACTLY one page long (100
 * commits, or 200, 300 …) sits on the boundary forever, so the boundary rule
 * alone offers a button that can only ask git for nothing and re-render — a
 * permanent dead click. Once the caller has actually seen git run out, that is
 * a fact about the repo and outranks the inference.
 */
export function commitLogWindow(
  loaded: number,
  pageSize = LOG_PAGE_SIZE,
  exhausted = false,
): CommitLogWindow {
  if (loaded === 0) return { label: 'Commits (0)', canLoadOlder: false }
  if (exhausted) return { label: `Commits (${loaded})`, canLoadOlder: false }
  // Loaded is a multiple of the page size ⇒ every page so far came back full.
  const atPageBoundary = loaded % pageSize === 0
  return atPageBoundary
    ? { label: `Commits · latest ${loaded}`, canLoadOlder: true }
    : { label: `Commits (${loaded})`, canLoadOlder: false }
}

/**
 * The cursor for the next page: the oldest commit loaded. `GitManager.log`
 * pages with `--skip=1 <rev>`, so passing the last hash returns what precedes
 * it. Null when there is nothing to page from.
 */
export function nextPageCursor(commits: ReadonlyArray<{ hash: string }>): string | null {
  const oldest = commits[commits.length - 1]
  return oldest?.hash ?? null
}
