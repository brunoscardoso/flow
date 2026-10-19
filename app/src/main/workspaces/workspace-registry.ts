/**
 * THE WORKSPACE REGISTRY — the app's one route to Workspaces, over the bundled
 * CLI's `workspace` verbs.
 *
 * THE CLI IS THE SOURCE OF TRUTH (allowed-pattern #14). Where a Workspace
 * lives, which project a repo is, what linking does to an existing `flow/`,
 * where the Flow folder is — all of it is `planflow-ai workspace
 * create|link|join|status`. This module never reads `workspace.json`, never
 * resolves a path, never re-implements a decision: it spawns the verb (async,
 * through the same runner every other CLI caller in main uses — never
 * synchronously, allowed-pattern #19), reads the LAST JSON line on stdout, and
 * rebuilds it field by field into the shared contract's shapes.
 *
 * NO SCHEMA CHANGE (deviation from the plan, 2026-10-06). The plan's
 * `workspace_groups` table and `workspace_id` columns would move the profile
 * past v35, which the installed Flow.app refuses — and the dev app and the
 * installed app share one profile. So membership is DERIVED, not stored:
 *
 *   · a project root's Workspace = the Workspace whose project has that root as
 *     this machine's checkout (one `workspace status` lists them all);
 *   · a thread's Workspace = its primary project root's;
 *   · a task's Workspace = its `project_root`'s.
 *
 * Board-per-Workspace and thread-list-per-Workspace are filters over existing
 * rows through `membershipOf`. The few facts only the app knows (the selected
 * Workspace, a card's extra projects) live in the app settings store — see
 * app-settings-store.ts.
 *
 * ALWAYS ON (decision 2026-10-06, workspaces-hard-migration). Every project
 * lives in a Workspace; there is no switch, so nothing here asks one. An old
 * profile's `workspaces_enabled` row is simply never read.
 *
 * REFUSALS ARE ANSWERS (allowed-pattern #21). A CLI refusal becomes a typed
 * `{ ok: false, reason, detail, payload }`: `reason` is the CLI's own code,
 * `payload` carries what it handed back (the choices, the commit a committed
 * `flow/` would take), and `detail` is THIS module's sentence for the reason —
 * the CLI writes for terminal users and its sentences can carry git output and
 * folder names, which stay in main's log (forbidden-pattern #12).
 *
 * CHEAP TO ASK. Reads are cached for a few seconds and in-flight reads are
 * shared, so a sidebar and a board asking at once cost one spawn; every
 * mutation drops the caches and announces itself once through `onChanged`.
 * Mutations run one at a time: two links racing would both rewrite the same
 * Workspace file.
 */

import { realpath as fsRealpath } from 'node:fs/promises'
import { isAbsolute, join as joinPath } from 'node:path'

import { parseGitRemote } from '../../shared/git-remote'
import { workspaceRefusalDetail } from '../../shared/workspace-refusals'
import {
  WORKSPACE_CLI_REFUSALS,
  type WorkspaceAnswer,
  type WorkspaceCliRefusal,
  type WorkspaceJoinResult,
  type WorkspaceLinkResult,
  type WorkspaceDeleteResult,
  type WorkspaceImported,
  type WorkspaceListing,
  type WorkspaceMembership,
  type WorkspaceMigrateResult,
  type WorkspacePreviousFlow,
  type WorkspaceProject,
  type WorkspaceRefusal,
  type WorkspaceRefusalReason,
  type WorkspaceRootMembership,
  type WorkspacesChangeCause,
  type WorkspacesChangedEvent,
  type WorkspacesList,
  type WorkspaceSuggestion,
  type WorkspaceSummary,
} from '../../shared/workspaces-contract'
import { lastJsonLine } from './cli-json'

// ── Collaborators ────────────────────────────────────────────────────────────

/** Structurally `CliRunResult` (agent/learn-session.ts). */
export interface WorkspaceCliRun {
  ok: boolean
  stdout: string
  error?: string
  stderr?: string
}

