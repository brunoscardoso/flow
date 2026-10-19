/**
 * WHICH WORKSPACE'S SYNC CARRIES A PROJECT'S KNOWLEDGE.
 *
 * One decision, in one place (allowed-pattern #14), asked by every caller that
 * starts a sync for a project root: provisioning's open, the commit after a
 * turn, and quit.
 *
 * EVERY PROJECT LIVES IN A WORKSPACE (decision 2026-10-06, hard migration), so
 * there is ONE sync path: the Workspace's. The per-project knowledge sync that
 * used to own projects outside a Workspace — or projects that kept a
 * knowledge repository of their own — is gone; such projects are migrated
 * like every other. A project the registry places in no Workspace (its move is
 * waiting on a person, or failed) has nothing to sync until it moves in.
 *
 * Membership comes from the registry's one answer (`membershipOf`, over the
 * CLI's listing), never from a path the app works out itself.
 *
 * A THREAD IS ONE SYNC PER WORKSPACE. A turn in a thread that touched its
 * primary project and attached projects of the same Workspace commits that
 * Workspace once; attached projects in another Workspace add that one.
 */

import type { WorkspaceAnswer, WorkspaceRootMembership } from '../../shared/workspaces-contract'
import type { WorkspaceSyncEngine } from './workspace-sync-engine'

/** The registry call the route needs (structurally `WorkspaceRegistry`). */
export interface RouteRegistry {
  /** ONE batched membership read for any number of roots (one cached listing). */
  membershipOf(roots: readonly string[]): Promise<WorkspaceAnswer<WorkspaceRootMembership>>
}

export interface KnowledgeRouteDeps {
  registry: RouteRegistry
  log: (message: string, detail?: Record<string, unknown>) => void
}

/**
 * The Workspace whose sync carries each project's knowledge (null → none: the
 * project is not in a Workspace yet), in the order asked. ONE membership read
 * for all of them — a turn across five projects asks the registry once.
 */
export type WorkspaceRoute = (rootPaths: readonly string[]) => Promise<Array<string | null>>

export function createWorkspaceRoute(deps: KnowledgeRouteDeps): WorkspaceRoute {
  return async (rootPaths) => {
    const none = rootPaths.map((): string | null => null)
    if (rootPaths.length === 0) return none
    try {
      const answer = await deps.registry.membershipOf(rootPaths)
      if (!answer.ok) return none
      const byRoot = new Map(answer.roots.map((entry) => [entry.root, entry]))
      return rootPaths.map((root) => byRoot.get(root)?.workspace ?? null)
    } catch (error) {
      deps.log('deciding which Workspace carries a project failed', { rootPaths: [...rootPaths], error: String(error) })
      return none
    }
  }
}

export interface KnowledgeRouterDeps {
  workspaces: Pick<WorkspaceSyncEngine, 'open' | 'commitAfterTurn' | 'quit'>
  route: WorkspaceRoute
}

export interface KnowledgeRouter {
  /** Sync on open — the project's Workspace's. */
  open(rootPath: string): Promise<void>
  /**
   * A turn finished. `primary` first, then the thread's attached projects; one
   * sync per Workspace among them.
   */
  commitAfterTurn(primary: string, attached: readonly string[], labelFor: (rootPath: string) => string): Promise<void>
  /** The engine's bounded quit. */
  quit(): Promise<void>
}

export function createKnowledgeRouter(deps: KnowledgeRouterDeps): KnowledgeRouter {
  async function open(rootPath: string): Promise<void> {
    const [slug = null] = await deps.route([rootPath])
    if (slug !== null) await deps.workspaces.open(slug)
  }

  async function commitAfterTurn(
    primary: string,
    attached: readonly string[],
    labelFor: (rootPath: string) => string,
  ): Promise<void> {
    const roots = [primary, ...attached.filter((root) => root !== primary)]
    const routes = await deps.route(roots)
    const seen = new Set<string>()
    for (const [index, slug] of routes.entries()) {
      if (slug === null || seen.has(slug)) continue
      seen.add(slug)
      deps.workspaces.commitAfterTurn(slug, labelFor(roots[index]))
    }
  }

  async function quit(): Promise<void> {
    await deps.workspaces.quit()
  }

  return { open, commitAfterTurn, quit }
}
