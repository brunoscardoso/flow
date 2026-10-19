/**
 * WORKSPACES — every word the Workspace settings, the New / Join dialogs, the
 * join suggestion and the onboarding step say, and every decision about what
 * they show. DOM-free, so it unit-tests under the app's node jest and so the
 * forbidden-pattern #12 scan in its test can see every sentence.
 *
 * The views (`workspace-settings-section.ts`, `workspace-dialogs-view.ts`, the
 * onboarding step) only turn these answers into elements. A literal sentence
 * in a view is a bug: the scan cannot see it.
 *
 * WHAT IS DATA AND WHAT IS COPY. A Workspace's name, its projects' names and
 * the shared repository address a person typed are data — shown as they are.
 * Everything around them is copy, and copy never names a command, a path, a
 * setting key or an internal word.
 *
 * EVERY PROJECT LIVES IN A WORKSPACE (decision 2026-10-06). There is no
 * on/off switch and no "outside a Workspace": a project moves BETWEEN
 * Workspaces ("Move to…"), a deleted Workspace's projects move to Default, and
 * Default itself can't be deleted.
 *
 * WHAT IS NOT SHOWN, AND WHY. The Flow folder: it had its own block here
 * (its name, and that moving it is not supported yet), but every Workspace card
 * already says where that Workspace's things live, so the block repeated it in
 * vaguer words (user, 2026-10-06). Moving the folder is still not offered: the
 * CLI's `move-flow-folder` needs its own confirmation flow and a restart story
 * before the app drives it.
 */
import type {
  WorkspaceAnswer,
  WorkspaceJoinResult,
  WorkspaceLinkResult,
  WorkspaceListing,
  WorkspaceRefusal,
  WorkspaceSuggestion,
  WorkspaceSyncStatus,
  WorkspacesChangeCause,
} from '../../shared/workspaces-contract'
import { workspaceRefusalDetail } from '../../shared/workspace-refusals'
import { comparablePath } from '../threads/workspace-switcher-model'

// ── The settings group and section ──────────────────────────────────────────

/** The settings tab, and the section's own heading. */
export const WORKSPACES_GROUP_LABEL = 'Workspaces'
export const WORKSPACES_SECTION_TITLE = 'Workspaces'
export const WORKSPACES_SECTION_ID = 'workspaces'
export const WORKSPACES_DESCRIPTION =
  'A Workspace groups projects so their knowledge, threads and board live together, and can be shared with your team through one repository.'

export const NEW_WORKSPACE_LABEL = 'New Workspace…'
export const JOIN_WORKSPACE_LABEL = 'Join a Workspace…'
export const NO_WORKSPACES_LINE = 'Flow is still setting up your Workspace. It appears here in a moment.'
export const LIST_FAILED_LINE = 'Flow could not read the Workspaces on this computer right now.'
export const UNREADABLE_LINE = 'One Workspace folder on this computer could not be read and is left as it is.'

export const SHARED_REPOSITORY_LABEL = 'Shared repository'
export const NO_SHARED_REPOSITORY = 'None — this Workspace stays on this computer'

export const SYNC_LABEL = 'Sync'
export const SYNC_NOW_LABEL = 'Sync now'
export const SYNCING_LABEL = 'Syncing…'
export const REVIEW_CHANGES_LABEL = 'Review the changes'
export const NO_ACCESS_LINE = 'The shared repository did not accept this computer’s git sign-in. Sync waits until it does.'

export const PROJECTS_LABEL = 'Projects'
export const NO_PROJECTS_LINE = 'No projects yet.'
export const NOT_ON_THIS_COMPUTER = 'Not on this computer'
export const NOT_OPEN_IN_FLOW = 'Not open in Flow'
export const PROJECT_SETTINGS_LABEL = 'Project settings'
export const SAME_PROJECT_LABEL = 'It is on this computer…'
export const SAME_PROJECT_QUESTION = 'Which open project is this?'
export const SAME_PROJECT_CONFIRM = 'This is the same project'
export const NO_MAP_CANDIDATES = 'Open the project in Flow first, then come back here.'
export const MOVE_HERE_LABEL = 'Move a project here…'
export const MOVE_HERE_CONFIRM = 'Move here'
export const MOVE_HERE_CHOOSE = 'Choose a project from another Workspace'
export const NO_MOVE_HERE_CANDIDATES = 'Every project is already in this Workspace.'
export const OPEN_PROJECT_HERE_LABEL = 'Open a project here…'
export const MOVE_TO_LABEL = 'Move to…'
export const RENAME_LABEL = 'Rename…'
export const DELETE_LABEL = 'Delete…'
export const DEFAULT_LINE = 'Default — every project without another Workspace lives here. It can’t be deleted.'
export const CANCEL_LABEL = 'Cancel'
export const WORKING_LABEL = 'Working…'

