// Ask the Blueprint's IPC (plan `ask_the_blueprint`, Phase 2).
//
//   ask:start  — mint an id, answer it at once, run the question in the
//                background; its state streams on `ask:state`.
//   ask:stop   — Stop here: abort that run; it keeps the best answer as partial.
//   ask:list   — saved answers for features or parts, through `blueprint qa list`.
//   ask:stale  — which saved answers have code that changed since, `qa stale`.
//   ask:saveConnection — Save as connection: one suggested connection,
//                recorded through `workspace link-knowledge` (its one writer).
//
// WORKSPACE SCOPE (plan `ask_the_blueprint_workspace`). A request carrying a
// Workspace scope is gated here into a project→root map: the Workspace map
// (`runWorkspaceGraph` + `alignLocalPaths`, cached for a short while — it walks
// every checkout) says which projects exist, which are on this computer and
// their feature graphs; a checkout counts as readable code only when it is a
// root open in Flow; `workspace status` names each project's knowledge folder.
// A scope with no readable project is refused with a sentence. list/stale run
// the same verbs with `--workspace` and `--tag`.
//
// Every write goes through the bundled CLI's one writer per drawer, called
// asynchronously with a timeout (allowed-pattern #19); the caged sessions only
// read. A root the renderer may not address is refused before anything runs.

import { ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve, sep } from 'node:path'

