/**
 * CONNECTING A WORKSPACE TO A SHARED REPOSITORY — every word the Connect /
 * Change / Disconnect dialogs and the onboarding "Share with your team" say,
 * and every decision about what they offer. DOM-free, so it unit-tests under
 * the app's node jest and the forbidden-pattern #12 scan in its test sees
 * every sentence.
 *
 * WHAT IS DATA AND WHAT IS COPY. The Workspace's name, an owner's or an
 * organization's name, the repository name, and the repository address a
 * person typed (or a host answered for one just created) are data — shown as
 * they are. Everything around them is copy, and copy never names a command, a
 * path, a setting key or an internal word.
 *
 * WHAT IS OFFERED. Creating one only on a host whose own tool is signed in on
 * this computer (GitHub, Azure DevOps) — always private; Flow holds no
 * credential. Using an existing repository on ANY git host, by its address,
 * always. The address is checked here with the same grammar main and the CLI
 * use, so a person reads the problem before anything is sent.
 */
import { gitRemoteRefusalDetail, parseGitRemote } from '../../shared/git-remote'
import type { WorkspaceHostTools, WorkspaceRemoteResult, WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import { syncLine } from './workspace-settings-model'

// ── On the Workspace card ───────────────────────────────────────────────────

export const CONNECT_REMOTE_LABEL = 'Connect a shared repository…'
export const CHANGE_REMOTE_LABEL = 'Change…'
export const DISCONNECT_REMOTE_LABEL = 'Disconnect…'

// ── The Connect / Change dialog ─────────────────────────────────────────────

export function connectTitle(workspaceName: string): string {
  return `Share ${workspaceName} with your team`
}

export function changeTitle(workspaceName: string): string {
  return `Change where ${workspaceName} is shared`
}

export const CONNECT_BODY =
  'The Workspace’s knowledge syncs through one private repository your team can reach. Flow uses this computer’s own sign-in to your git host — it never asks for a password.'
export const CHANGE_BODY =
  'The repository it uses now is left exactly as it is. From now on the Workspace syncs through the new one.'

export type ConnectChoice = 'github' | 'azure' | 'existing'

export const CHOICE_LEGEND = 'Where should it live?'
export const CHOICE_LABELS: Record<ConnectChoice, string> = {
  github: 'Create one on GitHub',
  azure: 'Create one on Azure DevOps',
  existing: 'Use an existing repository',
}
export const CHECKING_HOSTS = 'Checking where you can create one…'
export const NO_HOSTS_LINE =
  'To create one from here, sign in to the GitHub or Azure DevOps command-line tool on this computer. A repository you already have works too.'

export const OWNER_LABEL = 'Owner'
export const ORGANIZATION_LABEL = 'Organization'
export const AZURE_PROJECT_LABEL = 'Project'
export const REPOSITORY_NAME_LABEL = 'Repository name'
export const PRIVATE_NOTE = 'Flow creates it as a private repository. Only the people you invite can see it.'
export const ADDRESS_FIELD_LABEL = 'Repository address'
export const ADDRESS_FIELD_PLACEHOLDER = 'The address you would clone it with'
export const ADDRESS_FIELD_HELP =
  'Any git host your team uses — an empty repository, or one that already holds this Workspace.'

export const CREATE_AND_CONNECT_LABEL = 'Create and connect'
export const CONNECT_LABEL = 'Connect'
export const CREATING_REMOTE_LABEL = 'Creating the repository…'
export const CONNECTING_REMOTE_LABEL = 'Connecting and syncing…'

export const BLANK_REPOSITORY_ADDRESS = 'Paste the repository’s address.'
export const BLANK_REPOSITORY_NAME = 'Give the repository a name.'
export const INVALID_REPOSITORY_NAME =
  'That name won’t work. Use letters, numbers, dots, dashes and underscores, starting with a letter or number.'
export const CHOOSE_OWNER = 'Choose who owns the new repository.'
export const CHOOSE_AZURE_PROJECT = 'Choose the Azure DevOps project it goes in.'
export const CONNECT_FAILED_LINE = 'That did not work. Nothing was changed; try again in a moment.'

/** Which ways in this computer offers — a host only when its tool is signed in and has somewhere to put it. */
export function connectChoices(tools: WorkspaceHostTools | null): ConnectChoice[] {
  const choices: ConnectChoice[] = []
  if (tools?.github.available === true && tools.github.owners.length > 0) choices.push('github')
  if (tools?.azure.available === true && tools.azure.organizations.some((organization) => organization.projects.length > 0)) {
    choices.push('azure')
  }
  choices.push('existing')
  return choices
}

/** Whether the "sign in to create one" line belongs under the choices. */
export function showNoHostsLine(tools: WorkspaceHostTools | null): boolean {
  return tools !== null && connectChoices(tools).length === 1
}

export function primaryLabel(choice: ConnectChoice): string {
  return choice === 'existing' ? CONNECT_LABEL : CREATE_AND_CONNECT_LABEL
}

export function workingLabel(choice: ConnectChoice): string {
  return choice === 'existing' ? CONNECTING_REMOTE_LABEL : CREATING_REMOTE_LABEL
}

const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const MAX_SUGGESTED_BASE = 90

/** `acme` → `acme-knowledge`: the name a new repository is offered with. */
export function suggestedRepositoryName(workspaceSlug: string): string {
  const base = workspaceSlug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_SUGGESTED_BASE)
    .replace(/[-.]+$/, '')
  return `${base === '' ? 'workspace' : base}-knowledge`
}