export const ACTION_FAILED_LINE = 'That did not work. Try again in a moment.'

// ── Sync status ──────────────────────────────────────────────────────────────

/** "just now", "5 minutes ago", "yesterday" — a sync time in words. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'a while ago'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 2) return 'a minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 2) return 'an hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days < 2) return 'yesterday'
  return `${days} days ago`
}

export type SyncTone = 'ok' | 'muted' | 'warning' | 'error'

export interface SyncLineView {
  text: string
  tone: SyncTone
  /** "Sync now" can be pressed (not while syncing). */
  canSyncNow: boolean
  /** A person must choose before sync runs again. */
  paused: boolean
}

function waitingCount(status: WorkspaceSyncStatus): number {
  return status.asks.length + status.reviews.length
}

function needsYou(count: number): string {
  if (count <= 0) return 'Paused — waiting for you'
  return count === 1 ? 'Paused — 1 change needs you' : `Paused — ${count} changes need you`
}

/** One Workspace's sync, in words; `null` while it has not been read. */
export function syncLine(status: WorkspaceSyncStatus | null, now: number, syncing = false): SyncLineView {
  if (syncing || status?.state === 'syncing') {
    return { text: SYNCING_LABEL, tone: 'muted', canSyncNow: false, paused: false }
  }
  if (status === null) return { text: 'Not read yet', tone: 'muted', canSyncNow: true, paused: false }
  const last = status.lastSyncedAt
  switch (status.state) {
    case 'synced':
      return {
        text: last === null ? 'Up to date' : `Synced ${relativeTime(last, now)}`,
        tone: 'ok',
        canSyncNow: true,
        paused: false,
      }
    case 'idle':
      return {
        text: last === null ? 'Not synced yet' : `Last synced ${relativeTime(last, now)}`,
        tone: 'muted',
        canSyncNow: true,
        paused: false,
      }
    case 'paused':
      return { text: needsYou(waitingCount(status)), tone: 'warning', canSyncNow: true, paused: true }
    case 'offline':
      return {
        text: last === null ? 'Offline — will retry' : `Offline — will retry. Last synced ${relativeTime(last, now)}`,
        tone: 'warning',
        canSyncNow: true,
        paused: false,
      }
    case 'no-access':
      return { text: status.detail ?? NO_ACCESS_LINE, tone: 'error', canSyncNow: true, paused: false }
    case 'error':
      return { text: status.detail ?? 'Sync cannot run right now', tone: 'error', canSyncNow: true, paused: false }
    case 'local-only':
      return { text: 'Kept on this computer — no shared repository', tone: 'muted', canSyncNow: false, paused: false }
    default:
      return { text: 'Not read yet', tone: 'muted', canSyncNow: true, paused: false }
  }
}

// ── One Workspace, as the settings show it ──────────────────────────────────

/** Compare two folder locations the way the switcher does (trailing separators, the macOS private prefix). */
export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b)
}

export interface OpenProject {
  rootPath: string
  /** What the app calls it (disambiguated folder name). */
  label: string
  /** The Workspace it belongs to here, or null (its move in is waiting, or failed). */
  workspace: string | null
}

export interface WorkspaceProjectRow {
  id: string
  name: string
  /** The open checkout in the app, or null — data for the gear, never shown. */
  root: string | null
  note: string | null
  /** The project's own settings can be opened from here. */
  canOpenSettings: boolean
  /** Nothing is known here: offer to say which open project it is. */
  canMapSameProject: boolean
  /** It can move to another Workspace (there is another one). */
  canMove: boolean
}

export interface WorkspaceCardView {
  slug: string
  name: string
  isDefault: boolean
  /** Default can't be deleted. */
  canDelete: boolean
  remoteText: string
  hasRemote: boolean
  sync: SyncLineView
  projects: WorkspaceProjectRow[]
  /** Projects of the other Workspaces that may move here. */
  moveHereCandidates: MoveCandidate[]
}

