// Add-a-project orchestration, shared by the project:add and
// project:open IPC handlers so the "which pick actually enters the
// project" invariant lives in ONE code path, not duplicated per handler
// (#382/#1008, allowed-pattern #14).

export interface AddRootPorts<R extends { rootPath: string }> {
  /** Add (or dedupe) a project root; returns the resulting root. */
  addRoot(rootPath: string): R
  /** The active project's root path, or null when nothing is active. */
  activeRoot(): string | null
  /** Enter a project — fires activeProjectChanged so every surface rebinds. */
  setActiveProject(rootPath: string): void
}

/**
 * How the caller's pick relates to the active project.
 *
 * - `when-idle` — a BACKGROUND add (`project:add`: a repo discovered on
 *   the board, a folder attached to a thread's context). Enters the project
 *   only when nothing is active yet, so a second project never yanks the user
 *   out of the one they're working in (#382).
 * - `always` — a FOREGROUND open (`project:open`: the user picked a
 *   folder in "Open Project…"). The user named a project; entering it IS the
 *   action. Under `when-idle` this was a total no-op whenever a project was
 *   already open — picking an already-added folder deduped and activated
 *   nothing, so the app did literally nothing with an explicit request (#1008).
 */
export type RootActivation = 'when-idle' | 'always'

/**
 * Add a project root and enter it according to `activation` (default
 * `when-idle`, preserving #382's background-add behavior for every existing
 * caller). The added root is deduped by addRoot, so activation always uses the
 * RETURNED canonical path, not the raw argument — which is exactly why a
 * re-picked, already-present folder still activates under `always`.
 */
export function addRootAndMaybeActivate<R extends { rootPath: string }>(
  ports: AddRootPorts<R>,
  rootPath: string,
  activation: RootActivation = 'when-idle',
): R {
  const root = ports.addRoot(rootPath)
  const shouldActivate = activation === 'always' || ports.activeRoot() === null
  if (shouldActivate && ports.activeRoot() !== root.rootPath) {
    ports.setActiveProject(root.rootPath)
  }
  return root
}
