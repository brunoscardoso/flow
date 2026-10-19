// ProjectContextManager — the active-project context (ADR-002).
//
// One project is "active" at a time. This manager owns that selection plus the
// per-project, restorable state (open editor tabs + active tab, open terminals,
// last-active thread), persisted in the workspace_state table (migration v3).
//
// Surfaces (file tree, editor, terminals) rebind when the active project
// changes; the renderer restores the returned ProjectContext. Terminals'
// running PTYs are owned by TerminalManager — here we persist only their
// descriptors (title + cwd) so they can be re-spawned on a cold start.

import { EventEmitter } from 'events'

import type {
  OpenFileRef,
  ProjectContext,
  SavedTerminalRef,
  TabSet,
} from '../../shared/ipc-contract'
import type { FlowDatabase } from '../store/db'
import { PROJECT_STATE_TABLE } from '../store/storage-names'
import { TabSetStore, emptyTabSet } from '../store/tab-set-store'

/** Emitted when the active project changes. Payload: ProjectContext. */
export const ACTIVE_PROJECT_CHANGED_EVENT = 'active-project-changed'

/** Emitted when a project's active thread changes (setActiveThread — the one
 *  active_thread_id write path). Payload: ActiveThreadChangedEvent. Additive:
 *  ACTIVE_PROJECT_CHANGED_EVENT and its subscribers are untouched. */
export const ACTIVE_THREAD_CHANGED_EVENT = 'active-thread-changed'

/** Payload for ACTIVE_THREAD_CHANGED_EVENT. */
export interface ActiveThreadChangedEvent {
  rootPath: string
  threadId: string
}

/** Persisted terminal descriptor — enough to re-spawn on a cold start. */
export type OpenTerminalRef = SavedTerminalRef

interface ProjectStateRow {
  project_root: string
  open_files: string
  active_file: string | null
  open_terminals: string
  active_thread_id: string | null
  last_active_at: string
  dirty_buffers: string
}

export class ProjectContextManager extends EventEmitter {
  #activeRoot: string | null = null
  /** "Is this path still a project root?" — see {@link setKnownRootCheck}.
   *  null (unwired) means every path is accepted, so unit tests and any
   *  embedder that doesn't own a root list behave exactly as before. */
  #isKnownRoot: ((rootPath: string) => boolean) | null = null
  /** "Can a tab in this root still be opened?" — see {@link setAddressableCheck}.
   *  null (unwired) means every path is accepted. */
  #isAddressable: ((rootPath: string) => boolean) | null = null
  /** "Does this thread still exist?" — see {@link setKnownThreadCheck}. */
  #isKnownThread: ((threadId: string) => boolean) | null = null
  /** Per-(project, thread) tab sets — the one reader/writer of their table. */
  readonly #tabSets: TabSetStore

  constructor(private readonly db: FlowDatabase) {
    super()
    this.#tabSets = new TabSetStore(db)
  }

  /**
   * Register the predicate that decides whether a thread still exists. A
   * thread's tab set is dropped when the thread is deleted; without this a
   * late persist from the renderer (the switch away from a thread that was
   * just deleted) would write the set straight back. Unwired (null) accepts
   * every id — what unit tests and embedders get.
   */
  setKnownThreadCheck(isKnownThread: ((threadId: string) => boolean) | null): void {
    this.#isKnownThread = isKnownThread
  }

  /**
   * Register the predicate that decides whether a path is still a project
   * root (#1080). `last_active_at` is a *last-activated* stamp, but `#ensureRow`
   * let any state-persisting call (`saveOpenFiles`, `saveScopeTerminals`,
   * `setActiveThread`) INSERT a row for an arbitrary path. Removing the active
   * project raced exactly that: `forget(A)` deleted A's row, then the renderer's
   * outgoing-tab persist re-created it milliseconds later with
   * `last_active_at = now`, making the REMOVED project the newest row forever —
   * so every later boot resolved `lastActiveProject()` to a non-root and
   * activated nothing ("No project" with projects right there in the sidebar).
   *
   * With the predicate wired, state for a path that is no longer a root is
   * simply not persisted, and a removed project can never resurrect its row.
   */
  setKnownRootCheck(isKnownRoot: ((rootPath: string) => boolean) | null): void {
    this.#isKnownRoot = isKnownRoot
  }

