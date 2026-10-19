/**
 * Which slot each open project wears — its position in its Workspace (pure;
 * the wiring that reads the Workspaces is project-accent-workspaces.ts).
 */
import { comparablePath } from './threads/workspace-switcher-model'

export interface ListedWorkspace {
  projects: ReadonlyArray<{ localPath: string | null }>
}

/**
 * Root path → slot. Pure. `roots` are the paths Flow has open; a Workspace
 * project matches the one whose path is the same once `/private` and trailing
 * slashes are set aside.
 */
export function slotsFor(workspaces: readonly ListedWorkspace[], roots: readonly string[]): Map<string, number> {
  const byPath = new Map(roots.map((root) => [comparablePath(root), root]))
  const slots = new Map<string, number>()
  for (const workspace of workspaces) {
    workspace.projects.forEach((project, index) => {
      if (project.localPath === null) return
      const root = byPath.get(comparablePath(project.localPath))
      if (root !== undefined && !slots.has(root)) slots.set(root, index)
    })
  }
  return slots
}
