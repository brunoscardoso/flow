// A CONVERSATION'S DOCKER SERVICES, STOPPED WHEN IT IS ARCHIVED.
//
// Archive is how a person says "I am done with this for now". Its services have
// no reason to keep running — and keep holding ports and memory — but its DATA
// is exactly what a restore needs, so this stops containers and nothing else.
// Volumes stay; a `restored` thread does nothing here, because the next Run
// brings its data back.
//
// THE SIGNAL IS THE STORE'S OWN `archived` EVENT (thread-store.ts), emitted once
// when the flag really changes — never a poll, never a diff of `updated`
// events (allowed-pattern #17).
//
// NO DOCKER WORK WITHOUT A COMPOSE FILE. Most archives are of threads in
// projects that have none; for those this is a file check and a return — no
// `docker` is spawned (allowed-pattern #19). The stop itself goes
// through the supervisor, which owns marking the group's tabs stopped.
//
// THE BACKSTOP, STATED. Other ways a thread can end (a deleted task, a removed
// project, a delete that skips the sidebar) leave its volumes exactly where
// they are. Nothing in this flow deletes data silently (forbidden-pattern #15):
// a leftover is visible and removable from the Storage page and the
// conversation's Docker panel.

import { THREAD_STORE_CHANGE_EVENT, type ThreadChangeEvent } from '../store/thread-store'

/** The slice of the store this needs: its change events. */
export interface ThreadArchiveSource {
  on(event: string, listener: (event: ThreadChangeEvent) => void): unknown
  off(event: string, listener: (event: ThreadChangeEvent) => void): unknown
}

export interface DockerOnThreadArchivedDeps {
  /** Every project the conversation works in (the primary one first). Empty when the thread is gone. */
  rootsOf: (threadId: string) => string[]
  /** Whether the project has a Compose file (so each conversation has its own Docker data). */
  hasCompose: (rootPath: string) => Promise<boolean>
  /** `RunSupervisor.stopThreadDocker`. */
  stopThreadDocker: (threadId: string) => Promise<boolean>
  /** Injected so a test can watch without a console. */
  onOutcome?: (outcome: { threadId: string; stopped: boolean | null }) => void
}

/**
 * Stop a thread's Docker services when it is archived. Returns the
 * unsubscribe. `stopped` in the outcome is null when nothing was asked of
 * Docker (no project of the thread has a Compose file).
 */
export function stopDockerOnThreadArchived(
  store: ThreadArchiveSource,
  deps: DockerOnThreadArchivedDeps,
): () => void {
  const listener = (event: ThreadChangeEvent): void => {
    if (event.entity !== 'thread' || event.action !== 'archived') return
    void (async () => {
      try {
        let on = false
        for (const root of deps.rootsOf(event.threadId)) {
          if (await deps.hasCompose(root)) {
            on = true
            break
          }
        }
        if (!on) {
          deps.onOutcome?.({ threadId: event.threadId, stopped: null })
          return
        }
        const stopped = await deps.stopThreadDocker(event.threadId)
        deps.onOutcome?.({ threadId: event.threadId, stopped })
      } catch (error) {
        // A service left running is the state we were already in; never let
        // it interrupt the archive that caused this.
        console.error('flow: stopping an archived thread’s Docker services failed', error)
        deps.onOutcome?.({ threadId: event.threadId, stopped: false })
      }
    })()
  }
  store.on(THREAD_STORE_CHANGE_EVENT, listener)
  return () => {
    store.off(THREAD_STORE_CHANGE_EVENT, listener)
  }
}
