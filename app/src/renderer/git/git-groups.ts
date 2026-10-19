// Source Control repo groups (multi-project-threads Phase 4).
//
// The git panel lifts ADR-002's single-root constraint (superseded — see
// docs/adr-002-project-context.md): when the active thread's scope spans
// multiple roots, the panel renders ONE GROUP PER REPO in scope order, each
// with its own header (accent dot + project name + branch), change lists,
// commit box, and gates — all driving the existing per-root IPC. This module
// is the PURE view-model derivation (DOM-free, unit-testable under the node
// jest env); git-panel.ts renders the returned groups.
//
// The single-root rule: a scope with one root renders ZERO group chrome —
// byte-identical to the pre-scope panel (same NFR as the Phase 3 file tree).
import type { GitStatus, ThreadScopeEntry } from '../../shared/ipc-contract'
import type { GitRootView } from './git-panel'

/** Header chrome for one repo group — null when the group renders chromeless
 *  (the single-root rule). */
export interface GitGroupHeader {
  /** Absolute rootPath — the accent + collapse identity. */
  rootPath: string
  /** Display name (scope entry name, else the path's last segment). */
  name: string
  /** Current branch ('' when unknown / not a repository). */
  branch: string
  /** Compact ahead/behind marker ('↑1 ↓2', '' when in sync/unknown) — the
   *  branch header's existing presentation, lifted to the group header. */
  aheadBehind: string
  /** True for the thread's primary root (renders the 'main' tag). */
  primary: boolean
  /** User accent override from the scope entry (`#rrggbb`). Absent = no
   *  override — the deterministic hash accent applies. */
  accent?: string
  /** Availability from the scope entry (#263) — unreachable roots render the
   *  sidebar's unavailable treatment instead of pretending to be healthy. */
  available: boolean
}

/** One rendered repo group: optional header chrome + the root's view data. */
export interface GitGroup {
  header: GitGroupHeader | null
  view: GitRootView
}

/** The existing branch-header ahead/behind presentation, extracted pure. */
export function aheadBehindLabel(status: GitStatus | null): string {
  if (!status) return ''
  const parts: string[] = []
  if (status.ahead > 0) parts.push(`↑${status.ahead}`)
  if (status.behind > 0) parts.push(`↓${status.behind}`)
  return parts.join(' ')
}

/**
 * Derive the panel's repo groups from the resolved views (already in scope
 * order — resolvePanelState owns ordering/filtering) plus the thread-scope
 * entries for naming/primary/availability. `scope` null → the legacy
 * active-root binding (fail-soft): groups still derive, with names falling
 * back to path segments and the first view treated as primary.
 *
 * Single-root rule: exactly one view ⇒ its header is null (no group chrome),
 * keeping the common case byte-identical to the pre-scope panel.
 */
export function deriveGitGroups(
  views: GitRootView[],
  scope: ThreadScopeEntry[] | null,
): GitGroup[] {
  const showHeaders = views.length > 1
  const entryFor = new Map<string, ThreadScopeEntry>()
  for (const entry of scope ?? []) entryFor.set(entry.rootPath, entry)
  return views.map((view, index) => {
    if (!showHeaders) return { header: null, view }
    const entry = entryFor.get(view.rootPath)
    return {
      header: {
        rootPath: view.rootPath,
        name: entry?.name ?? lastPathSegment(view.rootPath),
        branch: view.status?.branch ?? '',
        aheadBehind: aheadBehindLabel(view.status),
        primary: entry?.primary ?? index === 0,
        available: entry?.available ?? true,
        ...(entry?.accent !== undefined ? { accent: entry.accent } : {}),
      },
      view,
    }
  })
}

/**
 * The repo name to put in destructive copy for `rootPath` — or null when the
 * panel shows a single repo and naming it would be noise (#1144).
 *
 * Same identity the group HEADER renders (scope entry name, else the path's
 * last segment), so the confirm names the repo the way the user sees it named
 * two lines above the button they clicked. The single-root rule is deliberate:
 * with one repo the copy stays byte-identical to the pre-scope panel.
 */
