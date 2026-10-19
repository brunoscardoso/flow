/**
 * THE WORKSPACE SWITCHER — every decision it makes, without a DOM.
 *
 * The dropdown at the top of the window chooses a WORKSPACE (user,
 * 2026-10-06: "the top dropdown should be the dropdown of the workspace, and
 * instead of list of projects the idea was have a unified one"). Since the
 * hard migration (decision 2026-10-06) Workspaces are always on and every
 * project lives in one — the Default Workspace unless a person moved it. What
 * the person is looking at — one thread list, one board, one files picker — is
 * called the SCOPE here:
 *
 *   · `workspace` — every project of one Workspace, as ONE list.
 *   · `none`      — no Workspace on this computer yet: the first launch's
 *                   migration is still running (or could not run). The one
 *                   list then holds every project, so nothing disappears.
 *
 * WHO DECIDES THE SCOPE. The person's last choice in the switcher, and opening
 * a project counts as a choice: a project that belongs to a Workspace puts you
 * in that Workspace. With no choice yet, the active project decides, then the
 * Workspace main remembers as current, then Default, then the first.
 *
 * MEMBERSHIP IS MAIN'S ANSWER (`workspaces:membership`), keyed by the root the
 * renderer asked with. A root in NO Workspace (its move is waiting on a
 * person, or failed) or whose answer has not arrived yet is shown in the list
 * of whichever Workspace is open — never hidden — and the switcher lists it
 * under "Needs attention".
 *
 * Every string here is a person's words (forbidden-pattern #12): no paths, no
 * commands, no setting names. "Workspace" is the product's noun and is
 * capitalised as one.
 */

import type { WorkspaceListing, WorkspacePlacementState, WorkspaceProject } from '../../shared/workspaces-contract'

// ── Scope ────────────────────────────────────────────────────────────────────

export type WorkspaceScope = { kind: 'workspace'; slug: string; name: string } | { kind: 'none' }

/** What the person last chose in the switcher (or by opening a project). */
export type SwitcherChoice = { kind: 'workspace'; slug: string }

/** registered root → its Workspace's slug, `null` for "in none". Absent = not known yet. */
export type RootMembership = ReadonlyMap<string, string | null>

/** registered root → the id of the Workspace project it is (the registry's answer), or null. */
export type RootProjects = ReadonlyMap<string, string | null>

export interface ScopeInputs {
  workspaces: readonly WorkspaceListing[]
  /** The Workspace main remembers as current (`workspaces:current`). */
  currentSlug: string | null
  membership: RootMembership
  activeRoot: string | null
  choice: SwitcherChoice | null
}

function workspaceBySlug(
  workspaces: readonly WorkspaceListing[],
  slug: string | null | undefined,
): WorkspaceListing | null {
  if (slug === null || slug === undefined) return null
  return workspaces.find((workspace) => workspace.slug === slug) ?? null
}

function asScope(workspace: WorkspaceListing): WorkspaceScope {
  return { kind: 'workspace', slug: workspace.slug, name: workspace.name }
}

/** The choice that opening `root` amounts to, or null while it is in no Workspace (or unknown). */
export function choiceForRoot(root: string, membership: RootMembership): SwitcherChoice | null {
  const slug = membership.get(root)
  return typeof slug === 'string' ? { kind: 'workspace', slug } : null
}

/** What the surfaces show. See the module header for the order of precedence. */
export function deriveScope(input: ScopeInputs): WorkspaceScope {
  const { workspaces } = input
  const chosen = workspaceBySlug(workspaces, input.choice?.slug)
  // A choice of a Workspace that has since gone falls through to the rest.
  if (chosen !== null) return asScope(chosen)
  if (input.activeRoot !== null) {
    const owner = workspaceBySlug(workspaces, input.membership.get(input.activeRoot))
    if (owner !== null) return asScope(owner)
  }
  const fallback =
    workspaceBySlug(workspaces, input.currentSlug) ??
    workspaces.find((workspace) => workspace.isDefault) ??
    workspaces[0] ??
    null
  return fallback === null ? { kind: 'none' } : asScope(fallback)
}

export function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'workspace' && b.kind === 'workspace') return a.slug === b.slug && a.name === b.name
  return true
}

/** Whether two membership answers say the same thing (they arrive as fresh maps). */
export function sameMembership(a: RootMembership, b: RootMembership): boolean {
  if (a.size !== b.size) return false
  for (const [root, slug] of a) {
    if (!b.has(root) || b.get(root) !== slug) return false
  }
  return true
}

