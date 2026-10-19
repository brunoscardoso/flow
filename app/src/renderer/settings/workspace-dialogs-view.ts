/**
 * The Workspace dialogs — New, Join, Rename, Delete, Move to…, Move it in,
 * "which Workspace does this new project join?", the one-commit confirmation,
 * "which open project is this?" — and the join suggestion shown when a project
 * is opened.
 *
 * A VIEW. Every word comes from `workspace-settings-model.ts` (scanned for
 * forbidden-pattern #12 by its test); this file owns overlays, fields, the
 * keyboard and the calls to `window.flow.workspaces` — every Workspace
 * operation goes through the CLI door behind those calls, never around it.
 *
 * ANSWERS `flow:workspace-dialog`. The sidebar's switcher dispatches it,
 * cancellable; `initWorkspaceDialogs` calls `preventDefault()` and opens the
 * dialog, so the switcher's "not ready yet" notice never shows.
 *
 * DISMISSING CHANGES NOTHING. Escape, the backdrop and Cancel resolve to null
 * and nothing was written. The one write that touches a project's own
 * repository — renaming a committed knowledge folder in one commit — is made
 * only after a person has read how many files that commit holds and pressed
 * the button that says so.
 */
import { markModalOverlay } from '../modal-overlay'
import { projectLabel } from '../project-label'
import type {
  WorkspaceListing,
  WorkspaceSuggestion,
  WorkspaceSummary,
} from '../../shared/workspaces-contract'
import {
  WORKSPACE_DIALOG_EVENT,
  moveTargets,
  type WorkspaceDialogRequest,
} from '../threads/workspace-switcher-model'
import { workspaceScope } from '../threads/workspace-scope'
import {
  ACTION_FAILED_LINE,
  ADD_OPEN_BODY,
  ADD_OPEN_TITLE,
  ADD_SELECTED_LABEL,
  ADDRESS_LABEL,
  ADDRESS_PLACEHOLDER,
  BLANK_ADDRESS,
  CANCEL_LABEL,
  COMMIT_CONFIRM_LABEL,
  COMMIT_CONFIRM_TITLE,
  CREATE_BODY,
  CREATE_CONFIRM,
  CREATE_TITLE,
  DISMISSED_SUGGESTIONS_KEY,
  DONE_LABEL,
  FRESH_NOTE,
  JOIN_BODY,
  JOIN_CONFIRM,
  JOIN_TITLE,
  JOINING_LABEL,
  NAME_LABEL,
  NAME_PLACEHOLDER,
  NEEDS_REVIEW_LABEL,
  ADD_CANDIDATES_LABEL,
  NO_OPEN_TO_ADD,
  REMOTE_HELP,
  REMOTE_LABEL,
  SAME_PROJECT_CONFIRM,
  SAME_PROJECT_QUESTION,
  SKIP_LABEL,
  SUGGESTION_ADD,
  SUGGESTION_NOT_NOW,
  WORKING_LABEL,
  ADD_TO_WORKSPACE_BODY,
  ADD_TO_WORKSPACE_CONFIRM,
  ADD_TO_WORKSPACE_TITLE,
  MOVE_BODY,
  MOVE_CONFIRM,
  MOVE_IN_CONFIRM,
  MOVE_IN_NOTHING,
  MOVE_IN_TITLE,
  NOWHERE_TO_MOVE,
  RENAME_BODY,
  RENAME_CONFIRM,
  RENAME_TITLE,
  WORKSPACE_LABEL,
  WORKSPACE_MOVE_IN_EVENT,
  commitConfirmText,
  createdLine,
  deleteConfirmView,
  deletedLine,
  moveHereCandidates,
  movedLine,
  moveTitle,
  validateRename,
  joinOutcome,
  linkOutcome,
  newlyOpened,
  parseDismissed,
  suggestionKey,
  suggestionText,
  validateCreate,
  type LinkStep,
  type OpenProject,
} from './workspace-settings-model'
import {
  ADDRESS_FIELD_HELP,
  ADDRESS_FIELD_LABEL,
  ADDRESS_FIELD_PLACEHOLDER,
  AZURE_PROJECT_LABEL,
  CHANGE_BODY,
  CHECKING_HOSTS,
  CHOICE_LABELS,
  CHOICE_LEGEND,
  CHOOSE_AZURE_PROJECT,
  CHOOSE_OWNER,
  CONNECT_BODY,
  CONNECT_FAILED_LINE,
  DISCONNECT_BODY,
  DISCONNECT_CONFIRM,
  NO_HOSTS_LINE,
  ORGANIZATION_LABEL,
  OWNER_LABEL,
  PRIVATE_NOTE,
  REPOSITORY_NAME_LABEL,
  azureProjectsOf,
  changeTitle,
  connectChoices,
  connectTitle,
  disconnectedLine,
  disconnectTitle,
  primaryLabel,
  remoteOutcome,
  showNoHostsLine,
  suggestedRepositoryName,
  validateRepositoryAddress,
  validateRepositoryName,
  workingLabel,
  type ConnectChoice,
} from './workspace-remote-model'
import type { WorkspaceHostTools, WorkspaceRemoteResult } from '../../shared/workspaces-contract'

/** The projects open in the app, with their Workspace. */
export async function readOpenProjects(): Promise<OpenProject[]> {
  const api = window.flow
  const roots = (await api.project.list().catch(() => [])).map((root) => root.rootPath)
  if (roots.length === 0) return []
  const membership = await api.workspaces?.membership({ roots }).catch(() => null)
  const bySlug = new Map<string, string | null>()
  if (membership?.ok === true) for (const entry of membership.roots) bySlug.set(entry.root, entry.workspace)
  return roots.map((rootPath) => ({ rootPath, label: projectLabel(rootPath, roots), workspace: bySlug.get(rootPath) ?? null }))
}

/** Every Workspace here, or an empty list when it can't be read. */
async function readWorkspaces(): Promise<WorkspaceListing[]> {
  const listed = await window.flow.workspaces?.list().catch(() => null)
  return listed?.ok === true ? listed.workspaces : []
}

