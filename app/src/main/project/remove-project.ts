// Remove a project from the sidebar for good. `ProjectRegistry.removeRoot`
// alone doesn't make a project disappear when it has threads: the threads
// sidebar renders a group for ANY project that owns threads (an "orphan root"),
// so the group survives the root removal. Removing a project therefore has to
// cascade — delete its tasks, then its threads (archived included), then drop
// the project root. Kept Electron/IPC-free so it unit-tests against the real
// stores.

import type { ThreadStore } from '../store/thread-store'
import type { TaskStore } from '../store/task-store'

export interface RemoveProjectDeps {
  threadStore: ThreadStore
  taskStore: TaskStore
  /** Drops the project-root registration (ProjectRegistry.removeRoot). */
  removeRoot: (rootPath: string) => void
  /**
   * Closes the project's terminals (#1484). Optional so existing callers and
   * unit tests are unaffected — but every real removal passes it: without one,
   * the project's PTYs outlive the project itself with no route back to them,
   * and this cascade is the only place that knows the project is going away.
   */
  disposeTerminals?: (rootPath: string) => void
}

/**
 * Fully remove `rootPath` from the sidebar: its tasks, then every thread it owns
 * (task-owned + bare, archived included), then the project root. The store
 * change events drive the sidebar re-render; removeRoot emits rootsChanged.
 */
export function removeProject(deps: RemoveProjectDeps, rootPath: string): void {
  // Tasks first — deleteTask only removes the task row (it doesn't touch the
  // thread), so the threads loop below cleans up their 1:1 threads uniformly.
  for (const task of deps.taskStore.listTasks(rootPath, { includeArchived: true })) {
    deps.taskStore.deleteTask(task.id)
  }
  for (const thread of deps.threadStore.listThreads(rootPath, { includeArchived: true })) {
    deps.threadStore.deleteThread(thread.id)
  }
  // Threads PRIMARIED elsewhere may still list this project as an ADDITIONAL
  // root — the FK cascade above only fired for threads this project owned. Prune
  // those dangling thread_roots so the removed project leaves no thread's SDK
  // scope / permission-containment set (#261).
  deps.threadStore.pruneThreadRootsByPath(rootPath)
  // Before the root goes: the terminals are scoped BY that root, so disposing
  // them afterwards would be scoping against something already gone (#1484).
  deps.disposeTerminals?.(rootPath)
  deps.removeRoot(rootPath)
}
