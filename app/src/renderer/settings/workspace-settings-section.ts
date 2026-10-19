/**
 * "Workspaces" — the settings section that manages each Workspace: its name
 * (Rename…), its shared repository (Connect a shared repository… / Change… /
 * Disconnect…), its sync, its projects
 * (Move to…, Move a project here…, Open a project here…) and Delete… (never
 * for Default). Workspaces are always on: there is no switch.
 *
 * A VIEW, NOT A MODEL. Every sentence and decision comes from
 * `workspace-settings-model.ts` (DOM-free, tested, scanned for
 * forbidden-pattern #12). Every operation goes through
 * `window.flow.workspaces`, i.e. the CLI door — the section never derives a
 * Workspace's structure itself.
 *
 * ONE INSTANCE PER SETTINGS PAGE. The page re-renders its body for unrelated
 * reasons (an account change, a runtime switch); this section is kept alive
 * and re-attached, and repaints ITSELF only when:
 *  · `workspaces:changed` says the Workspaces changed;
 *  · a Workspace's sync status changed (`workspaces:syncChanged`, which main
 *    sends only on change) — and only while the section is on screen
 *    (allowed-pattern #17);
 *  · one of its own actions finished.
 */
import type {
  WorkspaceListing,
  WorkspaceSyncStatus,
  WorkspacesList,
} from '../../shared/workspaces-contract'
import {
  chooseOpenProject,
  linkProject,
  openCreateDialog,
  openDeleteDialog,
  openJoinDialog,
  openConnectRemoteDialog,
  openDisconnectRemoteDialog,
  openMoveProjectDialog,
  openProjectIntoWorkspace,
  openRenameDialog,
  readOpenProjects,
} from './workspace-dialogs-view'
import {
  ACTION_FAILED_LINE,
  CANCEL_LABEL,
  DEFAULT_LINE,
  DELETE_LABEL,
  JOIN_WORKSPACE_LABEL,
  LIST_FAILED_LINE,
  MOVE_HERE_CHOOSE,
  MOVE_HERE_CONFIRM,
  MOVE_HERE_LABEL,
  MOVE_TO_LABEL,
  NEW_WORKSPACE_LABEL,
  NO_MAP_CANDIDATES,
  NO_MOVE_HERE_CANDIDATES,
  NO_PROJECTS_LINE,
  NO_WORKSPACES_LINE,
  OPEN_PROJECT_HERE_LABEL,
  PROJECT_SETTINGS_LABEL,
  PROJECTS_LABEL,
  RENAME_LABEL,
  REVIEW_CHANGES_LABEL,
  SAME_PROJECT_LABEL,
  SHARED_REPOSITORY_LABEL,
  SYNC_LABEL,
  SYNC_NOW_LABEL,
  UNREADABLE_LINE,
  WORKING_LABEL,
  WORKSPACES_DESCRIPTION,
  WORKSPACES_SECTION_ID,
  WORKSPACES_SECTION_TITLE,
  mapCandidates,
  settingsChangeAction,
  workspaceCard,
  type OpenProject,
  type WorkspaceCardView,
} from './workspace-settings-model'
import { WORKSPACE_SYNC_EVENT } from '../threads/collision-card-model'
import { CHANGE_REMOTE_LABEL, CONNECT_REMOTE_LABEL, DISCONNECT_REMOTE_LABEL } from './workspace-remote-model'

const RELATIVE_TIME_REFRESH_MS = 60_000

let stylesInjected = false

export class WorkspaceSettingsSection {
  readonly element: HTMLElement
  readonly #body: HTMLDivElement
  #list: WorkspacesList | null = null
  #listFailed = false
  #open: OpenProject[] = []
  #sync = new Map<string, WorkspaceSyncStatus>()
  #syncing = new Set<string>()
  /** Per-Workspace line after an action (what was added, what refused). */
  #notices = new Map<string, string>()
  /** The Workspace whose "Move a project here" picker is open. */
  #adding: string | null = null
  #busy = false
  #disposed = false
  #unsubscribe: Array<() => void> = []
  #clock: ReturnType<typeof setInterval> | null = null
  /** A change arrived while off screen (or nothing was read yet): re-read when shown. */
  #stale = true

