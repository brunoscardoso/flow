// A CONVERSATION'S DOCKER DATA, AS THE SCREENS SEE IT — the Manage containers
// panel's read and its two actions, which conversations' data is live (the
// thread list's mark), and whose data is live instead of this conversation's
// (the Run menu's Docker section, before a switch).
//
// READS are paid only while a surface is on screen (allowed-pattern #17): the
// panel asks while it is open, the thread list while it is visible, the Run
// menu when it opens. Docker is asked only for projects that have a Compose
// file — a project without one never spawns `docker` (NFR-5). Every call goes through the injected
// runner: async, with a timeout (allowed-pattern #19).
//
// RESET runs NOTHING without `confirmed: true` (forbidden-pattern #15). It
// stops the conversation's services first (the removal refuses while they
// run), then empties each project's volumes through `emptyThreadData`, which
// itself refuses without the same confirmation.
//
// Every sentence is shown to a person and names no command, path or setting
// (forbidden-pattern #12). A shared folder is named by its last part only.

import type { RunDockerElsewhere, RunThreadData, RunThreadDataAnswer, RunScope, RunGroupState } from '../../shared/run-setup'
import { projectDataSlug } from './compose-thread'
import { listThreadContainers, listThreadVolumes, liveThread, emptyThreadData } from './compose-thread-store'
import type { DockerRunner } from './docker-runner'
import type { DockerGroupPlan } from './thread-docker'

export const THREAD_DATA_SENTENCE = {
  noAnswer: "Docker didn't answer, so this conversation's data can't be shown right now.",
  unconfirmed: "Resetting a conversation's data needs an explicit confirmation.",
  unknownThread: "Flow can't find this conversation any more.",
  nothing: "This conversation doesn't keep data of its own in Docker.",
} as const

export interface ThreadDataDeps {
  runner: DockerRunner
  /**
   * The conversation's Docker groups — one per project with a readable
   * Compose file. Null when the conversation is unknown.
   */
  groupsOf: (threadId: string) => Promise<DockerGroupPlan[] | null>
  /** `RunSupervisor.stopThreadDocker`. */
  stopThreadDocker: (threadId: string) => Promise<boolean>
  slugOf?: (projectRoot: string) => string
}

/** The last part of a folder's path ("uploads"), never the path itself. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  return parts[parts.length - 1] ?? ''
}

/**
 * What the panel shows for one conversation: its services and their state,
 * its volumes with sizes, whether its data is the live one, and the folders it
 * shares. Null when it keeps no Docker data at all. Never throws.
 */
export async function readThreadData(deps: ThreadDataDeps, threadId: string): Promise<RunThreadData | null> {
  const slugOf = deps.slugOf ?? projectDataSlug
  let groups: DockerGroupPlan[] | null
  try {
    groups = await deps.groupsOf(threadId)
  } catch {
    groups = null
  }
  if (groups === null || groups.length === 0) return null
  const out: RunThreadData = {
    threadId,
    live: false,
    services: [],
    volumes: [],
    totalBytes: 0,
    sharedFolders: [],
    unreadable: [],
    problem: null,
  }
  for (const { group, plan } of groups) {
    const slug = slugOf(group.projectRoot)
    out.unreadable.push(...group.unreadable.map((entry) => ({ ...entry })))
    for (const bind of plan.sharedBinds) {
      const name = folderName(bind.source)
      if (name !== '' && !out.sharedFolders.includes(name)) out.sharedFolders.push(name)
    }
    try {
      const [live, containers, volumes] = await Promise.all([
        liveThread(deps.runner, slug),
        listThreadContainers(deps.runner, slug, threadId),
        listThreadVolumes(deps.runner, slug, threadId),
      ])
      if (live.ok && live.threadId === threadId) out.live = true
      const states = new Map<string, string>()
      if (containers.ok) for (const container of containers.items) if (container.service !== null) states.set(container.service, container.state)
      for (const service of group.services) {
        out.services.push({ projectName: group.projectName, service, state: states.get(service) ?? null })
      }
      if (!volumes.ok || !containers.ok || !live.ok) out.problem = THREAD_DATA_SENTENCE.noAnswer
      if (volumes.ok) {
        for (const volume of volumes.items) {
          const planned = plan.volumes.find((candidate) => candidate.name === volume.name)
          const service = planned?.services.find((name) => group.dataServices.includes(name)) ?? planned?.services[0] ?? null
          out.volumes.push({ projectName: group.projectName, volume: volume.volume, service, sizeBytes: volume.sizeBytes })
          out.totalBytes = out.totalBytes === null || volume.sizeBytes === null ? null : out.totalBytes + volume.sizeBytes
        }
      }
    } catch {
      out.problem = THREAD_DATA_SENTENCE.noAnswer
      for (const service of group.services) out.services.push({ projectName: group.projectName, service, state: null })
    }
  }
  if (out.problem !== null && out.volumes.length === 0) out.totalBytes = null
  return out
}

/**
 * Empty a conversation's data so its next Run starts fresh: stop its services,
 * then remove its volumes in every project. Nothing runs without
 * `confirmed: true`.
 */
