/**
 * When an open feature view reloads its walkthrough page — PURE, no DOM, so the
 * rules are held by a test rather than restated at every call site
 * (allowed-pattern #17: one helper, not ad-hoc visibility checks).
 *
 * A discovery and its page are rewritten by an agent many times while they are
 * being drafted. Each rewrite emits an artifact-changed event for the doc, and
 * each reload re-runs the whole page in its frame. Only a view someone can see
 * pays that; any other view is marked stale and catches up the moment it comes
 * back on screen — it never queues one reload per event. And a markdown-only
 * edit, which leaves the page untouched, reloads nothing at all.
 */
import { docVersionLabel } from './artifact-card-model'

/**
 * Editor-tab id of a discovery's feature view: one tab per PROJECT, slug,
 * VERSION and CONVERSATION. Slugs come from file names and are not unique
 * across projects — keyed by slug alone, opening a second project's
 * `onboarding` discovery would silently repurpose the first project's tab.
 * Every version of a discovery has its own page, and two versions are opened to
 * be COMPARED, so `_v7` and `_v8` are two tabs side by side, keyed by the page's
 * path (user call 2026-10-01). And each conversation keeps its own tabs: the
 * same discovery opened from two threads is two views, each in its own thread's
 * tab set (`threadId: null` — opened with no thread selected).
 */
export function featureViewTabId(
  rootPath: string | null,
  slug: string,
  pagePath: string,
  threadId: string | null = null,
): string {
  const thread = threadId === null ? '' : `&thread=${encodeURIComponent(threadId)}`
  return `flow://feature-view/${slug}?root=${encodeURIComponent(rootPath ?? '')}&page=${encodeURIComponent(pagePath)}${thread}`
}

/**
 * The tab's label: the slug and the version it shows — `pay v7` beside
 * `pay v8` — so two versions open side by side can be told apart.
 */
export function featureViewTabLabel(slug: string, pagePath: string): string {
  const version = docVersionLabel(pagePath)
  return version === null ? slug : `${slug} ${version}`
}

/** What the view last framed: whether the page existed, and its mtime if known. */
export interface FeatureViewPageState {
  present: boolean
  mtime?: number
}

/** What a doc event means for the page an open view frames:
 *   - `reload` — the page appeared or changed: frame it again.
 *   - `gone`   — the page was removed: say so instead of framing a missing page.
 *   - `none`   — the page did not change (a markdown-only edit): leave it. */
export type FeatureViewPageChange = 'reload' | 'gone' | 'none'

export function featureViewPageChange(
  known: FeatureViewPageState,
  event: { walkthrough?: boolean; walkthroughMtime?: number },
): FeatureViewPageChange {
  if (event.walkthrough !== true) return known.present ? 'gone' : 'none'
  if (!known.present) return 'reload'
  if (known.mtime === undefined || event.walkthroughMtime === undefined) return 'reload'
  return known.mtime === event.walkthroughMtime ? 'none' : 'reload'
}

/** What to do with an open feature view when its page changed on disk:
 *   - `now`   — it is on screen: reload the frame.
 *   - `defer` — its tab is open but not on screen: mark stale, reload on return.
 *   - `skip`  — its tab is closed: nothing; opening it again always reloads. */
export type FeatureViewRefreshDecision = 'now' | 'defer' | 'skip'

export interface FeatureViewRefreshInput {
  /** Whether the view's tab is in the editor's tab strip. */
  tabOpen: boolean
  /** Whether the view is actually drawn: its tab active, the editor shown, the
   *  window visible. */
  onScreen: boolean
}

/**
 * The feature views to close when the tab set on screen changes: every one
 * that belongs to a different project OR a different conversation. A feature
 * view left open would keep showing the old project's doc while its board
 * doors act on the new one, and would show one thread's work on another. The
 * tab-set switch already closes them; this is the backstop for a view opened
 * while that switch was in flight. Switching back to its conversation
 * restores it.
 */
export function featureViewsToClose(
  views: ReadonlyArray<{ id: string; rootPath: string | null; threadId: string | null }>,
  activeRoot: string | null,
  activeThreadId: string | null = null,
): string[] {
  return views
    .filter((view) => view.rootPath !== activeRoot || view.threadId !== activeThreadId)
    .map((view) => view.id)
}

export function decideFeatureViewRefresh(input: FeatureViewRefreshInput): FeatureViewRefreshDecision {
  if (!input.tabOpen) return 'skip'
  return input.onScreen ? 'now' : 'defer'
}