// ── A plain dialog shell ────────────────────────────────────────────────────

interface Shell {
  overlay: HTMLDivElement
  dialog: HTMLDivElement
  content: HTMLDivElement
  message: HTMLParagraphElement
  actions: HTMLDivElement
  close: () => void
  onClose: (listener: () => void) => void
}

function shell(title: string, body: string | null, kind: string): Shell {
  injectStyles()
  const overlay = document.createElement('div')
  overlay.className = 'fl-ws-dialog-overlay'
  markModalOverlay(overlay)
  const dialog = document.createElement('div')
  dialog.className = 'fl-ws-dialog'
  dialog.dataset['dialog'] = kind
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', title)
  dialog.tabIndex = -1
  const heading = document.createElement('h2')
  heading.className = 'fl-ws-dialog-title'
  heading.textContent = title
  dialog.appendChild(heading)
  if (body !== null) dialog.appendChild(paragraph(body, 'fl-ws-dialog-body'))
  const content = document.createElement('div')
  content.className = 'fl-ws-dialog-content'
  const message = document.createElement('p')
  message.className = 'fl-ws-dialog-message'
  message.setAttribute('role', 'alert')
  const actions = document.createElement('div')
  actions.className = 'fl-ws-dialog-actions'
  dialog.append(content, message, actions)
  overlay.appendChild(dialog)

  const listeners: Array<() => void> = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    for (const listener of listeners) listener()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  dialog.focus()
  return { overlay, dialog, content, message, actions, close, onClose: (listener) => listeners.push(listener) }
}

function paragraph(text: string, className: string): HTMLParagraphElement {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

function actionButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = primary ? 'fl-ws-dialog-btn fl-ws-dialog-btn--primary' : 'fl-ws-dialog-btn'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function field(id: string, label: string, placeholder: string, help: string | null): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement('div')
  row.className = 'fl-ws-dialog-field'
  const labelEl = document.createElement('label')
  labelEl.className = 'fl-ws-dialog-label'
  labelEl.htmlFor = id
  labelEl.textContent = label
  const input = document.createElement('input')
  input.type = 'text'
  input.id = id
  input.className = 'fl-ws-dialog-input'
  input.placeholder = placeholder
  input.spellcheck = false
  input.autocomplete = 'off'
  row.append(labelEl, input)
  if (help !== null) row.appendChild(paragraph(help, 'fl-ws-dialog-help'))
  return { row, input }
}

// ── The one-commit confirmation ─────────────────────────────────────────────

/** Ask before the one code-repo commit; true only on the button that names it. */
export function confirmCommit(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = shell(COMMIT_CONFIRM_TITLE, text, 'confirm-commit')
    let answered = false
    dialog.onClose(() => {
      if (!answered) resolve(false)
    })
    dialog.actions.append(
      actionButton(CANCEL_LABEL, false, () => dialog.close()),
      actionButton(COMMIT_CONFIRM_LABEL, true, () => {
        answered = true
        resolve(true)
        dialog.close()
      }),
    )
  })
}

/**
 * Add one project to a Workspace — the one path every surface takes. A
 * committed knowledge folder is asked about first and linked only on a yes.
 */
export async function linkProject(input: {
  rootPath: string
  workspace: string
  name: string
  projectId?: string
}): Promise<LinkStep> {
  const api = window.flow.workspaces
  if (api === undefined) return { kind: 'refused', text: ACTION_FAILED_LINE }
  const request = {
    rootPath: input.rootPath,
    workspace: input.workspace,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  }
  const first = await api.link(request).catch(() => null)
  if (first === null) return { kind: 'refused', text: ACTION_FAILED_LINE }
  const step = linkOutcome(first, input.name)
  if (step.kind !== 'confirm-commit') return step
  if (!(await confirmCommit(step.text))) return { kind: 'refused', text: '' }
  const second = await api.link({ ...request, confirmCommit: true }).catch(() => null)
  return second === null ? { kind: 'refused', text: ACTION_FAILED_LINE } : linkOutcome(second, input.name)
}

// ── "Which open project is this?" ───────────────────────────────────────────

export function chooseOpenProject(candidates: ReadonlyArray<{ root: string; label: string }>): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = shell(SAME_PROJECT_QUESTION, null, 'same-project')
    let answer: string | null = null
    dialog.onClose(() => resolve(answer))
    const select = document.createElement('select')
    select.className = 'fl-ws-dialog-input'
    for (const candidate of candidates) {
      const option = document.createElement('option')
      option.value = candidate.root
      option.textContent = candidate.label
      select.appendChild(option)
    }
    dialog.content.appendChild(select)
    dialog.actions.append(
      actionButton(CANCEL_LABEL, false, () => dialog.close()),
      actionButton(SAME_PROJECT_CONFIRM, true, () => {
        answer = select.value === '' ? null : select.value
        dialog.close()
      }),
    )
    select.focus()
  })
}

// ── New Workspace ───────────────────────────────────────────────────────────

/**
 * Name (+ optional shared repository) → create → offer the open projects that
 * can join. Resolves with the Workspace, or null when nothing was created.
 */