import type {
  AskConnectionKind,
  AskSavedThread,
  AskStaleResult,
  AskStateEvent,
  AskSuggestedConnection,
  AskWorkspaceListScope,
  AskWorkspaceScope,
} from '../../shared/ask-contract'
import type { BlueprintWorkspaceGraph } from '../../shared/ipc-contract'
import { withoutCommandHint } from '../../shared/command-hint'
import type { IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract'
import type { ModelRouting } from '../../shared/model-routing'
import { extractJsonObject, runBundledCliCapturing, runCagedSession } from '../agent/learn-session'
import { searchBrain } from '../brain/query'
import type { RootsProvider } from '../flow/flow-observer'
import { timed } from '../ipc/slow-handler'
import type { ThreadStore } from '../store/thread-store'
import { runGitCapturing } from '../worktree/thread-worktree-runners'
import {
  gatherAskContext,
  type AskKnowledgeHit,
  type AskNote,
  type AskResolvedScope,
  type AskScopeProject,
} from './ask-context'
import { refusalSentence, runAsk, type AskDeps } from './ask-orchestrator'
import { foldActiveInvestigations } from './blueprint-observer'
import type { BundledCli } from './derive-runner'
import { runFeatures } from './feature-runner'
import { alignLocalPaths, recentWorkspaceGraph, rememberWorkspaceGraph, runWorkspaceGraph } from './workspace-graph-runner'

const PROJECT_NOT_OPEN = "That project isn't open."
const NO_QUESTION = 'Type a question first.'
const LIST_FAILED = "Saved questions couldn't be read."
const STALE_FAILED = "Flow couldn't check whether the code changed."
const WORKSPACE_NOT_OPEN = "That Workspace isn't available from this project."
const NO_READABLE_PROJECT = "Flow couldn't read any of the projects this question is about."
const CONNECTION_INVALID = "That connection can't be saved: its two ends must be in two different projects of this Workspace."
const CONNECTION_FAILED = "The connection couldn't be saved."
/** The Workspace map walks every checkout; one read serves the questions of the next minute. */
const WORKSPACE_MAP_TTL_MS = 60_000
const WORKSPACE_STATUS_TIMEOUT_MS = 15_000
const LINK_TIMEOUT_MS = 30_000
/** Tags one Workspace list or stale read may carry. */
const MAX_WORKSPACE_TAGS = 40
const PROJECT_SLUG = /^[A-Za-z0-9._-]+$/
const CONNECTION_KINDS = new Set<AskConnectionKind>(['calls', 'exposes', 'consumes', 'relates'])
const QA_READ_TIMEOUT_MS = 30_000
const SEARCH_TIMEOUT_MS = 15_000
const SEARCH_LIMIT = 8
/** How many features one `ask:list` may read — each is one CLI run. */
const MAX_LIST_FEATURES = 20

/** What the registrar is built with. All required (allowed-pattern #26). */
export interface AskChannelDependencies {
  roots: RootsProvider
  bundledCli: BundledCli
  threadStore: ThreadStore
  /** The person's Auto routing map. */
  routing: () => Partial<ModelRouting> | null
  /** The project's bound credentials for a caged session. */
  authEnv: (rootPath: string) => Promise<NodeJS.ProcessEnv | undefined>
  /** Send `ask:state` to the windows. */
  broadcast: (event: AskStateEvent) => void
}

function capitalized(text: string): string {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

function isKnownRoot(roots: RootsProvider, rootId: string): boolean {
  return roots.getRoots().some((root) => root.rootPath === rootId)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : []
}

/** The last parseable JSON object on a CLI's stdout (pretty-printed or one line). */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // keep scanning
    }
  }
  const whole = extractJsonObject(stdout)
  if (whole === null) return null
  try {
    const parsed: unknown = JSON.parse(whole)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── Workspace scope: the gate ───────────────────────────────────────────────

/** What resolving a scope needs. All required (allowed-pattern #26). */
export interface AskScopeReads {
  /** The Workspace map of `rootId`'s Workspace, local paths named as Flow knows them. */
  workspaceGraph: (rootId: string) => Promise<BlueprintWorkspaceGraph>
  /** Each project's knowledge folder by slug (`workspace status`); empty when it could not be read. */
  knowledgeFolders: (rootId: string) => Promise<Map<string, string>>
  /** Every root open in Flow. */
  knownRoots: () => readonly string[]
}

/** The project slugs a Workspace tag names. */
function projectsNamedBy(tag: string): string[] {
  const project = /^project:([A-Za-z0-9._-]+)$/.exec(tag)
  if (project !== null) return [project[1]]
  const link = /^link:([A-Za-z0-9._-]+)::([A-Za-z0-9._-]+)$/.exec(tag)
  if (link !== null) return [link[1], link[2]]
  const feature = /^feature:([A-Za-z0-9._-]+)::/.exec(tag)
  return feature !== null ? [feature[1]] : []
}

/**
 * Resolve a Workspace scope into the project→root map every later step takes.
 * In scope: the requested projects plus those the tags name; none = every
 * project. A checkout is readable code only when it is a root open in Flow.
 * Refuses with a sentence when the Workspace is not this project's, or when no
 * in-scope project can be read at all (no code here and no feature map).
 */
export async function resolveAskScope(
  rootId: string,
  requested: AskWorkspaceScope,
  tags: readonly string[],
  reads: AskScopeReads,
): Promise<{ ok: true; scope: AskResolvedScope } | { ok: false; detail: string }> {
  const [graph, folders] = await Promise.all([
    reads.workspaceGraph(rootId).catch((): BlueprintWorkspaceGraph | null => null),
    reads.knowledgeFolders(rootId).catch(() => new Map<string, string>()),
  ])
  if (graph === null || !graph.available || graph.workspace === null || graph.workspace.slug !== requested.workspace) {
    return { ok: false, detail: WORKSPACE_NOT_OPEN }
  }
  const all = graph.projects
  const wanted = new Set([...strings(requested.projects), ...tags.flatMap(projectsNamedBy)])
  const named = all.filter((project) => wanted.has(project.slug))
  const chosen = named.length > 0 ? named : all
  const roots = new Set(reads.knownRoots())
  const projects: AskScopeProject[] = chosen.map((project) => {
    const rootPath = project.local !== null && roots.has(project.local) ? project.local : null
    return {
      slug: project.slug,
      name: project.name,
      rootPath,
      flowDir: rootPath !== null ? join(rootPath, 'flow') : (folders.get(project.slug) ?? null),
      graph: project.graph,
    }
  })
  if (!projects.some((project) => project.rootPath !== null || project.graph !== null)) {
    return { ok: false, detail: NO_READABLE_PROJECT }
  }
  return {
    ok: true,
    scope: {
      workspace: { slug: graph.workspace.slug, name: graph.workspace.name },
      projects,
      workspaceProjects: all.map((project) => project.slug),
      links: (graph.links ?? []).map((link) => ({
        kind: link.kind,
        from: link.from.address,
        to: link.to.address,
        fromProject: link.from.project,
        toProject: link.to.project,
        ...(link.note !== undefined ? { note: link.note } : {}),
      })),
    },
  }
}

/** A short-lived cache of one async read per key, sharing an in-flight read (allowed-pattern #20). */
function cached<T>(ttlMs: number, read: (key: string) => Promise<T>, keep: (value: T) => boolean, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<T> }>()
  return (key: string): Promise<T> => {
    const hit = entries.get(key)
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.value
    const value = read(key)
    entries.set(key, { at: now(), value })
    // A failed or unavailable read is not kept: the next question asks again.
    void value.then(
      (result) => {
        if (!keep(result)) entries.delete(key)
      },
      () => entries.delete(key),
    )
    return value
  }
}