  /**
   * Register the predicate that decides whether a persisted TAB can still be
   * opened — the address gate, which is a wider list than the root list above:
   * a tab lives in a registered project OR in a thread's own checkout.
   *
   * A TAB WHOSE ROOT IS GONE IS NOT AN ERROR TO REPORT FOREVER. A checkout that
   * is renamed, pruned or removed leaves its tabs behind in this row, and every
   * activation of that project rehydrated them — one `Unknown root` throw per
   * tab, on every switch, for the life of the row (user, 2026-09-18, after the
   * checkout rename moved 21 directories). Dropping them on the way out is what
   * makes that self-healing: the renderer never asks for a path that cannot be
   * opened, and its next tab-change persist writes the pruned set back.
   *
   * Unwired (null) means every path is accepted — exactly the behaviour that
   * shipped before this existed, and what unit tests and embedders get.
   */
  setAddressableCheck(isAddressable: ((rootPath: string) => boolean) | null): void {
    this.#isAddressable = isAddressable
  }

  /** The active project's context, or null before any project is activated. */
  getActiveProject(): ProjectContext | null {
    return this.#activeRoot ? this.#load(this.#activeRoot) : null
  }

  activeRoot(): string | null {
    return this.#activeRoot
  }

  /** Make `rootPath` the active project (creating its state row if needed) and
   *  announce the switch. Returns the restored context. */
  setActiveProject(rootPath: string): ProjectContext {
    this.#touch(rootPath)
    this.#activeRoot = rootPath
    const context = this.#load(rootPath)
    // #load always returns a row here — #touch just created/updated it.
    const resolved = context ?? emptyContext(rootPath)
    this.emit(ACTIVE_PROJECT_CHANGED_EVENT, resolved)
    return resolved
  }

  /** Persist the project-level editor tabs (order preserved) + active tab +
   *  the unsaved buffer contents (#955 — restored dirty on switch-back). The
   *  project-level set's views are kept as they are. Thread-aware callers use
   *  {@link saveTabSet}; this is the same write with `threadId: null`. */
  saveOpenFiles(
    rootPath: string,
    openFiles: OpenFileRef[],
    activeFile: string | null,
    dirtyBuffers: Record<string, string>,
  ): void {
    const openViews = this.#tabSets.load(rootPath, null)?.openViews ?? []
    this.saveTabSet(rootPath, null, { openFiles, activeFile, dirtyBuffers, openViews })
  }