/** A project of another Workspace, as "Move a project here…" lists it. */
export interface MoveCandidate {
  /** The project's id — data for the move, never shown. */
  projectId: string
  from: string
  /** "Backend — in Acme". */
  label: string
}

export function projectRows(
  workspace: WorkspaceListing,
  open: readonly OpenProject[],
  canMove = false,
): WorkspaceProjectRow[] {
  return workspace.projects.map((project) => {
    const localPath = project.localPath
    const match =
      localPath === null ? undefined : open.find((candidate) => samePath(candidate.rootPath, localPath))
    let note: string | null = null
    if (localPath === null) note = NOT_ON_THIS_COMPUTER
    else if (match === undefined) note = NOT_OPEN_IN_FLOW
    return {
      id: project.id,
      name: project.name,
      root: match?.rootPath ?? null,
      note,
      canOpenSettings: match !== undefined,
      canMapSameProject: localPath === null,
      canMove,
    }
  })
}

/** "Backend — in Acme": a project of another Workspace, named with where it is now. */
export function moveCandidateLabel(projectName: string, workspaceName: string): string {
  return `${projectName} — in ${workspaceName}`
}

/** The projects of every OTHER Workspace — what "Move a project here…" offers. */
export function moveHereCandidates(workspaces: readonly WorkspaceListing[], to: string): MoveCandidate[] {
  return workspaces
    .filter((workspace) => workspace.slug !== to)
    .flatMap((workspace) =>
      workspace.projects.map((project) => ({
        projectId: project.id,
        from: workspace.slug,
        label: moveCandidateLabel(project.name, workspace.name),
      })),
    )
}

/** The open projects that could be the same project as one not on this computer (in no Workspace, or another one). */
export function mapCandidates(open: readonly OpenProject[], workspace: string): Array<{ root: string; label: string }> {
  return open
    .filter((project) => project.workspace !== workspace)
    .map((project) => ({ root: project.rootPath, label: project.label }))
}

export function workspaceCard(input: {
  workspace: WorkspaceListing
  open: readonly OpenProject[]
  sync: WorkspaceSyncStatus | null
  syncing?: boolean
  now: number
  /** Every Workspace here — what a project could move to or from. */
  all?: readonly WorkspaceListing[]
}): WorkspaceCardView {
  const { workspace } = input
  const all = input.all ?? [workspace]
  return {
    slug: workspace.slug,
    name: workspace.name,
    isDefault: workspace.isDefault,
    canDelete: !workspace.isDefault,
    remoteText: workspace.remote ?? NO_SHARED_REPOSITORY,
    hasRemote: workspace.remote !== null,
    sync: syncLine(input.sync, input.now, input.syncing === true),
    projects: projectRows(workspace, input.open, all.length > 1),
    moveHereCandidates: moveHereCandidates(all, workspace.slug),
  }
}

// ── Rename, delete, move ────────────────────────────────────────────────────

export const RENAME_TITLE = 'Rename the Workspace'
export const RENAME_BODY = 'Only its name changes. Its projects, knowledge and shared repository stay as they are.'
export const RENAME_CONFIRM = 'Rename'

/** Trimmed input, or the sentence that keeps the dialog open. */
export function validateRename(name: string, current: string): { ok: true; name: string } | { ok: false; message: string } {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, message: BLANK_NAME }
  if (trimmed === current) return { ok: false, message: 'That is already its name.' }
  return { ok: true, name: trimmed }
}

export const DELETE_CONFIRM = 'Delete Workspace'
export const DELETE_KEEPS =
  'The shared copy online is not deleted, and the Workspace’s folder on this computer is kept as a backup.'

export interface DeleteConfirmView {
  title: string
  lines: string[]
  confirm: string
}

/** What the person reads before a Workspace is deleted: which projects move to Default, and what is kept. */
export function deleteConfirmView(workspace: WorkspaceListing, defaultName: string): DeleteConfirmView {
  const names = workspace.projects.map((project) => project.name)
  const moving =
    names.length === 0
      ? 'It has no projects.'
      : `${names.length === 1 ? 'Its project moves' : `Its ${names.length} projects move`} to ${defaultName}: ${names.join(', ')}.`
  return { title: `Delete ${workspace.name}?`, lines: [moving, DELETE_KEEPS], confirm: DELETE_CONFIRM }
}

export function deletedLine(name: string, defaultName: string): string {
  return `${name} was deleted. Its projects are in ${defaultName} now.`
}