export function repoConfirmName(
  rootPath: string,
  scope: ThreadScopeEntry[] | null,
  visibleRootCount: number,
): string | null {
  if (visibleRootCount <= 1) return null
  const entry = (scope ?? []).find((candidate) => candidate.rootPath === rootPath)
  return entry?.name ?? lastPathSegment(rootPath)
}

/**
 * What hovering a repo group's header says.
 *
 * IT SAYS WHAT THE GROUP IS, NOT WHERE IT LIVES. The primary group has had a
 * sentence since the 'main' text tag was dropped; every other group got
 * `head.title = header.rootPath` — an absolute filesystem path, on screen, on
 * every multi-root thread (forbidden-pattern #12). A path is the app's internal
 * spelling: the reader cannot act on it, it changes when the folder moves, and
 * it answers a question ("where is this on disk?") nobody asked of a tooltip on
 * a repository name they can already see.
 *
 * The primary's wording is UNCHANGED, deliberately — it is asserted verbatim by
 * the file tree's own tooltip and by the multi-project spec, and one sentence
 * for one role is the point.
 *
 * Pure and DOM-free: git-panel.ts sets whatever this returns.
 */
export function groupHeaderTitle(header: GitGroupHeader): string {
  if (header.primary) return 'Primary project — owns plans and flow state'
  return header.available
    ? 'Another project this thread works in — it has its own branch and its own changes.'
    : 'Another project this thread works in. Flow can’t reach it right now, so this is the last it saw.'
}

/** Collapse-store key for a repo group (namespaced so it can never collide
 *  with the section keys 'merge'/'staged'/'changes'/'commits'). */
export function groupCollapseKey(rootPath: string): string {
  return `root:${rootPath}`
}

/**
 * Fire-time guard for the git panel's destructive confirms (#951 generalized
 * for multi-root scope). The review panel's `mayFireArmedAction` compares the
 * armed root against THE active root; the grouped git panel legitimately fires
 * against any root it currently displays — so the invariant becomes: a
 * destructive action may only fire on the root it was ARMED on, and only
 * while that root is still part of the panel's visible root set. A scope
 * switch between arming (confirm open) and firing refuses the action.
 */
export function mayFireGroupAction(
  armedRoot: string | null,
  visibleRoots: readonly string[],
): boolean {
  return armedRoot !== null && visibleRoots.includes(armedRoot)
}

/**
 * Diff-overlay visibility for the grouped panel: the overlay stays valid while
 * its root is VISIBLE in the panel (the active project or any scope root that
 * is still alive) — the multi-root generalization of #191's "belongs to the
 * focused project" rule. Single-root scope (visible = [activeRoot]) reproduces
 * `shouldCloseDiff` exactly.
 */
export function diffRootStillVisible(
  diffRoot: string | null,
  visibleRoots: readonly string[],
  aliveRoots: ReadonlySet<string>,
): boolean {
  if (diffRoot === null) return false
  return aliveRoots.has(diffRoot) && visibleRoots.includes(diffRoot)
}

/**
 * Group any root-stamped items (e.g. the pending-hunks listing's
 * `PendingFileChange` rows) by their rootId, preserving first-seen order
 * within and across groups. `multiRoot` is true only when more than one
 * distinct root is present — the caller renders accent group headers exactly
 * then, keeping the single-root listing chrome-free (same rule as the panel).
 */
export function groupByRoot<T extends { rootId: string }>(
  items: readonly T[],
): { multiRoot: boolean; groups: Array<{ rootId: string; items: T[] }> } {
  const groups: Array<{ rootId: string; items: T[] }> = []
  const byRoot = new Map<string, { rootId: string; items: T[] }>()
  for (const item of items) {
    let group = byRoot.get(item.rootId)
    if (!group) {
      group = { rootId: item.rootId, items: [] }
      byRoot.set(item.rootId, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return { multiRoot: groups.length > 1, groups }
}

/** The path's last segment — display-name fallback when no scope entry names
 *  the root (mirrors git-panel's lastSegment, kept here so the module stays
 *  dependency-free for jest). */
export function lastPathSegment(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}
