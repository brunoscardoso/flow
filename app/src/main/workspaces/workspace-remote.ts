/**
 * CONNECTING A WORKSPACE TO A SHARED REPOSITORY — the app's half.
 *
 * Three ways in, one way through:
 *
 *  · CREATE one on a host this computer's own tool is signed in to (the GitHub
 *    CLI, the Azure CLI with its DevOps extension — `host-tools.ts`). Always
 *    PRIVATE; Flow holds no hosting credential and asks for none.
 *  · USE AN EXISTING one on any git host, by its address (GitLab, Bitbucket,
 *    a server of the team's own — anything the shared grammar accepts).
 *  · DISCONNECT: everything stays on this computer; the repository is left
 *    exactly as it is.
 *
 * Every one of them ends in the CLI's `workspace set-remote` / `unset-remote`
 * through the registry (allowed-pattern #14: the CLI is the source of truth
 * for a Workspace's state — nothing here writes `origin` or `workspace.json`),
 * then ONE sync through the engine, whose status is the answer. That sync is
 * what publishes the Workspace; a repository that already holds this
 * Workspace's history merges, and one that holds an unrelated history is
 * refused by the CLI and shown as the sync's own sentence.
 *
 * Text rules (forbidden-pattern #12): every `detail` is a plain sentence. The
 * host tools' raw output stays in the log. The address a person typed, or the
 * one a host answered for a repository just created, is data and may be shown.
 */

import type {
  WorkspaceCreateRemoteRequest,
  WorkspaceHostTools,
  WorkspaceRemoteResult,
  WorkspaceSetRemoteRequest,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import type { HostTools } from './host-tools'
import type { WorkspaceRegistry } from './workspace-registry'

export interface WorkspaceRemoteDeps {
  /** REQUIRED (allowed-pattern #26): the only writer of a Workspace's shared repository is the CLI, behind this. */
  registry: Pick<WorkspaceRegistry, 'list' | 'setRemote' | 'unsetRemote'>
  /** REQUIRED: the signed-in host tools — injected; tests never run the real `gh` or `az`. */
  hostTools: Pick<HostTools, 'detect' | 'listCreateTargets' | 'createRepo' | 'forgetDetection'>
  /** REQUIRED: the sync that follows every change, and whose status is the answer. */
  sync: { syncNow(slug: string): Promise<WorkspaceSyncStatus> }
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export interface WorkspaceRemoteSetup {
  hostTools(): Promise<WorkspaceHostTools>
  createRemote(request: WorkspaceCreateRemoteRequest): Promise<WorkspaceRemoteResult>
  setRemote(request: WorkspaceSetRemoteRequest): Promise<WorkspaceRemoteResult>
  unsetRemote(slug: string): Promise<WorkspaceRemoteResult>
}

/** Sentences this module adds (may reach the UI). */
export const WORKSPACE_REMOTE_SENTENCES = {
  createdNotConnected: (detail: string): string =>
    `The repository was created, but the Workspace couldn't be connected to it: ${detail} You can connect to it by its address instead.`,
  alreadyShared: 'This Workspace already shares through another repository. Choose Change to replace it.',
} as const

function noTools(): WorkspaceHostTools {
  return { github: { available: false, owners: [] }, azure: { available: false, organizations: [] } }
}

export function createWorkspaceRemoteSetup(deps: WorkspaceRemoteDeps): WorkspaceRemoteSetup {
  const log = deps.log ?? ((): void => undefined)

  async function hostTools(): Promise<WorkspaceHostTools> {
    let detected
    try {
      detected = await deps.hostTools.detect()
    } catch (error) {
      log('detecting host tools failed', { error: String(error) })
      return noTools()
    }
    const answer = noTools()
    const [github, azure] = await Promise.all([
      detected.github.available ? deps.hostTools.listCreateTargets('github').catch(() => null) : Promise.resolve(null),
      detected.azure.available ? deps.hostTools.listCreateTargets('azure').catch(() => null) : Promise.resolve(null),
    ])
    if (detected.github.available) {
      // A signed-in tool whose owner list could not be read still offers the signed-in account.
      const owners =
        github !== null && github.ok && github.provider === 'github'
          ? github.owners.map((owner) => ({ login: owner.login, type: owner.type }))
          : detected.github.login === undefined
            ? []
            : [{ login: detected.github.login, type: 'user' as const }]
      answer.github = {
        available: owners.length > 0,
        ...(detected.github.login === undefined ? {} : { login: detected.github.login }),
        owners,
      }
    }
    if (detected.azure.available) {
      if (azure !== null && azure.ok && azure.provider === 'azure') {
        answer.azure = {
          available: azure.organizations.some((organization) => organization.projects.length > 0),
          organizations: azure.organizations.map((organization) => ({ name: organization.name, projects: [...organization.projects] })),
          ...(azure.detail === undefined ? {} : { detail: azure.detail }),
        }
      } else if (azure !== null && !azure.ok) {
        answer.azure = { available: false, organizations: [], detail: azure.detail }
      }
    }
    return answer
  }

  /** The registry's set-remote, then one sync — the answer is that sync's status. */
  async function connect(slug: string, remote: string, replace: boolean): Promise<WorkspaceRemoteResult> {
    const answer = await deps.registry.setRemote(slug, remote, replace ? { replace: true } : {})
    if (!answer.ok) return { ok: false, reason: answer.reason, detail: answer.detail }
    const status = await deps.sync.syncNow(slug)
    return { ok: true, remote: answer.workspace.remote, status }
  }

  async function sharesElsewhere(slug: string): Promise<boolean> {
    const listed = await deps.registry.list()
    if (!listed.ok) return false
    const workspace = listed.workspaces.find((entry) => entry.slug === slug)
    return workspace !== undefined && workspace.remote !== null
  }

  async function createRemote(request: WorkspaceCreateRemoteRequest): Promise<WorkspaceRemoteResult> {
    const replace = request.replace === true
    // Never make a repository a Workspace then refuses to use.
    if (!replace && (await sharesElsewhere(request.slug))) {
      return { ok: false, reason: 'remote-exists', detail: WORKSPACE_REMOTE_SENTENCES.alreadyShared }
    }
    const created = await deps.hostTools.createRepo(
      request.provider === 'github'
        ? { provider: 'github', owner: request.owner, name: request.name }
        : { provider: 'azure', organization: request.organization, project: request.project, name: request.name },
    )
    if (!created.ok) {
      return {
        ok: false,
        reason: created.reason,
        detail: created.detail,
        ...(created.suggestion === undefined ? {} : { suggestion: created.suggestion }),
      }
    }
    deps.hostTools.forgetDetection()
    const connected = await connect(request.slug, created.url, replace)
    if (connected.ok) return connected
    log('a repository was created but the Workspace could not be connected to it', { reason: connected.reason })
    return {
      ok: false,
      reason: connected.reason,
      detail: WORKSPACE_REMOTE_SENTENCES.createdNotConnected(connected.detail),
      created: created.url,
    }
  }

  function setRemote(request: WorkspaceSetRemoteRequest): Promise<WorkspaceRemoteResult> {
    return connect(request.slug, request.remote, request.replace === true)
  }

  async function unsetRemote(slug: string): Promise<WorkspaceRemoteResult> {
    const answer = await deps.registry.unsetRemote(slug)
    if (!answer.ok) return { ok: false, reason: answer.reason, detail: answer.detail }
    const status = await deps.sync.syncNow(slug)
    return { ok: true, remote: null, status }
  }

  return { hostTools, createRemote, setRemote, unsetRemote }
}
