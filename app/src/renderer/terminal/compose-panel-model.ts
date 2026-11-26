/**
 * THE MANAGE CONTAINERS PANEL — what it says for one thread: its services and
 * their state, its data with sizes, the folders it shares, and the confirms
 * before Reset data and Delete data. DOM-free so every sentence is testable
 * (forbidden-pattern #12: no command, path or setting — a shared folder is
 * named by its last part only).
 *
 * Main reads Docker and owns every action (allowed-pattern #14); the panel
 * reads only while it is open (allowed-pattern #17).
 */
import type { RunThreadData, RunThreadDataService, RunThreadDataVolume } from '../../shared/run-setup'
import { humanSize } from '../threads/thread-sidebar-delete-notice'
import type { RunDotTone } from './run-group-model'

export const COMPOSE_PANEL_STRINGS = {
  title: 'Containers',
  untitled: 'Untitled thread',
  live: "This thread's data is running",
  notLive: "This thread's data is not running",
  loading: "Reading this thread's containers…",
  none: "This thread doesn't keep data of its own in Docker.",
  failed: "Flow couldn't read this thread's containers.",
  servicesHeading: 'Services',
  dataHeading: "This thread's data",
  noData: 'No data yet. The next Run makes it.',
  restart: 'Restart',
  start: 'Start',
  restartTitle: "Restart this thread's services",
  startTitle: "Start this thread's services. The thread that is running stops first.",
  reset: 'Reset data…',
  resetTitle: "Empty this thread's databases. The next Run fills them again.",
  delete: 'Delete data…',
  deleteTitle: "Remove this thread's data from this computer",
  close: 'Close',
  cancel: 'Cancel',
  resetConfirmTitle: "Reset this thread's data?",
  resetConfirmBody: 'Its services stop and these are deleted. The next Run starts with empty databases and fills them again.',
  resetConfirm: 'Reset data',
  deleteConfirmTitle: "Delete this thread's data?",
  deleteConfirmBody: 'Its services stop and these are deleted. The thread stays; its next Run makes new, empty data.',
  deleteConfirm: 'Delete data',
  untouched: 'The project and other threads are not touched.',
  sizeUnknown: 'size unknown',
  actionFailed: "Flow couldn't finish this. Nothing else was changed.",
} as const

/** How often an open panel re-reads, at most — states move on Run, not on a clock. */
export const COMPOSE_PANEL_REFRESH_MS = 15_000

export interface ComposeServiceRow {
  key: string
  name: string
  /** "Running", "Stopped", "Not created"… */
  state: string
  tone: RunDotTone
}

export interface ComposeVolumeRow {
  key: string
  /** "Database (db)", "Cache (redis)", or the volume's own name. */
  label: string
  size: string
}

export interface ComposePanelFace {
  title: string
  status: string
  live: boolean
  services: ComposeServiceRow[]
  dataHeading: string
  /** "1.3 GB in all", or null when nothing is kept or a size is unknown. */
  total: string | null
  volumes: ComposeVolumeRow[]
  /** Shown when there are no volumes yet. */
  noData: string | null
  /** The sentence about folders every thread shares, or null. */
  sharedNote: string | null
  /** Sentences about services run without data of their own. */
  notes: string[]
  /** Set when Docker could not be asked. */
  problem: string | null
  restart: { label: string; title: string }
  /** Reset and Delete are offered only when there is data to remove. */
  canRemove: boolean
}

/** Docker's state word as a person reads it, with its dot. */
export function serviceState(state: string | null): { state: string; tone: RunDotTone } {
  switch (state) {
    case 'running':
      return { state: 'Running', tone: 'ok' }
    case 'restarting':
      return { state: 'Restarting', tone: 'busy' }
    case 'created':
      return { state: 'Not started', tone: 'off' }
    case 'paused':
      return { state: 'Paused', tone: 'busy' }
    case 'exited':
      return { state: 'Stopped', tone: 'off' }
    case 'dead':
      return { state: 'Stopped with a problem', tone: 'bad' }
    case 'removing':
      return { state: 'Being removed', tone: 'busy' }
    case null:
      return { state: 'Not created', tone: 'off' }
    default:
      return { state, tone: 'off' }
  }
}

const KINDS: Array<[RegExp, string]> = [
  [/postgres|pgdata|mysql|maria|mongo|database|^db$|[-_]db$|^db[-_]|sql|couch|cockroach|clickhouse/i, 'Database'],
  [/redis|memcache|valkey|keydb|cache/i, 'Cache'],
  [/rabbit|kafka|nats|queue|mq\b/i, 'Queue'],
  [/elastic|opensearch|meili|typesense|solr|search/i, 'Search'],
  [/minio|s3|storage|upload|files?$/i, 'Files'],
]

/** What kind of data a volume holds ("Database", "Cache", …), from its own name and its service's; null when neither says. */
export function volumeKind(volume: string, service: string | null = null): string | null {
  return KINDS.find(([pattern]) => (service !== null && pattern.test(service)) || pattern.test(volume))?.[1] ?? null
}

