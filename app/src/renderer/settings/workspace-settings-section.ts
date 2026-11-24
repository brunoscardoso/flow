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
  openChangeBranchDialog,
  openDisconnectRemoteDialog,
  openMoveProjectDialog,
  openRemoveProjectDialog,
  openProjectIntoWorkspace,
  openRenameDialog,
  readOpenProjects,
} from './workspace-dialogs-view'
import {
  ACTION_FAILED_LINE,
  CANCEL_LABEL,
  DELETE_LABEL,
  JOIN_WORKSPACE_LABEL,
  LIST_FAILED_LINE,
  MOVE_HERE_CHOOSE,
  MOVE_HERE_CONFIRM,
  MOVE_HERE_LABEL,
  JOIN_INSTEAD_LABEL,
  alsoInTag,
  NEW_WORKSPACE_LABEL,
  NO_MAP_CANDIDATES,
  NO_MOVE_HERE_CANDIDATES,
  NO_PROJECTS_LINE,
  NO_WORKSPACES_LINE,
  OPEN_PROJECT_HERE_LABEL,
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
  DEFAULT_BADGE,
  DEFAULT_CARD_LINE,
  HIDE_WORKSPACE_LABEL,
  MOVE_TO_WORKSPACE_LABEL,
  ON_THIS_COMPUTER,
  SETTINGS_SHORT_LABEL,
  SHOW_WORKSPACE_LABEL,
  foldedSummary,
  removeFromLabel,
  moreFor,
  projectSettingsFor,
} from './workspace-settings-model'
import { workspaceScope } from '../threads/workspace-scope'
import { WORKSPACE_SYNC_EVENT } from '../threads/collision-card-model'
import { CHANGE_REMOTE_LABEL, CONNECT_REMOTE_LABEL, DISCONNECT_REMOTE_LABEL } from './workspace-remote-model'
import { BRANCH_LABEL, CHANGE_BRANCH_LABEL, NO_BRANCH_YET } from './workspace-branch-model'

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
  /** The project row whose ⋯ menu is open (`slug:projectId`), kept across repaints. */
  #menuFor: string | null = null
  /** Workspaces folded by default that the person chose to show. */
  #expanded = new Set<string>()
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
    // The two ways to get another Workspace sit beside what a Workspace is.
    const intro = document.createElement('div')
    intro.className = 'fl-wss-intro'
    const introActions = document.createElement('div')
    introActions.className = 'fl-wss-actions fl-wss-intro-actions'
    const create = this.#button(NEW_WORKSPACE_LABEL, () => void openCreateDialog().then(() => this.refresh()), 'new-workspace')
    create.classList.add('fl-wss-primary')
    introActions.append(
      this.#button(JOIN_WORKSPACE_LABEL, () => void openJoinDialog().then(() => this.refresh()), 'join-workspace'),
      create,
    )
    intro.append(description, introActions)
    section.append(heading, intro, this.#body)
    this.element = section
    // A row's menu closes on a press anywhere else, or Escape.
    const dismiss = (event: Event): void => {
      if (this.#menuFor === null) return
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && event.target instanceof Node && this.element.querySelector('.fl-wss-menu-wrap.open')?.contains(event.target)) return
      this.#menuFor = null
      for (const wrap of this.element.querySelectorAll('.fl-wss-menu-wrap.open')) closeMenu(wrap)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', dismiss)
    this.#unsubscribe.push(() => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', dismiss)
    })

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

    // ── Head: the name, a Default badge, and the Workspace's own actions ──
    const head = document.createElement('div')
    head.className = 'fl-wss-head'
    const name = document.createElement('div')
    name.className = 'fl-wss-name'
    name.textContent = view.name
    head.appendChild(name)
    if (view.isDefault) head.appendChild(this.#line(DEFAULT_BADGE, 'fl-wss-badge'))
    if (view.teamNameText !== null) {
      const team = this.#line(view.teamNameText, 'fl-wss-muted fl-wss-team-name')
      team.dataset['part'] = 'team-name'
      head.appendChild(team)
    }
    const folded = !this.#isExpanded(view.slug, view.isDefault)
    if (folded) {
      card.classList.add('folded')
      const summary = this.#line(foldedSummary(view.hasRemote, view.projects.length), 'fl-wss-muted fl-wss-summary')
      summary.dataset['part'] = 'workspace-summary'
      head.appendChild(summary)
    }
    const spacer = document.createElement('div')
    spacer.className = 'fl-wss-spacer'
    head.appendChild(spacer)
    if (folded) {
      head.appendChild(
        this.#button(SHOW_WORKSPACE_LABEL, () => {
          this.#expanded.add(view.slug)
          this.#render()
        }, 'show-workspace'),
      )
      card.appendChild(head)
      return card
    }
    if (!view.isDefault && this.#expanded.has(view.slug)) {
      head.appendChild(
        this.#button(HIDE_WORKSPACE_LABEL, () => {
          this.#expanded.delete(view.slug)
          this.#render()
        }, 'hide-workspace'),
      )
    }
    head.appendChild(
      this.#button(RENAME_LABEL, () => void openRenameDialog(view.slug).then((done) => { if (done) void this.refresh() }), 'rename-workspace'),
    )
    if (view.canDelete) {
      head.appendChild(
        this.#button(DELETE_LABEL, () => void openDeleteDialog(view.slug).then((done) => { if (done) void this.refresh() }), 'delete-workspace'),
      )
    }
    card.appendChild(head)
    if (view.isDefault) card.appendChild(this.#line(DEFAULT_CARD_LINE, 'fl-wss-muted fl-wss-lede'))

    // ── Facts: one grid — label · value · actions — so every button lines up ──
    const facts = document.createElement('div')
    facts.className = 'fl-wss-facts'

    // The shared repository: its address (data — what the person typed) with
    // Change… / Disconnect…, or nothing yet.
    const remoteActions: HTMLElement[] = []
    if (view.hasRemote) {
      remoteActions.push(
        this.#button(CHANGE_REMOTE_LABEL, () => void this.#connect(view.slug, view.name, true), 'change-remote'),
        this.#button(
          DISCONNECT_REMOTE_LABEL,
          () => void openDisconnectRemoteDialog({ slug: view.slug, name: view.name }).then((done) => { if (done) void this.refresh() }),
          'disconnect-remote',
        ),
      )
    } else {
      remoteActions.push(this.#button(CONNECT_REMOTE_LABEL, () => void this.#connect(view.slug, view.name, false), 'connect-remote'))
    }
    const remoteValue = this.#line(view.remoteText, view.hasRemote ? 'fl-wss-remote' : 'fl-wss-muted')
    if (view.hasRemote) remoteValue.title = view.remoteText
    facts.appendChild(this.#fact('shared-repository', SHARED_REPOSITORY_LABEL, [remoteValue], remoteActions))

    // The branch it syncs on, and why Flow moved it there if it did.
    if (view.hasRemote) {
      const values: HTMLElement[] = [this.#line(view.branchText, view.branchText === NO_BRANCH_YET ? 'fl-wss-muted' : 'fl-wss-remote')]
      if (view.branchMoveText !== null) {
        const moved = this.#line(view.branchMoveText, 'fl-wss-muted')
        moved.dataset['part'] = 'branch-move'
        values.push(moved)
      }
      facts.appendChild(
        this.#fact('workspace-branch', BRANCH_LABEL, values, [
          this.#button(
            CHANGE_BRANCH_LABEL,
            () => void openChangeBranchDialog({ slug: view.slug, name: view.name }).then((done) => { if (done && !this.#disposed) void this.refresh() }),
            'change-branch',
          ),
        ]),
      )
    }

    // Sync: where it stands, Sync now, and the way into a pause.
    const status = document.createElement('div')
    status.className = `fl-wss-status ${view.sync.tone}`
    status.dataset['part'] = 'sync-status'
    status.textContent = view.sync.text
    const statusLine = document.createElement('div')
    statusLine.className = 'fl-wss-status-line'
    const dot = document.createElement('span')
    dot.className = `fl-wss-dot ${view.sync.tone}`
    dot.setAttribute('aria-hidden', 'true')
    statusLine.append(dot, status)
    const syncActions: HTMLElement[] = []
    if (view.sync.paused) {
      syncActions.push(
        this.#button(REVIEW_CHANGES_LABEL, () => {
          document.dispatchEvent(new CustomEvent(WORKSPACE_SYNC_EVENT, { detail: { slug: view.slug } }))
        }),
      )
    }
    if (view.hasRemote && view.sync.joinInstead === true) {
      const remote = view.remoteText
      const branch = view.branchText === NO_BRANCH_YET ? null : view.branchText
      syncActions.push(
        this.#button(JOIN_INSTEAD_LABEL, () => void openJoinDialog({ remote, branch }).then(() => this.refresh()), 'join-instead'),
      )
    }
    if (view.hasRemote) {
      const syncNow = this.#button(SYNC_NOW_LABEL, () => void this.#syncNow(view.slug), 'sync-now')
      syncNow.disabled = !view.sync.canSyncNow
      syncActions.push(syncNow)
    }
    facts.appendChild(this.#fact('sync', SYNC_LABEL, [statusLine], syncActions))
    card.appendChild(facts)

    card.appendChild(this.#projects(view))
    const notice = this.#notices.get(view.slug)
    if (notice !== undefined) card.appendChild(this.#line(notice, 'fl-wss-notice'))
    return card
  }

  /** Default and the Workspace being looked at are open; any other is folded until shown. */
  #isExpanded(slug: string, isDefault: boolean): boolean {
    return isDefault || slug === workspaceScope.state.currentSlug || this.#expanded.has(slug)
  }

  /** One row of the facts grid. `part` names the row for the page's own wiring. */
  #fact(part: string, label: string, values: HTMLElement[], actions: HTMLElement[]): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-wss-fact'
    row.dataset['part'] = part
    const labelEl = this.#line(label, 'fl-wss-fact-label')
    const value = document.createElement('div')
    value.className = 'fl-wss-fact-value'
    value.append(...values)
    const buttons = document.createElement('div')
    buttons.className = 'fl-wss-fact-actions'
    buttons.append(...actions)
    row.append(labelEl, value, buttons)
    return row
  }

  #projects(view: WorkspaceCardView): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-wss-projects'

    // ── The heading: how many, and the two ways to bring one in ──
    const head = document.createElement('div')
    head.className = 'fl-wss-projects-head'
    head.append(this.#line(PROJECTS_LABEL, 'fl-wss-projects-title'), this.#line(String(view.projects.length), 'fl-wss-muted'))
    const spacer = document.createElement('div')
    spacer.className = 'fl-wss-spacer'
    head.appendChild(spacer)
    if (this.#adding !== view.slug) {
      head.append(
        this.#button(MOVE_HERE_LABEL, () => {
          this.#adding = view.slug
          this.#render()
        }, 'move-here'),
        this.#button(OPEN_PROJECT_HERE_LABEL, () => void openProjectIntoWorkspace(view.slug).then(() => this.refresh()), 'open-project-here'),
      )
    }
    block.appendChild(head)

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
    }

    const list = document.createElement('div')
    list.className = 'fl-wss-project-list'
    if (view.projects.length === 0) list.appendChild(this.#line(NO_PROJECTS_LINE, 'fl-wss-muted fl-wss-empty'))
    for (const project of view.projects) list.appendChild(this.#projectRow(view, project))
    block.appendChild(list)
    return block
  }

  /** name + where it is · the row's one direct action · its ⋯ menu — always in the same columns. */
  #projectRow(view: WorkspaceCardView, project: WorkspaceCardView['projects'][number]): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-wss-project'
    row.dataset['projectId'] = project.id
    const name = document.createElement('div')
    name.className = 'fl-wss-project-name'
    const title = document.createElement('div')
    title.className = 'fl-wss-project-title'
    title.appendChild(this.#line(project.name, 'fl-wss-value'))
    const also = alsoInTag(project.alsoIn)
    if (also !== null) {
      const tag = this.#line(also, 'fl-wss-also')
      tag.dataset['part'] = 'also-in'
      title.appendChild(tag)
    }
    name.append(title, this.#line(project.note ?? ON_THIS_COMPUTER, 'fl-wss-muted'))
    row.appendChild(name)

    // The direct action: the project's settings, or saying which open project it is.
    const direct = document.createElement('div')
    direct.className = 'fl-wss-project-direct'
    const root = project.root
    if (project.canOpenSettings && root !== null) {
      const settings = this.#button(SETTINGS_SHORT_LABEL, () => {
        document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath: root } }))
      }, 'project-settings')
      settings.prepend(gearIcon())
      settings.setAttribute('aria-label', projectSettingsFor(project.name))
      direct.appendChild(settings)
    } else if (project.canMapSameProject) {
      direct.appendChild(this.#button(SAME_PROJECT_LABEL, () => void this.#mapSameProject(view, project.id, project.name), 'same-project'))
    }
    row.appendChild(direct)

    // The ⋯ menu: Move to another Workspace…, Remove from this one… (with why not).
    const key = `${view.slug}:${project.id}`
    const wrap = document.createElement('div')
    wrap.className = 'fl-wss-menu-wrap'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'fl-settings-btn fl-wss-more'
    more.dataset['part'] = 'project-menu'
    more.textContent = '⋯'
    more.setAttribute('aria-label', moreFor(project.name))
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    const menu = document.createElement('div')
    menu.className = 'fl-wss-menu'
    menu.setAttribute('role', 'menu')
    menu.hidden = true
    const projectId = project.id
    const projectName = project.name
    const item = (label: string, part: string, onPick: () => void, blocked: string | null = null): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-wss-menu-item'
      button.setAttribute('role', 'menuitem')
      button.dataset['part'] = part
      button.appendChild(this.#line(label, 'fl-wss-menu-label'))
      if (blocked !== null) {
        button.disabled = true
        button.title = blocked
        button.appendChild(this.#line(blocked, 'fl-wss-menu-why'))
      }
      button.addEventListener('click', () => {
        this.#menuFor = null
        closeMenu(wrap)
        onPick()
      })
      return button
    }
    if (project.canMove) {
      menu.appendChild(
        item(MOVE_TO_WORKSPACE_LABEL, 'move-project', () => {
          void openMoveProjectDialog({ from: view.slug, projectId, projectName }).then((done) => { if (done) void this.refresh() })
        }),
      )
    }
    menu.appendChild(
      item(
        removeFromLabel(view.name),
        'remove-project',
        () => void openRemoveProjectDialog({ slug: view.slug, projectId, projectName }).then((done) => { if (done) void this.refresh() }),
        project.removeBlocked,
      ),
    )
    more.addEventListener('click', () => {
      const opening = !wrap.classList.contains('open')
      for (const other of this.element.querySelectorAll('.fl-wss-menu-wrap.open')) closeMenu(other)
      this.#menuFor = opening ? key : null
      if (opening) openMenu(wrap)
    })
    wrap.append(more, menu)
    if (this.#menuFor === key) openMenu(wrap)
    row.appendChild(wrap)
    return row
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

function openMenu(wrap: Element): void {
  wrap.classList.add('open')
  const menu = wrap.querySelector<HTMLElement>('.fl-wss-menu')
  if (menu !== null) menu.hidden = false
  wrap.querySelector('.fl-wss-more')?.setAttribute('aria-expanded', 'true')
}

function closeMenu(wrap: Element): void {
  wrap.classList.remove('open')
  const menu = wrap.querySelector<HTMLElement>('.fl-wss-menu')
  if (menu !== null) menu.hidden = true
  wrap.querySelector('.fl-wss-more')?.setAttribute('aria-expanded', 'false')
}

/** A small stroke gear, drawn inline (no emoji, no icon font). */
function gearIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'fl-wss-icon')
  const hub = document.createElementNS(ns, 'circle')
  hub.setAttribute('cx', '8')
  hub.setAttribute('cy', '8')
  hub.setAttribute('r', '2.2')
  const spokes = document.createElementNS(ns, 'path')
  spokes.setAttribute('d', 'M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1')
  svg.append(hub, spokes)
  return svg
}

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-wss-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--fl-space-md); flex-wrap: wrap; margin-bottom: var(--fl-space-sm); }
    .fl-wss-intro .fl-wss-description { margin: 0; flex: 1 1 320px; max-width: 520px; }
    .fl-wss-intro-actions { flex: none; }
    .fl-wss-body { display: flex; flex-direction: column; gap: var(--fl-space-md); }
    .fl-wss-actions { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); align-items: center; }
    .fl-settings-btn.fl-wss-primary { background: var(--fl-color-accent); color: var(--fl-color-on-accent, #fff); border-color: var(--fl-color-accent); }
    .fl-settings-btn.fl-wss-primary:hover { filter: brightness(1.08); }
    .fl-wss-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-wss-value { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    .fl-wss-remote { font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); color: var(--fl-color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-wss-muted { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-wss-notice {
      margin: 0 var(--fl-space-md) var(--fl-space-md);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
      padding: var(--fl-space-xs) var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised);
    }
    .fl-wss-card {
      display: flex; flex-direction: column;
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface); container-type: inline-size;
    }
    .fl-wss-spacer { flex: 1 1 auto; }
    .fl-wss-head { display: flex; align-items: center; gap: var(--fl-space-xs); padding: var(--fl-space-md) var(--fl-space-md) var(--fl-space-sm); flex-wrap: wrap; }
    .fl-wss-card.folded .fl-wss-head { padding-bottom: var(--fl-space-md); }
    .fl-wss-name { font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); margin-right: var(--fl-space-xs); }
    .fl-wss-badge {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 999px; padding: 1px 8px;
    }
    .fl-wss-summary { margin-left: var(--fl-space-xs); }
    .fl-wss-lede { padding: 0 var(--fl-space-md) var(--fl-space-md); }
    .fl-wss-facts { border-top: var(--fl-border-width) solid var(--fl-color-border); padding: 0 var(--fl-space-md); }
    .fl-wss-fact {
      display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; column-gap: var(--fl-space-md); align-items: center;
      min-height: 44px; padding: var(--fl-space-xs) 0;
    }
    .fl-wss-fact + .fl-wss-fact { border-top: var(--fl-border-width) solid var(--fl-color-separator, var(--fl-color-border)); }
    .fl-wss-fact-label { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    .fl-wss-fact-value { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fl-wss-fact-actions { display: flex; gap: var(--fl-space-xs); justify-content: flex-end; flex-wrap: wrap; }
    .fl-wss-status-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .fl-wss-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--fl-color-text-secondary); }
    .fl-wss-dot.ok { background: var(--fl-color-success); }
    .fl-wss-dot.warning { background: var(--fl-color-warning); }
    .fl-wss-dot.error { background: var(--fl-color-error); }
    .fl-wss-status { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    .fl-wss-status.ok { color: var(--fl-color-success); }
    .fl-wss-status.warning { color: var(--fl-color-warning); }
    .fl-wss-status.error { color: var(--fl-color-error); }
    .fl-wss-projects { border-top: var(--fl-border-width) solid var(--fl-color-border); display: flex; flex-direction: column; }
    .fl-wss-projects-head { display: flex; align-items: center; gap: var(--fl-space-xs); flex-wrap: wrap; padding: var(--fl-space-sm) var(--fl-space-md); }
    .fl-wss-projects-title { font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-wss-add { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); align-items: center; padding: 0 var(--fl-space-md) var(--fl-space-sm); }
    .fl-wss-project-list { display: flex; flex-direction: column; padding: 0 var(--fl-space-sm) var(--fl-space-sm); }
    .fl-wss-empty { padding: var(--fl-space-xs) var(--fl-space-sm); }
    .fl-wss-project {
      display: grid; grid-template-columns: minmax(0, 1fr) auto 32px; column-gap: var(--fl-space-xs); align-items: center;
      padding: var(--fl-space-xs) var(--fl-space-sm); border-radius: var(--fl-radius-sm);
    }
    .fl-wss-project + .fl-wss-project { border-top: var(--fl-border-width) solid var(--fl-color-separator, var(--fl-color-border)); }
    .fl-wss-project:hover, .fl-wss-project:has(.fl-wss-menu-wrap.open) { background: var(--fl-color-surface-raised); }
    .fl-wss-project-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .fl-wss-project-title { display: flex; align-items: center; gap: var(--fl-space-xs); min-width: 0; flex-wrap: wrap; }
    .fl-wss-project-title .fl-wss-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-wss-also {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-warning);
      border: var(--fl-border-width) solid currentColor; border-radius: 999px; padding: 0 7px; opacity: 0.9;
    }
    .fl-wss-project-direct { display: flex; justify-content: flex-end; }
    .fl-wss-project-direct .fl-settings-btn { display: inline-flex; align-items: center; gap: 6px; }
    .fl-wss-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
    .fl-wss-menu-wrap { position: relative; display: flex; justify-content: flex-end; }
    .fl-settings-btn.fl-wss-more { width: 30px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1; }
    .fl-wss-menu {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; min-width: 260px; max-width: 320px;
      display: flex; flex-direction: column; padding: 4px;
      background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md); box-shadow: var(--fl-shadow-md, 0 12px 32px rgba(0,0,0,0.4));
    }
    .fl-wss-menu[hidden] { display: none; }
    .fl-wss-menu-item {
      display: flex; flex-direction: column; gap: 2px; text-align: left; width: 100%;
      padding: 7px 10px; border: none; border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text); font: inherit; font-size: var(--fl-text-ui-size); cursor: pointer;
    }
    .fl-wss-menu-item:hover:not(:disabled), .fl-wss-menu-item:focus-visible { background: var(--fl-color-surface-selected, var(--fl-color-surface)); outline: none; }
    .fl-wss-menu-item:disabled { cursor: default; color: var(--fl-color-text-secondary); }
    .fl-wss-menu-why { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); white-space: normal; }
    @container (max-width: 560px) {
      .fl-wss-fact { grid-template-columns: minmax(0, 1fr) auto; }
      .fl-wss-fact-label { grid-column: 1 / -1; padding-top: var(--fl-space-xs); }
    }
  `
  document.head.appendChild(style)
}
