// Ask the Blueprint's IPC (plan `ask_the_blueprint`, Phase 2).
//
//   ask:start  — mint an id, answer it at once, run the question in the
//                background; its state streams on `ask:state`.
//   ask:stop   — Stop here: abort that run; it keeps the best answer as partial.
//   ask:list   — saved answers for features or parts, through `blueprint qa list`.
//   ask:stale  — which saved answers have code that changed since, `qa stale`.
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
  AskSavedThread,
  AskStaleResult,
  AskStateEvent,
} from '../../shared/ask-contract'
import { withoutCommandHint } from '../../shared/command-hint'
import type { IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract'
import type { ModelRouting } from '../../shared/model-routing'
import { extractJsonObject, runBundledCliCapturing, runCagedSession } from '../agent/learn-session'
import { searchBrain } from '../brain/query'
import type { RootsProvider } from '../flow/flow-observer'
import { timed } from '../ipc/slow-handler'
import type { ThreadStore } from '../store/thread-store'
import { runGitCapturing } from '../worktree/thread-worktree-runners'
import { gatherAskContext, type AskKnowledgeHit, type AskNote } from './ask-context'
import { refusalSentence, runAsk, type AskDeps } from './ask-orchestrator'
import { foldActiveInvestigations } from './blueprint-observer'
import type { BundledCli } from './derive-runner'
import { runFeatures } from './feature-runner'

const PROJECT_NOT_OPEN = "That project isn't open."
const NO_QUESTION = 'Type a question first.'
const LIST_FAILED = "Saved questions couldn't be read."
const STALE_FAILED = "Flow couldn't check whether the code changed."
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

  const readNotes = async (rootPath: string): Promise<AskNote[]> => {
    const content = await fs
      .readFile(join(rootPath, 'flow', 'brain', '.structure', 'investigations.jsonl'), 'utf8')
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

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('ask:start', (request) => {
    if (!isKnownRoot(deps.roots, request.rootId)) return { ok: false, detail: PROJECT_NOT_OPEN }
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') return { ok: false, detail: NO_QUESTION }
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
          tags: strings(request.tags),
          conversationIds: strings(request.conversationIds),
          followUpOf,
          stopSignal: stop.signal,
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
    const feature = typeof request.featureId === 'string' && request.featureId.trim() !== '' ? request.featureId.trim() : null
    const result = await askDeps.runCli(
      request.rootId,
      ['blueprint', 'qa', 'stale', ...(feature !== null ? ['--feature', feature] : []), '--json'],
      { timeoutMs: QA_READ_TIMEOUT_MS },
    )
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
      })
    }
    return { ok: true, results }
  })

  return function disposeAskChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
    for (const run of running.values()) run.abort()
    running.clear()
  }
}