export function openCreateDialog(): Promise<WorkspaceSummary | null> {
  return new Promise((resolve) => {
    const dialog = shell(CREATE_TITLE, CREATE_BODY, 'create')
    let created: WorkspaceSummary | null = null
    dialog.onClose(() => {
      // The new Workspace is where the person is now — the switcher's own path,
      // run once its projects are in, so it can open one of them.
      if (created !== null) void workspaceScope.selectWorkspace(created.slug)
      resolve(created)
    })
    const name = field('fl-ws-create-name', NAME_LABEL, NAME_PLACEHOLDER, null)
    const remote = field('fl-ws-create-remote', REMOTE_LABEL, '', REMOTE_HELP)
    dialog.content.append(name.row, remote.row, paragraph(FRESH_NOTE, 'fl-ws-dialog-note'))
    const cancel = actionButton(CANCEL_LABEL, false, () => dialog.close())
    const confirm = actionButton(CREATE_CONFIRM, true, () => void submit())
    dialog.actions.append(cancel, confirm)

    const submit = async (): Promise<void> => {
      const checked = validateCreate(name.input.value, remote.input.value)
      if (!checked.ok) {
        dialog.message.textContent = checked.message
        name.input.focus()
        return
      }
      confirm.disabled = true
      confirm.textContent = WORKING_LABEL
      const answer = await window.flow.workspaces
        ?.create({ name: checked.name, ...(checked.remote === null ? {} : { remote: checked.remote }) })
        .catch(() => null)
      confirm.disabled = false
      confirm.textContent = CREATE_CONFIRM
      if (answer === null || answer === undefined) {
        dialog.message.textContent = ACTION_FAILED_LINE
        return
      }
      if (!answer.ok) {
        dialog.message.textContent = answer.detail
        return
      }
      created = answer.workspace
      await offerOpenProjects(dialog, answer.workspace)
    }
    for (const input of [name.input, remote.input]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      })
      input.addEventListener('input', () => {
        dialog.message.textContent = ''
      })
    }
    name.input.focus()
  })
}

/** The second half of New: the projects of the other Workspaces, unticked, then moved one by one. */
async function offerOpenProjects(dialog: Shell, workspace: WorkspaceSummary): Promise<void> {
  const title = dialog.dialog.querySelector('.fl-ws-dialog-title')
  if (title !== null) title.textContent = ADD_OPEN_TITLE
  dialog.dialog.querySelector('.fl-ws-dialog-body')?.remove()
  dialog.message.textContent = ''
  dialog.content.replaceChildren(paragraph(createdLine(workspace.name), 'fl-ws-dialog-done'))
  dialog.actions.replaceChildren()
  const candidates = moveHereCandidates(await readWorkspaces(), workspace.slug)
  if (candidates.length === 0) {
    dialog.content.appendChild(paragraph(NO_OPEN_TO_ADD, 'fl-ws-dialog-help'))
    dialog.actions.appendChild(actionButton(DONE_LABEL, true, () => dialog.close()))
    return
  }
  dialog.content.appendChild(paragraph(ADD_OPEN_BODY, 'fl-ws-dialog-help'))
  const list = document.createElement('ul')
  list.className = 'fl-ws-dialog-projects'
  const rows: Array<{ projectId: string; from: string; box: HTMLInputElement; status: HTMLSpanElement }> = []
  for (const candidate of candidates) {
    const item = document.createElement('li')
    item.className = 'fl-ws-dialog-project'
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    // UNTICKED: moving a project changes where its knowledge lives — a person chooses each one.
    box.checked = false
    const name = document.createElement('span')
    name.textContent = candidate.label
    label.append(box, name)
    const status = document.createElement('span')
    status.className = 'fl-ws-dialog-project-status'
    item.append(label, status)
    list.appendChild(item)
    rows.push({ projectId: candidate.projectId, from: candidate.from, box, status })
  }
  dialog.content.appendChild(list)
  const skip = actionButton(SKIP_LABEL, false, () => dialog.close())
  const add = actionButton(ADD_SELECTED_LABEL, true, () => void moveSelected())
  dialog.actions.append(skip, add)

  const moveSelected = async (): Promise<void> => {
    add.disabled = true
    add.textContent = WORKING_LABEL
    for (const row of rows) {
      if (!row.box.checked || row.box.disabled) continue
      const answer = await window.flow.workspaces
        ?.moveProject({ project: row.projectId, to: workspace.slug, from: row.from })
        .catch(() => null)
      const ok = answer !== null && answer !== undefined && answer.ok
      row.status.textContent = ok ? DONE_LABEL : (answer?.ok === false ? answer.detail : ACTION_FAILED_LINE)
      row.status.dataset['tone'] = ok ? 'ok' : 'warning'
      if (ok) row.box.disabled = true
    }
    dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
  }
}

// ── Rename ──────────────────────────────────────────────────────────────────

export function openRenameDialog(slug: string): Promise<boolean> {
  return new Promise((resolve) => {
    void readWorkspaces().then((workspaces) => {
      const workspace = workspaces.find((candidate) => candidate.slug === slug)
      const dialog = shell(RENAME_TITLE, RENAME_BODY, 'rename')
      let renamed = false
      dialog.onClose(() => resolve(renamed))
      const name = field('fl-ws-rename-name', NAME_LABEL, NAME_PLACEHOLDER, null)
      name.input.value = workspace?.name ?? ''
      dialog.content.appendChild(name.row)
      const confirm = actionButton(RENAME_CONFIRM, true, () => void submit())
      dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)
      const submit = async (): Promise<void> => {
        const checked = validateRename(name.input.value, workspace?.name ?? '')
        if (!checked.ok) {
          dialog.message.textContent = checked.message
          name.input.focus()
          return
        }
        confirm.disabled = true
        confirm.textContent = WORKING_LABEL
        const answer = await window.flow.workspaces?.rename({ slug, name: checked.name }).catch(() => null)
        confirm.disabled = false
        confirm.textContent = RENAME_CONFIRM
        if (answer === null || answer === undefined) {
          dialog.message.textContent = ACTION_FAILED_LINE
          return
        }
        if (!answer.ok) {
          dialog.message.textContent = answer.detail
          return
        }
        renamed = true
        dialog.close()
      }
      name.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      })
      name.input.addEventListener('input', () => {
        dialog.message.textContent = ''
      })
      name.input.focus()
      name.input.select()
    })
  })
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a Workspace after the person has read which projects move to
 * Default and that the shared copy online stays. Default is never offered.
 */
