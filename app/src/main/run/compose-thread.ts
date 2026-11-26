/**
 * PER-THREAD COMPOSE — the Docker volumes a conversation owns and the Compose
 * override that gives its run those volumes and its own checkout.
 *
 * PURE: a `ComposeDescription` (from `compose-describe.ts`) in, plain data out.
 * Writing the override to disk and calling Docker belong to the main-process
 * store and runner (Phase 2); nothing here touches the fs or a child process.
 *
 * HOW THE OVERRIDE IS MEANT TO BE RUN — the runner must hold these, or the
 * override means something else:
 *
 *   docker compose -p <project name> -f <checkout>/<compose file> [-f <checkout>/<project override>]
 *                  -f <thread override> --project-directory <checkout>
 *                  up --renew-anon-volumes …
 *
 * - `--project-directory <checkout>`: relative binds in the BASE file (`./src`,
 *   `./pgdata`) then resolve inside the thread's checkout, so they are already
 *   per thread and the override leaves them alone. Relative paths in an
 *   override resolve against the override file's own folder, which is Flow's
 *   data folder — so every host path this module writes is absolute.
 * - The same Compose project name as a run outside any thread, passed with
 *   `-p` (`composeProjectName` in `thread-docker.ts`): without it Compose names
 *   the project after `--project-directory`, i.e. the checkout's folder, and
 *   every thread would be a different project. Threads reuse the project's
 *   container names and ports on purpose: a switch is a recreate, and only one
 *   thread's data is live at a time.
 * - `--renew-anon-volumes`: Docker keeps anonymous volumes across a recreate —
 *   including the ones an image declares itself — so without it one thread's
 *   data would survive into the next.
 * - The project's own override file, when it has one, passed explicitly:
 *   Compose skips it as soon as any `-f` is given.
 *
 * WHAT IT REDIRECTS: a named volume a readable service mounts is redirected
 * through the top-level `volumes.<name>.name`, which reaches EVERY service
 * using it at once — an unreadable service that happens to share it too. That
 * is the safe direction: two services that share a volume in the project share
 * the thread's volume, and no thread ever sees another's data. A volume that is
 * shared whatever Flow does (created outside Compose, backed by a host folder)
 * is left as written and reported.
 */
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, normalize, resolve } from 'path'

import type { ComposeDescription, ReadableComposeService } from './compose-describe'
import { DOCKER_VOLUME_NAME } from './compose-describe'

// ─── names and labels ────────────────────────────────────────────────────────

/** Docker label keys Flow puts on a thread's volumes and containers, so it can list them without a table of its own. */
export const LABEL_THREAD = 'dev.planflow.thread'
export const LABEL_PROJECT = 'dev.planflow.project'
export const LABEL_VOLUME = 'dev.planflow.volume'

/** How much of the thread id goes into a name: enough that two threads never meet, short enough to read. */
export const THREAD_ID_PREFIX_LENGTH = 12

/** Lowercase, Docker-safe: anything else becomes `-`, runs collapse, ends are trimmed. */
export function sanitizeProjectSlug(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return clean === '' ? 'project' : clean
}

/** How much of the project folder's hash goes into its slug. */
export const PROJECT_HASH_LENGTH = 6

/**
 * THE project slug every Docker name and label of a project uses — volumes,
 * labels, the override folder, the Storage list. ONE function, so the store,
 * the override and the inventory can never disagree about which project a
 * volume belongs to (allowed-pattern #14).
 *
 * The folder's name (readable) plus a short hash of its full path: two
 * projects that share a folder name on one computer (`~/work/api` and
 * `~/oss/api`) never share a volume. Moving a project's folder gives it a new
 * slug — its old volumes stay listed under the old one until removed.
 */
export function projectDataSlug(projectRoot: string): string {
  const full = resolve(projectRoot)
  const hash = createHash('sha256').update(full).digest('hex').slice(0, PROJECT_HASH_LENGTH)
  return sanitizeProjectSlug(`${basename(full) || 'project'}-${hash}`)
}

/**
 * The thread's part of a name: its id without dashes, first 12 characters.
 * Throws on an id with nothing usable in it — two threads falling back to one
 * name would share data, which is the one thing this feature must not do.
 */
export function threadIdPrefix(threadId: string): string {
  const clean = threadId.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (clean === '') throw new Error(`A thread id with no letters or digits cannot name a volume: '${threadId}'`)
  return clean.slice(0, THREAD_ID_PREFIX_LENGTH)
}

/** The start every volume of this thread shares: `flow-<project>-<thread>-`. */
export function threadVolumePrefix(projectSlug: string, threadId: string): string {
  return `flow-${sanitizeProjectSlug(projectSlug)}-${threadIdPrefix(threadId)}-`
}

/**
 * A thread's volume for one of the project's named volumes:
 * `flow-<project>-<thread id prefix>-<volume>`. Built from the thread's stable
 * id, never its title, so renaming a thread never orphans its data.
 */