/**
 * Whether a row whose project is `root` belongs on screen for `scope`: its
 * own Workspace's, or — for a project in no Workspace yet (or not known) —
 * whichever is open, so its threads never vanish.
 */
export function rootInScope(root: string, scope: WorkspaceScope, membership: RootMembership): boolean {
  if (scope.kind === 'none') return true
  const slug = membership.get(root)
  return slug === scope.slug || slug === null || slug === undefined
}

/** The registered roots of a scope, in the order they were given. */
export function rootsInScope(
  roots: readonly string[],
  scope: WorkspaceScope,
  membership: RootMembership,
): string[] {
  return roots.filter((root) => rootInScope(root, scope, membership))
}

// ── Project names ────────────────────────────────────────────────────────────

/**
 * The two spellings one folder arrives with on macOS: the temp and var folders
 * live under `/private`, and one side of the app may have resolved the link
 * while the other did not. Compared, never shown.
 */
export function comparablePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '')
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * The Workspace project a registered root IS — by the registry's answer
 * (`workspaces:membership`: its Workspace and project id), looked up in the
 * listing for its name. NEVER re-derived by comparing the root's path with a
 * listing's: main decides membership once, on real paths, and every surface
 * reads that one answer (allowed-pattern #14).
 */
export function memberOf(
  root: string,
  membership: RootMembership,
  projects: RootProjects,
  workspaces: readonly WorkspaceListing[],
): { workspace: WorkspaceListing; project: WorkspaceProject } | null {
  const slug = membership.get(root)
  const id = projects.get(root)
  if (typeof slug !== 'string' || typeof id !== 'string') return null
  const workspace = workspaces.find((candidate) => candidate.slug === slug)
  const project = workspace?.projects.find((candidate) => candidate.id === id)
  return workspace === undefined || project === undefined ? null : { workspace, project }
}

/**
 * The short name a row is tagged with: the Workspace's name for the project
 * when it has one, the folder's name otherwise.
 */
export function projectTag(
  root: string,
  membership: RootMembership,
  projects: RootProjects,
  workspaces: readonly WorkspaceListing[],
): string {
  return memberOf(root, membership, projects, workspaces)?.project.name ?? lastSegment(root)
}

/** The app's own (registered) root for a Workspace project, when the app has it open. */
export function registeredRootOf(
  workspaceSlug: string,
  projectId: string,
  registered: readonly string[],
  membership: RootMembership,
  projects: RootProjects,
): string | null {
  return registered.find((root) => membership.get(root) === workspaceSlug && projects.get(root) === projectId) ?? null
}

// ── New thread ───────────────────────────────────────────────────────────────

/** Where the last-used project of each Workspace is remembered (per machine). */
export const LAST_PROJECT_STORAGE_KEY = 'flow.workspaces.lastProject'

/** Parse the remembered map; anything malformed reads as "nothing remembered". */
export function parseLastProjects(raw: string | null): Record<string, string> {
  if (raw === null || raw === '') return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [slug, root] of Object.entries(value as Record<string, unknown>)) {
      if (typeof root === 'string' && root !== '') out[slug] = root
    }
    return out
  } catch {
    return {}
  }
}

/** A new copy of the map with `slug → root` recorded (never mutates the input). */
export function rememberLastProject(
  map: Readonly<Record<string, string>>,
  slug: string,
  root: string,
): Record<string, string> {
  return { ...map, [slug]: root }
}

/**
 * Which project a new thread in a Workspace starts in: the one last used in
 * this Workspace, else the active project when it is one of them, else the
 * first. Only projects the person can open here (`available`) are candidates.
 */
export function defaultNewThreadProject(input: {
  scopeRoots: readonly string[]
  available: (root: string) => boolean
  lastUsed: string | null
  activeRoot: string | null
}): string | null {
  const candidates = input.scopeRoots.filter((root) => input.available(root))
  if (input.lastUsed !== null && candidates.includes(input.lastUsed)) return input.lastUsed
  if (input.activeRoot !== null && candidates.includes(input.activeRoot)) return input.activeRoot
  return candidates[0] ?? null
}

// ── Sync status (Workspace sync, when the app offers it) ─────────────────────

/**
 * One line about a Workspace's sync, or null when there is nothing to say.
 * The shape is read defensively: the status arrives from a newer part of the
 * app, and an answer this does not recognise is shown as nothing rather than
 * as a guess.
 */