export function openDeleteDialog(slug: string): Promise<boolean> {
  return new Promise((resolve) => {
    void readWorkspaces().then((workspaces) => {
      const workspace = workspaces.find((candidate) => candidate.slug === slug)
      if (workspace === undefined || workspace.isDefault) {
        resolve(false)
        return
      }
      const fallback = workspaces.find((candidate) => candidate.isDefault)?.name ?? 'Default'
      const view = deleteConfirmView(workspace, fallback)
      const dialog = shell(view.title, null, 'delete')
      let deleted = false
      dialog.onClose(() => {
        if (deleted) void workspaceScope.afterDelete(slug)
        resolve(deleted)
      })
      for (const line of view.lines) dialog.content.appendChild(paragraph(line, 'fl-ws-dialog-help'))
      const confirm = actionButton(view.confirm, true, () => {
        void (async () => {
          confirm.disabled = true
          confirm.textContent = WORKING_LABEL
          const answer = await window.flow.workspaces?.delete({ slug }).catch(() => null)
          if (answer === null || answer === undefined || !answer.ok) {
            confirm.disabled = false
            confirm.textContent = view.confirm
            dialog.message.textContent = answer?.ok === false ? answer.detail : ACTION_FAILED_LINE
            return
          }
          deleted = true
          dialog.content.replaceChildren(paragraph(deletedLine(workspace.name, fallback), 'fl-ws-dialog-done'))
          dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
        })()
      })
      confirm.dataset['action'] = 'confirm-delete'
      dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)
    })
  })
}

// ── Connect a Workspace to a shared repository ─────────────────────────────

/** A labelled `<select>` of plain values — owners, organizations, projects (data, shown as they are). */
function selectField(id: string, label: string, values: readonly string[]): { row: HTMLDivElement; select: HTMLSelectElement } {
  const row = document.createElement('div')
  row.className = 'fl-ws-dialog-field'
  const labelEl = document.createElement('label')
  labelEl.className = 'fl-ws-dialog-label'
  labelEl.htmlFor = id
  labelEl.textContent = label
  const select = document.createElement('select')
  select.id = id
  select.className = 'fl-ws-dialog-input'
  fillSelect(select, values)
  row.append(labelEl, select)
  return { row, select }
}

function fillSelect(select: HTMLSelectElement, values: readonly string[]): void {
  select.replaceChildren()
  for (const value of values) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    select.appendChild(option)
  }
}

/**
 * "Connect a shared repository…" (or "Change…", `replace: true`): create a
 * PRIVATE one on a host whose own tool is signed in here, or use an existing
 * one on any git host by its address. Main runs the CLI's set-remote and one
 * sync; this dialog shows the progress and a plain result. Resolves true when
 * the Workspace's shared repository changed.
 */
export function openConnectRemoteDialog(input: { slug: string; name: string; replace?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const api = window.flow.workspaces
    const replace = input.replace === true
    const dialog = shell(replace ? changeTitle(input.name) : connectTitle(input.name), replace ? CHANGE_BODY : CONNECT_BODY, 'connect-remote')
    let changed = false
    dialog.onClose(() => resolve(changed))

    // The choices: the signed-in hosts arrive a moment later; an existing repository is offered at once.
    const choicesBox = document.createElement('fieldset')
    choicesBox.className = 'fl-ws-dialog-choices'
    const legend = document.createElement('legend')
    legend.className = 'fl-ws-dialog-label'
    legend.textContent = CHOICE_LEGEND
    choicesBox.appendChild(legend)
    const hostsLine = paragraph(CHECKING_HOSTS, 'fl-ws-dialog-help')
    hostsLine.dataset['part'] = 'host-tools'
    const panel = document.createElement('div')
    panel.className = 'fl-ws-dialog-content'
    dialog.content.append(choicesBox, hostsLine, panel)

    let tools: WorkspaceHostTools | null = null
    let choice: ConnectChoice = 'existing'
    const nameDefault = suggestedRepositoryName(input.slug)

    // One set of fields, kept across choice changes so nothing typed is lost.
    const address = field('fl-ws-remote-address', ADDRESS_FIELD_LABEL, ADDRESS_FIELD_PLACEHOLDER, ADDRESS_FIELD_HELP)
    const repoName = field('fl-ws-remote-name', REPOSITORY_NAME_LABEL, nameDefault, null)
    repoName.input.value = nameDefault
    const owner = selectField('fl-ws-remote-owner', OWNER_LABEL, [])
    const organization = selectField('fl-ws-remote-organization', ORGANIZATION_LABEL, [])
    const azureProject = selectField('fl-ws-remote-project', AZURE_PROJECT_LABEL, [])
    organization.select.addEventListener('change', () => fillSelect(azureProject.select, azureProjectsOf(tools, organization.select.value)))
    const privateNote = paragraph(PRIVATE_NOTE, 'fl-ws-dialog-note')

    const confirm = actionButton(primaryLabel(choice), true, () => void submit())
    confirm.dataset['action'] = 'connect-remote-confirm'
    dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)

    const paintPanel = (): void => {
      dialog.message.textContent = ''
      confirm.textContent = primaryLabel(choice)
      if (choice === 'existing') {
        panel.replaceChildren(address.row)
        address.input.focus()
        return
      }
      if (choice === 'github') {
        fillSelect(owner.select, tools?.github.owners.map((entry) => entry.login) ?? [])
        panel.replaceChildren(owner.row, repoName.row, privateNote)
      } else {
        const organizations = tools?.azure.organizations.filter((entry) => entry.projects.length > 0).map((entry) => entry.name) ?? []
        fillSelect(organization.select, organizations)
        fillSelect(azureProject.select, azureProjectsOf(tools, organizations[0] ?? ''))
        panel.replaceChildren(organization.row, azureProject.row, repoName.row, privateNote)
      }
      repoName.input.focus()
    }

    const paintChoices = (): void => {
      for (const old of [...choicesBox.querySelectorAll('label')]) old.remove()
      const choices = connectChoices(tools)
      if (!choices.includes(choice)) choice = choices[0] ?? 'existing'
      for (const option of choices) {
        const label = document.createElement('label')
        label.className = 'fl-ws-dialog-choice'
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'fl-ws-remote-choice'
        radio.value = option
        radio.checked = option === choice
        radio.addEventListener('change', () => {
          if (!radio.checked) return
          choice = option
          paintPanel()
        })
        const text = document.createElement('span')
        text.textContent = CHOICE_LABELS[option]
        label.append(radio, text)
        choicesBox.appendChild(label)
      }
    }

    paintChoices()
    paintPanel()
    void (api?.hostTools().catch(() => null) ?? Promise.resolve(null)).then((answer) => {
      if (!dialog.overlay.isConnected) return
      tools = answer
      if (showNoHostsLine(tools)) hostsLine.textContent = NO_HOSTS_LINE
      else hostsLine.remove()
      // A host tool that is signed in is the easier path: offer it first, unless the person already typed an address.
      const before = choice
      const choices = connectChoices(tools)
      if (choice === 'existing' && address.input.value.trim() === '' && choices[0] !== undefined) choice = choices[0]
      paintChoices()
      if (choice !== before) paintPanel()
    })

    const fail = (text: string): void => {
      dialog.message.textContent = text
    }

    const submit = async (): Promise<void> => {
      if (api === undefined) {
        fail(CONNECT_FAILED_LINE)
        return
      }
      let request: Promise<WorkspaceRemoteResult>
      if (choice === 'existing') {
        const checked = validateRepositoryAddress(address.input.value)
        if (!checked.ok) {
          fail(checked.message)
          address.input.focus()
          return
        }
        request = api.setRemote({ slug: input.slug, remote: checked.remote, ...(replace ? { replace } : {}) })
      } else {
        const named = validateRepositoryName(repoName.input.value)
        if (!named.ok) {
          fail(named.message)
          repoName.input.focus()
          return
        }
        if (choice === 'github') {
          if (owner.select.value === '') {
            fail(CHOOSE_OWNER)
            return
          }
          request = api.createRemote({ slug: input.slug, provider: 'github', owner: owner.select.value, name: named.name, ...(replace ? { replace } : {}) })
        } else {
          if (organization.select.value === '' || azureProject.select.value === '') {
            fail(CHOOSE_AZURE_PROJECT)
            return
          }
          request = api.createRemote({
            slug: input.slug,
            provider: 'azure',
            organization: organization.select.value,
            project: azureProject.select.value,
            name: named.name,
            ...(replace ? { replace } : {}),
          })
        }
      }
      confirm.disabled = true
      confirm.textContent = workingLabel(choice)
      choicesBox.disabled = true
      const result = await request.catch(() => null)
      choicesBox.disabled = false
      confirm.disabled = false
      confirm.textContent = primaryLabel(choice)
      if (result === null) {
        fail(CONNECT_FAILED_LINE)
        return
      }
      const outcome = remoteOutcome(result, input.name, Date.now())
      if (outcome.kind === 'refused') {
        fail(outcome.text)
        if (outcome.suggestion !== undefined) repoName.input.value = outcome.suggestion
        if (outcome.created !== undefined) {
          // The repository exists now: the person can connect to it by its address.
          address.input.value = outcome.created
          choice = 'existing'
          paintChoices()
          panel.replaceChildren(address.row)
          confirm.textContent = primaryLabel(choice)
        }
        return
      }
      changed = true
      const done = paragraph(outcome.text, outcome.tone === 'ok' ? 'fl-ws-dialog-done' : 'fl-ws-dialog-help')
      done.dataset['part'] = 'connect-result'
      dialog.content.replaceChildren(done)
      dialog.dialog.querySelector('.fl-ws-dialog-body')?.remove()
      dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
    }

    address.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
    })
    for (const input of [address.input, repoName.input]) {
      input.addEventListener('input', () => {
        dialog.message.textContent = ''
      })
    }
  })
}