export const MOVE_CONFIRM = 'Move'
export const MOVE_BODY = 'Its knowledge — discoveries, plans and the brain — moves with it.'
export const NOWHERE_TO_MOVE = 'There is no other Workspace to move it to. Create one first.'

export function moveTitle(projectName: string): string {
  return `Move ${projectName} to…`
}

export function movedLine(projectName: string, workspaceName: string): string {
  return `${projectName} is now in ${workspaceName}.`
}

// ── A pending project: "Move it in" ─────────────────────────────────────────

/** A pending project's card dispatches this (mirrored from main's `workspace-placement.ts`; a test pins the two). */
export const WORKSPACE_MOVE_IN_EVENT = 'flow:workspace-move-in'
export const MOVE_IN_TITLE = 'Move it into its Workspace?'
export const MOVE_IN_CONFIRM = 'Move it in'
export const MOVE_IN_NOTHING = 'This project is already in a Workspace.'

// ── Adding a project when there are several Workspaces ──────────────────────

export const ADD_TO_WORKSPACE_TITLE = 'Add the project to which Workspace?'
export const ADD_TO_WORKSPACE_BODY = 'Every project lives in a Workspace. You can move it later.'
export const ADD_TO_WORKSPACE_CONFIRM = 'Choose a folder…'
export const WORKSPACE_LABEL = 'Workspace'

// ── Adding a project (link) ─────────────────────────────────────────────────

/**
 * The one sentence before the one code-repo commit a committed knowledge
 * folder takes — with the commit message the CLI will write, when it said, so
 * the person agrees to the commit that actually lands in their history.
 */
export function commitConfirmText(files: number, message: string | null = null): string {
  const count = files === 1 ? '1 file' : `${files} files`
  const base = `Flow will rename the knowledge folder in one commit of ${count}; review before continuing. Nothing is deleted — the old knowledge stays in the project under its new name.`
  return message === null ? base : `${base} The commit will say: “${message}”`
}

/** The commit message the committed-folder refusal says the rename commit will carry, or null. */
export function commitMessageOf(payload: Record<string, unknown>): string | null {
  const commit = payload['commit']
  if (typeof commit !== 'object' || commit === null) return null
  const message = (commit as Record<string, unknown>)['message']
  if (typeof message !== 'string') return null
  // eslint-disable-next-line no-control-regex -- control characters never reach a screen
  const line = message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return line === '' ? null : line.slice(0, 200)
}
export const COMMIT_CONFIRM_TITLE = 'Rename the knowledge folder?'
export const COMMIT_CONFIRM_LABEL = 'Rename and add'
export const COMMIT_UNKNOWN_COUNT =
  'Flow will rename the knowledge folder in one commit; review before continuing. Nothing is deleted — the old knowledge stays in the project under its new name.'

// The refusals the settings word themselves — read from the ONE table main uses.
export const KEEPS_OWN_REFUSAL = workspaceRefusalDetail('keeps-own-knowledge-repo')
export const DIRTY_CODE_REFUSAL = workspaceRefusalDetail('dirty-code')
export const LINKED_ELSEWHERE_REFUSAL = workspaceRefusalDetail('linked-elsewhere')

export type LinkStep =
  | { kind: 'done'; text: string }
  | { kind: 'confirm-commit'; text: string }
  | { kind: 'refused'; text: string }

/** How many files the committed-folder refusal says the rename commit holds, or null. */
export function commitFilesOf(payload: Record<string, unknown>): number | null {
  const commit = payload['commit']
  if (typeof commit !== 'object' || commit === null) return null
  const files = (commit as Record<string, unknown>)['files']
  return typeof files === 'number' && Number.isFinite(files) && files >= 0 ? files : null
}

function previousKept(result: WorkspaceLinkResult): boolean {
  return result.previous.kind === 'folder' || result.previous.kind === 'committed-folder'
}

/** What a link answer means for the person who pressed Add. */
export function linkOutcome(answer: WorkspaceAnswer<WorkspaceLinkResult>, projectName: string): LinkStep {
  if (answer.ok) {
    const base = `${projectName} is now part of ${answer.workspace.name}.`
    return {
      kind: 'done',
      text: previousKept(answer) ? `${base} Its knowledge came along; the old copy is kept as a backup.` : base,
    }
  }
  return refusalStep(answer, projectName)
}

