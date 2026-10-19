/**
 * Which roots the Source Control panel may address (thread-worktrees Phase 9).
 *
 * THE DEFECT THIS EXISTS FOR. The panel's notion of "a root I know" was the
 * project root list — the user's project list — restated as `rootOrder`. Every
 * scope root was filtered through it before the panel would render a group,
 * refresh git, keep a diff open, or let an armed destructive action fire.
 *
 * A thread's checkout is not in that list, and must never be: putting checkouts
 * in the user's project list would be worse than the bug (the same rule the
 * main-side address gate is built around, `project/addressable-roots.ts`). So
 * once a thread owned a checkout, the scope reported it, `rootOrder` rejected
 * it, and Source Control rendered "No project open" for a thread that had a
 * whole working tree of its own.
 *
 * THE ANSWER IS NOT A SECOND ADDRESS GATE (allowed-pattern #14). The rule for
 * what may be addressed lives in main and stays there. What this does is READ
 * MAIN'S ANSWER: a scope entry is main's own statement that this root is part
 * of the active thread's scope, and `available` is main's own join against the
 * project record — an entry it could not vouch for comes back `available:
 * false`. So "a registered available root, or a scope entry main marked
 * available" is a relay, not a rule of the renderer's own.
 *
 * WHAT THAT MEANS FOR DESTRUCTIVE ACTIONS. This set is also the fire-time
 * domain for the panel's armed confirms (`mayFireGroupAction`) and the validity
 * domain for an open diff. Widening it therefore has to stay narrow in the one
 * way that matters: an entry main flagged `available: false` — a thread root
 * with no project record behind it — is dropped here, so nothing is ever
 * armed against a root main would not stand behind.
 *
 * Pure and DOM-free: unit-testable without the panel.
 */
import type { ThreadScopeEntry } from '../../shared/ipc-contract'

/**
 * The panel's root domain: the project list's own available roots in their order,
 * followed by any scope root not already among them.
 *
 * Order matters — `rootOrder[0]` is the panel's boot focus, and the registered
 * roots keep the project list's ordering they always had.
 *
 * `scopeEntries` is null (or empty) whenever the panel is running on the legacy
 * active-root binding, in which case this is exactly `registeredOrder` — the
 * pre-worktree behaviour, unchanged.
 */
export function panelRootDomain(
  registeredOrder: readonly string[],
  scopeEntries: readonly ThreadScopeEntry[] | null,
): string[] {
  const domain = [...registeredOrder]
  for (const entry of scopeEntries ?? []) {
    // Main could not vouch for this one — it has no project record behind it
    // (or its project has gone away). It is kept in the scope so the auto-open
    // phase can materialize it; it is not something to address, refresh, or arm
    // an action against.
    if (entry.available === false) continue
    if (entry.rootPath === '') continue
    if (domain.includes(entry.rootPath)) continue
    domain.push(entry.rootPath)
  }
  return domain
}

/**
 * The project's OWN tree, when the active thread's checkout has displaced it
 * from the scope. Null when nothing is displaced — which is every state that
 * existed before thread worktrees, so this changes nothing for them.
 *
 * THE DEFECT THIS EXISTS FOR. A thread with a checkout reports THAT as its
 * primary root, and the project's own tree is then not a scope root at all.
 * Source Control renders one group per scope root, so the first real use of the
 * feature showed the thread's copy, the two sibling repos — and nowhere at all
 * the tree the user's own uncommitted work was sitting in. Their changes had
 * not gone anywhere; the only surface that shows changes had stopped listing
 * the tree they were in.
 *
 * A thread's checkout is ADDITIONAL here, not a replacement. The terminal strip
 * reached the same conclusion for the same reason (`terminal-scope.ts`'s
 * function of this name): a running shell the user could reach a moment ago
 * must not vanish, and neither must their working tree.
 *
 * This is a VISIBILITY answer only. It grants nothing: the project root is a
 * REGISTERED project root — it was already in `panelRootDomain` via
 * `registeredOrder`, already watched, already refreshable, already a legal
 * target for every action the panel offers. Nothing about what may be addressed
 * moves (that rule lives in main — `project/addressable-roots.ts`), and the
 * thread's scope itself is untouched: the agent still cannot reach out here.
 */
export function displacedProjectRoot(
  scopeEntries: readonly ThreadScopeEntry[] | null,
  activeProjectRoot: string | null,
): string | null {
  if (scopeEntries === null || scopeEntries.length === 0) return null
  if (activeProjectRoot === null) return null
  // Not displaced when the project IS a scope root — the case for every thread
  // without a checkout, so this returns null and the panel is byte-identical to
  // what it was before worktrees existed.
  return scopeEntries.some((entry) => entry.rootPath === activeProjectRoot)
    ? null
    : activeProjectRoot
}

/**
 * The roots the panel puts on screen under a thread scope, in render order.
 *
 * ONE GROUP PER REPOSITORY (user call 2026-08-26: "lets show just one of each
 * of them"). A thread with a checkout used to put that repository on screen
 * TWICE — the thread's copy and the project's own tree, under two names that
 * differed by a parenthesis. It was deliberate: the project's tree is where a
 * person's own uncommitted work sits, and a thread's checkout displaces it from
 * the scope entirely, so without this the only surface that shows changes
 * stopped listing the tree those changes were in.
 *
 * THE COST OF THE CHANGE, NAMED. While a thread has a checkout, uncommitted
 * work in the project's shared tree is not on this panel. It has not moved and
 * nothing has happened to it; it is reachable from any thread without a
 * checkout of its own, which is every chat-only thread. The duplicate was the
 * price of showing it, and the duplicate is what was rejected.
 *
 * THE FALLBACK SURVIVES, and it is the reason this is not simply a deletion.
 * When the thread's own checkout is NOT addressable — no project record
 * behind it, so `panelRootDomain` drops it — the project's tree is the only
 * tree of that repository the panel has, and it is shown. "One of each" is the
 * rule; "none" never was.
 *
 * ORDER. The thread's checkout stays FIRST. It is the scope's primary root, the
 * one the editor and the terminal are pointed at, the one an agent is writing
 * to this second — and the panel's leading root is also its focus: `syncRoots`
 * refreshes `visibleRoots()[0]` before anything else, and demoting it would
 * spend that refresh on a tree nobody is looking at. The question the panel
 * answers is "what has changed", and the answer that is still changing goes on
 * top.
 *
 * Roots the domain does not vouch for are dropped, exactly as before: an entry
 * main flagged `available: false` never reaches `panelRootDomain`, so it is not
 * rendered, refreshed, or armed against.
 */
export function panelVisibleRoots(
  scopeEntries: readonly ThreadScopeEntry[] | null,
  addressable: readonly string[],
  activeProjectRoot: string | null,
): string[] {
  const visible = (scopeEntries ?? [])
    .map((entry) => entry.rootPath)
    .filter((rootPath) => addressable.includes(rootPath))
  const displaced = displacedProjectRoot(scopeEntries, activeProjectRoot)
  if (displaced === null || !addressable.includes(displaced) || visible.includes(displaced)) {
    return visible
  }
  // The thread's own checkout is on screen, so this repository already has its
  // group and the project's tree would be its second.
  const primary = (scopeEntries ?? []).find((entry) => entry.primary)?.rootPath
  if (primary !== undefined && visible.includes(primary)) return visible
  // Nothing of this repository is on screen otherwise — the project's tree is
  // the only one the panel has, and it leads.
  visible.unshift(displaced)
  return visible
}