/** "Database (db)", "Cache (redis)" — or the volume's name when no service says what it is. */
export function volumeLabel(volume: Pick<RunThreadDataVolume, 'volume' | 'service'>): string {
  if (volume.service === null) return volume.volume
  const kind = KINDS.find(([pattern]) => pattern.test(volume.service!) || pattern.test(volume.volume))?.[1]
  return kind === undefined ? `${volume.volume} (${volume.service})` : `${kind} (${volume.service})`
}

function sizeOf(bytes: number | null): string {
  return bytes === null ? COMPOSE_PANEL_STRINGS.sizeUnknown : humanSize(bytes)
}

/** "The uploads folder is shared…", "The uploads and media folders are shared…". */
export function sharedFoldersNote(folders: readonly string[]): string | null {
  if (folders.length === 0) return null
  const names =
    folders.length === 1
      ? `The ${folders[0]} folder is`
      : `The ${folders.slice(0, -1).join(', ')} and ${folders[folders.length - 1]} folders are`
  return `${names} shared with the project and every thread. Flow does not keep a copy per thread.`
}

/** Several projects in one thread: a row says which project its service is in. */
function serviceName(service: RunThreadDataService, many: boolean): string {
  return many ? `${service.service} · ${service.projectName}` : service.service
}

/** What the panel shows; `data` null means nothing to show (it says why). */
export function composePanelFace(threadTitle: string | null, data: RunThreadData): ComposePanelFace {
  const title = `${COMPOSE_PANEL_STRINGS.title} · ${threadTitle !== null && threadTitle.trim() !== '' ? threadTitle.trim() : COMPOSE_PANEL_STRINGS.untitled}`
  const projects = new Set([...data.services.map((entry) => entry.projectName), ...data.volumes.map((entry) => entry.projectName)])
  const many = projects.size > 1
  const services = data.services.map((service) => {
    const face = serviceState(service.state)
    return { key: `${service.projectName}::${service.service}`, name: serviceName(service, many), state: face.state, tone: face.tone }
  })
  const volumes = data.volumes.map((volume) => ({
    key: `${volume.projectName}::${volume.volume}`,
    label: many ? `${volumeLabel(volume)} · ${volume.projectName}` : volumeLabel(volume),
    size: sizeOf(volume.sizeBytes),
  }))
  const notes = data.unreadable.map((entry) => `${entry.service}: ${entry.reason}`)
  return {
    title,
    status: data.live ? COMPOSE_PANEL_STRINGS.live : COMPOSE_PANEL_STRINGS.notLive,
    live: data.live,
    services,
    dataHeading: COMPOSE_PANEL_STRINGS.dataHeading,
    total: volumes.length === 0 || data.totalBytes === null ? null : `${humanSize(data.totalBytes)} in all`,
    volumes,
    noData: volumes.length === 0 ? COMPOSE_PANEL_STRINGS.noData : null,
    sharedNote: sharedFoldersNote(data.sharedFolders),
    notes,
    problem: data.problem,
    restart: data.live
      ? { label: COMPOSE_PANEL_STRINGS.restart, title: COMPOSE_PANEL_STRINGS.restartTitle }
      : { label: COMPOSE_PANEL_STRINGS.start, title: COMPOSE_PANEL_STRINGS.startTitle },
    canRemove: volumes.length > 0,
  }
}

export interface DataRemoveConfirm {
  title: string
  body: string
  volumes: ComposeVolumeRow[]
  note: string
  cancel: string
  confirm: string
}

/** The confirm before Reset data or Delete data: what goes, with its size. */
export function dataRemoveConfirm(kind: 'reset' | 'delete', face: Pick<ComposePanelFace, 'volumes'>): DataRemoveConfirm {
  return {
    title: kind === 'reset' ? COMPOSE_PANEL_STRINGS.resetConfirmTitle : COMPOSE_PANEL_STRINGS.deleteConfirmTitle,
    body: kind === 'reset' ? COMPOSE_PANEL_STRINGS.resetConfirmBody : COMPOSE_PANEL_STRINGS.deleteConfirmBody,
    volumes: face.volumes.map((volume) => ({ ...volume })),
    note: COMPOSE_PANEL_STRINGS.untouched,
    cancel: COMPOSE_PANEL_STRINGS.cancel,
    confirm: kind === 'reset' ? COMPOSE_PANEL_STRINGS.resetConfirm : COMPOSE_PANEL_STRINGS.deleteConfirm,
  }
}

/**
 * Whether an open panel should read again now: it is on screen, nothing is in
 * flight, and the last read is older than the interval (or a person acted).
 */
export function shouldRefreshPanel(input: {
  open: boolean
  onScreen: boolean
  inflight: boolean
  lastReadAt: number | null
  now: number
  force?: boolean
}): boolean {
  if (!input.open || !input.onScreen || input.inflight) return false
  if (input.force === true || input.lastReadAt === null) return true
  return input.now - input.lastReadAt >= COMPOSE_PANEL_REFRESH_MS
}
