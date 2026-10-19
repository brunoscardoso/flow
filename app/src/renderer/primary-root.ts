// The renderer's ONE answer to "which working tree is on screen right now?"
//
// Before threads owned checkouts, "the active project's rootPath" was that
// answer, and every panel cached it off `project:activeChanged`
// independently. A thread with its own git worktree breaks that equivalence:
// the project's tree and the thread's tree are different directories, with
// different files, on different branches — and a panel still reading the
// project is a panel silently showing the wrong repo.
//
// Main already derives the truth (ThreadScopeManager reports the thread's
// worktree as the scope's primary root), so nothing is derived here
// (allowed-pattern #14, one scope source of truth). This only JOINS the two
// subscriptions a surface would otherwise wire by hand, and reports the primary
// root, deduped.
//
// Deliberately DOM-free and dependency-free (a type-only import) so it runs
// under plain `npx jest`.

import type { ProjectContext, ThreadScope } from '../shared/ipc-contract'

/** Unsubscribe handle, matching the preload bridge's `Unsubscribe`. */
export type Unbind = () => void

/**
 * The slice of `window.flow.project` this needs. The two scope members are
 * OPTIONAL on purpose: every existing scope consumer feature-detects them
 * (`typeof … === 'function'`) so a renderer running against an older preload
 * degrades to the active project instead of throwing.
 */
export interface PrimaryRootApi {
  active(): Promise<ProjectContext | null>
  onActiveChanged(listener: (context: ProjectContext | null) => void): Unbind
  getThreadScope?: () => Promise<ThreadScope>
  onThreadScopeChanged?: (listener: (scope: ThreadScope) => void) => Unbind
}

/**
 * Resolve the working tree on screen: the thread scope's primary root when
 * there is a scope, else the active project's root.
 *
 * These are not two competing sources. The scope ALREADY degrades to the active
 * project's single root when no thread is active, so the project root is the
 * fallback for "no scope at all" — no project open, or a preload with no scope
 * channel — never a second opinion about a live one.
 */
export function primaryRootOf(
  scope: ThreadScope | null,
  projectRoot: string | null,
): string | null {
  const primary = scope?.roots.find((root) => root.primary) ?? scope?.roots[0]
  return primary?.rootPath ?? projectRoot
}

/**
 * One-shot read of the current working tree, for surfaces that resolve it fresh
 * each time they open rather than holding a subscription (the command palette).
 * Fail-soft on both halves — a rejected snapshot reads as "nothing known here",
 * which is what the palette's own `catch(() => null)` already did.
 */
export async function readPrimaryRoot(api: PrimaryRootApi): Promise<string | null> {
  const getScope = api.getThreadScope
  const [context, scope] = await Promise.all([
    api.active().catch(() => null),
    typeof getScope === 'function' ? getScope().catch(() => null) : Promise.resolve(null),
  ])
  return primaryRootOf(scope, context?.rootPath ?? null)
}

/**
 * Subscribe a surface to the current working tree.
 *
 * `onChange` fires once with the seeded value, then once per ACTUAL change of
 * the resolved root — never for a scope event that leaves it where it was.
 * Every caller answers it by discarding cached state and reloading, so an event
 * that changes nothing the surface draws must cost nothing (allowed-pattern
 * #17). The seeding report is unconditional, including a null root: "no project
 * open" is a state a surface must be TOLD to enter, not one it may assume.
 *
 * Returns a disposer that drops both subscriptions.
 */
export function bindPrimaryRoot(
  api: PrimaryRootApi,
  onChange: (rootPath: string | null) => void,
): Unbind {
  const getScope = api.getThreadScope
  const onScopeChanged = api.onThreadScopeChanged
  const scopeAvailable = typeof getScope === 'function' && typeof onScopeChanged === 'function'

  let scope: ThreadScope | null = null
  let projectRoot: string | null = null
  let current: string | null = null
  let seeded = false
  let disposed = false
  // A live event that lands DURING seeding is newer than the snapshot being
  // awaited — without this the snapshot would overwrite it and the surface
  // would sit on a root that has already moved.
  let projectIsLive = false
  let scopeIsLive = false

  const report = (next: string | null): void => {
    if (next === current) return
    current = next
    onChange(next)
  }

  const settle = (): void => {
    if (disposed || !seeded) return
    report(primaryRootOf(scope, projectRoot))
  }

  const unbindProject = api.onActiveChanged((context) => {
    projectRoot = context?.rootPath ?? null
    projectIsLive = true
    settle()
  })

  const unbindScope: Unbind =
    scopeAvailable && onScopeChanged !== undefined
      ? onScopeChanged((next) => {
          scope = next
          scopeIsLive = true
          settle()
        })
      : () => undefined

  // Read both snapshots before reporting anything, so a surface never sees the
  // project root flash past on its way to the thread's. Fail-soft: a rejected
  // snapshot leaves that half null, which the resolution already reads as
  // "nothing known here".
  const seedScope =
    scopeAvailable && getScope !== undefined
      ? getScope().catch(() => null)
      : Promise.resolve(null)
  void Promise.all([api.active().catch(() => null), seedScope]).then(
    ([context, initialScope]) => {
      if (disposed) return
      if (!projectIsLive) projectRoot = context?.rootPath ?? null
      if (!scopeIsLive) scope = initialScope
      seeded = true
      current = primaryRootOf(scope, projectRoot)
      onChange(current)
    },
  )

  return () => {
    disposed = true
    unbindProject()
    unbindScope()
  }
}