export function threadVolumeName(projectSlug: string, threadId: string, volume: string): string {
  const part = volume.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_.]+/, '')
  const name = `${threadVolumePrefix(projectSlug, threadId)}${part === '' ? 'volume' : part}`
  // Every input is sanitized above; this guards the rule itself, not the inputs.
  if (!DOCKER_VOLUME_NAME.test(name)) throw new Error(`Not a valid Docker volume name: '${name}'`)
  return name
}

/** The labels on a thread's containers: whose run this is. */
export function threadLabels(projectSlug: string, threadId: string): Record<string, string> {
  return { [LABEL_THREAD]: threadId, [LABEL_PROJECT]: sanitizeProjectSlug(projectSlug) }
}

/** The labels on one of a thread's volumes: whose it is and which of the project's volumes it stands in for. */
export function threadVolumeLabels(projectSlug: string, threadId: string, volume: string): Record<string, string> {
  return { ...threadLabels(projectSlug, threadId), [LABEL_VOLUME]: volume }
}

// ─── the plan ────────────────────────────────────────────────────────────────

/** A bind mount written in long form, the only form the override uses. */
export interface OverrideBind {
  type: 'bind'
  source: string
  target: string
  read_only?: true
}

/** The override, shaped like the Compose file it is merged onto. */
export interface ComposeOverride {
  services: Record<string, { labels: Record<string, string>; volumes?: OverrideBind[] }>
  volumes: Record<string, { name: string; labels: Record<string, string> }>
}

export interface ThreadVolume {
  /** The project's volume name, as the Compose file writes it. */
  original: string
  /** The thread's Docker volume. */
  name: string
  labels: Record<string, string>
  /** The services that mount it. */
  services: string[]
}

export interface ThreadBind {
  service: string
  source: string
  target: string
}

export interface ThreadPublishedPort {
  service: string
  /** The port on this computer. */
  published: number
  /** The port inside the container. */
  target: number
  /** The address Compose binds it to; null means every address of this computer. */
  hostIp: string | null
  protocol: string
}

export interface ThreadComposePlan {
  threadId: string
  projectSlug: string
  checkout: string
  volumes: ThreadVolume[]
  /** Readable services that keep data in one of the thread's volumes. */
  dataServices: string[]
  appService: string | null
  /** Every service the description could read — the ones the guard may name as the place a migration runs. */
  readableServices: string[]
  /**
   * The host ports this thread's run publishes, with a definite number only:
   * a port Compose picks itself (`published: null`) or one written with a
   * variable (`unresolvedPorts`) is NOT here, because nothing proves which port
   * it will be. The migration guard trusts this list and nothing else.
   */
  publishedPorts: ThreadPublishedPort[]
  /** Where the checkout is mounted in place of the project's code. */
  codeMounts: Array<ThreadBind & { checkoutSource: string }>
  /** Relative binds of the base file: they already resolve inside the checkout, so they are per thread as written. */
  threadBinds: ThreadBind[]
  /** Absolute host binds (and relative ones that climb out of the project): every thread shares them. */
  sharedBinds: Array<ThreadBind & { reason: string }>
  /** Named volumes left shared, each with why. */
  sharedVolumes: Array<{ volume: string; reason: string }>
  /** Services run as written, without data of their own. */
  unreadable: Array<{ service: string; reason: string }>
  /** Services whose anonymous volumes the runner must renew on a switch. */
  anonymousVolumes: Array<{ service: string; target: string }>
  /** File-level things the description did not follow. */
  problems: string[]
  override: ComposeOverride
}

const SHARED_BIND = {
  absolute: 'This folder is on this computer outside the project, so every conversation shares it.',
  outside: "This folder sits beside the conversation's copy of the project, not inside it, so it isn't kept per conversation.",
} as const

export interface ThreadComposeInput {
  project: ComposeDescription
  projectSlug: string
  threadId: string
  /** The thread's checkout of the project — absolute, because override paths do not resolve against the project. */
  checkout: string
}

/**
 * The volumes a thread owns and the override that gives its run those volumes
 * and its checkout. Deterministic: the same description, slug, id and checkout
 * give the same plan.
 */
