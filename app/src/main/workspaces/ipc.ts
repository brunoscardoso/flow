// Workspaces IPC channels — the renderer's whole route to Workspaces.
//
// Every request is validated HERE, in main, and rebuilt field by field before
// it goes further (the knowledge channels' rule): a root must be one the
// renderer may address (a thread's checkout is answered as its project),
// strings must be strings, booleans booleans, and a field nobody reads is never
// passed on. Every answer is a value or a typed refusal from the registry,
// which already rebuilt the CLI's JSON into the shared contract's shapes.
//
// Workspaces are always on (decision 2026-10-06): there is no switch, and no
// channel answers "off".

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { ConnectionsLearningStatus, IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract'
import type {
  WorkspaceAnswer,
  WorkspaceLinkResult,
  WorkspacePlacementState,
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceMergeGroupKey,
  WorkspaceReviewAgreeRequest,
  WorkspaceReviewDecideRequest,
  WorkspaceReviewDisagreeRequest,
  WorkspaceReviewResult,
  WorkspacesChangedEvent,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import { timed } from '../ipc/slow-handler'
import type { WorkspaceRegistry } from './workspace-registry'
import type { WorkspaceRemoteSetup } from './workspace-remote'
import type { MergeReasons } from './merge-reasons'

export interface WorkspaceChannelDependencies {
  registry: WorkspaceRegistry
  /** A task card's extra projects (app settings rows — no schema change). */
  taskProjects: {
    get(taskId: string): string[]
    set(taskId: string, roots: readonly string[]): string[]
    /** Whether a person chose the task's projects (the remote ticket's picker). */
    chosen(taskId: string): boolean
  }
  /** REQUIRED: a card's projects are only written for a task that exists. */
  taskExists: (taskId: string) => boolean
  /**
   * REQUIRED (allowed-pattern #26): the PROJECT root for a path the renderer
   * may address — a registered root answers itself, a thread's checkout its
   * project — or null when the renderer may not address it at all.
   */
  resolveRoot: (rootPath: string) => string | null
  /**
   * REQUIRED (allowed-pattern #26): the projects open in the app. A join links
   * the ones the CLI found no checkout for — it only knows the checkouts its
   * own Flow folder recorded.
   */
  openRoots: () => string[]
  /** REQUIRED: only the app window's own top frame may drive Workspaces. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Announce a change the registry did not make itself (a card's projects). */
  broadcastChanged: (event: WorkspacesChangedEvent) => void
  /**
   * REQUIRED (allowed-pattern #26): the projects outside every Workspace —
   * the launch migration's leftovers and what a person confirms ("Move it in").
   */
  placement: {
    state(): WorkspacePlacementState
    moveIn(root: string): Promise<WorkspaceAnswer<WorkspaceLinkResult>>
    retry(root: string): Promise<void>
  }
  /**
   * REQUIRED (allowed-pattern #26): each Workspace's knowledge sync (the
   * engine over the CLI's `workspace sync`). It validates the slug.
   */
  sync: {
    status(slug: string): WorkspaceSyncStatus
    syncNow(slug: string): Promise<WorkspaceSyncStatus>
    resolve(request: WorkspaceResolveRequest): Promise<WorkspaceResolveResult>
    reviewAgree(request: WorkspaceReviewAgreeRequest): Promise<WorkspaceReviewResult>
    reviewDisagree(request: WorkspaceReviewDisagreeRequest): Promise<WorkspaceReviewResult>
    reviewDecide(request: WorkspaceReviewDecideRequest): Promise<WorkspaceReviewResult>
  }
  /**
   * REQUIRED (allowed-pattern #26): connecting a Workspace to a shared
   * repository — the signed-in host tools, then the CLI's `set-remote` /
   * `unset-remote`, then one sync.
   */
  remote: WorkspaceRemoteSetup
  /**
   * REQUIRED (allowed-pattern #26): the Workspace's shared merge reasons —
   * the CLI's `merge-decision list` / `remove`, run async.
   */
  mergeReasons: MergeReasons
  /**
   * REQUIRED (allowed-pattern #26): connections learning — a person's run of
   * a project's Workspace, and the run going now (or the last one).
   */
  connections: {
    learn(root: string): Promise<ConnectionsLearningStatus | null>
    status(root: string): Promise<ConnectionsLearningStatus | null>
  }
}

/** A refused request — the renderer sent something main will not act on. */
export class WorkspaceRequestError extends Error {
  constructor(channel: string, what: string) {
    super(`${channel}: ${what}`)
    this.name = 'WorkspaceRequestError'
  }
}

/** How many roots one membership question may name. */
/** The most cards one board read may ask about. */
const MAX_TASK_IDS_PER_REQUEST = 2_000
const MAX_ROOTS_PER_REQUEST = 500
/** How many extra projects one card may name (the store caps it too). */
const MAX_TASK_PROJECTS = 32
const MAX_FIELD_LENGTH = 2048
/** A merged text a person settled on — far beyond any note, well inside one IPC message. */
const MAX_RESOLVE_TEXT_LENGTH = 1024 * 1024
const RESOLVE_TAKES = ['ours', 'theirs', 'merged', 'text'] as const
const REVIEW_GROUPS: readonly WorkspaceMergeGroupKey[] = ['kept-both', 'took-theirs', 'kept-mine', 'merged', 'identical']
/** The most items one review request names (a review is bounded by the CLI's batch anyway). */
const MAX_REVIEW_IDS = 5000
/** A disagreement's reason is one short paragraph. */
const MAX_REASON_LENGTH = 2000

/** A Workspace slug that goes on a CLI argv: never empty, never shaped like a flag. */
const CLI_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** A recorded decision's id: hex (the CLI writes 16; a longer hash is still an id). */
const MERGE_REASON_ID = /^[0-9a-f]{8,64}$/

function cliSlug(value: unknown, channel: string): string {
  if (typeof value !== 'string' || !CLI_SLUG.test(value)) throw new WorkspaceRequestError(channel, 'slug must be a Workspace slug')
  return value
}

/** A list of item ids, each a plain string — nothing else is passed on. */
function idList(value: unknown, channel: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_IDS || !value.every((id) => typeof id === 'string' && id !== '' && id.length <= 128)) {
    throw new WorkspaceRequestError(channel, 'ids must be a list of item ids')
  }
  return [...value] as string[]
}

function record(request: unknown, channel: string): Record<string, unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new WorkspaceRequestError(channel, 'expected a request object')
  }
  return request as Record<string, unknown>
}