export function syncStatusText(status: unknown): string | null {
  if (typeof status !== 'object' || status === null) return null
  const record = status as Record<string, unknown>
  const raw = record['state'] ?? record['status'] ?? record['kind']
  if (typeof raw !== 'string') return null
  switch (raw) {
    // IDLE IS NOT A CLAIM. The engine rests in idle before its first sync and
    // after arming a retry ("Flow will try again shortly") — saying "Up to
    // date" there would be the app vouching for a sync that did not happen.
    case 'idle':
      return null
    case 'synced':
    case 'clean':
    case 'up-to-date':
      return 'Up to date'
    case 'syncing':
    case 'running':
    case 'pushing':
    case 'pulling':
      return 'Syncing'
    case 'pending':
    case 'dirty':
    case 'queued':
      return 'Changes waiting to sync'
    case 'paused':
    case 'ask':
    case 'review':
      return 'Sync paused — needs you'
    case 'offline':
      return 'Offline — saving here'
    case 'no-access': {
      // The engine's own sentence names the Workspace and nothing else (#12).
      const detail = record['detail']
      return typeof detail === 'string' && detail.trim() !== '' ? detail : 'No access to the shared repository'
    }
    case 'error':
    case 'failed':
      return 'Sync failed'
    case 'no-remote':
    case 'local':
    case 'local-only':
      return 'Kept on this machine'
    default:
      return null
  }
}

// ── The menu ─────────────────────────────────────────────────────────────────

export type SwitcherAction = 'new-workspace' | 'join-workspace' | 'open-project'
/** What the open Workspace's row offers as icons: rename / delete it, make a
 *  new one, join a team's (user, 2026-10-06). */
export type WorkspaceAction = 'rename' | 'delete' | 'new' | 'join'

export interface SwitcherWorkspaceProject {
  /** The Workspace project's id — data for "Move to…", never shown. */
  id: string
  name: string
  /** The checkout on this machine that the app has open, or null. */
  root: string | null
  /** A short note when the project cannot be used here. */
  note: string | null
  /** It can move to another Workspace (there is another one to move to). */
  canMove: boolean
  /** Its position in the Workspace — its colour when nobody picked one. */
  slot: number
}

/** A project in no Workspace, and what pressing its row does. */
export interface SwitcherAttention {
  root: string
  label: string
  /** One plain line: why it is here. */
  text: string
  action: 'move-in' | 'retry'
}

export type SwitcherMenuEntry =
  | {
      kind: 'workspace'
      slug: string
      name: string
      active: boolean
      isDefault: boolean
      /** Second line: its projects, and its sync status when known. */
      detail: string
      /** The Workspace's projects — listed under the CURRENT Workspace only. */
      projects: SwitcherWorkspaceProject[]
      /** Rename / Delete — offered on the CURRENT Workspace only; Default can't be deleted. */
      actions: WorkspaceAction[]
    }
  | { kind: 'heading'; text: string }
  | { kind: 'note'; text: string }
  | ({ kind: 'attention' } & SwitcherAttention)
  | { kind: 'action'; action: SwitcherAction; label: string }

export const NEEDS_ATTENTION_HEADING = 'Needs attention'
export const SETTING_UP_LINE = 'Setting up your Workspace…'
export const NO_WORKSPACE_LABEL = 'No Workspace yet'
export const NEW_WORKSPACE_LABEL = 'New Workspace…'
export const JOIN_WORKSPACE_LABEL = 'Join a Workspace…'
export const OPEN_PROJECT_LABEL = 'Add project…'
export const RENAME_WORKSPACE_LABEL = 'Rename…'
export const DELETE_WORKSPACE_LABEL = 'Delete…'
export const MOVE_PROJECT_LABEL = 'Move to…'
export const NO_PROJECTS_DETAIL = 'No projects yet'
export const NOT_ON_THIS_MACHINE = 'Not on this machine'
/** A registered project whose folder cannot be reached right now. */
export const UNAVAILABLE_TAG = 'Not available on this computer'
export const NOT_OPEN_HERE = 'Not open in Flow'
export const DEFAULT_TAG = 'Default'

/** "Waiting to move into Default — needs your go-ahead". */
export function pendingAttentionText(workspaceName: string): string {
  return `Waiting to move into ${workspaceName} — needs your go-ahead`
}
export const FAILED_ATTENTION_TEXT = "Couldn't move into a Workspace — try again"

/** The accessible name of a project's move button. */
export function moveProjectLabel(projectName: string): string {
  return `Move ${projectName} to another Workspace`
}