/** Runs the bundled CLI in `cwd`; never rejects (runBundledCliCapturing). */
export type WorkspaceCliRunner = (
  cwd: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<WorkspaceCliRun>

/** The app-settings row the registry reads and writes: which Workspace is selected. */
export interface WorkspaceSettings {
  getCurrentWorkspace(): string | null
  setCurrentWorkspace(slug: string | null): void
}

export interface WorkspaceRegistryDeps {
  /** REQUIRED (allowed-pattern #26): the only way anything about Workspaces is learned or changed. */
  runCli: WorkspaceCliRunner
  /** REQUIRED: where the selected Workspace is remembered. */
  settings: WorkspaceSettings
  /** Where verbs that name no repository run (list, create, join) — the person's home folder. */
  homeDir: string
  /** Called once per successful mutation, after the caches are dropped. */
  onChanged?: (event: WorkspacesChangedEvent) => void
  /** Diagnostics — the CLI's own sentences and raw output land here, never in an answer. */
  log?: (message: string, details: Record<string, unknown>) => void
  realpath?: (path: string) => Promise<string>
  now?: () => number
  /** Wait between retries of a change refused because a sync holds the Workspace (tests pass their own). */
  sleep?: (ms: number) => Promise<void>
  /** How long a read stays fresh. */
  cacheTtlMs?: number
}

export interface WorkspaceLinkRequest {
  /** The code repository (a project root). */
  repoPath: string
  /** The Workspace's slug. */
  workspace: string
  /** Map onto this existing project (id or slug) — forks, mirrors, repos with no remote. */
  projectId?: string
  /**
   * A PERSON has seen the one code-repo commit a committed `flow/` takes, and
   * wants it. Only an explicit `true` passes the flag on (forbidden-pattern #15).
   */
  confirmCommit?: boolean
  /**
   * Copy the project's existing knowledge in (`--import`): what adding a
   * project does now that every project lives in a Workspace. The old copy
   * stays as a backup.
   */
  importKnowledge?: boolean
}

export interface WorkspaceMigrateRequest {
  /** The project roots to move in — absolute paths. */
  roots: readonly string[]
  /** A name for the Workspace when the migration creates it. */
  name?: string
  /** Target this Workspace instead of the Default one. */
  workspace?: string
  dryRun?: boolean
}

export interface WorkspaceMoveProjectRequest {
  /** The project's slug or id. */
  project: string
  /** The Workspace it moves into. */
  to: string
  /** The Workspace it moves out of, when the person said. */
  from?: string
}

export interface WorkspaceDescribeRequest {
  /** The Workspace's slug. */
  workspace: string
  /** The project's slug (or id). */
  project: string
  text: string
  ifEmpty?: boolean
}

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceAnswer<WorkspacesList>>
  statusFor(projectRoot: string): Promise<WorkspaceAnswer<{ membership: WorkspaceMembership }>>
  /** Which Workspace each root belongs to — ONE CLI call for any number of roots. */
  membershipOf(roots: readonly string[]): Promise<WorkspaceAnswer<WorkspaceRootMembership>>
  /** One root's Workspace slug, or null (off, unknown, or in none) — for main's own consumers. */
  workspaceOfRoot(root: string): Promise<string | null>
  create(name: string, remote?: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary }>>
  link(request: WorkspaceLinkRequest): Promise<WorkspaceAnswer<WorkspaceLinkResult>>
  /**
   * Clone a Workspace and link the projects this machine has. `openRoots` —
   * the projects open in the app — are linked too when the CLI found no
   * checkout for them: the CLI only knows the checkouts its own Flow folder
   * recorded, and on a computer that never had the Workspace that is none.
   */
  join(remote: string, name?: string, options?: { openRoots?: readonly string[] }): Promise<WorkspaceAnswer<WorkspaceJoinResult>>
  /** The selected Workspace; falls back to the Default one (then the first) when the selection is gone. */
  current(): Promise<WorkspaceAnswer<{ slug: string | null }>>
  setCurrent(slug: string | null): Promise<WorkspaceAnswer<{ slug: string | null }>>
  /**
   * Set a project's description (`workspace describe`). `ifEmpty` writes only
   * when it has none — what a GENERATED description passes, so a sentence a
   * person wrote is never replaced by a machine's guess.
   */
  describe(request: WorkspaceDescribeRequest): Promise<WorkspaceAnswer<{ project: WorkspaceProject; changed: boolean }>>
  /**
   * Move projects into a Workspace (the Default one unless `workspace` says
   * otherwise), copying their knowledge in and keeping the old copy as a
   * backup. Committed knowledge folders come back `pending`.
   */
  migrate(request: WorkspaceMigrateRequest): Promise<WorkspaceAnswer<WorkspaceMigrateResult>>
  /** A Workspace's display name (its slug never changes). */
  rename(workspace: string, name: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary }>>
  /** Move a project, and its knowledge, from one Workspace to another. */
  moveProject(request: WorkspaceMoveProjectRequest): Promise<WorkspaceAnswer<{ to: string }>>
  /**
   * Delete a Workspace on this computer: its projects move into Default and
   * its folder is kept as a backup; the shared repository is left untouched.
   * Only ever asked after a person confirmed (`--confirm`). Default refuses.
   */
  deleteWorkspace(workspace: string): Promise<WorkspaceAnswer<WorkspaceDeleteResult>>
  /**
   * Connect a Workspace to a shared repository (`workspace set-remote`). The
   * CLI contacts nothing — the next sync publishes. `replace` only when a
   * person chose to change the repository it already has (forbidden-pattern #15).
   */
  setRemote(workspace: string, remote: string, options?: { replace?: boolean }): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>>
  /** Disconnect a Workspace (`workspace unset-remote`): everything stays here; the repository is untouched. */
  unsetRemote(workspace: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>>
  /** FR-3 auto-suggest: the repo is a local Workspace's project but is not linked yet. */
  suggestJoin(projectRoot: string): Promise<WorkspaceAnswer<{ suggestion: WorkspaceSuggestion }>>
  /** Drop every cached read (a change made outside the app, e.g. in a terminal). */
  invalidate(): void
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How long a `workspace status` read is reused. Short: a terminal may change things too. */
const DEFAULT_CACHE_TTL_MS = 5_000
/** Reads, create, link: local work only. */
const READ_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = 60_000
/** Link may commit in the code repo. */
const LINK_TIMEOUT_MS = 120_000
/** Join clones (the CLI's own clone bound is 300 s) — a little more, so the CLI's answer arrives first. */
const JOIN_TIMEOUT_MS = 330_000
/** Migrate, move and delete copy knowledge folders — a large vault copy takes a while. */
const COPY_TIMEOUT_MS = 5 * 60_000
/** The most roots one migration may name. */
const MAX_MIGRATE_ROOTS = 500
/**
 * A change that rewrites a Workspace (migrate, link, move, rename, delete) is
 * refused while that Workspace syncs (`sync-busy`) — and the app's own sync
 * runs on its own schedule (an open, a finished turn). A person who pressed
 * Move should not lose that race: the change waits for the sync and tries
 * again, for up to about a minute, before the refusal is reported.
 */
const BUSY_RETRY_MS = 1_500
const BUSY_RETRIES = 40

const MAX_NAME_LENGTH = 120
/** The CLI's own bound on a description (workspace-model.ts). */
const MAX_DESCRIPTION_LENGTH = 4000
const MAX_PROJECT_ID_LENGTH = 512
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 64
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** The sentence for a refusal — the one wording, wherever it is reported (shared/workspace-refusals.ts). */
export { workspaceRefusalDetail }

// ── Reading the CLI's JSON — rebuilt field by field ─────────────────────────

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function strOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...(value as string[])] : null
}