function requiredString(value: unknown, channel: string, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_FIELD_LENGTH) {
    throw new WorkspaceRequestError(channel, `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, channel: string, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, channel, field)
}

function optionalBoolean(value: unknown, channel: string, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new WorkspaceRequestError(channel, `${field} must be a boolean`)
  return value
}

/** Register the Workspaces invoke handlers. Returns a dispose function (mirrors the other registrars). */
export function registerWorkspaceChannels(deps: WorkspaceChannelDependencies): () => void {
  const { registry, isTrustedSender } = deps
  const registered: IpcInvokeChannel[] = []

  function rootOf(raw: unknown, channel: string, field = 'rootPath'): string {
    const path = requiredString(raw, channel, field)
    const root = deps.resolveRoot(path)
    if (root === null) throw new WorkspaceRequestError(channel, `unknown ${field}`)
    return root
  }

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: unknown) => Promise<IpcResponse<C>> | IpcResponse<C>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (event, request: IpcRequest<C>) =>
      timed(channel, async (req: unknown) => {
        let trusted = false
        try {
          trusted = isTrustedSender(event)
        } catch {
          trusted = false
        }
        if (!trusted) {
          console.warn('[Workspaces] refused a call from outside the app window', { channel })
          throw new WorkspaceRequestError(channel, 'not available here')
        }
        return handler(req ?? {})
      })(request),
    )
  }

  handle('workspaces:list', () => registry.list())

  handle('workspaces:status', (request) => {
    const channel = 'workspaces:status'
    return registry.statusFor(rootOf(record(request, channel)['rootPath'], channel))
  })

  handle('workspaces:membership', async (request) => {
    const channel = 'workspaces:membership'
    const roots = record(request, channel)['roots']
    if (!Array.isArray(roots) || roots.length > MAX_ROOTS_PER_REQUEST) {
      throw new WorkspaceRequestError(channel, `roots must be a list of at most ${MAX_ROOTS_PER_REQUEST}`)
    }
    // Each root is answered under the path the renderer asked with, so it can
    // match its rows; membership is decided on the project root behind it.
    const asked = roots.map((root) => requiredString(root, channel, 'roots[]'))
    const resolved = asked.map((root) => deps.resolveRoot(root))
    const known = resolved.filter((root): root is string => root !== null)
    const answer = await registry.membershipOf(known)
    if (!answer.ok) return answer
    const byRoot = new Map(answer.roots.map((entry) => [entry.root, entry]))
    return {
      ok: true,
      roots: asked.map((root, index) => {
        const projectRoot = resolved[index]
        const entry = projectRoot === null ? undefined : byRoot.get(projectRoot)
        return {
          root,
          workspace: entry?.workspace ?? null,
          project: entry?.project ?? null,
          linked: entry?.linked ?? false,
        }
      }),
    }
  })

  handle('workspaces:create', (request) => {
    const channel = 'workspaces:create'
    const body = record(request, channel)
    const name = requiredString(body['name'], channel, 'name')
    const remote = optionalString(body['remote'], channel, 'remote')
    return registry.create(name, remote)
  })

  handle('workspaces:link', (request) => {
    const channel = 'workspaces:link'
    const body = record(request, channel)
    const repoPath = rootOf(body['rootPath'], channel)
    const workspace = requiredString(body['workspace'], channel, 'workspace')
    const projectId = optionalString(body['projectId'], channel, 'projectId')
    const confirmCommit = optionalBoolean(body['confirmCommit'], channel, 'confirmCommit')
    return registry.link({
      repoPath,
      workspace,
      ...(projectId === undefined ? {} : { projectId }),
      ...(confirmCommit === true ? { confirmCommit: true } : {}),
    })
  })

  handle('workspaces:join', async (request) => {
    const channel = 'workspaces:join'
    const body = record(request, channel)
    const remote = requiredString(body['remote'], channel, 'remote')
    const name = optionalString(body['name'], channel, 'name')
    const branch = optionalString(body['branch'], channel, 'branch')
    const started = Date.now()
    console.log('[Workspaces] join started')
    const answer = await registry.join(remote, name, { openRoots: deps.openRoots(), ...(branch === undefined ? {} : { branch }) })
    console.log('[Workspaces] join finished', {
      ms: Date.now() - started,
      ok: answer.ok,
      ...(answer.ok
        ? { slug: answer.workspace.slug, disconnected: (answer.disconnected ?? []).map((entry) => entry.slug) }
        : { reason: answer.reason }),
    })
    // A Workspace the join disconnected still shows its last sync — an
    // "unrelated history" error that is no longer true. One sync, the same
    // as a hand disconnect runs, turns it into "kept on this computer".
    if (answer.ok) {
      for (const entry of answer.disconnected ?? []) void deps.sync.syncNow(entry.slug).catch(() => undefined)
    }
    return answer
  })

  handle('workspaces:current', () => registry.current())

  handle('workspaces:setCurrent', (request) => {
    const channel = 'workspaces:setCurrent'
    const slug = record(request, channel)['slug']
    if (slug !== null && (typeof slug !== 'string' || slug === '' || slug.length > MAX_FIELD_LENGTH)) {
      throw new WorkspaceRequestError(channel, 'slug must be a non-empty string or null')
    }
    return registry.setCurrent(slug)
  })

  handle('workspaces:suggest', (request) => {
    const channel = 'workspaces:suggest'
    return registry.suggestJoin(rootOf(record(request, channel)['rootPath'], channel))
  })

  handle('workspaces:rename', (request) => {
    const channel = 'workspaces:rename'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const name = requiredString(body['name'], channel, 'name')
    return registry.rename(slug, name)
  })

  handle('workspaces:moveProject', (request) => {
    const channel = 'workspaces:moveProject'
    const body = record(request, channel)
    const project = requiredString(body['project'], channel, 'project')
    const to = requiredString(body['to'], channel, 'to')
    const from = optionalString(body['from'], channel, 'from')
    return registry.moveProject({ project, to, ...(from === undefined ? {} : { from }) })
  })

  handle('workspaces:delete', async (request) => {
    const channel = 'workspaces:delete'
    const slug = requiredString(record(request, channel)['slug'], channel, 'slug')
    const answer = await registry.deleteWorkspace(slug)
    // The selection may have named the Workspace that just went: `current`
    // falls back to Default, and the scope follows the broadcast.
    if (answer.ok) deps.broadcastChanged({ cause: 'current' })
    return answer
  })

  handle('workspaces:removeProject', (request) => {
    const channel = 'workspaces:removeProject'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const project = requiredString(body['project'], channel, 'project')
    return registry.removeProject({ slug, project })
  })

  handle('workspaces:placement', () => deps.placement.state())

  handle('workspaces:moveIn', (request) => {
    const channel = 'workspaces:moveIn'
    return deps.placement.moveIn(rootOf(record(request, channel)['rootPath'], channel))
  })

  handle('workspaces:retryPlacement', async (request) => {
    const channel = 'workspaces:retryPlacement'
    await deps.placement.retry(rootOf(record(request, channel)['rootPath'], channel))
    return deps.placement.state()
  })

  handle('workspaces:taskProjects', (request) => {
    const channel = 'workspaces:taskProjects'
    const taskId = requiredString(record(request, channel)['taskId'], channel, 'taskId')
    return { ok: true, roots: deps.taskProjects.get(taskId) }
  })

  handle('workspaces:taskProjectsMany', (request) => {
    const channel = 'workspaces:taskProjectsMany'
    const taskIds = record(request, channel)['taskIds']
    if (!Array.isArray(taskIds) || taskIds.length > MAX_TASK_IDS_PER_REQUEST) {
      throw new WorkspaceRequestError(channel, `taskIds must be a list of at most ${MAX_TASK_IDS_PER_REQUEST}`)
    }
    const ids = taskIds.map((id) => requiredString(id, channel, 'taskIds[]'))
    const projects: Record<string, string[]> = {}
    for (const id of ids) projects[id] = deps.taskProjects.get(id)
    return { ok: true, projects, chosen: ids.filter((id) => deps.taskProjects.chosen(id)) }
  })

  handle('workspaces:setTaskProjects', (request) => {
    const channel = 'workspaces:setTaskProjects'
    const body = record(request, channel)
    const taskId = requiredString(body['taskId'], channel, 'taskId')
    const roots = body['roots']
    if (!Array.isArray(roots) || roots.length > MAX_TASK_PROJECTS) {
      throw new WorkspaceRequestError(channel, `roots must be a list of at most ${MAX_TASK_PROJECTS}`)
    }
    // Stored as the PROJECT roots behind what was asked — a thread checkout is its project.
    const projects = roots.map((root) => rootOf(root, channel, 'roots[]'))
    if (!deps.taskExists(taskId)) throw new WorkspaceRequestError(channel, 'unknown task')
    const stored = deps.taskProjects.set(taskId, projects)
    deps.broadcastChanged({ cause: 'task-projects' })
    return { ok: true, roots: stored }
  })

  // ── Workspace sync ──

  handle('workspaces:syncStatus', (request) => {
    const channel = 'workspaces:syncStatus'
    return deps.sync.status(requiredString(record(request, channel)['slug'], channel, 'slug'))
  })

  handle('workspaces:syncNow', (request) => {
    const channel = 'workspaces:syncNow'
    return deps.sync.syncNow(requiredString(record(request, channel)['slug'], channel, 'slug'))
  })

  handle('workspaces:resolve', (request) => {
    const channel = 'workspaces:resolve'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const path = requiredString(body['path'], channel, 'path')
    const id = optionalString(body['id'], channel, 'id')
    const take = body['take']
    if (typeof take !== 'string' || !(RESOLVE_TAKES as readonly string[]).includes(take)) {
      throw new WorkspaceRequestError(channel, 'take must be ours, theirs, merged or text')
    }
    if (take === 'text') {
      const text = body['text']
      if (typeof text !== 'string' || text.length > MAX_RESOLVE_TEXT_LENGTH) {
        throw new WorkspaceRequestError(channel, 'text must be a string of at most 1 MB')
      }
      return deps.sync.resolve({ slug, ...(id === undefined ? {} : { id }), path, take: 'text', text })
    }
    // Rebuilt field by field: a `file:` take or any other field is never passed on.
    return deps.sync.resolve({ slug, ...(id === undefined ? {} : { id }), path, take: take as 'ours' | 'theirs' | 'merged' })
  })

  // ── The review of an agent-decided merge — rebuilt field by field ──

  handle('workspaces:reviewAgree', (request) => {
    const channel = 'workspaces:reviewAgree'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const group = body['group']
    if (group !== undefined && !(REVIEW_GROUPS as readonly unknown[]).includes(group)) {
      throw new WorkspaceRequestError(channel, 'group must be one of the review groups')
    }
    const ids = body['ids'] === undefined ? undefined : idList(body['ids'], channel)
    const allGroups = body['allGroups']
    if (allGroups !== undefined && allGroups !== true) throw new WorkspaceRequestError(channel, 'allGroups must be true when given')
    const named = [ids, group, allGroups].filter((value) => value !== undefined).length
    if (named !== 1) throw new WorkspaceRequestError(channel, 'name exactly one of ids, a group or allGroups')
    return deps.sync.reviewAgree({
      slug,
      ...(ids === undefined ? {} : { ids }),
      ...(group === undefined ? {} : { group: group as WorkspaceMergeGroupKey }),
      ...(allGroups === true ? { allGroups: true as const } : {}),
    })
  })

  handle('workspaces:reviewDisagree', (request) => {
    const channel = 'workspaces:reviewDisagree'
    const body = record(request, channel)
    const reason = body['reason']
    if (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH) {
      throw new WorkspaceRequestError(channel, 'reason must be a string of at most 2000 characters')
    }
    // An empty reason is the engine's to refuse, with a sentence for the person.
    return deps.sync.reviewDisagree({ slug: requiredString(body['slug'], channel, 'slug'), ids: idList(body['ids'], channel), reason })
  })

  handle('workspaces:reviewDecide', (request) => {
    const channel = 'workspaces:reviewDecide'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const id = requiredString(body['id'], channel, 'id')
    const take = body['take']
    if (take === 'ours' || take === 'theirs') return deps.sync.reviewDecide({ slug, id, take })
    if (take !== 'text') throw new WorkspaceRequestError(channel, 'take must be ours, theirs or text')
    const text = body['text']
    if (typeof text !== 'string' || text.length > MAX_RESOLVE_TEXT_LENGTH) {
      throw new WorkspaceRequestError(channel, 'text must be a string of at most 1 MB')
    }
    return deps.sync.reviewDecide({ slug, id, take: 'text', text })
  })

  // ── The shared merge reasons — a slug and an id, nothing else passed on ──

  handle('workspaces:mergeReasons', (request) => {
    const channel = 'workspaces:mergeReasons'
    return deps.mergeReasons.list(cliSlug(record(request, channel)['slug'], channel))
  })

  handle('workspaces:removeMergeReason', (request) => {
    const channel = 'workspaces:removeMergeReason'
    const body = record(request, channel)
    const slug = cliSlug(body['slug'], channel)
    const id = body['id']
    if (typeof id !== 'string' || !MERGE_REASON_ID.test(id)) throw new WorkspaceRequestError(channel, 'id must be a recorded decision id')
    return deps.mergeReasons.remove(slug, id)
  })

  // ── Connecting a Workspace to a shared repository ──

  handle('workspaces:hostTools', () => deps.remote.hostTools())

  // ── Connections learning ──

  handle('workspaces:learnConnections', (request) => {
    const channel = 'workspaces:learnConnections'
    return deps.connections.learn(rootOf(record(request, channel)['rootId'], channel, 'rootId'))
  })

  handle('workspaces:connectionsLearningStatus', (request) => {
    const channel = 'workspaces:connectionsLearningStatus'
    return deps.connections.status(rootOf(record(request, channel)['rootId'], channel, 'rootId'))
  })

  handle('workspaces:createRemote', (request) => {
    const channel = 'workspaces:createRemote'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const name = requiredString(body['name'], channel, 'name')
    const replace = optionalBoolean(body['replace'], channel, 'replace') === true
    const branch = optionalString(body['branch'], channel, 'branch')
    const extra = { ...(replace ? { replace } : {}), ...(branch === undefined ? {} : { branch }) }
    const provider = body['provider']
    // Rebuilt field by field: nothing the renderer adds is passed on.
    if (provider === 'github') {
      const owner = requiredString(body['owner'], channel, 'owner')
      return deps.remote.createRemote({ slug, provider, owner, name, ...extra })
    }
    if (provider === 'azure') {
      const organization = requiredString(body['organization'], channel, 'organization')
      const project = requiredString(body['project'], channel, 'project')
      return deps.remote.createRemote({ slug, provider, organization, project, name, ...extra })
    }
    throw new WorkspaceRequestError(channel, 'provider must be github or azure')
  })

  handle('workspaces:setRemote', (request) => {
    const channel = 'workspaces:setRemote'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const remote = requiredString(body['remote'], channel, 'remote')
    const replace = optionalBoolean(body['replace'], channel, 'replace') === true
    const branch = optionalString(body['branch'], channel, 'branch')
    return deps.remote.setRemote({ slug, remote, ...(replace ? { replace } : {}), ...(branch === undefined ? {} : { branch }) })
  })

  handle('workspaces:branches', (request) => {
    const channel = 'workspaces:branches'
    const body = record(request, channel)
    const slug = requiredString(body['slug'], channel, 'slug')
    const remote = optionalString(body['remote'], channel, 'remote')
    return deps.remote.branches({ slug, ...(remote === undefined ? {} : { remote }) })
  })

  handle('workspaces:setBranch', (request) => {
    const channel = 'workspaces:setBranch'
    const body = record(request, channel)
    return deps.remote.setBranch({ slug: requiredString(body['slug'], channel, 'slug'), branch: requiredString(body['branch'], channel, 'branch') })
  })

  handle('workspaces:unsetRemote', (request) => {
    const channel = 'workspaces:unsetRemote'
    return deps.remote.unsetRemote(requiredString(record(request, channel)['slug'], channel, 'slug'))
  })

  return function disposeWorkspaceChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
  }
}
