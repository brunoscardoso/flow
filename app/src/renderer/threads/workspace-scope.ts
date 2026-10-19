/**
 * THE WORKSPACE SCOPE — the one renderer-side answer to "which Workspace is
 * the person looking at", shared by the switcher, the thread list, the board,
 * the files panel and the project chips.
 *
 * ONE READER of `window.flow.workspaces` for all five, so they can never
 * disagree about the scope, and so the reads are paid once: the Workspace list
 * and each root's membership are read on start, then again only when main says
 * a Workspace changed (`workspaces:changed`) or a project was added — never on
 * a thread or task broadcast (forbidden-patterns #13/#14). Membership is cached
 * per root; a new root costs one question, an old one none.
 *
 * Every decision is in `workspace-switcher-model.ts`; this file only holds the
 * state and talks to main.
 *
 * Always on (decision 2026-10-06): every project lives in a Workspace. Until
 * the first launch's migration has made one, the scope is `none` and the one
 * list holds every project.
 */

import type { FlowWorkspacesApi, RegisteredProject } from '../../shared/ipc-contract'
import type { WorkspaceListing, WorkspacePlacementState, WorkspacesChangedEvent } from '../../shared/workspaces-contract'
import { isRootAvailable } from '../../shared/root-selection'
import {
  LAST_PROJECT_STORAGE_KEY,
  choiceForRoot,
  defaultNewThreadProject,
  deriveScope,
  memberOf,
  parseLastProjects,
  projectTag,
  registeredRootOf,
  rememberLastProject,
  rootsInScope,
  type RootMembership,
  type RootProjects,
  type SwitcherChoice,
  type WorkspaceScope,
  workspaceAfterDelete,
} from './workspace-switcher-model'

export interface WorkspaceScopeState {
  workspaces: readonly WorkspaceListing[]
  currentSlug: string | null
  membership: RootMembership
  /** registered root → its Workspace project's id (the registry's answer). */
  memberProjects: RootProjects
  registered: readonly RegisteredProject[]
  activeRoot: string | null
  scope: WorkspaceScope
  /** Each Workspace's sync status, when the app reports one (any shape). */
  syncStatus: ReadonlyMap<string, unknown>
  /** The projects outside every Workspace (waiting on a person, or failed); null until read. */
  placement: WorkspacePlacementState | null
}

type Listener = (state: WorkspaceScopeState) => void

function readLastProjects(): Record<string, string> {
  try {
    return parseLastProjects(window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY))
  } catch {
    return {}
  }
}

function writeLastProjects(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, JSON.stringify(map))
  } catch (error) {
    console.warn('flow: could not remember the last project of a Workspace', error)
  }
}

class WorkspaceScopeStore {
  #started = false
  #placement: WorkspacePlacementState | null = null
  #workspaces: WorkspaceListing[] = []
  #currentSlug: string | null = null
  #membership = new Map<string, string | null>()
  #memberProjects = new Map<string, string | null>()
  #registered: RegisteredProject[] = []
  #activeRoot: string | null = null
  #choice: SwitcherChoice | null = null
  #syncStatus = new Map<string, unknown>()
  #listeners = new Set<Listener>()
  #state: WorkspaceScopeState = this.#snapshot()
  /** Bumped by every full reload; a slower, older reload assigns nothing. */
  #reloadToken = 0

