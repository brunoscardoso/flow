// DOCKER DATA KEPT FROM DELETED THREADS — what the Storage page lists, and the
// one call that deletes it.
//
// "KEPT" IS A DIFFERENCE OF TWO LISTS. Docker labels are the record
// (`compose-thread.ts`), so a Flow volume whose thread id has no record in the
// thread store belongs to a conversation that was deleted with its data left in
// place. Nothing here keeps a table of its own.
//
// READS happen only while the Storage page is open (allowed-pattern #17), and
// only ask Docker about projects that have a Compose file — a project without
// one never spawns `docker`. Docker closed is a typed answer
// (`dockerAvailable: false`), never a failure.
//
// DELETING runs NOTHING without `confirmed === true` (forbidden-pattern #15),
// refuses a thread that still exists (this path is only for deleted ones —
// a live thread's data goes through its own panel), and refuses a project that
// is not one of the Compose projects. The removal itself is `removeThreadVolumes`,
// which refuses again without the same confirmation and while its services run.
// Every sentence names no command, path or setting (forbidden-pattern #12).

import { LABEL_PROJECT, LABEL_THREAD, projectDataSlug, sanitizeProjectSlug } from './compose-thread'
import { DOCKER_LIST_TIMEOUT_MS, listProjectVolumes, removeThreadVolumes, volumeSizes, type FlowVolume } from './compose-thread-store'
import { dockerAvailability, type DockerRunner } from './docker-runner'
import type { RunKeptData, RunKeptDataItem, RunThreadDataAnswer } from '../../shared/run-setup'

/** Stopping a deleted conversation's leftover containers. */
const DOCKER_STOP_TIMEOUT_MS = 2 * 60_000

export const KEPT_DATA_SENTENCE = {
  unconfirmed: "Deleting a thread's data needs an explicit confirmation.",
  stillExists: 'This thread still exists, so its data is not kept data. Use its own data panel instead.',
  unknownProject: "Flow can't find the project this data belongs to.",
} as const

export interface KeptDataDeps {
  runner: DockerRunner
  /** The projects on this computer that have a Compose file. */
  projects: () => Promise<Array<{ root: string; name: string }>>
  /** The thread's record, or null when no thread of that id exists. */
  lookupThread: (threadId: string) => { title: string | null } | null
  slugOf?: (projectRoot: string) => string
}

/**
 * Group one project's volumes into kept items: a volume with a thread label
 * that no thread answers to. Volumes without a label are not Flow's to
 * judge and are left out. Largest first, so the cost is at the top.
 */
export function groupKeptVolumes(
  project: { root: string; name: string },
  volumes: readonly FlowVolume[],
  lookupThread: (threadId: string) => { title: string | null } | null,
): RunKeptDataItem[] {
  const byThread = new Map<string, RunKeptDataItem>()
  for (const volume of volumes) {
    if (volume.threadId === null) continue
    const thread = lookupThread(volume.threadId)
    if (thread !== null) continue
    let item = byThread.get(volume.threadId)
    if (item === undefined) {
      item = { threadId: volume.threadId, projectRoot: project.root, projectName: project.name, title: null, volumes: [], totalBytes: 0 }
      byThread.set(volume.threadId, item)
    }
    item.volumes.push({ volume: volume.volume, sizeBytes: volume.sizeBytes })
    item.totalBytes = item.totalBytes === null || volume.sizeBytes === null ? null : item.totalBytes + volume.sizeBytes
  }
  return [...byThread.values()].sort((a, b) => (b.totalBytes ?? -1) - (a.totalBytes ?? -1))
}

/** Every deleted thread's kept data across the Compose projects. Never throws. */
export async function readKeptData(deps: KeptDataDeps): Promise<RunKeptData> {
  let projects: Array<{ root: string; name: string }> = []
  try {
    projects = await deps.projects()
  } catch {
    projects = []
  }
  // No project with a Compose file: there is nothing to ask Docker, not even whether it runs.
  if (projects.length === 0) return { dockerAvailable: true, items: [] }
  let availability
  try {
    availability = await dockerAvailability(deps.runner)
  } catch {
    return { dockerAvailable: false, items: [] }
  }
  if (!availability.available) return { dockerAvailable: false, items: [] }
  const slugOf = deps.slugOf ?? projectDataSlug
  // Listed without sizes per project; the sizes come from ONE scan of every
  // volume, asked only when there is something to size.
  const listedByProject: Array<{ project: { root: string; name: string }; volumes: FlowVolume[] }> = []
  for (const project of projects) {
    try {
      const listed = await listProjectVolumes(deps.runner, slugOf(project.root), { sizes: false })
      if (listed.ok && listed.items.length > 0) listedByProject.push({ project, volumes: listed.items })
    } catch {
      // unreadable: nothing from this project
    }
  }
  const sizes = listedByProject.length > 0 ? await volumeSizes(deps.runner) : new Map<string, number | null>()
  const items: RunKeptDataItem[] = []
  for (const { project, volumes } of listedByProject) {
    const sized = volumes.map((volume) => ({ ...volume, sizeBytes: sizes.get(volume.name) ?? null }))
    items.push(...groupKeptVolumes(project, sized, deps.lookupThread))
  }
  return { dockerAvailable: true, items }
}

/** Delete one deleted thread's data in one project. Runs nothing unless confirmed. */
export async function deleteKeptData(
  deps: KeptDataDeps,
  request: { threadId: string; projectRoot: string; confirmed?: unknown },
): Promise<RunThreadDataAnswer> {
  if (request.confirmed !== true) return { ok: false, detail: KEPT_DATA_SENTENCE.unconfirmed }
  if (deps.lookupThread(request.threadId) !== null) return { ok: false, detail: KEPT_DATA_SENTENCE.stillExists }
  let projects: Array<{ root: string; name: string }> = []
  try {
    projects = await deps.projects()
  } catch {
    projects = []
  }
  if (!projects.some((project) => project.root === request.projectRoot)) {
    return { ok: false, detail: KEPT_DATA_SENTENCE.unknownProject }
  }
  const slugOf = deps.slugOf ?? projectDataSlug
  const slug = slugOf(request.projectRoot)
  // The conversation is gone, so nothing else can stop its services: a
  // container still running (a delete while they ran) is stopped here, by
  // this conversation's labels only, before its data is removed.
  const running = await deps.runner.run(
    ['ps', '-q', '--filter', `label=${LABEL_PROJECT}=${sanitizeProjectSlug(slug)}`, '--filter', `label=${LABEL_THREAD}=${request.threadId}`],
    { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
  )
  const ids = running.ok ? running.stdout.split(/\s+/).filter((id) => id !== '') : []
  if (ids.length > 0) await deps.runner.run(['stop', ...ids], { timeoutMs: DOCKER_STOP_TIMEOUT_MS })
  const result = await removeThreadVolumes(deps.runner, slug, request.threadId, { confirmed: true })
  return result.ok ? { ok: true } : { ok: false, detail: result.detail }
}
