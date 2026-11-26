/**
 * A THREAD'S DOCKER DATA — its volumes and their sizes, whose data is live, the
 * override file Flow writes for its run, and removing its volumes.
 *
 * NO TABLE OF ITS OWN. Docker labels are the record (`compose-thread.ts` puts
 * them on every volume and container of a thread's run), so what is listed is
 * what Docker holds — a volume removed by hand simply stops being listed.
 *
 * EVERY DOCKER CALL GOES THROUGH THE INJECTED RUNNER (`docker-runner.ts`):
 * async, with a timeout, argv only. Tests hand in a table of expected argv.
 *
 * DESTRUCTIVE CALLS NEED A CONFIRMATION THE CALLER SPELLS OUT
 * (forbidden-pattern #15). `removeThreadVolumes` and `emptyThreadData` do
 * nothing — no Docker call at all — unless handed `{ confirmed: true }`.
 *
 * WHAT A REMOVAL DOES, AND WHEN IT REFUSES. Docker refuses to remove a volume
 * any container still references, running or stopped. So a removal:
 *   1. refuses while any of the thread's containers is RUNNING. Stopping them
 *      is the run supervisor's job (it knows the Compose project and stops the
 *      whole group); this store never stops a live run behind its back.
 *   2. removes the thread's STOPPED containers (only ones carrying its label —
 *      a Run recreates them anyway), then
 *   3. removes the volumes labelled with the thread.
 * Reset data is the same removal: the next Run creates the volumes empty, and
 * the seeds run again because the volume is new.
 *
 * App reset removes the override folder (`reset-steps.ts`, Run setups item).
 * It does NOT remove volumes: those are removed per thread, with confirmation.
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import type { ThreadComposePlan } from './compose-thread'
import { LABEL_PROJECT, LABEL_THREAD, LABEL_VOLUME, sanitizeProjectSlug, serializeComposeOverride, threadIdPrefix } from './compose-thread'
import type { DockerRunner } from './docker-runner'

/** The folder, inside the app's data folder, that holds every thread's override file. */
export const COMPOSE_OVERRIDES_DIR = 'compose-overrides'

/** Listing calls. */
export const DOCKER_LIST_TIMEOUT_MS = 15_000
/** Sizes read every volume on the computer; give it room, and fall back to "unknown". */
export const DOCKER_SIZE_TIMEOUT_MS = 30_000
/** Removing containers and volumes. */
export const DOCKER_REMOVE_TIMEOUT_MS = 60_000

// ─── shapes ──────────────────────────────────────────────────────────────────

export interface FlowVolume {
  /** The Docker volume's name. */
  name: string
  /** The project's own volume it stands in for, as the Compose file writes it. */
  volume: string
  /** The thread it belongs to (its full id, from the label); null when the label is missing. */
  threadId: string | null
  /** Bytes on disk; null when Docker did not say. */
  sizeBytes: number | null
}

export interface ThreadContainer {
  id: string
  /** The Compose service it runs; null when the label is missing. */
  service: string | null
  /** Docker's state word: running, exited, created, restarting, … */
  state: string
}

export type ListResult<T> = { ok: true; items: T[] } | { ok: false; detail: string }

export type RemoveResult = { ok: true; removed: string[] } | { ok: false; detail: string }

export interface Confirmation {
  confirmed?: unknown
}

const SENTENCE = {
  unconfirmed: "Removing a conversation's data needs an explicit confirmation.",
  unconfirmedReset: "Resetting a conversation's data needs an explicit confirmation.",
  noAnswer: "Docker didn't answer, so Flow couldn't read this conversation's data.",
  running: "This conversation's services are running. Stop them first, then remove its data.",
  containers: "Docker couldn't remove this conversation's stopped services, so its data was kept.",
  volumes: "Docker couldn't remove some of this conversation's data.",
} as const

// ─── reading ─────────────────────────────────────────────────────────────────

const filter = (key: string, value: string): string[] => ['--filter', `label=${key}=${value}`]

/** `docker volume ls` with one line per volume: name, project volume, thread. */
async function listVolumes(runner: DockerRunner, filters: string[]): Promise<ListResult<Omit<FlowVolume, 'sizeBytes'>>> {
  const result = await runner.run(
    ['volume', 'ls', ...filters, '--format', `{{.Name}}\t{{.Label "${LABEL_VOLUME}"}}\t{{.Label "${LABEL_THREAD}"}}`],
    { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
  )
  if (!result.ok) return { ok: false, detail: SENTENCE.noAnswer }
  const items = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', volume = '', thread = ''] = line.split('\t')
      return { name, volume: volume === '' ? name : volume, threadId: thread === '' ? null : thread }
    })
    .filter((item) => item.name !== '')
  return { ok: true, items }
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
}