/** `workspace status --json`: each project's knowledge folder by slug. */
function parseKnowledgeFolders(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  const parsed = lastJsonObject(stdout)
  if (parsed === null) return out
  const views = [parsed.project, ...(Array.isArray(parsed.siblings) ? parsed.siblings : [])]
  for (const raw of views) {
    if (typeof raw !== 'object' || raw === null) continue
    const view = raw as Record<string, unknown>
    if (typeof view.slug === 'string' && typeof view.flowPath === 'string' && view.flowPath !== '') out.set(view.slug, view.flowPath)
  }
  return out
}

/** A suggested connection as the renderer sent it back, checked before anything runs. */
function validConnection(raw: unknown): AskSuggestedConnection | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  const { kind, from, to, fromProject, toProject } = c
  if (typeof kind !== 'string' || !CONNECTION_KINDS.has(kind as AskConnectionKind)) return null
  if (typeof fromProject !== 'string' || typeof toProject !== 'string') return null
  if (!PROJECT_SLUG.test(fromProject) || !PROJECT_SLUG.test(toProject) || fromProject === toProject) return null
  if (typeof from !== 'string' || typeof to !== 'string') return null
  if (!from.startsWith(`${fromProject}/`) || from.length <= fromProject.length + 1) return null
  if (!to.startsWith(`${toProject}/`) || to.length <= toProject.length + 1) return null
  if (/[\n\r]/.test(from) || /[\n\r]/.test(to)) return null
  const note = typeof c.note === 'string' ? c.note.replace(/\s+/g, ' ').trim() : ''
  return {
    id: typeof c.id === 'string' ? c.id : `${from}|${kind}|${to}`,
    kind: kind as AskConnectionKind,
    fromProject,
    from,
    toProject,
    to,
    ...(note !== '' ? { note } : {}),
  }
}

/** A Workspace list/stale scope from the renderer, narrowed; null when absent or malformed. */
function workspaceListScope(raw: AskWorkspaceListScope | null | undefined): { workspace: string; tags: string[] } | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  if (typeof raw.workspace !== 'string' || !PROJECT_SLUG.test(raw.workspace)) return null
  return { workspace: raw.workspace, tags: [...new Set(strings(raw.tags))].slice(0, MAX_WORKSPACE_TAGS) }
}

