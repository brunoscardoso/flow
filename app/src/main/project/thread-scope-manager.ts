// ThreadScopeManager — the live thread-scope derivation (multi-project
// threads, phase 1).
//
// Computes the CURRENT scope = the active project's active thread (the
// workspace_state `active_thread_id` ProjectContextManager already loads) +
// that thread's roots + the project root list, via the pure `threadScopeFor`
// model. Re-derives on every input seam and emits THREAD_SCOPE_CHANGED_EVENT
// only when the derived scope actually differs (triggers can over-fire; the
// broadcast never lies).
//
// Additive by design: `active-project-changed` and every existing behavior is
// untouched — this manager only LISTENS. It is the one scope source of truth
// (allowed-pattern #14); renderer surfaces consume it via
// `project:getThreadScope` / `project:threadScopeChanged` in later phases.

import { EventEmitter } from 'events'

import type { ProjectContext, ThreadScope } from '../../shared/ipc-contract'
import {
  THREAD_ROOTS_CHANGED_EVENT,
  THREAD_STORE_CHANGE_EVENT,
  type ThreadChangeEvent,
} from '../store/thread-store'
import {
  ACTIVE_PROJECT_CHANGED_EVENT,
  ACTIVE_THREAD_CHANGED_EVENT,
} from './project-context'
import { PROJECT_LIST_CHANGED_EVENT } from './project-registry'
import { threadCopyName, threadScopeFor, type ScopeProjectRoot } from './thread-scope'

/** Emitted when the derived scope changes. Payload: ThreadScope. */
export const THREAD_SCOPE_CHANGED_EVENT = 'thread-scope-changed'

/** Event-source + reader seams the derivation needs (structurally satisfied by
 *  ProjectContextManager / ThreadStore / ProjectRegistry; fakes in tests). */
interface ScopeEventSource {
  on: EventEmitter['on']
  off: EventEmitter['off']
}

export interface ThreadScopeManagerDeps {
  projectContext: ScopeEventSource & {
    getActiveProject(): ProjectContext | null
  }
  threadStore: ScopeEventSource & {
    getThread(id: string): {
      projectRoot: string
      worktreePath: string | null
      worktreeBranch?: string | null
    } | null
    getThreadRoots(threadId: string): string[]
    /**
     * The checkouts this thread owns for its ATTACHED projects.
     *
     * OPTIONAL BECAUSE THE TEST HARNESSES PREDATE IT, and a scope that refuses
     * to derive without it would turn "this store is older than that column"
     * into a blank sidebar. Absent reads as "no attached checkouts", which is
     * the truth for every thread that has none.
     */
    getThreadRootWorktrees?(
      threadId: string,
    ): Array<{ rootPath: string; worktreePath: string; branch: string | null }>
  }
  projectRegistry: ScopeEventSource & {
    getRoots(): ScopeProjectRoot[]
  }
}

export class ThreadScopeManager extends EventEmitter {
  #current: ThreadScope = { threadId: null, roots: [] }
  #started = false