export function validateRepositoryName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim()
  if (name === '') return { ok: false, message: BLANK_REPOSITORY_NAME }
  if (!REPOSITORY_NAME.test(name) || name.endsWith('.git') || name.endsWith('.')) return { ok: false, message: INVALID_REPOSITORY_NAME }
  return { ok: true, name }
}

/** The address as typed (trimmed), or the sentence that keeps the dialog open — the one grammar main and the CLI use. */
export function validateRepositoryAddress(raw: string): { ok: true; remote: string } | { ok: false; message: string } {
  const remote = raw.trim()
  if (remote === '') return { ok: false, message: BLANK_REPOSITORY_ADDRESS }
  const verdict = parseGitRemote(remote)
  if (!verdict.ok) return { ok: false, message: gitRemoteRefusalDetail(verdict.reason) }
  return { ok: true, remote }
}

/** The projects of one Azure DevOps organization, or none. */
export function azureProjectsOf(tools: WorkspaceHostTools | null, organization: string): string[] {
  return tools?.azure.organizations.find((entry) => entry.name === organization)?.projects ?? []
}

// ── What happened ───────────────────────────────────────────────────────────

export type RemoteOutcome =
  | { kind: 'done'; text: string; tone: 'ok' | 'warning' }
  | {
      kind: 'refused'
      text: string
      /** A free repository name to put in the name field. */
      suggestion?: string
      /** A repository that was created but not connected — its address goes in the address field. */
      created?: string
    }

/** "Acme is shared — synced just now." or, when the first sync could not finish, why. */
export function connectedLine(workspaceName: string, status: WorkspaceSyncStatus, now: number): { text: string; tone: 'ok' | 'warning' } {
  if (status.state === 'synced') return { text: `${workspaceName} is shared now. Its knowledge syncs through this repository.`, tone: 'ok' }
  const line = syncLine(status, now)
  return { text: `${workspaceName} is connected, but its first sync didn’t finish: ${line.text}`, tone: 'warning' }
}

export function remoteOutcome(result: WorkspaceRemoteResult, workspaceName: string, now: number): RemoteOutcome {
  if (result.ok) return { kind: 'done', ...connectedLine(workspaceName, result.status, now) }
  return {
    kind: 'refused',
    text: result.detail,
    ...(result.suggestion === undefined ? {} : { suggestion: result.suggestion }),
    ...(result.created === undefined ? {} : { created: result.created }),
  }
}

// ── Disconnect ──────────────────────────────────────────────────────────────

export function disconnectTitle(workspaceName: string): string {
  return `Disconnect ${workspaceName}?`
}

export const DISCONNECT_BODY =
  'Its knowledge stays on this computer, and the shared repository is left as it is — teammates keep their copies. You can connect again any time.'
export const DISCONNECT_CONFIRM = 'Disconnect'

export function disconnectedLine(workspaceName: string): string {
  return `${workspaceName} is no longer shared. Its knowledge stays on this computer.`
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export const ONBOARDING_SHARE = 'Share with your team…'
export const ONBOARDING_SHARE_OPTIONAL = 'Sharing is optional — Next skips it, and you can share a Workspace any time in Settings.'

export function onboardingSharedLine(workspaceName: string): string {
  return `${workspaceName} is shared with your team.`
}

// ── For the scan: every fixed string this module can produce ───────────────

export const FIXED_STRINGS: readonly string[] = [
  CONNECT_REMOTE_LABEL,
  CHANGE_REMOTE_LABEL,
  DISCONNECT_REMOTE_LABEL,
  CONNECT_BODY,
  CHANGE_BODY,
  CHOICE_LEGEND,
  ...Object.values(CHOICE_LABELS),
  CHECKING_HOSTS,
  NO_HOSTS_LINE,
  OWNER_LABEL,
  ORGANIZATION_LABEL,
  AZURE_PROJECT_LABEL,
  REPOSITORY_NAME_LABEL,
  PRIVATE_NOTE,
  ADDRESS_FIELD_LABEL,
  ADDRESS_FIELD_PLACEHOLDER,
  ADDRESS_FIELD_HELP,
  CREATE_AND_CONNECT_LABEL,
  CONNECT_LABEL,
  CREATING_REMOTE_LABEL,
  CONNECTING_REMOTE_LABEL,
  BLANK_REPOSITORY_ADDRESS,
  BLANK_REPOSITORY_NAME,
  INVALID_REPOSITORY_NAME,
  CHOOSE_OWNER,
  CHOOSE_AZURE_PROJECT,
  CONNECT_FAILED_LINE,
  DISCONNECT_BODY,
  DISCONNECT_CONFIRM,
  ONBOARDING_SHARE,
  ONBOARDING_SHARE_OPTIONAL,
]