  /**
   * The tab set of one conversation in one project (`threadId: null` — the
   * project-level set). Never null: a set nobody saved is the empty set. Tabs
   * whose root can no longer be addressed are filtered out on the way out,
   * exactly as the project context's are (see `setAddressableCheck`).
   */
  loadTabSet(rootPath: string, threadId: string | null): TabSet {
    const set = this.#tabSets.load(rootPath, threadId) ?? emptyTabSet()
    return { ...set, openFiles: this.#openable(set.openFiles) }
  }

  /**
   * Persist one conversation's tab set. Writes NOTHING for a root that is no
   * longer a project root (#1080) or a thread that no longer exists — a late
   * persist must not resurrect state the user just removed.
   *
   * Except its unsaved text: the late persist of a just-deleted conversation
   * (the switch away from it) can carry text typed after the delete's own
   * rescue read the row, and that text goes to the project-level set rather
   * than nowhere.
   */
  saveTabSet(rootPath: string, threadId: string | null, set: TabSet): void {
    if (this.#isKnownRoot !== null && !this.#isKnownRoot(rootPath)) return
    if (threadId !== null && this.#isKnownThread !== null && !this.#isKnownThread(threadId)) {
      this.#tabSets.rescueBuffers(rootPath, set)
      return
    }
    this.#tabSets.save(rootPath, threadId, set)
  }

  /**
   * Persist the shells one scope has open (for cold-start restore) — a
   * conversation in a project, or (`threadId: null`) the project view. Same
   * guards as {@link saveTabSet}: nothing is written for a removed project or
   * a deleted thread, so a late write cannot resurrect either.
   */
  saveScopeTerminals(
    rootPath: string,
    threadId: string | null,
    terminals: OpenTerminalRef[],
  ): void {
    if (this.#isKnownRoot !== null && !this.#isKnownRoot(rootPath)) return
    if (threadId !== null && this.#isKnownThread !== null && !this.#isKnownThread(threadId)) return
    this.#tabSets.saveTerminals(rootPath, threadId, terminals)
  }

  /** The shells one scope had open — empty when it never saved any. */
  loadScopeTerminals(rootPath: string, threadId: string | null): OpenTerminalRef[] {
    return this.#tabSets.loadTerminals(rootPath, threadId)
  }

  /** Persist the last-active thread for a project (re-selected on switch). */
  setActiveThread(rootPath: string, threadId: string): void {
    if (!this.#ensureRow(rootPath)) return
    this.db
      .prepare(`UPDATE ${PROJECT_STATE_TABLE} SET active_thread_id = ? WHERE project_root = ?`)
      .run(threadId, rootPath)
    // Thread-scope trigger (multi-project threads): the active thread is one of
    // the scope's inputs, so its one write path announces the change.
    const event: ActiveThreadChangedEvent = { rootPath, threadId }
    this.emit(ACTIVE_THREAD_CHANGED_EVENT, event)
  }

  /** The project to restore on boot: the most recently active one. */
  lastActiveProject(): string | null {
    const row = this.db
      .prepare(`SELECT project_root FROM ${PROJECT_STATE_TABLE} ORDER BY last_active_at DESC LIMIT 1`)
      .get() as { project_root: string } | undefined
    return row?.project_root ?? null
  }

  /** Drop a project's persisted state (on removeRoot). */
  forget(rootPath: string): void {
    this.db.prepare(`DELETE FROM ${PROJECT_STATE_TABLE} WHERE project_root = ?`).run(rootPath)
    this.#tabSets.deleteRoot(rootPath)
    if (this.#activeRoot === rootPath) {
      this.#activeRoot = null
      // Announce that there is NO active project so every surface (titlebar
      // switcher, editor, file tree, …) rebinds to the empty state (#323). Only
      // fires when the removed root was the active one AND no sibling has been
      // re-activated first (removing the LAST project) — otherwise #activeRoot
      // already points at the sibling and this branch is skipped.
      this.emit(ACTIVE_PROJECT_CHANGED_EVENT, null)
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #row(rootPath: string): ProjectStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM ${PROJECT_STATE_TABLE} WHERE project_root = ?`)
      .get(rootPath) as ProjectStateRow | undefined
  }

  /**
   * The tabs whose root the renderer may still address.
   *
   * AN UNTITLED TAB HAS NO ROOT ON DISK (#1441) — it is a scratch note whose
   * `relPath` is its display name — so it is never filtered: there is nothing
   * to address and nothing that can go missing.
   */
  #openable(tabs: OpenFileRef[]): OpenFileRef[] {
    const gate = this.#isAddressable
    if (gate === null) return tabs
    return tabs.filter((tab) => tab.untitled === true || gate(tab.rootPath))
  }

  #load(rootPath: string): ProjectContext | null {
    const row = this.#row(rootPath)
    if (!row) {
      return null
    }
    // TABS THAT CANNOT BE OPENED ARE NOT HANDED OUT. See
    // `setAddressableCheck`: a checkout that was renamed or removed leaves its
    // tabs in this row, and restoring them throws once per tab on every switch.
    // Filtered on the way OUT rather than deleted here — a read path that
    // rewrites the row would destroy a tab whose root is merely unmounted right
    // now, and the renderer's next persist prunes it for real anyway.
    //
    // The tabs are the PROJECT-LEVEL tab set (thread_tab_state, v34) — the
    // legacy workspace_state tab columns were migrated into it and are no
    // longer read. A thread's own set is asked for by `loadTabSet`.
    const set = this.loadTabSet(row.project_root, null)
    return {
      rootPath: row.project_root,
      openFiles: set.openFiles,
      activeFile: set.activeFile,
      activeThreadId: row.active_thread_id,
      dirtyBuffers: set.dirtyBuffers,
    }
  }

  /** Create the state row if absent. Returns false — and writes NOTHING — when
   *  `rootPath` is no longer a project root (#1080): a removed project must
   *  not be able to resurrect its `workspace_state` row through a late
   *  tab/terminal/thread persist and become the newest `last_active_at`. */
  #ensureRow(rootPath: string): boolean {
    if (this.#isKnownRoot !== null && !this.#isKnownRoot(rootPath)) {
      return false
    }
    this.db
      .prepare(
        `INSERT INTO ${PROJECT_STATE_TABLE} (project_root, last_active_at)
         VALUES (?, ?) ON CONFLICT(project_root) DO NOTHING`,
      )
      .run(rootPath, new Date().toISOString())
    return true
  }

  #touch(rootPath: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO ${PROJECT_STATE_TABLE} (project_root, last_active_at)
         VALUES (?, ?) ON CONFLICT(project_root) DO UPDATE SET last_active_at = excluded.last_active_at`,
      )
      .run(rootPath, now)
  }
}

function emptyContext(rootPath: string): ProjectContext {
  return { rootPath, openFiles: [], activeFile: null, activeThreadId: null, dirtyBuffers: {} }
}