/** A malformed answer from the CLI — reported as `unavailable`, never half-used. */
class MalformedAnswer extends Error {}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new MalformedAnswer(what)
  return value
}

export function readSummary(value: unknown): WorkspaceSummary {
  if (!isRecord(value)) throw new MalformedAnswer('workspace')
  const remote = strOrNull(value['remote'])
  if (remote === undefined) throw new MalformedAnswer('workspace.remote')
  return {
    name: need(str(value['name']), 'workspace.name'),
    slug: need(str(value['slug']), 'workspace.slug'),
    path: need(str(value['path']), 'workspace.path'),
    remote,
    // A local notion the CLI marks; an older CLI says nothing — not the default, then.
    isDefault: value['default'] === true,
  }
}

export function readProject(value: unknown): WorkspaceProject {
  if (!isRecord(value)) throw new MalformedAnswer('project')
  const description = strOrNull(value['description'])
  const localPath = strOrNull(value['localPath'])
  if (description === undefined || localPath === undefined) throw new MalformedAnswer('project fields')
  return {
    id: need(str(value['id']), 'project.id'),
    name: need(str(value['name']), 'project.name'),
    slug: need(str(value['slug']), 'project.slug'),
    remotes: need(strings(value['remotes']), 'project.remotes'),
    description,
    localPath,
    flowPath: need(str(value['flowPath']), 'project.flowPath'),
  }
}

function readProjects(value: unknown): WorkspaceProject[] {
  if (!Array.isArray(value)) throw new MalformedAnswer('projects')
  return value.map(readProject)
}

function readList(payload: Json): WorkspacesList {
  const workspaces = payload['workspaces']
  const unreadable = payload['unreadable']
  if (!Array.isArray(workspaces) || !Array.isArray(unreadable)) throw new MalformedAnswer('status list')
  return {
    flowFolder: need(str(payload['flowFolder']), 'flowFolder'),
    workspaces: workspaces.map(
      (entry): WorkspaceListing => ({ ...readSummary(entry), projects: readProjects(isRecord(entry) ? entry['projects'] : null) }),
    ),
    unreadable: unreadable.map((entry) => {
      if (!isRecord(entry)) throw new MalformedAnswer('unreadable')
      return { workspace: need(str(entry['workspace']), 'unreadable.workspace'), detail: need(str(entry['detail']), 'unreadable.detail') }
    }),
  }
}

const VIAS = ['flow-link', 'local-path', 'remote'] as const

function readMembership(payload: Json): WorkspaceMembership {
  const via = payload['via']
  if (via !== null && !(VIAS as readonly unknown[]).includes(via)) throw new MalformedAnswer('via')
  if (typeof payload['linked'] !== 'boolean') throw new MalformedAnswer('linked')
  return {
    flowFolder: need(str(payload['flowFolder']), 'flowFolder'),
    target: need(str(payload['target']), 'target'),
    workspace: payload['workspace'] === null ? null : readSummary(payload['workspace']),
    project: payload['project'] === null ? null : readProject(payload['project']),
    linked: payload['linked'],
    via: via as WorkspaceMembership['via'],
    siblings: readProjects(payload['siblings']),
    alsoIn: need(strings(payload['alsoIn']), 'alsoIn'),
  }
}

function readPrevious(value: unknown): WorkspacePreviousFlow {
  if (!isRecord(value)) throw new MalformedAnswer('previous')
  switch (value['kind']) {
    case 'none':
      return { kind: 'none' }
    case 'workspace-link':
      return { kind: 'workspace-link' }
    case 'link':
      return { kind: 'link' }
    case 'folder':
      return { kind: 'folder', keptAt: need(str(value['keptAt']), 'previous.keptAt') }
    case 'committed-folder':
      return { kind: 'committed-folder', keptAt: need(str(value['keptAt']), 'previous.keptAt') }
    default:
      throw new MalformedAnswer('previous.kind')
  }
}