/** Docker's human sizes ("0B", "12.3kB", "1.5GB", "512MiB") in bytes; null for anything else ("N/A", ""). */
export function parseDockerSize(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.round(text) : null
  if (typeof text !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(text)
  if (match === null) return null
  const unit = UNITS[(match[2] === '' ? 'b' : match[2]!).toLowerCase()]
  if (unit === undefined) return null
  return Math.round(Number(match[1]) * unit)
}

/**
 * Volume sizes from `docker system df -v --format json`. Docker versions print
 * this as one object with a `Volumes` array, as one object per line, or as an
 * array — every shape is read; anything unreadable is skipped.
 */
export function parseVolumeSizes(stdout: string): Map<string, number | null> {
  const sizes = new Map<string, number | null>()
  const take = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null) return
    const record = entry as Record<string, unknown>
    if (Array.isArray(record['Volumes'])) {
      for (const volume of record['Volumes']) take(volume)
      return
    }
    const name = record['Name']
    if (typeof name !== 'string' || name === '') return
    const raw = record['Size'] ?? (record['UsageData'] as Record<string, unknown> | undefined)?.['Size']
    sizes.set(name, parseDockerSize(raw))
  }
  const parse = (text: string): void => {
    try {
      const value: unknown = JSON.parse(text)
      if (Array.isArray(value)) value.forEach(take)
      else take(value)
    } catch {
      // not JSON: skipped
    }
  }
  const whole = stdout.trim()
  if (whole === '') return sizes
  if (whole.startsWith('[')) {
    parse(whole)
    return sizes
  }
  for (const line of whole.split(/\r?\n/)) {
    if (line.trim() !== '') parse(line.trim())
  }
  if (sizes.size === 0) parse(whole)
  return sizes
}

/** Every volume's size, or an empty map when Docker did not answer — a size is orientation, never a gate. */
/** Every volume's size on this computer — one slow call; callers that list many projects ask it once. */
export async function volumeSizes(runner: DockerRunner): Promise<Map<string, number | null>> {
  try {
    const result = await runner.run(['system', 'df', '-v', '--format', 'json'], { timeoutMs: DOCKER_SIZE_TIMEOUT_MS })
    return result.ok ? parseVolumeSizes(result.stdout) : new Map()
  } catch {
    return new Map()
  }
}

async function withSizes(
  runner: DockerRunner,
  listed: ListResult<Omit<FlowVolume, 'sizeBytes'>>,
  sized: boolean,
): Promise<ListResult<FlowVolume>> {
  if (!listed.ok) return listed
  if (listed.items.length === 0 || !sized) return { ok: true, items: listed.items.map((item) => ({ ...item, sizeBytes: null })) }
  const sizes = await volumeSizes(runner)
  return { ok: true, items: listed.items.map((item) => ({ ...item, sizeBytes: sizes.get(item.name) ?? null })) }
}

export interface ListOptions {
  /** Read sizes too (one more, slower Docker call). Default true. */
  sizes?: boolean
}

/** One thread's volumes in one project, with sizes. */
export async function listThreadVolumes(
  runner: DockerRunner,
  projectSlug: string,
  threadId: string,
  options: ListOptions = {},
): Promise<ListResult<FlowVolume>> {
  const listed = await listVolumes(runner, [
    ...filter(LABEL_PROJECT, sanitizeProjectSlug(projectSlug)),
    ...filter(LABEL_THREAD, threadId),
  ])
  return withSizes(runner, listed, options.sizes !== false)
}

/** Every volume Flow made for one project, every thread's — the Storage inventory reads this. */
export async function listProjectVolumes(
  runner: DockerRunner,
  projectSlug: string,
  options: ListOptions = {},
): Promise<ListResult<FlowVolume>> {
  const listed = await listVolumes(runner, filter(LABEL_PROJECT, sanitizeProjectSlug(projectSlug)))
  return withSizes(runner, listed, options.sizes !== false)
}

/** A thread's containers (running or not) in one project. */
export async function listThreadContainers(
  runner: DockerRunner,
  projectSlug: string,
  threadId: string,
): Promise<ListResult<ThreadContainer>> {
  const result = await runner.run(
    [
      'ps',
      '--all',
      ...filter(LABEL_PROJECT, sanitizeProjectSlug(projectSlug)),
      ...filter(LABEL_THREAD, threadId),
      '--format',
      '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}',
    ],
    { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
  )
  if (!result.ok) return { ok: false, detail: SENTENCE.noAnswer }
  const items = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [id = '', service = '', state = ''] = line.split('\t')
      return { id, service: service === '' ? null : service, state: state.toLowerCase() }
    })
    .filter((item) => item.id !== '')
  return { ok: true, items }
}

export type LiveThreadResult = { ok: true; threadId: string | null } | { ok: false; detail: string }

/**
 * Whose data is live in a project: the thread label on its RUNNING containers.
 * Null when none runs (or only a run outside any thread, which carries no
 * label). When containers disagree — a half-finished switch — the thread most
 * of them carry wins, ties broken by the first listed.
 */