/** Uncommitted knowledge files in a project, named — no paths. */
export function dirtyKnowledgeLine(projectName: string): string {
  return `Some knowledge files in ${projectName} have changes that aren't committed yet. Commit them first, then move it in.`
}

export function refusalStep(refusal: WorkspaceRefusal, projectName: string | null = null): LinkStep {
  switch (refusal.reason) {
    case 'committed-flow': {
      const files = commitFilesOf(refusal.payload)
      const message = commitMessageOf(refusal.payload)
      if (files === null) {
        return { kind: 'confirm-commit', text: message === null ? COMMIT_UNKNOWN_COUNT : `${COMMIT_UNKNOWN_COUNT} The commit will say: “${message}”` }
      }
      return { kind: 'confirm-commit', text: commitConfirmText(files, message) }
    }
    case 'keeps-own-knowledge-repo':
      return { kind: 'refused', text: KEEPS_OWN_REFUSAL }
    case 'dirty-code':
      return { kind: 'refused', text: projectName === null ? DIRTY_CODE_REFUSAL : dirtyKnowledgeLine(projectName) }
    case 'linked-elsewhere':
      return { kind: 'refused', text: LINKED_ELSEWHERE_REFUSAL }
    default:
      return { kind: 'refused', text: refusal.detail }
  }
}

// ── When the section re-reads ───────────────────────────────────────────────

/**
 * What the Workspaces settings do with a `workspaces:changed`. Re-reading
 * spawns the CLI (a list, then a sync status per Workspace), so: never for a
 * change it draws nothing of (the selection, a card's extra projects); never
 * while it is off screen — it marks itself stale and re-reads when next shown.
 */
export function settingsChangeAction(input: {
  cause: WorkspacesChangeCause
  onScreen: boolean
}): 'reload' | 'mark-stale' | 'ignore' {
  if (input.cause === 'current' || input.cause === 'task-projects') return 'ignore'
  return input.onScreen ? 'reload' : 'mark-stale'
}

// ── New Workspace ───────────────────────────────────────────────────────────

export const CREATE_TITLE = 'Create a Workspace'
export const CREATE_BODY = 'Give it the name your team knows it by. A shared repository can be added now or later.'
export const NAME_LABEL = 'Name'
export const NAME_PLACEHOLDER = 'Acme'
export const REMOTE_LABEL = 'Shared repository address (optional)'
export const REMOTE_HELP =
  'An empty repository on any git host your team uses. Flow only records it now; nothing is sent until the first sync.'
export const CREATE_CONFIRM = 'Create Workspace'
export const BLANK_NAME = 'Give the Workspace a name.'
export const FRESH_NOTE =
  'A project’s knowledge moves with it: when a project moves into this Workspace, its discoveries, plans and brain come along, and the old copy is kept as a backup.'
export const ADD_OPEN_TITLE = 'Move projects into it?'
export const ADD_OPEN_BODY = 'Choose the projects that belong to this Workspace. You can move more later.'
export const ADD_SELECTED_LABEL = 'Move selected'
export const SKIP_LABEL = 'Not now'
export const DONE_LABEL = 'Done'
export const NO_OPEN_TO_ADD = 'There is no project to move yet. You can move projects into it later.'

export function createdLine(name: string): string {
  return `${name} is ready.`
}

/** Trimmed input, or the sentence that keeps the dialog open. */
export function validateCreate(name: string, remote: string): { ok: true; name: string; remote: string | null } | { ok: false; message: string } {
  const trimmedName = name.trim()
  if (trimmedName === '') return { ok: false, message: BLANK_NAME }
  const trimmedRemote = remote.trim()
  return { ok: true, name: trimmedName, remote: trimmedRemote === '' ? null : trimmedRemote }
}

// ── Join a Workspace ────────────────────────────────────────────────────────

export const JOIN_TITLE = 'Join a Workspace'
export const JOIN_BODY =
  'Paste the address of your team’s Workspace repository. Flow then shows which of your open projects it lists, and you choose which to add.'
export const ADDRESS_LABEL = 'Workspace address'
export const ADDRESS_PLACEHOLDER = 'The repository address your team shared'
export const JOIN_CONFIRM = 'Join'
export const JOINING_LABEL = 'Joining…'
export const BLANK_ADDRESS = 'Paste the Workspace’s address.'
export const NEEDS_REVIEW_LABEL = 'Review'
/** Above the open projects a join PROPOSES — none is added until the person says so. */
export const JOIN_CANDIDATES_LINE =
  'These open projects look like ones this Workspace lists. Tick the ones that belong to it — nothing is added until you do.'