function readLink(payload: Json): WorkspaceLinkResult {
  const link = payload['link']
  if (link !== 'created' && link !== 'unchanged') throw new MalformedAnswer('link')
  if (typeof payload['projectAdded'] !== 'boolean') throw new MalformedAnswer('projectAdded')
  const codeRepo = payload['codeRepo']
  if (!isRecord(codeRepo)) throw new MalformedAnswer('codeRepo')
  const rawCommit = codeRepo['commit']
  let commit: WorkspaceLinkResult['commit'] = null
  if (rawCommit !== null) {
    if (!isRecord(rawCommit) || typeof rawCommit['files'] !== 'number') throw new MalformedAnswer('commit')
    commit = {
      sha: need(str(rawCommit['sha']), 'commit.sha'),
      message: need(str(rawCommit['message']), 'commit.message'),
      files: rawCommit['files'],
    }
  }
  return {
    workspace: readSummary(payload['workspace']),
    project: readProject(payload['project']),
    link,
    previous: readPrevious(payload['previous']),
    projectAdded: payload['projectAdded'],
    commit,
  }
}

function readJoin(payload: Json): WorkspaceJoinResult {
  const needsReview = payload['needsReview']
  if (!Array.isArray(needsReview)) throw new MalformedAnswer('needsReview')
  return {
    workspace: readSummary(payload['workspace']),
    linked: readProjects(payload['linked']),
    noLocalCheckout: readProjects(payload['noLocalCheckout']),
    needsReview: needsReview.map((entry) => ({
      ...readProject(entry),
      refusal: isRecord(entry) && isRecord(entry['refusal']) ? jsonCopy(entry['refusal']) : {},
    })),
    // Older CLIs say nothing about candidates — none, then.
    candidates: payload['candidates'] === undefined ? [] : readProjects(payload['candidates']),
    // Filled by the registry from the projects open in the app (see `join`).
    openCandidates: [],
  }
}

function readImported(value: unknown): WorkspaceImported | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new MalformedAnswer('imported')
  // A count, or the list of what it counts (the CLI reports skipped and renamed files by name).
  const count = (key: string): number => {
    const entry = value[key]
    if (Array.isArray(entry)) return entry.length
    return typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : 0
  }
  return { files: count('files'), skipped: count('skipped'), renamed: count('renamed') }
}

/** `intoDefault`: the migration named no Workspace, so the one it reports is the Default one. */
function readMigrate(payload: Json, intoDefault: boolean): WorkspaceMigrateResult {
  const workspace = payload['workspace']
  const migrated = payload['migrated']
  const unchanged = payload['unchanged']
  const pending = payload['pending']
  const failed = payload['failed']
  if (!isRecord(workspace) || !Array.isArray(migrated) || !Array.isArray(pending) || !Array.isArray(failed)) {
    throw new MalformedAnswer('migrate')
  }
  return {
    dryRun: payload['dryRun'] === true,
    // The CLI's migrate answer names the Workspace without its remote — none is assumed then.
    workspace: {
      ...readSummary({ remote: null, ...workspace }),
      isDefault: typeof workspace['default'] === 'boolean' ? workspace['default'] : intoDefault,
      created: workspace['created'] === true,
    },
    migrated: migrated.map((entry) => {
      if (!isRecord(entry)) throw new MalformedAnswer('migrated')
      return {
        root: need(str(entry['root']), 'migrated.root'),
        project: readProject(entry['project']),
        previous: entry['previous'] === undefined ? { kind: 'none' } : readPrevious(entry['previous']),
        imported: readImported(entry['imported']),
      }
    }),
    unchanged: need(strings(unchanged ?? []), 'unchanged'),
    pending: pending.map((entry) => {
      if (!isRecord(entry) || !isRecord(entry['commit'])) throw new MalformedAnswer('pending')
      const commit = entry['commit']
      const files = commit['files']
      return {
        root: need(str(entry['root']), 'pending.root'),
        reason: 'committed-folder' as const,
        commit: {
          message: str(commit['message']) ?? '',
          files: typeof files === 'number' && Number.isFinite(files) && files >= 0 ? files : 0,
          from: str(commit['from']) ?? '',
          to: str(commit['to']) ?? '',
        },
      }
    }),
    failed: failed.map((entry) => {
      if (!isRecord(entry)) throw new MalformedAnswer('failed')
      return {
        root: need(str(entry['root']), 'failed.root'),
        reason: str(entry['reason']) ?? 'failed',
        detail: str(entry['detail']) ?? '',
      }
    }),
  }
}

/** A plain-data copy: whatever crosses to the renderer is JSON, nothing else. */
function jsonCopy(value: Json): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

// ── Requests checked before anything is spawned ─────────────────────────────

function isPlainName(value: string): boolean {
  return value.trim() !== '' && value.length <= MAX_NAME_LENGTH && !CONTROL_CHARACTERS.test(value)
}

function isSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value)
}

function isProjectId(value: string): boolean {
  return value.trim() !== '' && value.length <= MAX_PROJECT_ID_LENGTH && !/\s/.test(value) && !CONTROL_CHARACTERS.test(value)
}