export function threadComposeOverride(input: ThreadComposeInput): ThreadComposePlan {
  const { project, projectSlug, threadId } = input
  if (!isAbsolute(input.checkout)) throw new Error(`A thread checkout must be an absolute path: '${input.checkout}'`)
  const checkout = normalize(input.checkout)

  const readable = project.services.filter((service): service is ReadableComposeService => service.readable)
  const unreadable = project.services
    .filter((service) => !service.readable)
    .map((service) => ({ service: service.name, reason: service.readable ? '' : service.reason }))

  // A named volume becomes the thread's when a readable service mounts it and
  // its declaration does not make it shared. One Compose forgot to declare is
  // still redirected: Compose would refuse the file without it anyway.
  const declared = new Map(project.volumes.map((decl) => [decl.name, decl.shared]))
  const users = new Map<string, string[]>()
  for (const service of readable) {
    for (const mount of service.volumes) {
      const list = users.get(mount.volume) ?? []
      if (!list.includes(service.name)) list.push(service.name)
      users.set(mount.volume, list)
    }
  }

  const volumes: ThreadVolume[] = []
  const sharedVolumes: Array<{ volume: string; reason: string }> = []
  for (const [original, services] of users) {
    const shared = declared.get(original) ?? null
    if (shared !== null) {
      sharedVolumes.push({ volume: original, reason: shared })
      continue
    }
    volumes.push({
      original,
      name: threadVolumeName(projectSlug, threadId, original),
      labels: threadVolumeLabels(projectSlug, threadId, original),
      services,
    })
  }

  const owned = new Set(volumes.map((volume) => volume.original))
  const dataServices = readable
    .filter((service) => service.volumes.some((mount) => owned.has(mount.volume)))
    .map((service) => service.name)

  const codeMounts: ThreadComposePlan['codeMounts'] = []
  const threadBinds: ThreadBind[] = []
  const sharedBinds: ThreadComposePlan['sharedBinds'] = []
  const anonymousVolumes: ThreadComposePlan['anonymousVolumes'] = []
  const labels = threadLabels(projectSlug, threadId)
  const override: ComposeOverride = { services: {}, volumes: {} }

  for (const service of project.services) {
    // Every service of the run carries the thread's labels, so "whose run is
    // live" can be read off any container — labels change nothing it does.
    override.services[service.name] = { labels: { ...labels } }
  }

  for (const service of readable) {
    const binds: OverrideBind[] = []
    for (const bind of service.binds) {
      const at = { service: service.name, source: bind.source, target: bind.target }
      if (!bind.relative) {
        sharedBinds.push({ ...at, reason: SHARED_BIND.absolute })
      } else if (bind.outside) {
        sharedBinds.push({ ...at, reason: SHARED_BIND.outside })
      } else if (bind.code) {
        // Already true under `--project-directory <checkout>`; written out so
        // the checkout mount does not depend on how the runner was invoked.
        const checkoutSource = join(checkout, bind.source)
        codeMounts.push({ ...at, checkoutSource })
        binds.push({ type: 'bind', source: checkoutSource, target: bind.target, ...(bind.readOnly ? { read_only: true as const } : {}) })
      } else {
        threadBinds.push(at)
      }
    }
    if (binds.length > 0) override.services[service.name]!.volumes = binds
    for (const target of service.anonymousVolumes) anonymousVolumes.push({ service: service.name, target })
  }

  for (const volume of volumes) {
    override.volumes[volume.original] = { name: volume.name, labels: { ...volume.labels } }
  }

  const publishedPorts: ThreadPublishedPort[] = []
  for (const service of readable) {
    for (const port of service.ports) {
      if (port.published === null) continue
      publishedPorts.push({
        service: service.name,
        published: port.published,
        target: port.target,
        hostIp: port.hostIp,
        protocol: port.protocol,
      })
    }
  }

  return {
    threadId,
    projectSlug: sanitizeProjectSlug(projectSlug),
    checkout,
    volumes,
    dataServices,
    appService: project.appService,
    readableServices: readable.map((service) => service.name),
    publishedPorts,
    codeMounts,
    threadBinds,
    sharedBinds,
    sharedVolumes,
    unreadable,
    anonymousVolumes,
    problems: [...project.problems],
    override,
  }
}

// ─── the override as a file ──────────────────────────────────────────────────

/** A YAML double-quoted scalar. JSON's string escapes are a subset of YAML's, so this is always valid. */
const quote = (text: string): string => JSON.stringify(text)

function labelLines(labels: Record<string, string>, indent: string): string[] {
  const keys = Object.keys(labels)
  if (keys.length === 0) return [`${indent}labels: {}`]
  return [`${indent}labels:`, ...keys.map((key) => `${indent}  ${quote(key)}: ${quote(labels[key]!)}`)]
}

/**
 * The override as YAML, for the fixed shape above. Every key and string is
 * double-quoted, so a service called `on` or a path with a `#` reads back as
 * written. Deterministic: same override, same bytes.
 */
export function serializeComposeOverride(override: ComposeOverride): string {
  const out: string[] = ['# Written by Flow for one conversation; rewritten on every run.']
  const services = Object.keys(override.services)
  if (services.length === 0) {
    out.push('services: {}')
  } else {
    out.push('services:')
    for (const name of services) {
      const service = override.services[name]!
      out.push(`  ${quote(name)}:`)
      out.push(...labelLines(service.labels, '    '))
      if (service.volumes !== undefined && service.volumes.length > 0) {
        out.push('    volumes:')
        for (const bind of service.volumes) {
          out.push(`      - type: ${quote(bind.type)}`)
          out.push(`        source: ${quote(bind.source)}`)
          out.push(`        target: ${quote(bind.target)}`)
          if (bind.read_only === true) out.push('        read_only: true')
        }
      }
    }
  }
  const volumes = Object.keys(override.volumes)
  if (volumes.length === 0) {
    out.push('volumes: {}')
  } else {
    out.push('volumes:')
    for (const original of volumes) {
      const volume = override.volumes[original]!
      out.push(`  ${quote(original)}:`)
      out.push(`    name: ${quote(volume.name)}`)
      out.push(...labelLines(volume.labels, '    '))
    }
  }
  return `${out.join('\n')}\n`
}