  /** The Workspaces bridge — present whenever the store has started. */
  #ws(): FlowWorkspacesApi {
    const api = window.flow.workspaces
    if (api === undefined) throw new Error('Workspaces are not available in this build')
    return api
  }

  get state(): WorkspaceScopeState {
    return this.#state
  }

  /** Subscribe; the listener runs now with the current state and on every change. */
  subscribe(listener: Listener): () => void {
    this.start()
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  /** Begin reading (idempotent). */
  start(): void {
    if (this.#started) return
    const api = window.flow
    if (api?.workspaces === undefined || api.project === undefined) return
    this.#started = true
    api.workspaces.onChanged((event) => void this.#onChanged(event))
    api.project.onListChanged((roots) => {
      this.#registered = roots
      void this.#readMembership(roots.map((root) => root.rootPath).filter((root) => !this.#membership.has(root)))
      this.#emit()
    })
    api.project.onActiveChanged((context) => {
      this.#activeRoot = context?.rootPath ?? null
      // Opening a project IS a choice of where to look — when we know where it lives.
      if (this.#activeRoot !== null) {
        const choice = choiceForRoot(this.#activeRoot, this.#membership)
        if (choice !== null) this.#choice = choice
      }
      this.#emit()
    })
    // Workspace sync status — FEATURE-DETECTED: a preload without the sync
    // channels simply shows no sync status. The event carries the new status,
    // so a change costs no read.
    const workspacesApi = api.workspaces
    if (typeof workspacesApi.onSyncChanged === 'function') {
      workspacesApi.onSyncChanged((event) => {
        this.#syncStatus.set(event.slug, event.status)
        this.#emit()
      })
    }
    void this.#boot()
  }

  async #boot(): Promise<void> {
    const api = window.flow
    try {
      this.#registered = await api.project.list()
      const active = await api.project.active().catch(() => null)
      this.#activeRoot = active?.rootPath ?? null
    } catch (error) {
      console.warn('flow: could not read the projects for the Workspace switcher', error)
    }
    await this.#reload()
  }

  /**
   * Read the Workspaces again — for a change nothing announced (one made in a
   * terminal). Main keeps its reads for a few seconds, so asking often is cheap.
   */
  async refresh(): Promise<void> {
    if (!this.#started) return
    await this.#reload()
  }

  async #onChanged(event: WorkspacesChangedEvent): Promise<void> {
    if (event.cause === 'current') {
      const current = await this.#ws().current().catch(() => null)
      if (current?.ok === true) this.#currentSlug = current.slug
      this.#emit()
      return
    }
    // A card's extra projects change no Workspace — its own consumer re-reads them.
    if (event.cause === 'task-projects') return
    if (event.cause !== 'described') {
      this.#membership.clear()
      this.#memberProjects.clear()
    }
    await this.#reload()
  }

  /** Read the Workspaces, the current one, the projects needing attention and every root's membership. */
  async #reload(): Promise<void> {
    const token = ++this.#reloadToken
    const api = this.#ws()
    const [listed, current, placement] = await Promise.all([
      api.list().catch(() => null),
      api.current().catch(() => null),
      typeof api.placement === 'function' ? api.placement().catch(() => null) : Promise.resolve(null),
    ])
    if (token !== this.#reloadToken) return
    this.#workspaces = listed?.ok === true ? listed.workspaces : []
    this.#currentSlug = current?.ok === true ? current.slug : null
    this.#placement = placement
    await this.#readMembership(this.#registered.map((root) => root.rootPath))
    if (token !== this.#reloadToken) return
    if (this.#choice === null && this.#activeRoot !== null) {
      this.#choice = choiceForRoot(this.#activeRoot, this.#membership)
    }
    this.#emit()
    void this.#readSyncStatus()
  }

  async #readMembership(roots: readonly string[]): Promise<void> {
    if (roots.length === 0) return
    const answer = await this.#ws().membership({ roots: [...roots] }).catch(() => null)
    if (answer?.ok !== true) return
    for (const entry of answer.roots) {
      this.#membership.set(entry.root, entry.workspace)
      this.#memberProjects.set(entry.root, entry.project)
    }
    this.#emit()
  }

  async #readSyncStatus(): Promise<void> {
    const api = this.#ws()
    if (typeof api.syncStatus !== 'function') return
    const answers = await Promise.all(
      this.#workspaces.map(async (workspace) => {
        try {
          return [workspace.slug, await api.syncStatus({ slug: workspace.slug })] as const
        } catch {
          return [workspace.slug, null] as const
        }
      }),
    )
    this.#syncStatus = new Map(answers.filter(([, status]) => status !== null))
    this.#emit()
  }

  #snapshot(): WorkspaceScopeState {
    return {
      workspaces: this.#workspaces,
      currentSlug: this.#currentSlug,
      membership: new Map(this.#membership),
      memberProjects: new Map(this.#memberProjects),
      registered: this.#registered,
      activeRoot: this.#activeRoot,
      scope: deriveScope({
        workspaces: this.#workspaces,
        currentSlug: this.#currentSlug,
        membership: this.#membership,
        activeRoot: this.#activeRoot,
        choice: this.#choice,
      }),
      syncStatus: new Map(this.#syncStatus),
      placement: this.#placement,
    }
  }

  #emit(): void {
    this.#state = this.#snapshot()
    for (const listener of this.#listeners) {
      try {
        listener(this.#state)
      } catch (error) {
        console.error('flow: a Workspace scope listener failed', error)
      }
    }
  }

  // ── Questions every consumer asks ─────────────────────────────────────────

  /** The registered roots of the current scope, in sidebar order. */
  scopeRoots(state: WorkspaceScopeState = this.#state): string[] {
    return rootsInScope(
      state.registered.map((root) => root.rootPath),
      state.scope,
      state.membership,
    )
  }

  /** The name a row is tagged with — by the registry's membership answer. */
  nameOf(root: string): string {
    const state = this.#state
    return projectTag(root, state.membership, state.memberProjects, state.workspaces)
  }

  /** The Workspace a root belongs to — the registry's answer, never a path comparison. */
  workspaceOf(root: string): WorkspaceListing | null {
    const slug = this.#state.membership.get(root)
    if (typeof slug !== 'string') return null
    return this.#state.workspaces.find((w) => w.slug === slug) ?? null
  }

  /** The Workspace project a registered root is, when the registry says it is one. */
  projectOf(root: string): ReturnType<typeof memberOf> {
    const state = this.#state
    return memberOf(root, state.membership, state.memberProjects, state.workspaces)
  }

  /** The app's own root for a Workspace project, when the app has it open. */
  registeredRoot(workspaceSlug: string, projectId: string): string | null {
    const state = this.#state
    return registeredRootOf(
      workspaceSlug,
      projectId,
      state.registered.map((root) => root.rootPath),
      state.membership,
      state.memberProjects,
    )
  }

  /** Where a new thread in the current Workspace starts. Null outside one. */
  newThreadProject(): string | null {
    const state = this.#state
    if (state.scope.kind !== 'workspace') return null
    const available = new Map(state.registered.map((root) => [root.rootPath, isRootAvailable(root)]))
    return defaultNewThreadProject({
      scopeRoots: this.scopeRoots(state),
      available: (root) => available.get(root) ?? false,
      lastUsed: readLastProjects()[state.scope.slug] ?? null,
      activeRoot: state.activeRoot,
    })
  }

  /** Remember the project a thread was just started in, for its Workspace. */
  rememberProject(root: string): void {
    const slug = this.#state.membership.get(root)
    if (typeof slug !== 'string') return
    writeLastProjects(rememberLastProject(readLastProjects(), slug, root))
  }

  // ── What the switcher does ────────────────────────────────────────────────

  /** Look at a Workspace: remember it in main, and open one of its projects. */
  async selectWorkspace(slug: string): Promise<void> {
    this.#choice = { kind: 'workspace', slug }
    this.#emit()
    const answer = await this.#ws().setCurrent({ slug }).catch(() => null)
    if (answer !== null && !answer.ok) console.warn('flow: could not make the Workspace current', answer.detail)
    const target = this.newThreadProject()
    const activeSlug = this.#activeRoot === null ? undefined : this.#membership.get(this.#activeRoot)
    if (target !== null && activeSlug !== slug) {
      await window.flow.project
        .setActive({ rootPath: target })
        .catch((error: unknown) => console.error('flow: failed to switch project', error))
    }
  }

  /**
   * A Workspace was deleted: its projects moved into Default, so look there
   * (or at the first one left) — never at a Workspace that is gone.
   */
  async afterDelete(deleted: string): Promise<void> {
    await this.#reload()
    const next = workspaceAfterDelete(this.#workspaces, deleted)
    if (next !== null) await this.selectWorkspace(next)
  }
}

/** The one scope for the window. */
export const workspaceScope = new WorkspaceScopeStore()