  constructor() {
    injectStyles()
    const section = document.createElement('div')
    section.className = 'fl-settings-section fl-wss'
    section.dataset['sectionId'] = WORKSPACES_SECTION_ID
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = WORKSPACES_SECTION_TITLE
    const description = document.createElement('div')
    description.className = 'fl-fs-help fl-wss-description'
    description.textContent = WORKSPACES_DESCRIPTION
    this.#body = document.createElement('div')
    this.#body.className = 'fl-wss-body'
    section.append(heading, description, this.#body)
    this.element = section

    const api = window.flow.workspaces
    if (api !== undefined) {
      this.#unsubscribe.push(
        api.onChanged((event) => {
          const action = settingsChangeAction({ cause: event.cause, onScreen: this.#onScreen() })
          if (action === 'reload') void this.refresh()
          else if (action === 'mark-stale') this.#stale = true
        }),
      )
      this.#unsubscribe.push(
        api.onSyncChanged((event) => {
          if (this.#disposed) return
          this.#sync.set(event.slug, event.status)
          if (this.element.isConnected) this.#render()
        }),
      )
    }
    this.#clock = setInterval(() => {
      if (this.#onScreen() && !this.#busy) this.#render()
    }, RELATIVE_TIME_REFRESH_MS)
  }

  /** On screen: in the page AND not inside a hidden group or a closed tab. */
  #onScreen(): boolean {
    return this.element.isConnected && this.element.getClientRects().length > 0
  }