export const ADD_CANDIDATES_LABEL = 'Add these projects'

function names(projects: readonly { name: string }[]): string {
  return projects.map((project) => project.name).join(', ')
}

export interface JoinOutcomeView {
  headline: string
  lines: string[]
  /** Projects whose checkout needs a person first — each may be reviewed here. */
  needsReview: Array<{ name: string; root: string | null; text: string; canConfirm: boolean }>
  /**
   * Open projects that look like the Workspace's (by remote — which a
   * Workspace file can name for any repository). UNTICKED: only the ones the
   * person ticks are added, on "Add these projects".
   */
  candidates: Array<{ root: string; name: string; projectId: string; checked: false }>
}

export function joinOutcome(result: WorkspaceJoinResult): JoinOutcomeView {
  const lines: string[] = []
  const candidates = result.openCandidates.map((candidate) => ({
    root: candidate.root,
    name: candidate.project.name,
    projectId: candidate.project.id,
    checked: false as const,
  }))
  const proposed = new Set(candidates.map((candidate) => candidate.projectId))
  if (result.linked.length > 0) lines.push(`Linked on this computer: ${names(result.linked)}.`)
  else if (candidates.length === 0) lines.push('No project was added yet — none of its projects are open in Flow on this computer.')
  if (candidates.length > 0) lines.push(JOIN_CANDIDATES_LINE)
  const elsewhere = result.noLocalCheckout.filter((project) => !proposed.has(project.id))
  if (elsewhere.length > 0) {
    lines.push(`Not on this computer: ${names(elsewhere)}. When you open one in Flow, Flow asks whether to add it.`)
  }
  const needsReview = result.needsReview.map((project) => {
    const step = refusalStep({
      ok: false,
      reason: refusalReasonOf(project.refusal),
      detail: ACTION_FAILED_LINE,
      payload: project.refusal,
    })
    return {
      name: project.name,
      root: project.localPath,
      text: step.text,
      canConfirm: step.kind === 'confirm-commit' && project.localPath !== null,
    }
  })
  if (needsReview.length > 0) lines.push(`Needs you first: ${names(result.needsReview)}.`)
  return { headline: `Joined ${result.workspace.name}.`, lines, needsReview, candidates }
}

function refusalReasonOf(payload: Record<string, unknown>): WorkspaceRefusal['reason'] {
  const refused = payload['refused']
  if (refused === 'committed-flow' || refused === 'keeps-own-knowledge-repo' || refused === 'dirty-code' || refused === 'linked-elsewhere') {
    return refused
  }
  if (commitFilesOf(payload) !== null) return 'committed-flow'
  return 'failed'
}

// ── The join suggestion (FR-3) ──────────────────────────────────────────────

export const SUGGESTION_ADD = 'Add it'
export const SUGGESTION_NOT_NOW = 'Not now'

export function suggestionText(suggestion: WorkspaceSuggestion): string | null {
  if (suggestion.kind !== 'link') return null
  return `This project, ${suggestion.project.name}, belongs to the ${suggestion.workspace.name} Workspace. Add it?`
}

/** The key a dismissed suggestion is remembered under — the same Workspace never asks twice. */
export function suggestionKey(rootPath: string, suggestion: WorkspaceSuggestion): string | null {
  if (suggestion.kind !== 'link') return null
  return `${suggestion.workspace.slug}\u0000${suggestion.project.id}\u0000${rootPath}`
}

export const DISMISSED_SUGGESTIONS_KEY = 'flow.workspaces.dismissedSuggestions'