/** "Disconnect…": everything stays on this computer; the repository is left as it is. Resolves true when it was disconnected. */
export function openDisconnectRemoteDialog(input: { slug: string; name: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = shell(disconnectTitle(input.name), DISCONNECT_BODY, 'disconnect-remote')
    let disconnected = false
    dialog.onClose(() => resolve(disconnected))
    const confirm = actionButton(DISCONNECT_CONFIRM, true, () => {
      void (async () => {
        confirm.disabled = true
        confirm.textContent = WORKING_LABEL
        const answer = await window.flow.workspaces?.unsetRemote({ slug: input.slug }).catch(() => null)
        if (answer === null || answer === undefined || !answer.ok) {
          confirm.disabled = false
          confirm.textContent = DISCONNECT_CONFIRM
          dialog.message.textContent = answer?.ok === false ? answer.detail : ACTION_FAILED_LINE
          return
        }
        disconnected = true
        dialog.dialog.querySelector('.fl-ws-dialog-body')?.remove()
        dialog.content.replaceChildren(paragraph(disconnectedLine(input.name), 'fl-ws-dialog-done'))
        dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
      })()
    })
    confirm.dataset['action'] = 'confirm-disconnect'
    dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)
  })
}

// ── Move a project to another Workspace ─────────────────────────────────────

export function openMoveProjectDialog(input: { from: string; projectId: string; projectName: string }): Promise<boolean> {
  return new Promise((resolve) => {
    void readWorkspaces().then((workspaces) => {
      const targets = moveTargets(workspaces, input.from)
      const dialog = shell(moveTitle(input.projectName), MOVE_BODY, 'move-project')
      let moved = false
      dialog.onClose(() => resolve(moved))
      if (targets.length === 0) {
        dialog.content.appendChild(paragraph(NOWHERE_TO_MOVE, 'fl-ws-dialog-help'))
        dialog.actions.appendChild(actionButton(DONE_LABEL, true, () => dialog.close()))
        return
      }
      const select = document.createElement('select')
      select.className = 'fl-ws-dialog-input'
      select.setAttribute('aria-label', WORKSPACE_LABEL)
      for (const target of targets) {
        const option = document.createElement('option')
        option.value = target.slug
        option.textContent = target.name
        select.appendChild(option)
      }
      dialog.content.appendChild(select)
      const confirm = actionButton(MOVE_CONFIRM, true, () => {
        void (async () => {
          const to = select.value
          const target = targets.find((candidate) => candidate.slug === to)
          if (target === undefined) return
          confirm.disabled = true
          confirm.textContent = WORKING_LABEL
          const answer = await window.flow.workspaces
            ?.moveProject({ project: input.projectId, to, from: input.from })
            .catch(() => null)
          if (answer === null || answer === undefined || !answer.ok) {
            confirm.disabled = false
            confirm.textContent = MOVE_CONFIRM
            dialog.message.textContent = answer?.ok === false ? answer.detail : ACTION_FAILED_LINE
            return
          }
          moved = true
          dialog.content.replaceChildren(paragraph(movedLine(input.projectName, target.name), 'fl-ws-dialog-done'))
          dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
        })()
      })
      dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)
      select.focus()
    })
  })
}