  readonly #refresh = (): void => {
    this.refresh()
  }

  /**
   * Thread mutations that move the scope.
   *
   * TWO, not one. A DELETION moves it (it nulls the project's active_thread_id
   * and cascades the thread's thread_roots rows away — neither write path emits
   * its own trigger). And an UPDATE of the scope's own thread moves it, because
   * `#derive` reads `worktreePath` off the thread row: `setThreadWorktree` is
   * the writer of that column, and the only thing it emits is
   * `{ entity: 'thread', action: 'updated' }`.
   *
   * That second case is the one this file got wrong for six phases. The comment
   * here used to say "only a deletion moves the scope", and it was TRUE until
   * the derivation started depending on a column no other trigger covers — at
   * which point it became a documented invariant that no longer held, and the
   * thread's checkout was never followed by the editor, the terminal or the git
   * panel. A change to what a derivation READS is a change to what must
   * INVALIDATE it.
   *
   * Narrowed to the scope's OWN thread: `thread updated` also fires for every
   * status transition of every thread in the app, and a scope that re-derives
   * for a thread it does not depend on is paying for something nobody can see
   * (allowed-pattern #17). `refresh()` is the second gate — it emits only when
   * the derived scope actually differs, so a status-only update is silent.
   */
  readonly #onThreadChange = (event: ThreadChangeEvent): void => {
    if (event.entity !== 'thread') return
    if (event.action === 'deleted') {
      this.refresh()
      return
    }
    if (event.action === 'updated' && event.threadId === this.#current.threadId) {
      this.refresh()
    }
  }

  constructor(private readonly deps: ThreadScopeManagerDeps) {
    super()
  }

  /** Subscribe to every derivation trigger and derive the initial scope:
   *  active project change, active thread change, thread_roots mutations,
   *  thread deletion AND updates of the active thread (the worktree column —
   *  see #onThreadChange), and root availability refresh (rootsChanged fires on
   *  restore/add/remove — the availability source, #263). */
  start(): void {
    if (this.#started) return
    this.#started = true
    this.deps.projectContext.on(ACTIVE_PROJECT_CHANGED_EVENT, this.#refresh)
    this.deps.projectContext.on(ACTIVE_THREAD_CHANGED_EVENT, this.#refresh)
    this.deps.threadStore.on(THREAD_ROOTS_CHANGED_EVENT, this.#refresh)
    this.deps.threadStore.on(THREAD_STORE_CHANGE_EVENT, this.#onThreadChange)
    this.deps.projectRegistry.on(PROJECT_LIST_CHANGED_EVENT, this.#refresh)
    this.refresh()
  }

  /** Unsubscribe from every trigger. Safe to call twice. */
  dispose(): void {
    if (!this.#started) return
    this.#started = false
    this.deps.projectContext.off(ACTIVE_PROJECT_CHANGED_EVENT, this.#refresh)
    this.deps.projectContext.off(ACTIVE_THREAD_CHANGED_EVENT, this.#refresh)
    this.deps.threadStore.off(THREAD_ROOTS_CHANGED_EVENT, this.#refresh)
    this.deps.threadStore.off(THREAD_STORE_CHANGE_EVENT, this.#onThreadChange)
    this.deps.projectRegistry.off(PROJECT_LIST_CHANGED_EVENT, this.#refresh)
    this.removeAllListeners()
  }

  /** The current derived scope (empty before start / without an active project). */
  current(): ThreadScope {
    return this.#current
  }

  /** Re-derive now; emit THREAD_SCOPE_CHANGED_EVENT only on an actual change. */
  refresh(): ThreadScope {
    const scope = this.#derive()
    if (JSON.stringify(scope) !== JSON.stringify(this.#current)) {
      this.#current = scope
      this.emit(THREAD_SCOPE_CHANGED_EVENT, scope)
    }
    return this.#current
  }

  #derive(): ThreadScope {
    const project = this.deps.projectContext.getActiveProject()
    if (project === null) {
      return { threadId: null, roots: [] }
    }
    const projectRoots = this.deps.projectRegistry.getRoots()
    const activeThreadId = project.activeThreadId
    const thread = activeThreadId !== null ? this.deps.threadStore.getThread(activeThreadId) : null
    if (activeThreadId === null || thread === null) {
      // No active thread (or a stale pointer to a deleted one) — the scope is
      // the active project's single root, exactly today's semantics.
      return threadScopeFor({
        threadId: null,
        primaryRoot: project.rootPath,
        additionalRoots: [],
        projectRoots,
      })
    }
    // THE THREAD'S CHECKOUT IS THE THREAD'S ROOT. When a thread owns a git
    // worktree, the scope reports THAT as its primary root instead of the
    // project's shared tree — which is the whole of what moves the editor, the
    // terminal and the git panel, because all three already bind to the scope
    // (allowed-pattern #14: one derivation, not three surfaces each deciding).
    // The path is the one the worktree CLI returned; it is never recomputed
    // here, or a symlinked root would produce a spelling git does not use.
    const primaryRoot = thread.worktreePath ?? thread.projectRoot
    // EVERY PROJECT THE THREAD CARRIES, not just the one it started in. An
    // attached project with a checkout of its own is shown AS that checkout —
    // same rule as the primary, one project at a time — so a thread isolated
    // across two repos reads as two copies rather than one copy beside one
    // shared tree.
    const attached = new Map(
      (this.deps.threadStore.getThreadRootWorktrees?.(activeThreadId) ?? []).map((entry) => [
        entry.rootPath,
        entry,
      ]),
    )
    const additionalRoots = this.deps.threadStore
      .getThreadRoots(activeThreadId)
      .map((root) => attached.get(root)?.worktreePath ?? root)

    let roots = withWorktreeRoot(projectRoots, primaryRoot, thread.projectRoot)
    // Each attached checkout is lent into the list under ITS project's name,
    // exactly as the primary's is — one rule, several projects.
    for (const entry of attached.values()) {
      roots = withWorktreeRoot(roots, entry.worktreePath, entry.rootPath)
    }

    return threadScopeFor({
      threadId: activeThreadId,
      primaryRoot,
      additionalRoots,
      projectRoots: roots,
    })
  }
}

/**
 * A thread's worktree is a checkout OF a project, not a project — it is never
 * registered as a project root and must never appear in the project list. But
 * the scope model resolves identity and availability by joining against that
 * list, so an unregistered path comes back `available: false`, and the terminal
 * reads that as "spawn somewhere else" (`spawnRootFor`) — landing the thread's
 * shell in a sibling repo. Lend the worktree its OWN project's record instead:
 * same accent (the chrome stays the project's colour), and availability
 * INHERITED rather than asserted, because a worktree sitting beside a project
 * folder that has gone away has gone away with it.
 *
 * Returns the list unchanged when the thread has no worktree, or when its
 * worktree path is already a registered root — a real record always wins.
 *
 * The one thing it does NOT inherit is the name. A record carries no name —
 * every consumer derives it from the path — and the checkout's path ends in the
 * thread id, so an inherited record produced a group header reading a raw UUID.
 * The lent record therefore states its own name (`threadCopyName`) — the
 * project's name. Whether it is a copy is said by `threadCopy` and shown by the
 * worktree panel above the tree, not spelled into the label.
 */
function withWorktreeRoot(
  projectRoots: readonly ScopeProjectRoot[],
  primaryRoot: string,
  projectRoot: string,
): readonly ScopeProjectRoot[] {
  if (primaryRoot === projectRoot) return projectRoots
  if (projectRoots.some((root) => root.rootPath === primaryRoot)) return projectRoots
  const project = projectRoots.find((root) => root.rootPath === projectRoot)
  if (project === undefined) return projectRoots
  return [
    ...projectRoots,
    {
      ...project,
      rootPath: primaryRoot,
      name: threadCopyName(projectRoot),
      // Said as a fact, because the NAME deliberately cannot say it.
      threadCopy: true,
    },
  ]
}