export async function liveThread(runner: DockerRunner, projectSlug: string): Promise<LiveThreadResult> {
  const result = await runner.run(
    ['ps', ...filter(LABEL_PROJECT, sanitizeProjectSlug(projectSlug)), '--format', `{{.Label "${LABEL_THREAD}"}}`],
    { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
  )
  if (!result.ok) return { ok: false, detail: SENTENCE.noAnswer }
  const counts = new Map<string, number>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const id = line.trim()
    if (id !== '') counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  let best: string | null = null
  let most = 0
  for (const [id, count] of counts) {
    if (count > most) {
      best = id
      most = count
    }
  }
  return { ok: true, threadId: best }
}

// ─── removing ────────────────────────────────────────────────────────────────

async function removeThread(
  runner: DockerRunner,
  projectSlug: string,
  threadId: string,
): Promise<RemoveResult> {
  const containers = await listThreadContainers(runner, projectSlug, threadId)
  if (!containers.ok) return containers
  if (containers.items.some((container) => container.state === 'running' || container.state === 'restarting')) {
    return { ok: false, detail: SENTENCE.running }
  }
  const volumes = await listVolumes(runner, [
    ...filter(LABEL_PROJECT, sanitizeProjectSlug(projectSlug)),
    ...filter(LABEL_THREAD, threadId),
  ])
  if (!volumes.ok) return volumes

  if (containers.items.length > 0) {
    // Plain `rm`, never forced: a container that started meanwhile is refused by Docker, not killed.
    const removed = await runner.run(['rm', ...containers.items.map((container) => container.id)], {
      timeoutMs: DOCKER_REMOVE_TIMEOUT_MS,
    })
    if (!removed.ok) return { ok: false, detail: SENTENCE.containers }
  }
  const names = volumes.items.map((volume) => volume.name)
  if (names.length === 0) return { ok: true, removed: [] }
  const removed = await runner.run(['volume', 'rm', ...names], { timeoutMs: DOCKER_REMOVE_TIMEOUT_MS })
  if (!removed.ok) return { ok: false, detail: SENTENCE.volumes }
  return { ok: true, removed: names }
}

/**
 * Remove every volume of one thread in one project. Runs NOTHING unless
 * `confirmation.confirmed === true` — a call with defaults is a refusal, never
 * a deletion (forbidden-pattern #15).
 */
export async function removeThreadVolumes(
  runner: DockerRunner,
  projectSlug: string,
  threadId: string,
  confirmation: Confirmation = {},
): Promise<RemoveResult> {
  if (confirmation.confirmed !== true) return { ok: false, detail: SENTENCE.unconfirmed }
  return removeThread(runner, projectSlug, threadId)
}

/**
 * Empty a thread's data so its next Run starts fresh (and seeds again). The
 * same removal as `removeThreadVolumes` — the next Run creates the volumes —
 * with the same rules: nothing without `{ confirmed: true }`, and a refusal
 * while its services run (the supervisor stops them first).
 */
export async function emptyThreadData(
  runner: DockerRunner,
  projectSlug: string,
  threadId: string,
  confirmation: Confirmation = {},
): Promise<RemoveResult> {
  if (confirmation.confirmed !== true) return { ok: false, detail: SENTENCE.unconfirmedReset }
  return removeThread(runner, projectSlug, threadId)
}

// ─── the override file ───────────────────────────────────────────────────────

/** The filesystem calls the override files need (node's `fs.promises` shape). */
export interface OverrideFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

export interface OverrideFiles {
  /** Where a thread's override for one project lives. */
  pathFor(projectSlug: string, threadId: string): string
  /** Write the plan's override; answers the file's path. Throws when it cannot be written. */
  write(plan: ThreadComposePlan): Promise<string>
  /** Remove a thread's override for one project. Never throws. */
  remove(projectSlug: string, threadId: string): Promise<void>
}

/**
 * The override files, under `<dir>` — the app's data folder joined with
 * `COMPOSE_OVERRIDES_DIR`, passed in REQUIRED so a test can only ever write
 * into its own temp folder.
 */
export function createOverrideFiles(options: { dir: string; fs?: OverrideFs }): OverrideFiles {
  const fs: OverrideFs = options.fs ?? (nodeFs as unknown as OverrideFs)
  const folderFor = (projectSlug: string): string => join(options.dir, sanitizeProjectSlug(projectSlug))
  const pathFor = (projectSlug: string, threadId: string): string =>
    join(folderFor(projectSlug), `${threadIdPrefix(threadId)}.yml`)
  return {
    pathFor,
    write: async (plan) => {
      const path = pathFor(plan.projectSlug, plan.threadId)
      await fs.mkdir(folderFor(plan.projectSlug), { recursive: true, mode: 0o700 })
      await fs.writeFile(path, serializeComposeOverride(plan.override), { mode: 0o600 })
      return path
    },
    remove: async (projectSlug, threadId) => {
      try {
        await fs.rm(pathFor(projectSlug, threadId), { force: true })
      } catch {
        // already gone, or unreadable: nothing to do
      }
    },
  }
}