export function parseDismissed(raw: string | null): Set<string> {
  if (raw === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

/** The roots that just appeared — the projects opened since the last look. */
export function newlyOpened(previous: ReadonlySet<string>, current: readonly string[]): string[] {
  return current.filter((root) => !previous.has(root))
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export const ONBOARDING_TITLE = 'Your Workspace'
export const ONBOARDING_QUESTION =
  'Your projects live in a Workspace, which keeps their knowledge, threads and board together — and can be shared with your team.'
export const ONBOARDING_SETTING_UP = 'Flow is setting up your Workspace…'
export const ONBOARDING_RENAME = 'Rename it'
export const ONBOARDING_RENAME_CONFIRM = 'Save name'
export const ONBOARDING_JOIN = 'Join your team’s Workspace instead'
export const ONBOARDING_UNAVAILABLE = 'Workspaces are not available in this build of Flow.'
export const ONBOARDING_LATER = 'You can rename it, create more and move projects between them any time in Settings.'

/** "Your projects are in Default." — the Workspace the person is in. */
export function onboardingWorkspaceLine(name: string): string {
  return `Your projects are in ${name}.`
}

export function onboardingDoneLine(name: string): string {
  return `You are working in ${name}. You can manage it any time in Settings.`
}

// ── For the scan: every fixed string this module can produce ───────────────

export const FIXED_STRINGS: readonly string[] = [
  WORKSPACES_GROUP_LABEL,
  WORKSPACES_SECTION_TITLE,
  WORKSPACES_DESCRIPTION,
  NEW_WORKSPACE_LABEL,
  JOIN_WORKSPACE_LABEL,
  NO_WORKSPACES_LINE,
  LIST_FAILED_LINE,
  UNREADABLE_LINE,
  SHARED_REPOSITORY_LABEL,
  NO_SHARED_REPOSITORY,
  SYNC_LABEL,
  SYNC_NOW_LABEL,
  SYNCING_LABEL,
  REVIEW_CHANGES_LABEL,
  NO_ACCESS_LINE,
  PROJECTS_LABEL,
  NO_PROJECTS_LINE,
  NOT_ON_THIS_COMPUTER,
  NOT_OPEN_IN_FLOW,
  PROJECT_SETTINGS_LABEL,
  SAME_PROJECT_LABEL,
  SAME_PROJECT_QUESTION,
  SAME_PROJECT_CONFIRM,
  NO_MAP_CANDIDATES,
  MOVE_HERE_LABEL,
  MOVE_HERE_CONFIRM,
  MOVE_HERE_CHOOSE,
  NO_MOVE_HERE_CANDIDATES,
  OPEN_PROJECT_HERE_LABEL,
  MOVE_TO_LABEL,
  RENAME_LABEL,
  DELETE_LABEL,
  DEFAULT_LINE,
  CANCEL_LABEL,
  WORKING_LABEL,
  ACTION_FAILED_LINE,
  COMMIT_CONFIRM_TITLE,
  COMMIT_CONFIRM_LABEL,
  COMMIT_UNKNOWN_COUNT,
  KEEPS_OWN_REFUSAL,
  DIRTY_CODE_REFUSAL,
  LINKED_ELSEWHERE_REFUSAL,
  RENAME_TITLE,
  RENAME_BODY,
  RENAME_CONFIRM,
  DELETE_CONFIRM,
  DELETE_KEEPS,
  MOVE_CONFIRM,
  MOVE_BODY,
  NOWHERE_TO_MOVE,
  MOVE_IN_TITLE,
  MOVE_IN_CONFIRM,
  MOVE_IN_NOTHING,
  ADD_TO_WORKSPACE_TITLE,
  ADD_TO_WORKSPACE_BODY,
  ADD_TO_WORKSPACE_CONFIRM,
  WORKSPACE_LABEL,
  CREATE_TITLE,
  CREATE_BODY,
  NAME_LABEL,
  NAME_PLACEHOLDER,
  REMOTE_LABEL,
  REMOTE_HELP,
  CREATE_CONFIRM,
  BLANK_NAME,
  FRESH_NOTE,
  ADD_OPEN_TITLE,
  ADD_OPEN_BODY,
  ADD_SELECTED_LABEL,
  SKIP_LABEL,
  DONE_LABEL,
  NO_OPEN_TO_ADD,
  JOIN_TITLE,
  JOIN_BODY,
  ADDRESS_LABEL,
  ADDRESS_PLACEHOLDER,
  JOIN_CONFIRM,
  JOINING_LABEL,
  BLANK_ADDRESS,
  NEEDS_REVIEW_LABEL,
  SUGGESTION_ADD,
  SUGGESTION_NOT_NOW,
  ONBOARDING_TITLE,
  ONBOARDING_QUESTION,
  ONBOARDING_SETTING_UP,
  ONBOARDING_RENAME,
  ONBOARDING_RENAME_CONFIRM,
  ONBOARDING_JOIN,
  ONBOARDING_UNAVAILABLE,
  ONBOARDING_LATER,
]