// ── Move it in (a committed knowledge folder) ───────────────────────────────

/**
 * The one confirmed commit a committed knowledge folder takes to move into
 * its Workspace: shows the commit message main recorded, and only the press
 * that names it sends the confirmation.
 */
export function openMoveInDialog(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      const api = window.flow.workspaces
      const placement = await api?.placement().catch(() => null)
      const issue = placement?.issues.find((candidate) => candidate.root === root && candidate.kind === 'pending')
      const dialog = shell(MOVE_IN_TITLE, null, 'move-in')
      let movedIn = false
      dialog.onClose(() => resolve(movedIn))
      if (issue === undefined || issue.kind !== 'pending') {
        dialog.content.appendChild(paragraph(MOVE_IN_NOTHING, 'fl-ws-dialog-help'))
        dialog.actions.appendChild(actionButton(DONE_LABEL, true, () => dialog.close()))
        return
      }
      dialog.content.appendChild(
        paragraph(commitConfirmText(issue.commit.files, issue.commit.message === '' ? null : issue.commit.message), 'fl-ws-dialog-help'),
      )
      const confirm = actionButton(MOVE_IN_CONFIRM, true, () => {
        void (async () => {
          confirm.disabled = true
          confirm.textContent = WORKING_LABEL
          const answer = await api?.moveIn({ rootPath: root }).catch(() => null)
          if (answer === null || answer === undefined) {
            confirm.disabled = false
            confirm.textContent = MOVE_IN_CONFIRM
            dialog.message.textContent = ACTION_FAILED_LINE
            return
          }
          const step = linkOutcome(answer, issue.name)
          if (step.kind !== 'done') {
            confirm.disabled = false
            confirm.textContent = MOVE_IN_CONFIRM
            dialog.message.textContent = step.text
            return
          }
          movedIn = true
          dialog.content.replaceChildren(paragraph(step.text, 'fl-ws-dialog-done'))
          dialog.actions.replaceChildren(actionButton(DONE_LABEL, true, () => dialog.close()))
        })()
      })
      confirm.dataset['action'] = 'confirm-move-in'
      dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)
    })()
  })
}

// ── Open a project into a Workspace ─────────────────────────────────────────

/**
 * "Open Project…": every project lives in a Workspace, so with more than one
 * here the person picks which it joins (the one being looked at is chosen
 * already) before the folder picker opens. With one, it simply joins it.
 */
export async function openProjectIntoWorkspace(preferred?: string): Promise<void> {
  const workspaces = await readWorkspaces()
  const current = preferred ?? (workspaceScope.state.scope.kind === 'workspace' ? workspaceScope.state.scope.slug : undefined)
  let workspace: string | undefined = workspaces.length === 1 ? workspaces[0]?.slug : current
  if (workspaces.length > 1) {
    const chosen = await chooseWorkspace(workspaces, current)
    if (chosen === null) return
    workspace = chosen
  }
  const root = await window.flow.project
    .open(workspace === undefined ? {} : { workspace })
    .catch((error: unknown) => {
      console.error('flow: failed to open project', error)
      return null
    })
  if (root) document.dispatchEvent(new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }))
}

function chooseWorkspace(workspaces: readonly WorkspaceListing[], current: string | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = shell(ADD_TO_WORKSPACE_TITLE, ADD_TO_WORKSPACE_BODY, 'choose-workspace')
    let answer: string | null = null
    dialog.onClose(() => resolve(answer))
    const select = document.createElement('select')
    select.className = 'fl-ws-dialog-input'
    select.setAttribute('aria-label', WORKSPACE_LABEL)
    for (const workspace of workspaces) {
      const option = document.createElement('option')
      option.value = workspace.slug
      option.textContent = workspace.name
      if (workspace.slug === current) option.selected = true
      select.appendChild(option)
    }
    dialog.content.appendChild(select)
    dialog.actions.append(
      actionButton(CANCEL_LABEL, false, () => dialog.close()),
      actionButton(ADD_TO_WORKSPACE_CONFIRM, true, () => {
        answer = select.value === '' ? null : select.value
        dialog.close()
      }),
    )
    select.focus()
  })
}

// ── Join a Workspace ────────────────────────────────────────────────────────

