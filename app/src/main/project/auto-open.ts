// Auto-open on thread activation (multi-project threads, phase 6).
//
// When a thread becomes active (ProjectContextManager.setActiveThread — the
// one active_thread_id write path, announced via ACTIVE_THREAD_CHANGED_EVENT),
// any of its thread_roots that exists on disk but has no project record (a
// closed / never-opened project) is opened through the existing
// ProjectRegistry.addRoot path — idempotent, and the provisioner reacts to
// the resulting rootsChanged on its own. Roots missing on disk are left alone:
// the scope model already surfaces them as unavailable entries.

import { statSync } from 'fs'
import { EventEmitter } from 'events'

import { ACTIVE_THREAD_CHANGED_EVENT, type ActiveThreadChangedEvent } from './project-context'

/**
 * Pure decision: which of a thread's roots should be opened now?
 * A root qualifies when it is not already a project root (open OR unavailable
 * record — unavailable records are the availability-refresh mechanism's job,
 * #263) and its directory exists on disk. Order preserved, deduped.
 */
export function autoOpenTargets(
  threadRoots: readonly string[],
  projectRootPaths: readonly string[],
  existsOnDisk: (path: string) => boolean,
): string[] {
  const known = new Set(projectRootPaths)
  const seen = new Set<string>()
  const targets: string[] = []
  for (const rootPath of threadRoots) {
    if (rootPath === '' || seen.has(rootPath) || known.has(rootPath)) continue
    seen.add(rootPath)
    if (existsOnDisk(rootPath)) targets.push(rootPath)
  }
  return targets
}

/** Event-source seam (structurally satisfied by ProjectContextManager). */
interface ActivationEventSource {
  on: EventEmitter['on']
  off: EventEmitter['off']
}

export interface AutoOpenDeps {
  projectContext: ActivationEventSource
  threadStore: {
    getThread(id: string): { projectRoot: string } | null
    getThreadRoots(threadId: string): string[]
  }
  projectRegistry: {
    getRoots(): { rootPath: string }[]
    addRoot(rootPath: string): unknown
  }
  /** Injectable existence probe (tests). Default: statSync isDirectory. */
  exists?: (path: string) => boolean
}

/** True when `path` exists and is a directory (addRoot's own precondition). */
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Subscribe to thread activation and open the activated thread's on-disk,
 * not-yet-open roots. Fail-soft per root — an addRoot failure (e.g. the
 * directory raced away) logs and never breaks activation. Returns a disposer.
 */
export function startAutoOpenOnActivation(deps: AutoOpenDeps): () => void {
  const exists = deps.exists ?? directoryExists
  const onActivated = (event: ActiveThreadChangedEvent): void => {
    const thread = deps.threadStore.getThread(event.threadId)
    if (!thread) return
    const threadRoots = [thread.projectRoot, ...deps.threadStore.getThreadRoots(event.threadId)]
    const knownPaths = deps.projectRegistry.getRoots().map((root) => root.rootPath)
    for (const rootPath of autoOpenTargets(threadRoots, knownPaths, exists)) {
      try {
        deps.projectRegistry.addRoot(rootPath)
      } catch (error) {
        console.warn(`[AutoOpen] Failed to open thread root ${rootPath}:`, error)
      }
    }
  }
  deps.projectContext.on(ACTIVE_THREAD_CHANGED_EVENT, onActivated)
  return () => {
    deps.projectContext.off(ACTIVE_THREAD_CHANGED_EVENT, onActivated)
  }
}