export async function emptyThreadDataOf(
  deps: ThreadDataDeps,
  threadId: string,
  request: { confirmed?: unknown } = {},
): Promise<RunThreadDataAnswer> {
  if (request.confirmed !== true) return { ok: false, detail: THREAD_DATA_SENTENCE.unconfirmed }
  const slugOf = deps.slugOf ?? projectDataSlug
  let groups: DockerGroupPlan[] | null
  try {
    groups = await deps.groupsOf(threadId)
  } catch {
    groups = null
  }
  if (groups === null) return { ok: false, detail: THREAD_DATA_SENTENCE.unknownThread }
  if (groups.length === 0) return { ok: false, detail: THREAD_DATA_SENTENCE.nothing }
  try {
    await deps.stopThreadDocker(threadId)
  } catch {
    // a failed stop surfaces as the removal's own refusal below
  }
  for (const { group } of groups) {
    const result = await emptyThreadData(deps.runner, slugOf(group.projectRoot), threadId, { confirmed: true })
    if (!result.ok) return { ok: false, detail: result.detail }
  }
  return { ok: true }
}

/** The slice of the run supervisor a restart drives. */
export interface RestartSupervisor {
  state(scope: RunScope): RunGroupState
  reload(scope: RunScope, stepKey?: string, force?: boolean): Promise<RunGroupState>
  startDocker(scope: RunScope): Promise<RunGroupState>
}

/**
 * Restart a conversation's services: while its Docker steps are going, each
 * is reloaded in its own tab. When none is (never started, stopped, switched
 * away, or emptied by Reset data), the conversation's Docker is started —
 * that is the switch, so its data becomes the live one and the data steps run
 * again; the steps that run on this computer are left alone.
 */
export async function restartThreadDocker(
  supervisor: RestartSupervisor,
  scope: RunScope | null,
): Promise<RunThreadDataAnswer> {
  if (scope === null || scope.threadId === null) return { ok: false, detail: THREAD_DATA_SENTENCE.unknownThread }
  const state = supervisor.state(scope)
  const going = (status: string): boolean => status === 'waiting' || status === 'starting' || status === 'running' || status === 'ready'
  const started = state.steps.filter((step) => step.docker !== undefined && going(step.status))
  if (started.length === 0) {
    await supervisor.startDocker(scope)
    return { ok: true }
  }
  for (const step of started) await supervisor.reload(scope, step.key, true)
  return { ok: true }
}

export interface LiveThreadsDeps {
  runner: DockerRunner
  /** The projects on this computer that have a Compose file. */
  composeRoots: () => Promise<string[]>
  slugOf?: (projectRoot: string) => string
  now?: () => number
}

/** How long one answer is reused: the thread list asks on every run change. */
export const LIVE_THREADS_TTL_MS = 3_000

/**
 * The conversations whose data is live, across every project with a Compose
 * file. Cached briefly (allowed-pattern #20): a burst of run changes asks Docker
 * once. A project Docker cannot answer for contributes nothing.
 */
export function createLiveThreads(deps: LiveThreadsDeps): { read(): Promise<string[]>; forget(): void } {
  const slugOf = deps.slugOf ?? projectDataSlug
  const now = deps.now ?? Date.now
  let cached: { at: number; ids: string[] } | null = null
  let pending: Promise<string[]> | null = null
  const ask = async (): Promise<string[]> => {
    const ids: string[] = []
    let roots: string[] = []
    try {
      roots = await deps.composeRoots()
    } catch {
      roots = []
    }
    for (const root of roots) {
      try {
        const answer = await liveThread(deps.runner, slugOf(root))
        if (answer.ok && answer.threadId !== null && !ids.includes(answer.threadId)) ids.push(answer.threadId)
      } catch {
        // unreadable: nothing from this project
      }
    }
    return ids
  }
  return {
    read() {
      if (cached !== null && now() - cached.at < LIVE_THREADS_TTL_MS) return Promise.resolve([...cached.ids])
      pending ??= ask()
        .then((ids) => {
          cached = { at: now(), ids }
          return [...ids]
        })
        .finally(() => {
          pending = null
        })
      return pending
    },
    forget() {
      cached = null
    },
  }
}

export interface DockerElsewhereDeps {
  runner: DockerRunner
  /** Every project the conversation works in (the primary one first). Empty when the thread is gone. */
  rootsOf: (threadId: string) => string[]
  /** Whether a project has a Compose file — the only projects Docker is asked about. */
  hasCompose: (rootPath: string) => Promise<boolean>
  /** A conversation's title, or null when this computer has no record of it. */
  titleOf: (threadId: string) => string | null
  slugOf?: (projectRoot: string) => string
}

/**
 * Whose Docker data runs instead of this conversation's, in the first project
 * of the conversation where another conversation's is live — or null (none
 * is, this conversation's own is, or Docker did not answer). Asked when the
 * Run menu opens; it reads and never switches anything. Never throws.
 */
export async function readDockerElsewhere(deps: DockerElsewhereDeps, scope: RunScope): Promise<RunDockerElsewhere | null> {
  const threadId = scope.threadId
  if (threadId === null) return null
  const slugOf = deps.slugOf ?? projectDataSlug
  for (const root of deps.rootsOf(threadId)) {
    try {
      if (!(await deps.hasCompose(root))) continue
      const answer = await liveThread(deps.runner, slugOf(root))
      if (!answer.ok || answer.threadId === null || answer.threadId === threadId) continue
      let title: string | null = null
      try {
        title = deps.titleOf(answer.threadId)
      } catch {
        title = null
      }
      return { threadId: answer.threadId, title: title !== null && title.trim() !== '' ? title : null }
    } catch {
      // unreadable: nothing from this project
    }
  }
  return null
}