export function openJoinDialog(): Promise<WorkspaceSummary | null> {
  return new Promise((resolve) => {
    const dialog = shell(JOIN_TITLE, JOIN_BODY, 'join')
    let joined: WorkspaceSummary | null = null
    dialog.onClose(() => {
      if (joined !== null) void workspaceScope.selectWorkspace(joined.slug)
      resolve(joined)
    })
    const address = field('fl-ws-join-address', ADDRESS_LABEL, ADDRESS_PLACEHOLDER, null)
    dialog.content.append(address.row, paragraph(FRESH_NOTE, 'fl-ws-dialog-note'))
    const confirm = actionButton(JOIN_CONFIRM, true, () => void submit())
    dialog.actions.append(actionButton(CANCEL_LABEL, false, () => dialog.close()), confirm)

    const submit = async (): Promise<void> => {
      const remote = address.input.value.trim()
      if (remote === '') {
        dialog.message.textContent = BLANK_ADDRESS
        address.input.focus()
        return
      }
      confirm.disabled = true
      confirm.textContent = JOINING_LABEL
      const answer = await window.flow.workspaces?.join({ remote }).catch(() => null)
      confirm.disabled = false
      confirm.textContent = JOIN_CONFIRM
      if (answer === null || answer === undefined) {
        dialog.message.textContent = ACTION_FAILED_LINE
        return
      }
      if (!answer.ok) {
        dialog.message.textContent = answer.detail
        return
      }
      joined = answer.workspace
      const view = joinOutcome(answer)
      const title = dialog.dialog.querySelector('.fl-ws-dialog-title')
      if (title !== null) title.textContent = view.headline
      dialog.dialog.querySelector('.fl-ws-dialog-body')?.remove()
      dialog.message.textContent = ''
      dialog.content.replaceChildren(...view.lines.map((line) => paragraph(line, 'fl-ws-dialog-help')))
      for (const project of view.needsReview) {
        const row = document.createElement('div')
        row.className = 'fl-ws-dialog-review'
        const text = paragraph(project.text, 'fl-ws-dialog-help')
        row.appendChild(text)
        const root = project.root
        if (project.canConfirm && root !== null) {
          const review = actionButton(NEEDS_REVIEW_LABEL, false, () => {
            void (async () => {
              review.disabled = true
              const step = await linkProject({ rootPath: root, workspace: answer.workspace.slug, name: project.name })
              text.textContent = step.text
              if (step.kind !== 'done') review.disabled = false
              else review.remove()
            })()
          })
          row.appendChild(review)
        }
        dialog.content.appendChild(row)
      }
      // THE OPEN PROJECTS THE JOIN PROPOSES — unticked. A Workspace file can
      // list the remote of any repository, so nothing is linked until the
      // person ticks a project and presses "Add these projects".
      const done = actionButton(DONE_LABEL, true, () => dialog.close())
      if (view.candidates.length === 0) {
        dialog.actions.replaceChildren(done)
        return
      }
      const list = document.createElement('ul')
      list.className = 'fl-ws-dialog-projects'
      list.dataset['part'] = 'join-candidates'
      const rows: Array<{ root: string; name: string; projectId: string; box: HTMLInputElement; status: HTMLSpanElement }> = []
      for (const candidate of view.candidates) {
        const item = document.createElement('li')
        item.className = 'fl-ws-dialog-project'
        const label = document.createElement('label')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = candidate.checked
        box.value = candidate.root
        const name = document.createElement('span')
        name.textContent = candidate.name
        label.append(box, name)
        const status = document.createElement('span')
        status.className = 'fl-ws-dialog-project-status'
        item.append(label, status)
        list.appendChild(item)
        rows.push({ root: candidate.root, name: candidate.name, projectId: candidate.projectId, box, status })
      }
      dialog.content.appendChild(list)
      const add = actionButton(ADD_CANDIDATES_LABEL, false, () => {
        void (async () => {
          add.disabled = true
          add.textContent = WORKING_LABEL
          for (const row of rows) {
            if (!row.box.checked || row.box.disabled) continue
            const step = await linkProject({
              rootPath: row.root,
              workspace: answer.workspace.slug,
              name: row.name,
              projectId: row.projectId,
            })
            row.status.textContent = step.text
            row.status.dataset['tone'] = step.kind === 'done' ? 'ok' : 'warning'
            if (step.kind === 'done') row.box.disabled = true
          }
          add.remove()
        })()
      })
      // Nothing ticked → nothing to add.
      const syncAdd = (): void => {
        add.disabled = !rows.some((row) => row.box.checked && !row.box.disabled)
      }
      for (const row of rows) row.box.addEventListener('change', syncAdd)
      syncAdd()
      dialog.actions.replaceChildren(add, done)
    }
    address.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
    })
    address.input.addEventListener('input', () => {
      dialog.message.textContent = ''
    })
    address.input.focus()
  })
}

// ── The join suggestion (FR-3) ──────────────────────────────────────────────

function readDismissed(): Set<string> {
  try {
    return parseDismissed(localStorage.getItem(DISMISSED_SUGGESTIONS_KEY))
  } catch {
    return new Set()
  }
}

function rememberDismissed(key: string): void {
  try {
    const set = readDismissed()
    set.add(key)
    localStorage.setItem(DISMISSED_SUGGESTIONS_KEY, JSON.stringify([...set]))
  } catch {
    // A private window or blocked storage: the suggestion may come back once.
  }
}

let promptOpen = false

/** One dismissible prompt: "This project belongs to the Acme Workspace. Add it?" */
export function showSuggestion(rootPath: string, suggestion: WorkspaceSuggestion): void {
  const text = suggestionText(suggestion)
  const key = suggestionKey(rootPath, suggestion)
  if (text === null || key === null || suggestion.kind !== 'link' || promptOpen) return
  if (readDismissed().has(key)) return
  injectStyles()
  promptOpen = true
  const card = document.createElement('div')
  card.className = 'fl-ws-suggestion'
  card.setAttribute('role', 'status')
  const line = paragraph(text, 'fl-ws-suggestion-text')
  const actions = document.createElement('div')
  actions.className = 'fl-ws-suggestion-actions'
  const close = (): void => {
    promptOpen = false
    card.remove()
  }
  const notNow = actionButton(SUGGESTION_NOT_NOW, false, () => {
    rememberDismissed(key)
    close()
  })
  const add = actionButton(SUGGESTION_ADD, true, () => {
    void (async () => {
      add.disabled = true
      add.textContent = WORKING_LABEL
      const step = await linkProject({
        rootPath,
        workspace: suggestion.workspace.slug,
        name: suggestion.project.name,
        projectId: suggestion.project.id,
      })
      if (step.kind === 'done') {
        line.textContent = step.text
        actions.replaceChildren(actionButton(DONE_LABEL, false, close))
        return
      }
      if (step.text === '') {
        add.disabled = false
        add.textContent = SUGGESTION_ADD
        return
      }
      line.textContent = step.text
      actions.replaceChildren(actionButton(DONE_LABEL, false, close))
    })()
  })
  actions.append(notNow, add)
  card.append(line, actions)
  document.body.appendChild(card)
}