function projectList(names: readonly string[]): string {
  if (names.length === 0) return NO_PROJECTS_DETAIL
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/** The switcher's "Needs attention" rows — the projects in no Workspace, and why. */
export function attentionEntries(
  placement: WorkspacePlacementState | null,
  label: (root: string) => string,
): SwitcherAttention[] {
  if (placement === null) return []
  // A waiting project keeps "Move it in" — and says why the last try stopped,
  // when one did. A failed one says its own reason, never a bare "try again".
  return placement.issues.map((issue) =>
    issue.kind === 'pending'
      ? {
          root: issue.root,
          label: label(issue.root),
          text: issue.problem ?? pendingAttentionText(issue.workspaceName),
          action: 'move-in' as const,
        }
      : {
          root: issue.root,
          label: label(issue.root),
          text: issue.reason.trim() === '' ? FAILED_ATTENTION_TEXT : issue.reason,
          action: 'retry' as const,
        },
  )
}

export interface SwitcherMenuInput {
  workspaces: readonly WorkspaceListing[]
  scope: WorkspaceScope
  /** The projects open in the app, in their sidebar order. */
  registered: ReadonlyArray<{ rootPath: string; available: boolean }>
  membership: RootMembership
  activeRoot: string | null
  /** Each Workspace's sync status (any shape — see `syncStatusText`). */
  syncStatus?: ReadonlyMap<string, unknown>
  /** The projects outside every Workspace, and whether the launch migration still runs. */
  placement?: WorkspacePlacementState | null
  /** Disambiguated labels for the registered roots. */
  label: (root: string) => string
}

/**
 * The open menu, top to bottom: every Workspace (the current one listing its
 * projects and offering Rename / Delete), the projects that need attention,
 * then the actions. There is no list of "projects outside a Workspace": every
 * project lives in one.
 */
export function switcherMenu(input: SwitcherMenuInput): SwitcherMenuEntry[] {
  const entries: SwitcherMenuEntry[] = []
  const registeredByPath = new Map(
    input.registered.map((root) => [comparablePath(root.rootPath), root.rootPath]),
  )
  // A registered project whose folder is gone (#974) — the row must say so.
  // The flag was already in `registered` and nothing read it: the old project
  // switcher greyed and tagged such a row, and when the Workspace switcher took
  // its place a vanished project listed exactly like a healthy one.
  const unavailable = new Set(
    input.registered.filter((root) => !root.available).map((root) => comparablePath(root.rootPath)),
  )
  const several = input.workspaces.length > 1
  for (const workspace of input.workspaces) {
    const active = input.scope.kind === 'workspace' && input.scope.slug === workspace.slug
    // "Kept on this machine" is the ordinary state of a Workspace with no
    // shared repository — not news in the menu (user, 2026-10-06). Settings
    // and the hover title still say it.
    const syncRecord = input.syncStatus?.get(workspace.slug) as { state?: unknown } | undefined
    const sync = syncRecord?.state === 'local-only' ? null : syncStatusText(syncRecord)
    const names = workspace.projects.map((project) => project.name)
    // The open Workspace lists its projects right below its name, so repeating
    // them on its line is noise (user, 2026-10-06); it keeps only its sync status.
    const summary = active ? null : projectList(names)
    const detail = [summary, sync].filter((part): part is string => part !== null).join(' · ')
    const projects: SwitcherWorkspaceProject[] = active
      ? workspace.projects.map((project, slot) => {
          const root =
            project.localPath === null
              ? null
              : (registeredByPath.get(comparablePath(project.localPath)) ?? null)
          let note: string | null = null
          if (project.localPath === null) note = NOT_ON_THIS_MACHINE
          else if (root === null) note = NOT_OPEN_HERE
          else if (unavailable.has(comparablePath(root))) note = UNAVAILABLE_TAG
          return { id: project.id, name: project.name, root, note, canMove: several, slot }
        })
      : []
    const actions: WorkspaceAction[] = active
      ? [...(workspace.isDefault ? (['rename'] as const) : (['rename', 'delete'] as const)), 'new', 'join']
      : []
    entries.push({
      kind: 'workspace',
      slug: workspace.slug,
      name: workspace.name,
      active,
      isDefault: workspace.isDefault,
      detail,
      projects,
      actions,
    })
  }
  if (input.workspaces.length === 0 && input.placement?.migrating !== false) {
    entries.push({ kind: 'note', text: SETTING_UP_LINE })
  }
  const attention = attentionEntries(input.placement ?? null, input.label)
  if (attention.length > 0) {
    entries.push({ kind: 'heading', text: NEEDS_ATTENTION_HEADING })
    for (const item of attention) entries.push({ kind: 'attention', ...item })
  }
  // New / Join are icons on the OPEN Workspace's row; with none open, these
  // rows are the only way in, so they stay.
  const anOpenWorkspace = entries.some((entry) => entry.kind === 'workspace' && entry.active)
  if (!anOpenWorkspace) {
    entries.push({ kind: 'action', action: 'new-workspace', label: NEW_WORKSPACE_LABEL })
    entries.push({ kind: 'action', action: 'join-workspace', label: JOIN_WORKSPACE_LABEL })
  }
  entries.push({ kind: 'action', action: 'open-project', label: OPEN_PROJECT_LABEL })
  return entries
}

/** The switcher button's own text. */
export function switcherLabel(scope: WorkspaceScope, migrating = false): string {
  if (scope.kind === 'workspace') return scope.name
  return migrating ? SETTING_UP_LINE : NO_WORKSPACE_LABEL
}

/** The switcher button's hover text: the Workspace's projects and its sync status. */
export function switcherTitle(
  scope: WorkspaceScope,
  workspaces: readonly WorkspaceListing[],
  syncStatus?: ReadonlyMap<string, unknown>,
): string {
  if (scope.kind !== 'workspace') return ''
  const workspace = workspaceBySlug(workspaces, scope.slug)
  if (workspace === null) return scope.name
  const names = workspace.projects.map((project) => project.name)
  const lines = [`${workspace.name} — ${projectList(names)}`]
  const sync = syncStatusText(syncStatus?.get(workspace.slug))
  if (sync !== null) lines.push(sync)
  return lines.join('\n')
}

/** The sidebar's line when a Workspace has no thread yet. */
export function emptyWorkspaceMessage(scope: WorkspaceScope, hasRoots: boolean): string | null {
  if (scope.kind !== 'workspace') return null
  if (!hasRoots) return `None of ${scope.name}'s projects are open in Flow yet`
  return `No threads in ${scope.name} yet`
}

/**
 * Where a person lands after a Workspace was deleted: the Default one (every
 * project of the deleted Workspace moved there), else the first left.
 */
export function workspaceAfterDelete(workspaces: readonly WorkspaceListing[], deleted: string): string | null {
  const left = workspaces.filter((workspace) => workspace.slug !== deleted)
  return (left.find((workspace) => workspace.isDefault) ?? left[0])?.slug ?? null
}

/** The Workspaces a project may move to: every one but its own. */
export function moveTargets(
  workspaces: readonly WorkspaceListing[],
  from: string,
): Array<{ slug: string; name: string }> {
  return workspaces.filter((workspace) => workspace.slug !== from).map((workspace) => ({ slug: workspace.slug, name: workspace.name }))
}

// ── The dialogs the switcher asks for ───────────────────────────────────────

/**
 * Every Workspace dialog the switcher (and the settings) can ask for, through
 * one cancellable event, so the switcher never imports the dialogs' view.
 */
export type WorkspaceDialogRequest =
  | { kind: 'create' }
  | { kind: 'join' }
  | { kind: 'rename'; slug: string }
  | { kind: 'delete'; slug: string }
  | { kind: 'move-project'; from: string; projectId: string; projectName: string }
  | { kind: 'move-in'; root: string }
  | { kind: 'open-project' }

export type WorkspaceDialogKind = WorkspaceDialogRequest['kind']

export const WORKSPACE_DIALOG_EVENT = 'flow:workspace-dialog'

/** What the person is told while no dialog answers yet. */
export function unansweredDialogNotice(kind: WorkspaceDialogKind): { title: string; body: string } {
  return {
    title: kind === 'join' ? 'Join a Workspace' : 'Workspaces',
    body: 'That is not ready yet. Your projects keep working as they are.',
  }
}

/**
 * The ask for one project's actions (detail: `{ rootPath, anchor? }`) — new
 * thread or task in it, its colour, archiving its threads, removing it.
 * Dispatched by the Workspace switcher's project rows (their `⋯` button and a
 * right-click); answered by the thread sidebar, which owns the menu.
 */
export const PROJECT_MENU_EVENT = 'flow:project-menu'

/** The accessible name of a project row's actions button. */
export function projectActionsLabel(projectName: string): string {
  return `${projectName} actions`
}