  /**
   * The section was just shown (its group selected, the page opened). Re-read
   * only what changed while nobody was looking — a show is not a reason to
   * spawn the CLI again when nothing did.
   */
  shown(): void {
    if (!this.#stale || this.#disposed) return
    void this.refresh()
  }

  dispose(): void {
    this.#disposed = true
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe = []
    if (this.#clock !== null) clearInterval(this.#clock)
    this.#clock = null
  }

  /** Re-read everything the section shows, then paint. */
  async refresh(): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined || this.#disposed) return
    this.#stale = false
    const [list, open] = await Promise.all([api.list().catch(() => null), readOpenProjects()])
    this.#open = open
    if (list !== null && list.ok) {
      this.#list = list
      this.#listFailed = false
      const statuses = await Promise.all(
        list.workspaces.map(async (workspace) => [workspace.slug, await api.syncStatus({ slug: workspace.slug }).catch(() => null)] as const),
      )
      for (const [slug, status] of statuses) if (status !== null) this.#sync.set(slug, status)
    } else {
      this.#listFailed = true
    }
    if (!this.#disposed) this.#render()
  }

  #render(): void {
    this.#body.replaceChildren()

    const actions = document.createElement('div')
    actions.className = 'fl-wss-actions'
    actions.append(
      this.#button(NEW_WORKSPACE_LABEL, () => void openCreateDialog().then(() => this.refresh()), 'new-workspace'),
      this.#button(JOIN_WORKSPACE_LABEL, () => void openJoinDialog().then(() => this.refresh()), 'join-workspace'),
    )
    this.#body.appendChild(actions)

    if (this.#listFailed || this.#list === null) {
      this.#body.appendChild(this.#line(LIST_FAILED_LINE, 'fl-wss-muted'))
      return
    }
    const list = this.#list
    // No Flow folder block: each Workspace card already says where its things
    // live (user, 2026-10-06).

    if (list.workspaces.length === 0) this.#body.appendChild(this.#line(NO_WORKSPACES_LINE, 'fl-wss-muted'))
    for (const workspace of list.workspaces) this.#body.appendChild(this.#workspaceCard(workspace))
    if (list.unreadable.length > 0) this.#body.appendChild(this.#line(UNREADABLE_LINE, 'fl-wss-muted'))
  }

  #workspaceCard(workspace: WorkspaceListing): HTMLElement {
    const view = workspaceCard({
      workspace,
      open: this.#open,
      sync: this.#sync.get(workspace.slug) ?? null,
      syncing: this.#syncing.has(workspace.slug),
      now: Date.now(),
      all: this.#list?.workspaces ?? [workspace],
    })
    const card = document.createElement('div')
    card.className = 'fl-wss-card'
    card.dataset['workspace'] = view.slug
    const head = document.createElement('div')
    head.className = 'fl-wss-row'
    const name = document.createElement('div')
    name.className = 'fl-wss-name'
    name.textContent = view.name
    const manage = document.createElement('div')
    manage.className = 'fl-wss-actions'
    manage.appendChild(
      this.#button(RENAME_LABEL, () => void openRenameDialog(view.slug).then((done) => { if (done) void this.refresh() }), 'rename-workspace'),
    )
    if (view.canDelete) {
      manage.appendChild(
        this.#button(DELETE_LABEL, () => void openDeleteDialog(view.slug).then((done) => { if (done) void this.refresh() }), 'delete-workspace'),
      )
    }
    head.append(name, manage)
    card.appendChild(head)
    if (view.isDefault) card.appendChild(this.#line(DEFAULT_LINE, 'fl-wss-muted'))

    // The shared repository: its address (data — what the person typed) with
    // Change… / Disconnect…, or nothing yet.
    const shared = document.createElement('div')
    shared.className = 'fl-wss-row'
    shared.dataset['part'] = 'shared-repository'
    const remotePair = this.#pair(SHARED_REPOSITORY_LABEL, view.remoteText, view.hasRemote ? 'fl-wss-remote' : 'fl-wss-muted')
    shared.appendChild(remotePair)
    if (view.hasRemote) {
      const remoteActions = document.createElement('div')
      remoteActions.className = 'fl-wss-actions'
      remoteActions.append(
        this.#button(CHANGE_REMOTE_LABEL, () => void this.#connect(view.slug, view.name, true), 'change-remote'),
        this.#button(
          DISCONNECT_REMOTE_LABEL,
          () => void openDisconnectRemoteDialog({ slug: view.slug, name: view.name }).then((done) => { if (done) void this.refresh() }),
          'disconnect-remote',
        ),
      )
      shared.appendChild(remoteActions)
    }
    card.appendChild(shared)

    // Sync: where it stands, Sync now, and the way into a pause.
    const sync = document.createElement('div')
    sync.className = 'fl-wss-row'
    const syncText = document.createElement('div')
    syncText.className = 'fl-wss-pair'
    const status = this.#line(view.sync.text, `fl-wss-status ${view.sync.tone}`)
    status.dataset['part'] = 'sync-status'
    syncText.append(this.#line(SYNC_LABEL, 'fl-wss-label'), status)
    const syncActions = document.createElement('div')
    syncActions.className = 'fl-wss-actions'
    if (view.sync.paused) {
      syncActions.appendChild(
        this.#button(REVIEW_CHANGES_LABEL, () => {
          document.dispatchEvent(new CustomEvent(WORKSPACE_SYNC_EVENT, { detail: { slug: view.slug } }))
        }),
      )
    }
    if (view.hasRemote) {
      const syncNow = this.#button(SYNC_NOW_LABEL, () => void this.#syncNow(view.slug), 'sync-now')
      syncNow.disabled = !view.sync.canSyncNow
      syncActions.appendChild(syncNow)
    } else {
      // Nothing to sync with yet: the way to get there, instead of a button that can't do anything.
      syncActions.appendChild(this.#button(CONNECT_REMOTE_LABEL, () => void this.#connect(view.slug, view.name, false), 'connect-remote'))
    }
    sync.append(syncText, syncActions)
    card.appendChild(sync)

    card.appendChild(this.#projects(view))
    const notice = this.#notices.get(view.slug)
    if (notice !== undefined) card.appendChild(this.#line(notice, 'fl-wss-notice'))
    return card
  }

  #projects(view: WorkspaceCardView): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-wss-projects'
    block.appendChild(this.#line(PROJECTS_LABEL, 'fl-wss-label'))
    if (view.projects.length === 0) block.appendChild(this.#line(NO_PROJECTS_LINE, 'fl-wss-muted'))
    for (const project of view.projects) {
      const row = document.createElement('div')
      row.className = 'fl-wss-project'
      row.dataset['projectId'] = project.id
      const name = document.createElement('div')
      name.className = 'fl-wss-project-name'
      name.appendChild(this.#line(project.name, 'fl-wss-value'))
      if (project.note !== null) name.appendChild(this.#line(project.note, 'fl-wss-muted'))
      row.appendChild(name)
      const root = project.root
      if (project.canOpenSettings && root !== null) {
        row.appendChild(
          this.#button(PROJECT_SETTINGS_LABEL, () => {
            document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath: root } }))
          }),
        )
      }
      if (project.canMapSameProject) {
        row.appendChild(this.#button(SAME_PROJECT_LABEL, () => void this.#mapSameProject(view, project.id, project.name)))
      }
      if (project.canMove) {
        const projectId = project.id
        const projectName = project.name
        row.appendChild(
          this.#button(MOVE_TO_LABEL, () => {
            void openMoveProjectDialog({ from: view.slug, projectId, projectName }).then((done) => { if (done) void this.refresh() })
          }, 'move-project'),
        )
      }
      block.appendChild(row)
    }

    // Move a project here: a project of another Workspace, chosen here.
    if (this.#adding === view.slug) {
      const picker = document.createElement('div')
      picker.className = 'fl-wss-add'
      const candidates = view.moveHereCandidates
      if (candidates.length === 0) {
        picker.append(this.#line(NO_MOVE_HERE_CANDIDATES, 'fl-wss-muted'), this.#button(CANCEL_LABEL, () => this.#stopAdding()))
      } else {
        const select = document.createElement('select')
        select.className = 'fl-settings-select'
        select.setAttribute('aria-label', MOVE_HERE_CHOOSE)
        for (const [index, candidate] of candidates.entries()) {
          const option = document.createElement('option')
          option.value = String(index)
          option.textContent = candidate.label
          select.appendChild(option)
        }
        const move = this.#button(MOVE_HERE_CONFIRM, () => {
          const chosen = candidates[Number(select.value)]
          if (chosen === undefined) return
          move.disabled = true
          move.textContent = WORKING_LABEL
          void this.#moveHere(view.slug, chosen.projectId, chosen.from)
        }, 'move-here-confirm')
        picker.append(select, move, this.#button(CANCEL_LABEL, () => this.#stopAdding()))
      }
      block.appendChild(picker)
    } else {
      const actions = document.createElement('div')
      actions.className = 'fl-wss-actions'
      actions.append(
        this.#button(MOVE_HERE_LABEL, () => {
          this.#adding = view.slug
          this.#render()
        }, 'move-here'),
        this.#button(OPEN_PROJECT_HERE_LABEL, () => void openProjectIntoWorkspace(view.slug).then(() => this.refresh()), 'open-project-here'),
      )
      block.appendChild(actions)
    }
    return block
  }

  async #moveHere(slug: string, projectId: string, from: string): Promise<void> {
    this.#busy = true
    const answer = await window.flow.workspaces?.moveProject({ project: projectId, to: slug, from }).catch(() => null)
    this.#busy = false
    this.#adding = null
    if (answer === null || answer === undefined) this.#notices.set(slug, ACTION_FAILED_LINE)
    else if (!answer.ok) this.#notices.set(slug, answer.detail)
    else this.#notices.delete(slug)
    await this.refresh()
  }

  #stopAdding(): void {
    this.#adding = null
    this.#render()
  }

  async #link(slug: string, rootPath: string, name: string, projectId?: string): Promise<void> {
    this.#busy = true
    const step = await linkProject({ rootPath, workspace: slug, name, ...(projectId === undefined ? {} : { projectId }) })
    this.#busy = false
    this.#adding = null
    if (step.text !== '') this.#notices.set(slug, step.text)
    else this.#notices.delete(slug)
    await this.refresh()
  }

  async #mapSameProject(view: WorkspaceCardView, projectId: string, name: string): Promise<void> {
    const candidates = mapCandidates(this.#open, view.slug)
    if (candidates.length === 0) {
      this.#notices.set(view.slug, NO_MAP_CANDIDATES)
      this.#render()
      return
    }
    const root = await chooseOpenProject(candidates)
    if (root === null) return
    await this.#link(view.slug, root, name, projectId)
  }

  async #connect(slug: string, name: string, replace: boolean): Promise<void> {
    const changed = await openConnectRemoteDialog({ slug, name, replace })
    if (!changed || this.#disposed) return
    this.#notices.delete(slug)
    await this.refresh()
  }

  async #syncNow(slug: string): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined) return
    this.#syncing.add(slug)
    this.#render()
    const status = await api.syncNow({ slug }).catch(() => null)
    this.#syncing.delete(slug)
    if (status === null) this.#notices.set(slug, ACTION_FAILED_LINE)
    else {
      this.#sync.set(slug, status)
      this.#notices.delete(slug)
    }
    if (!this.#disposed) this.#render()
  }

  #pair(label: string, value: string, valueClass: string): HTMLElement {
    const pair = document.createElement('div')
    pair.className = 'fl-wss-pair'
    pair.append(this.#line(label, 'fl-wss-label'), this.#line(value, valueClass))
    return pair
  }

  #line(text: string, className: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = className
    el.textContent = text
    return el
  }

  #button(label: string, onClick: () => void, part?: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-settings-btn'
    button.textContent = label
    if (part !== undefined) button.dataset['part'] = part
    button.addEventListener('click', onClick)
    return button
  }
}

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-wss-description { margin-bottom: var(--fl-space-sm); }
    .fl-wss-body { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-wss-actions { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); align-items: center; }
    .fl-wss-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-wss-value { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    .fl-wss-remote { font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); color: var(--fl-color-text); word-break: break-all; }
    .fl-wss-muted { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-wss-notice {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
      padding: var(--fl-space-xs) var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised);
    }
    .fl-wss-card {
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-md);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
    }
    .fl-wss-name { font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-wss-pair { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fl-wss-row { display: flex; align-items: center; justify-content: space-between; gap: var(--fl-space-sm); }
    .fl-wss-status { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    .fl-wss-status.ok { color: var(--fl-color-success); }
    .fl-wss-status.warning { color: var(--fl-color-warning); }
    .fl-wss-status.error { color: var(--fl-color-error); }
    .fl-wss-projects { display: flex; flex-direction: column; gap: var(--fl-space-xs); align-items: flex-start; }
    .fl-wss-project {
      align-self: stretch; display: flex; align-items: center; justify-content: space-between; gap: var(--fl-space-sm);
      padding: var(--fl-space-xs) 0; border-top: var(--fl-border-width) solid var(--fl-color-separator, var(--fl-color-border));
    }
    .fl-wss-project-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .fl-wss-add { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); align-items: center; }
  `
  document.head.appendChild(style)
}