/** The production dependencies of one run. */
export function createAskDeps(deps: AskChannelDependencies): AskDeps {
  const runCli: AskDeps['runCli'] = (cwd, args, options) => runBundledCliCapturing(deps.bundledCli, cwd, args, options)

  // Brain search across the Workspace when the project is in one (the CLI
  // widens and says when it could not); the in-process project search that
  // `brain:query` uses is the fallback.
  const searchKnowledge = async (rootPath: string, query: string): Promise<AskKnowledgeHit[]> => {
    const result = await runCli(
      rootPath,
      ['brain', 'search', query, '--scope', 'workspace', '--json', '--limit', String(SEARCH_LIMIT), '--target', rootPath],
      { timeoutMs: SEARCH_TIMEOUT_MS },
    ).catch(() => null)
    const parsed = result !== null && result.ok ? lastJsonObject(result.stdout) : null
    if (parsed !== null && Array.isArray(parsed.hits)) {
      const hits: AskKnowledgeHit[] = []
      for (const raw of parsed.hits) {
        if (typeof raw !== 'object' || raw === null) continue
        const hit = raw as Record<string, unknown>
        if (typeof hit.file !== 'string') continue
        hits.push({
          file: hit.file,
          title: typeof hit.heading === 'string' ? hit.heading : hit.file,
          snippet: typeof hit.snippet === 'string' ? hit.snippet : '',
          ...(typeof hit.project === 'string' ? { project: hit.project } : {}),
        })
      }
      return hits
    }
    const local = await searchBrain(rootPath, query, SEARCH_LIMIT)
    return local.hits.map((hit) => ({ file: hit.path, title: hit.title, snippet: hit.snippet }))
  }

  const readNotes = async (flowDir: string): Promise<AskNote[]> => {
    const content = await fs
      .readFile(join(flowDir, 'brain', '.structure', 'investigations.jsonl'), 'utf8')
      .catch(() => '')
    return foldActiveInvestigations(content).map((note) => ({
      ts: note.ts,
      text: note.text,
      anchors: note.anchors.map((anchor) => anchor.ref),
    }))
  }

  return {
    runSession: runCagedSession,
    runCli,
    git: (cwd, args) => runGitCapturing(cwd, args),
    now: () => Date.now(),
    gatherContext: (input) =>
      gatherAskContext(input, {
        searchKnowledge,
        readFeatureGraph: (rootPath) => runFeatures(deps.bundledCli, rootPath),
        readNotes,
        threadStore: deps.threadStore,
        git: (cwd, args) => runGitCapturing(cwd, args),
      }),
    routing: deps.routing,
    authEnv: deps.authEnv,
    author: async (rootPath) => {
      const result = await runGitCapturing(rootPath, ['config', 'user.name'])
      const name = result.ok ? result.stdout.trim() : ''
      if (name !== '') return name
      try {
        return userInfo().username
      } catch {
        return ''
      }
    },
    fileExists: async (rootPath, relPath) => {
      const root = resolve(rootPath)
      const full = resolve(root, relPath)
      if (full !== root && !full.startsWith(root + sep)) return false
      try {
        return (await fs.stat(full)).isFile()
      } catch {
        return false
      }
    },
    writeInputFile: async (json) => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'flow-ask-'))
      const path = join(dir, 'answer.json')
      await fs.writeFile(path, json, 'utf8')
      return { path, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
    },
    emit: deps.broadcast,
  }
}

/** Narrow one saved thread from `qa list --json`; null when it is not one. */
function toSavedThread(raw: unknown): AskSavedThread | null {
  if (typeof raw !== 'object' || raw === null) return null
  const thread = raw as AskSavedThread
  if (typeof thread.id !== 'string' || typeof thread.question !== 'string' || typeof thread.answer !== 'string') return null
  const strip = <T extends { sources?: unknown }>(entry: T): T => ({
    ...entry,
    sources: Array.isArray(entry.sources)
      ? (entry.sources as Array<Record<string, unknown>>).map(({ hashStamp: _stamp, ...source }) => source)
      : [],
  })
  return {
    ...strip(thread),
    followUps: Array.isArray(thread.followUps) ? thread.followUps.map((entry) => strip(entry)) : [],
  }
}

/**
 * Register Ask the Blueprint's channels. Returns a dispose function that
 * unregisters them and stops every run still going.
 */