async function suggestFor(rootPath: string): Promise<void> {
  const api = window.flow.workspaces
  if (api === undefined) return
  const answer = await api.suggest({ rootPath }).catch(() => null)
  if (answer === null || !answer.ok) return
  showSuggestion(rootPath, answer.suggestion)
}

// ── Wiring ───────────────────────────────────────────────────────────────────

let initialized = false

/** Answer the switcher's New / Join and watch for projects that belong to a Workspace. */
export function initWorkspaceDialogs(): void {
  if (initialized || window.flow?.workspaces === undefined) return
  initialized = true
  document.addEventListener(WORKSPACE_DIALOG_EVENT, (event) => {
    const detail = (event as CustomEvent<WorkspaceDialogRequest | undefined>).detail
    event.preventDefault()
    switch (detail?.kind) {
      case 'join':
        void openJoinDialog()
        return
      case 'rename':
        void openRenameDialog(detail.slug)
        return
      case 'delete':
        void openDeleteDialog(detail.slug)
        return
      case 'move-project':
        void openMoveProjectDialog(detail)
        return
      case 'move-in':
        void openMoveInDialog(detail.root)
        return
      case 'open-project':
        void openProjectIntoWorkspace()
        return
      default:
        void openCreateDialog()
    }
  })
  // A pending project's card ("Move it in") — main's notification names this event.
  document.addEventListener(WORKSPACE_MOVE_IN_EVENT, (event) => {
    const root = (event as CustomEvent<{ root?: unknown } | undefined>).detail?.root
    if (typeof root === 'string' && root !== '') void openMoveInDialog(root)
  })

  // FR-3: a project that just appeared in the app, or became the active one.
  let known: Set<string> | null = null
  const look = async (): Promise<void> => {
    const roots = (await window.flow.project.list().catch(() => [])).map((root) => root.rootPath)
    const previous = known
    known = new Set(roots)
    // The first look only learns what is already open — opening the app is not opening a project.
    if (previous === null) return
    for (const root of newlyOpened(previous, roots)) await suggestFor(root)
  }
  void look()
  window.flow.project.onListChanged?.(() => void look())
}

// ── Styles ──────────────────────────────────────────────────────────────────

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-ws-dialog-overlay {
      position: fixed; inset: 0; z-index: 2100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-ws-dialog {
      width: min(480px, calc(100vw - var(--fl-space-xl)));
      max-height: 80vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-lg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface);
      box-shadow: var(--fl-shadow-md);
      font-family: var(--fl-font-ui); color: var(--fl-color-text);
    }
    .fl-ws-dialog:focus { outline: none; }
    .fl-ws-dialog-title { margin: 0; font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-ws-dialog-body, .fl-ws-dialog-help {
      margin: 0; font-size: var(--fl-text-ui-size); line-height: var(--fl-line-height);
      color: var(--fl-color-text-secondary);
    }
    .fl-ws-dialog-content { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-ws-dialog-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .fl-ws-dialog-label {
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text-secondary);
    }
    .fl-ws-dialog-input {
      width: 100%; box-sizing: border-box;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-ws-dialog-input:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
    .fl-ws-dialog-help { font-size: var(--fl-text-caption-size); }
    .fl-ws-dialog-note {
      margin: 0; font-size: var(--fl-text-caption-size); line-height: var(--fl-line-height-dense);
      color: var(--fl-color-text-secondary);
      border-left: 2px solid var(--fl-color-accent); padding-left: var(--fl-space-sm);
    }
    .fl-ws-dialog-done { margin: 0; font-size: var(--fl-text-ui-size); color: var(--fl-color-success); }
    .fl-ws-dialog-message {
      margin: 0; min-height: var(--fl-text-caption-size);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-warning);
    }
    .fl-ws-dialog-choices { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--fl-space-xs); min-width: 0; }
    .fl-ws-dialog-choices legend { padding: 0; margin-bottom: var(--fl-space-xs); }
    .fl-ws-dialog-choice { display: flex; align-items: center; gap: var(--fl-space-sm); font-size: var(--fl-text-ui-size); cursor: pointer; }
    .fl-ws-dialog-projects { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-ws-dialog-project { display: flex; flex-direction: column; gap: 2px; font-size: var(--fl-text-ui-size); }
    .fl-ws-dialog-project label { display: flex; align-items: center; gap: var(--fl-space-sm); cursor: pointer; }
    .fl-ws-dialog-project-status { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); padding-left: 22px; }
    .fl-ws-dialog-project-status[data-tone="ok"] { color: var(--fl-color-success); }
    .fl-ws-dialog-project-status[data-tone="warning"] { color: var(--fl-color-warning); }
    .fl-ws-dialog-review { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--fl-space-sm); }
    .fl-ws-dialog-link {
      border: none; background: none; padding: 0 0 0 var(--fl-space-xs); cursor: pointer;
      color: var(--fl-color-accent); font: inherit; text-decoration: underline;
    }
    .fl-ws-dialog-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); margin-top: var(--fl-space-xs); }
    .fl-ws-dialog-btn {
      padding: var(--fl-space-xs) var(--fl-space-md); border-radius: var(--fl-radius-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); cursor: pointer;
    }
    .fl-ws-dialog-btn--primary { background: var(--fl-color-accent); border-color: var(--fl-color-accent); color: var(--fl-color-on-accent, #fff); }
    .fl-ws-dialog-btn:disabled { opacity: 0.5; cursor: default; }
    .fl-ws-dialog-btn:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
    .fl-ws-suggestion {
      position: fixed; right: var(--fl-space-lg); bottom: var(--fl-space-lg); z-index: 1500;
      width: min(360px, calc(100vw - var(--fl-space-xl)));
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-md);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface); box-shadow: var(--fl-shadow-md);
      font-family: var(--fl-font-ui); color: var(--fl-color-text);
    }
    .fl-ws-suggestion-text { margin: 0; font-size: var(--fl-text-ui-size); line-height: var(--fl-line-height); }
    .fl-ws-suggestion-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); }
  `
  document.head.appendChild(style)
}