function refusal(reason: WorkspaceRefusalReason, payload: Json = {}): WorkspaceRefusal {
  return { ok: false, reason, detail: workspaceRefusalDetail(reason), payload }
}

function remoteProblem(remote: string): WorkspaceRefusal | null {
  const verdict = parseGitRemote(remote)
  return verdict.ok ? null : refusal(verdict.reason)
}

// ── The registry ─────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  at: number
  promise: Promise<T>
}

type Outcome = { ok: true; payload: Json } | WorkspaceRefusal

export function createWorkspaceRegistry(deps: WorkspaceRegistryDeps): WorkspaceRegistry {
  const now = deps.now ?? Date.now
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const realpath = deps.realpath ?? ((path: string) => fsRealpath(path))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)))
  const log = deps.log ?? ((message: string, details: Record<string, unknown>) => console.warn(`[Workspaces] ${message}`, details))

  let listCache: CacheEntry<WorkspaceAnswer<WorkspacesList>> | null = null
  const statusCache = new Map<string, CacheEntry<WorkspaceAnswer<{ membership: WorkspaceMembership }>>>()
  let mutations: Promise<unknown> = Promise.resolve()

  function invalidate(): void {
    listCache = null
    statusCache.clear()
  }

  function changed(cause: WorkspacesChangeCause): void {
    invalidate()
    deps.onChanged?.({ cause })
  }

  /** Spawn one verb and sort the answer into a payload or a typed refusal. */
  async function run(action: string, cwd: string, args: string[], timeoutMs: number): Promise<Outcome> {
    const result = await deps.runCli(cwd, ['workspace', action, ...args, '--json'], { timeoutMs })
    const payload = lastJsonLine(result.stdout)
    if (result.ok && payload !== null && payload['action'] === action && typeof payload['refused'] !== 'string') {
      return { ok: true, payload }
    }
    if (!result.ok && payload !== null && typeof payload['refused'] === 'string') {
      const code = payload['refused']
      const reason: WorkspaceCliRefusal = (WORKSPACE_CLI_REFUSALS as readonly string[]).includes(code)
        ? (code as WorkspaceCliRefusal)
        : 'failed'
      // The CLI's sentence is for terminal users; it stays in main's log.
      log(`workspace ${action} refused`, { reason: code, detail: payload['detail'] })
      const { action: _action, refused: _refused, detail: _detail, ...rest } = payload
      return refusal(reason, jsonCopy(rest))
    }
    log(`workspace ${action} gave no usable answer`, { error: result.error, stderr: result.stderr })
    return refusal('unavailable')
  }

  /** A rewriting verb: a refusal because a sync holds the Workspace waits and asks again. */
  async function runWhenFree(action: string, cwd: string, args: string[], timeoutMs: number): Promise<Outcome> {
    let outcome = await run(action, cwd, args, timeoutMs)
    for (let attempt = 0; attempt < BUSY_RETRIES && !outcome.ok && outcome.reason === 'sync-busy'; attempt += 1) {
      await sleep(BUSY_RETRY_MS)
      outcome = await run(action, cwd, args, timeoutMs)
    }
    return outcome
  }

  /** Read a successful payload into its shape; a malformed one is `unavailable`. */
  function shape<T>(outcome: Outcome, read: (payload: Json) => T, action: string): WorkspaceAnswer<T> {
    if (!outcome.ok) return outcome
    try {
      return { ok: true, ...read(outcome.payload) }
    } catch (error) {
      log(`workspace ${action} answered in a shape this build can't read`, { field: (error as Error).message })
      return refusal('unavailable')
    }
  }

  /** A cached read: fresh entries and in-flight promises are shared; refusals are never kept. */
  function cached<T extends { ok: boolean }>(
    get: () => CacheEntry<T> | null | undefined,
    set: (entry: CacheEntry<T> | null) => void,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = get()
    if (hit !== null && hit !== undefined && now() - hit.at < ttl) return hit.promise
    const entry: CacheEntry<T> = { at: now(), promise: load() }
    set(entry)
    void entry.promise.then((answer) => {
      if (!answer.ok && get() === entry) set(null)
    })
    return entry.promise
  }

  /** Run one mutation after any other has finished — never two at once. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = mutations.then(work, work)
    mutations = next.catch(() => undefined)
    return next
  }

  function list(): Promise<WorkspaceAnswer<WorkspacesList>> {
    return cached(
      () => listCache,
      (entry) => {
        listCache = entry
      },
      async () => shape(await run('status', deps.homeDir, [], READ_TIMEOUT_MS), readList, 'status'),
    )
  }

  function statusFor(projectRoot: string): Promise<WorkspaceAnswer<{ membership: WorkspaceMembership }>> {
    if (!isAbsolute(projectRoot)) return Promise.resolve(refusal('not-a-git-repo'))
    return cached(
      () => statusCache.get(projectRoot),
      (entry) => {
        if (entry === null) statusCache.delete(projectRoot)
        else statusCache.set(projectRoot, entry)
      },
      async () =>
        shape(
          await run('status', projectRoot, [`--target=${projectRoot}`], READ_TIMEOUT_MS),
          (payload) => ({ membership: readMembership(payload) }),
          'status',
        ),
    )
  }

  async function canonical(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      return path
    }
  }

  async function membershipOf(roots: readonly string[]): Promise<WorkspaceAnswer<WorkspaceRootMembership>> {
    const listed = await list()
    if (!listed.ok) return listed
    const owner = new Map<string, { workspace: string; project: WorkspaceProject }>()
    for (const workspace of listed.workspaces) {
      for (const project of workspace.projects) {
        if (project.localPath === null) continue
        const key = await canonical(project.localPath)
        // Sorted by the CLI; the first Workspace that lists a checkout owns it.
        if (!owner.has(key)) owner.set(key, { workspace: workspace.slug, project })
      }
    }
    const answer: WorkspaceRootMembership['roots'] = []
    for (const root of roots) {
      const hit = owner.get(await canonical(root))
      if (hit === undefined) {
        answer.push({ root, workspace: null, project: null, linked: false })
        continue
      }
      // LINKED = the repo's `flow` resolves into the folder the CLI named for
      // this project. Both sides are read (the link and the CLI's flowPath),
      // compared real to real — nothing is derived from a path's shape.
      const [linkTarget, projectFolder] = await Promise.all([
        canonical(joinPath(root, 'flow')),
        canonical(hit.project.flowPath),
      ])
      answer.push({ root, workspace: hit.workspace, project: hit.project.id, linked: linkTarget === projectFolder })
    }
    return { ok: true, roots: answer }
  }

  async function workspaceOfRoot(root: string): Promise<string | null> {
    const answer = await membershipOf([root])
    return answer.ok ? (answer.roots[0]?.workspace ?? null) : null
  }

  function create(name: string, remote?: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary }>> {
    if (!isPlainName(name)) return Promise.resolve(refusal('invalid-name'))
    if (remote !== undefined) {
      const problem = remoteProblem(remote)
      if (problem !== null) return Promise.resolve(problem)
    }
    const args = [`--name=${name.trim()}`, ...(remote === undefined ? [] : [`--remote=${remote.trim()}`])]
    return serial(async () => {
      const answer = shape(
        await runWhenFree('create', deps.homeDir, args, CREATE_TIMEOUT_MS),
        (payload) => ({ workspace: readSummary(payload['workspace']) }),
        'create',
      )
      if (answer.ok) changed('created')
      return answer
    })
  }

  /** One `workspace link`, unserialized — `link` and `join` both run it inside `serial`. */
  async function linkNow(request: WorkspaceLinkRequest): Promise<WorkspaceAnswer<WorkspaceLinkResult>> {
    const args = [
      `--target=${request.repoPath}`,
      `--workspace=${request.workspace}`,
      ...(request.projectId === undefined ? [] : [`--project=${request.projectId}`]),
      // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15).
      ...(request.confirmCommit === true ? ['--confirm-commit'] : []),
      ...(request.importKnowledge === true ? ['--import'] : []),
    ]
    return shape(await runWhenFree('link', request.repoPath, args, LINK_TIMEOUT_MS), readLink, 'link')
  }

  function link(request: WorkspaceLinkRequest): Promise<WorkspaceAnswer<WorkspaceLinkResult>> {
    if (!isAbsolute(request.repoPath)) return Promise.resolve(refusal('not-a-git-repo'))
    if (!isSlug(request.workspace)) return Promise.resolve(refusal('unknown-workspace'))
    if (request.projectId !== undefined && !isProjectId(request.projectId)) return Promise.resolve(refusal('unknown-project'))
    return serial(async () => {
      const answer = await linkNow(request)
      if (answer.ok) changed('linked')
      return answer
    })
  }

  /**
   * After a join: which projects OPEN in the app look like one of the joined
   * Workspace's — the CLI's own remote-only `candidates` that are open here,
   * and open projects the CLI found no checkout for whose remote matches (the
   * CLI's `status`, its own rule). PROPOSED ONLY: a Workspace file can name the
   * remote of any repository, so nothing here is linked — the person ticks the
   * ones that belong and the dialog links those.
   *
   * Runs OUTSIDE the mutation lock, the reads in parallel: they decide nothing
   * and must not hold every other Workspace change behind N CLI spawns.
   */
  async function openCandidatesFor(
    result: WorkspaceJoinResult,
    openRoots: readonly string[],
  ): Promise<WorkspaceJoinResult['openCandidates']> {
    const roots = openRoots.filter((root) => isAbsolute(root))
    if (roots.length === 0) return []
    const realRoots = await Promise.all(roots.map((root) => canonical(root)))
    const found = new Map<number, { root: string; project: WorkspaceProject }>()
    const claimed = new Set<string>()
    // The CLI's candidates: offered only when that checkout is open here.
    for (const project of result.candidates) {
      if (project.localPath === null) continue
      const real = await canonical(project.localPath)
      const index = realRoots.indexOf(real)
      if (index === -1 || found.has(index) || claimed.has(project.id)) continue
      found.set(index, { root: roots[index] as string, project: { ...project, localPath: roots[index] as string } })
      claimed.add(project.id)
    }
    const waiting = result.noLocalCheckout.filter((project) => !claimed.has(project.id))
    if (waiting.length > 0) {
      const statuses = await Promise.all(
        roots.map((root, index) => (found.has(index) ? Promise.resolve(null) : statusFor(root))),
      )
      for (const [index, status] of statuses.entries()) {
        if (status === null || !status.ok) continue
        const { membership } = status
        if (membership.workspace?.slug !== result.workspace.slug || membership.project === null || membership.linked) continue
        const projectId = membership.project.id
        const project = waiting.find((entry) => entry.id === projectId)
        if (project === undefined || claimed.has(project.id)) continue
        found.set(index, { root: roots[index] as string, project: { ...project, localPath: roots[index] as string } })
        claimed.add(project.id)
      }
    }
    return [...found.entries()].sort(([a], [b]) => a - b).map(([, candidate]) => candidate)
  }

  async function join(
    remote: string,
    name?: string,
    options: { openRoots?: readonly string[] } = {},
  ): Promise<WorkspaceAnswer<WorkspaceJoinResult>> {
    const problem = remoteProblem(remote)
    if (problem !== null) return problem
    if (name !== undefined && !isPlainName(name)) return refusal('invalid-name')
    const args = [`--remote=${remote.trim()}`, ...(name === undefined ? [] : [`--name=${name.trim()}`])]
    const answer = await serial(async () => {
      const joined = shape(await run('join', deps.homeDir, args, JOIN_TIMEOUT_MS), readJoin, 'join')
      if (!joined.ok) return joined
      // The reads below must see the Workspace the join just cloned.
      invalidate()
      changed('joined')
      return joined
    })
    if (!answer.ok) return answer
    const { ok: _ok, ...result } = answer
    const openCandidates = await openCandidatesFor(result, options.openRoots ?? []).catch((error: unknown) => {
      log('reading the open projects after a join failed', { error: String(error) })
      return []
    })
    return { ok: true, ...result, openCandidates }
  }

  async function current(): Promise<WorkspaceAnswer<{ slug: string | null }>> {
    const listed = await list()
    if (!listed.ok) return listed
    const stored = deps.settings.getCurrentWorkspace()
    if (stored !== null && listed.workspaces.some((workspace) => workspace.slug === stored)) return { ok: true, slug: stored }
    // The selection is gone (deleted, never made): the Default Workspace, then the first one.
    const fallback = listed.workspaces.find((workspace) => workspace.isDefault) ?? listed.workspaces[0]
    return { ok: true, slug: fallback?.slug ?? null }
  }

  async function setCurrent(slug: string | null): Promise<WorkspaceAnswer<{ slug: string | null }>> {
    if (slug !== null) {
      const listed = await list()
      if (!listed.ok) return listed
      if (!listed.workspaces.some((workspace) => workspace.slug === slug)) {
        return refusal('unknown-workspace', { workspaces: listed.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.name })) })
      }
    }
    deps.settings.setCurrentWorkspace(slug)
    // The selection changes no Workspace — announce it without dropping the reads.
    deps.onChanged?.({ cause: 'current' })
    return { ok: true, slug }
  }

  function describe(
    request: WorkspaceDescribeRequest,
  ): Promise<WorkspaceAnswer<{ project: WorkspaceProject; changed: boolean }>> {
    if (!isSlug(request.workspace)) return Promise.resolve(refusal('unknown-workspace'))
    if (!isProjectId(request.project)) return Promise.resolve(refusal('unknown-project'))
    const text = request.text.trim()
    if (text === '' || text.length > MAX_DESCRIPTION_LENGTH) return Promise.resolve(refusal('invalid-description'))
    const args = [
      `--workspace=${request.workspace}`,
      `--project=${request.project}`,
      `--text=${text}`,
      ...(request.ifEmpty === true ? ['--if-empty'] : []),
    ]
    return serial(async () => {
      const answer = shape(
        await run('describe', deps.homeDir, args, READ_TIMEOUT_MS),
        (payload) => {
          if (typeof payload['changed'] !== 'boolean') throw new MalformedAnswer('changed')
          return { project: readProject(payload['project']), changed: payload['changed'] }
        },
        'describe',
      )
      if (answer.ok && answer.changed) changed('described')
      return answer
    })
  }

  async function suggestJoin(projectRoot: string): Promise<WorkspaceAnswer<{ suggestion: WorkspaceSuggestion }>> {
    const status = await statusFor(projectRoot)
    if (!status.ok) return status
    const { membership } = status
    if (
      membership.workspace !== null &&
      membership.project !== null &&
      !membership.linked &&
      (membership.via === 'remote' || membership.via === 'local-path')
    ) {
      return {
        ok: true,
        suggestion: { kind: 'link', workspace: membership.workspace, project: membership.project, via: membership.via },
      }
    }
    return { ok: true, suggestion: { kind: 'none' } }
  }

  function migrate(request: WorkspaceMigrateRequest): Promise<WorkspaceAnswer<WorkspaceMigrateResult>> {
    const roots = [...request.roots]
    if (roots.length > MAX_MIGRATE_ROOTS || roots.some((root) => !isAbsolute(root))) {
      return Promise.resolve(refusal('not-a-git-repo'))
    }
    if (request.name !== undefined && !isPlainName(request.name)) return Promise.resolve(refusal('invalid-name'))
    if (request.workspace !== undefined && !isSlug(request.workspace)) return Promise.resolve(refusal('unknown-workspace'))
    const args = [
      `--roots=${JSON.stringify(roots)}`,
      ...(request.name === undefined ? [] : [`--name=${request.name.trim()}`]),
      ...(request.workspace === undefined ? [] : [`--workspace=${request.workspace}`]),
      ...(request.dryRun === true ? ['--dry-run'] : []),
    ]
    return serial(async () => {
      const answer = shape(
        await runWhenFree('migrate', deps.homeDir, args, COPY_TIMEOUT_MS),
        (payload) => readMigrate(payload, request.workspace === undefined),
        'migrate',
      )
      if (answer.ok && !answer.dryRun) changed('migrated')
      return answer
    })
  }

  function rename(workspace: string, name: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary }>> {
    if (!isSlug(workspace)) return Promise.resolve(refusal('unknown-workspace'))
    if (!isPlainName(name)) return Promise.resolve(refusal('invalid-name'))
    return serial(async () => {
      const answer = shape(
        await runWhenFree('rename', deps.homeDir, [`--workspace=${workspace}`, `--name=${name.trim()}`], READ_TIMEOUT_MS),
        (payload) => ({ workspace: readSummary(payload['workspace']) }),
        'rename',
      )
      if (answer.ok) changed('renamed')
      return answer
    })
  }

  function moveProject(request: WorkspaceMoveProjectRequest): Promise<WorkspaceAnswer<{ to: string }>> {
    if (!isProjectId(request.project)) return Promise.resolve(refusal('unknown-project'))
    if (!isSlug(request.to)) return Promise.resolve(refusal('unknown-workspace'))
    if (request.from !== undefined && !isSlug(request.from)) return Promise.resolve(refusal('unknown-workspace'))
    const args = [
      `--project=${request.project}`,
      `--to=${request.to}`,
      ...(request.from === undefined ? [] : [`--from=${request.from}`]),
    ]
    return serial(async () => {
      // The answer's detail beyond success is the CLI's own; the app re-reads the listing.
      const answer = shape(await runWhenFree('move-project', deps.homeDir, args, COPY_TIMEOUT_MS), () => ({ to: request.to }), 'move-project')
      if (answer.ok) changed('moved')
      return answer
    })
  }

  function deleteWorkspace(workspace: string): Promise<WorkspaceAnswer<WorkspaceDeleteResult>> {
    if (!isSlug(workspace)) return Promise.resolve(refusal('unknown-workspace'))
    return serial(async () => {
      // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15): this is
      // only ever called after a person read which projects move to Default.
      const answer = shape(
        await runWhenFree('delete', deps.homeDir, [`--workspace=${workspace}`, '--confirm'], COPY_TIMEOUT_MS),
        (payload): WorkspaceDeleteResult => {
          const moved = payload['movedProjects'] ?? payload['moved'] ?? payload['projects']
          const names = Array.isArray(moved)
            ? moved.map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? (str(entry['name']) ?? str(entry['slug']) ?? '') : '')).filter((name) => name !== '')
            : []
          return { workspace, moved: names }
        },
        'delete',
      )
      if (answer.ok) changed('deleted')
      return answer
    })
  }

  function readRemoteAnswer(payload: Json): { workspace: WorkspaceSummary; changed: boolean } {
    if (typeof payload['changed'] !== 'boolean') throw new MalformedAnswer('changed')
    return { workspace: readSummary(payload['workspace']), changed: payload['changed'] }
  }

  function setRemote(
    workspace: string,
    remote: string,
    options: { replace?: boolean } = {},
  ): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>> {
    if (!isSlug(workspace)) return Promise.resolve(refusal('unknown-workspace'))
    // The shared grammar decides before anything is spawned (the CLI decides again).
    const problem = remoteProblem(remote)
    if (problem !== null) return Promise.resolve(problem)
    const args = [
      `--workspace=${workspace}`,
      `--remote=${remote.trim()}`,
      // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15).
      ...(options.replace === true ? ['--replace'] : []),
    ]
    return serial(async () => {
      const answer = shape(await runWhenFree('set-remote', deps.homeDir, args, READ_TIMEOUT_MS), readRemoteAnswer, 'set-remote')
      if (answer.ok && answer.changed) changed('remote')
      return answer
    })
  }

  function unsetRemote(workspace: string): Promise<WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>> {
    if (!isSlug(workspace)) return Promise.resolve(refusal('unknown-workspace'))
    return serial(async () => {
      const answer = shape(
        await runWhenFree('unset-remote', deps.homeDir, [`--workspace=${workspace}`], READ_TIMEOUT_MS),
        readRemoteAnswer,
        'unset-remote',
      )
      if (answer.ok && answer.changed) changed('remote')
      return answer
    })
  }

  return {
    list,
    statusFor,
    membershipOf,
    workspaceOfRoot,
    create,
    link,
    join,
    current,
    setCurrent,
    describe,
    migrate,
    rename,
    moveProject,
    deleteWorkspace,
    setRemote,
    unsetRemote,
    suggestJoin,
    invalidate,
  }
}