export function registerAskChannels(deps: AskChannelDependencies): () => void {
  const registered: IpcInvokeChannel[] = []
  const running = new Map<string, AbortController>()
  const askDeps = createAskDeps(deps)
  const knownRoots = (): string[] => deps.roots.getRoots().map((root) => root.rootPath)
  const scopeReads: AskScopeReads = {
    workspaceGraph: (() => {
      const read = cached(
        WORKSPACE_MAP_TTL_MS,
        async (rootId) => {
          const graph = await alignLocalPaths(await runWorkspaceGraph(deps.bundledCli, rootId), knownRoots())
          rememberWorkspaceGraph(rootId, graph)
          return graph
        },
        (graph) => graph.available,
      )
      // The board's own read of the sheet, when it is recent enough, costs nothing.
      return (rootId: string) => Promise.resolve(recentWorkspaceGraph(rootId, WORKSPACE_MAP_TTL_MS) ?? read(rootId))
    })(),
    knowledgeFolders: async (rootId) => {
      const result = await askDeps
        .runCli(rootId, ['workspace', 'status', '--target', rootId, '--json'], { timeoutMs: WORKSPACE_STATUS_TIMEOUT_MS })
        .catch(() => null)
      return result !== null && result.ok ? parseKnowledgeFolders(result.stdout) : new Map<string, string>()
    },
    knownRoots,
  }

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('ask:start', async (request) => {
    if (!isKnownRoot(deps.roots, request.rootId)) return { ok: false, detail: PROJECT_NOT_OPEN }
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') return { ok: false, detail: NO_QUESTION }
    const tags = strings(request.tags)
    // A Workspace ask is gated into its project→root map before anything runs.
    let scope: AskResolvedScope | undefined
    const requested = request.workspace
    if (requested !== null && requested !== undefined) {
      if (typeof requested !== 'object' || typeof requested.workspace !== 'string' || !PROJECT_SLUG.test(requested.workspace)) {
        return { ok: false, detail: WORKSPACE_NOT_OPEN }
      }
      const resolved = await resolveAskScope(request.rootId, { workspace: requested.workspace, projects: strings(requested.projects) }, tags, scopeReads)
      if (!resolved.ok) return resolved
      scope = resolved.scope
    }
    const askId = `ask-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const stop = new AbortController()
    running.set(askId, stop)
    const followUpOf = typeof request.followUpOf === 'string' && request.followUpOf.trim() !== '' ? request.followUpOf.trim() : null
    // After this reply leaves: the renderer learns the id before its first state.
    setTimeout(() => {
      void runAsk(
        {
          askId,
          rootId: request.rootId,
          question,
          tags,
          conversationIds: strings(request.conversationIds),
          followUpOf,
          stopSignal: stop.signal,
          ...(scope !== undefined ? { workspace: { workspace: scope.workspace.slug, projects: scope.projects.map((p) => p.slug) }, scope } : {}),
        },
        askDeps,
      ).finally(() => running.delete(askId))
    }, 0)
    return { ok: true, askId }
  })

  handle('ask:stop', ({ askId }) => {
    const run = running.get(askId)
    if (run === undefined) return { stopped: false }
    run.abort()
    return { stopped: true }
  })

  handle('ask:list', async (request) => {
    if (!isKnownRoot(deps.roots, request.rootId)) return { ok: false, detail: PROJECT_NOT_OPEN }
    if (request.workspace !== null && request.workspace !== undefined) {
      const scope = workspaceListScope(request.workspace)
      if (scope === null) return { ok: false, detail: WORKSPACE_NOT_OPEN }
      const result = await askDeps.runCli(
        request.rootId,
        ['blueprint', 'qa', 'list', '--workspace', scope.workspace, '--target', request.rootId, ...scope.tags.flatMap((tag) => [`--tag=${tag}`]), '--json'],
        { timeoutMs: QA_READ_TIMEOUT_MS },
      )
      const parsed = result.ok ? lastJsonObject(result.stdout) : null
      if (parsed === null || !Array.isArray(parsed.threads)) {
        return { ok: false, detail: withoutCommandHint(refusalSentence(result) ?? LIST_FAILED) }
      }
      const threads = parsed.threads.map(toSavedThread).filter((thread): thread is AskSavedThread => thread !== null)
      return { ok: true, threads: threads.sort((a, b) => b.ts.localeCompare(a.ts)) }
    }
    const features = [...new Set(strings(request.featureIds))].slice(0, MAX_LIST_FEATURES)
    if (features.length === 0) return { ok: true, threads: [] }
    const byId = new Map<string, AskSavedThread>()
    let failure: string | null = null
    for (const feature of features) {
      const result = await askDeps.runCli(
        request.rootId,
        ['blueprint', 'qa', 'list', '--feature', feature, '--json'],
        { timeoutMs: QA_READ_TIMEOUT_MS },
      )
      const parsed = result.ok ? lastJsonObject(result.stdout) : null
      if (parsed === null || !Array.isArray(parsed.threads)) {
        failure = refusalSentence(result) ?? LIST_FAILED
        continue
      }
      for (const raw of parsed.threads) {
        const thread = toSavedThread(raw)
        if (thread !== null && !byId.has(thread.id)) byId.set(thread.id, thread)
      }
    }
    if (byId.size === 0 && failure !== null) return { ok: false, detail: withoutCommandHint(failure) }
    const threads = [...byId.values()].sort((a, b) => b.ts.localeCompare(a.ts))
    return { ok: true, threads }
  })

  handle('ask:stale', async (request) => {
    if (!isKnownRoot(deps.roots, request.rootId)) return { ok: false, detail: PROJECT_NOT_OPEN }
    const workspace = request.workspace !== null && request.workspace !== undefined ? workspaceListScope(request.workspace) : null
    if (request.workspace !== null && request.workspace !== undefined && workspace === null) return { ok: false, detail: WORKSPACE_NOT_OPEN }
    const feature = typeof request.featureId === 'string' && request.featureId.trim() !== '' ? request.featureId.trim() : null
    const args =
      workspace !== null
        ? ['blueprint', 'qa', 'stale', '--workspace', workspace.workspace, '--target', request.rootId, ...workspace.tags.map((tag) => `--tag=${tag}`), '--json']
        : ['blueprint', 'qa', 'stale', ...(feature !== null ? ['--feature', feature] : []), '--json']
    const result = await askDeps.runCli(request.rootId, args, { timeoutMs: QA_READ_TIMEOUT_MS })
    const parsed = result.ok ? lastJsonObject(result.stdout) : null
    if (parsed === null || !Array.isArray(parsed.results)) {
      return { ok: false, detail: withoutCommandHint(refusalSentence(result) ?? STALE_FAILED) }
    }
    const results: AskStaleResult[] = []
    for (const raw of parsed.results) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      if (typeof item.id !== 'string') continue
      results.push({
        id: item.id,
        stale: item.stale === true,
        changedFiles: strings(item.changedFiles),
        missingFiles: strings(item.missingFiles),
        ...(workspace !== null ? { notChecked: strings(item.notChecked) } : {}),
      })
    }
    return { ok: true, results }
  })

  // Save as connection — the ONLY way a suggested connection is recorded, and
  // only through the Workspace's one link writer (allowed-pattern #14).
  handle('ask:saveConnection', async (request) => {
    if (!isKnownRoot(deps.roots, request.rootId)) return { ok: false, detail: PROJECT_NOT_OPEN }
    if (typeof request.workspace !== 'string' || !PROJECT_SLUG.test(request.workspace)) return { ok: false, detail: WORKSPACE_NOT_OPEN }
    const connection = validConnection(request.connection)
    if (connection === null) return { ok: false, detail: CONNECTION_INVALID }
    const result = await askDeps
      .runCli(
        request.rootId,
        [
          'workspace',
          'link-knowledge',
          '--target',
          request.rootId,
          '--workspace',
          request.workspace,
          `--from=${connection.from}`,
          `--to=${connection.to}`,
          `--kind=${connection.kind}`,
          ...(connection.note !== undefined ? [`--note=${connection.note}`] : []),
          '--json',
        ],
        { timeoutMs: LINK_TIMEOUT_MS },
      )
      .catch(() => null)
    const parsed = result !== null && result.ok ? lastJsonObject(result.stdout) : null
    if (parsed === null || parsed.action !== 'link-knowledge' || typeof parsed.refused === 'string') {
      const why = result === null ? null : refusalSentence(result)
      return { ok: false, detail: why === null ? CONNECTION_FAILED : `${CONNECTION_FAILED} ${capitalized(withoutCommandHint(why))}` }
    }
    return { ok: true, recorded: parsed.recorded === true }
  })

  return function disposeAskChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
    for (const run of running.values()) run.abort()
    running.clear()
  }
}
