/**
 * THE BOARD OF A WORKSPACE — which projects' cards it draws, and how a card
 * says where it belongs. DOM-free.
 *
 * With Workspaces on and a Workspace chosen, the board is that Workspace's:
 * every card filed against any of its projects, each tagged with its project —
 * and with the extra projects a card was linked to, so a card that spans the
 * backend and the frontend says both. Outside a Workspace (or with Workspaces
 * off) the board is exactly what it was: the active project's.
 *
 * The board's other half — the loop's live list in Todo — stays the active
 * project's. That list is one project's file or one repository's issues; it
 * has no Workspace to be read across.
 */

import { rootsInScope, type RootMembership, type WorkspaceScope } from '../threads/workspace-switcher-model'

/**
 * The project roots whose cards the board loads. The active project first (it
 * owns the loop's list), then the rest of the Workspace in sidebar order.
 */
export function boardRoots(input: {
  scope: WorkspaceScope
  activeRoot: string | null
  registered: readonly string[]
  membership: RootMembership
}): string[] {
  if (input.scope.kind !== 'workspace') return input.activeRoot === null ? [] : [input.activeRoot]
  const inScope = rootsInScope(input.registered, input.scope, input.membership)
  if (input.activeRoot !== null && inScope.includes(input.activeRoot)) {
    return [input.activeRoot, ...inScope.filter((root) => root !== input.activeRoot)]
  }
  return inScope
}

/** Whether cards carry a project tag (only a Workspace board mixes projects). */
export function boardTagsCards(scope: WorkspaceScope): boolean {
  return scope.kind === 'workspace'
}

/**
 * A card's project names: its own project first, then the extra projects it
 * was linked to, each once.
 */
export function cardProjectNames(input: {
  projectRoot: string
  extraRoots: readonly string[] | undefined
  name: (root: string) => string
}): string[] {
  const names: string[] = []
  for (const root of [input.projectRoot, ...(input.extraRoots ?? [])]) {
    const name = input.name(root)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** The tag's text: "Backend", or "Backend + Frontend" for a card that spans both. */
export function cardProjectTag(names: readonly string[]): string {
  return names.join(' + ')
}
