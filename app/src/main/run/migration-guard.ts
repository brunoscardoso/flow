/**
 * THE MIGRATION GUARD — the ONE path every automatic migration or seed takes
 * (allowed-pattern #14). Nothing else in the app decides where one runs.
 *
 * A command may run:
 *   1. INSIDE the project's app service, when the plan has one. The caller
 *      builds the argv (`docker compose … exec -T <service> sh -lc <command>`),
 *      here it is just the service and the command.
 *   2. AS a Compose service of its own (a `migrate` / `seed` service) the
 *      thread's run can start.
 *   For both, being in a container proves nothing by itself: its environment
 *   can point at any server. So EVERY database address in that service's
 *   resolved environment must be one of this thread's readable services (a
 *   name on the run's own network). An environment Flow could not read, or one
 *   with no database address, is refused.
 *   3. LOCALLY, only when EVERY database address it would use is this computer
 *      (localhost, 127.0.0.1, ::1, 0.0.0.0) on a port this thread's Compose run
 *      publishes with a definite number. A port Compose picks itself, or one
 *      written with a variable, proves nothing and does not count.
 * Anything else is REFUSED with a sentence. No addresses known is a refusal:
 * "nobody said" is not "it is safe".
 *
 * PURE: no fs, no child process. The caller reads the project's env files and
 * hands `databaseAddressesFrom` their variables.
 *
 * Refusal sentences are shown to people: no command, path or setting in them
 * (forbidden-pattern #12).
 */
import type { ThreadComposePlan, ThreadPublishedPort } from './compose-thread'

export type GuardedCommand =
  /** Run `command` inside `service` of the thread's run. */
  | { kind: 'inside'; service: string; command: string }
  /** Start `service` — a migration or seed service of the Compose file — in the thread's run. */
  | { kind: 'service'; service: string }
  /** Run `command` on this computer; every address in `addresses` is one of the thread's published ports. */
  | { kind: 'local'; command: string; addresses: string[] }
  | { kind: 'refused'; reason: string }

export interface GuardInput {
  /** The command as detected or as the person corrected it. Ignored when `composeService` is given. */
  command: string
  plan: ThreadComposePlan
  /** Every database address the command would use, as `host:port` (from `databaseAddressesFrom`). */
  databaseAddresses: string[]
  /** The detected command IS a Compose service (a `migrate` / `seed` service). */
  composeService?: string
  /**
   * Each service's resolved environment, as Compose would hand it to the
   * container. Null or absent: it could not be read, and nothing runs inside
   * a container.
   */
  serviceEnvironments?: Record<string, Record<string, string>> | null
}

export const GUARD_REFUSAL = {
  empty: 'There was nothing to run.',
  service: "The service this was meant to run in isn't one Flow can read, so it didn't run it.",
  noAddresses:
    "Flow couldn't tell which database this would change, so it didn't run it. Only this conversation's own database may be changed automatically.",
  foreign:
    "This would reach a database that isn't one of this conversation's services, so Flow didn't run it.",
  unproven:
    "This would reach a port Flow can't prove belongs to this conversation's services, so it didn't run it.",
  unreadable: "Flow couldn't read one of the database addresses this would use, so it didn't run it.",
  containerEnv: "Flow couldn't read the settings of the service this would run in, so it didn't run it.",
} as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
/** A published port with one of these bind addresses answers on every local address. */
const ALL_ADDRESSES = new Set(['0.0.0.0', '::', ''])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/** `host:port`, `[v6]:port` → parts; null when there is no definite numeric port. */
export function splitAddress(address: string): { host: string; port: number } | null {
  const text = address.trim()
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(text)
  const plain = /^([^:[\]]+):(\d+)$/.exec(text)
  const match = v6 ?? plain
  if (match === null) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: match[1]!.toLowerCase(), port }
}

/** True when a connection to `host:port` on this computer lands on `published`. */
function reaches(host: string, port: number, published: ThreadPublishedPort): boolean {
  if (published.published !== port) return false
  if (published.protocol.toLowerCase() !== 'tcp') return false
  const bind = (published.hostIp ?? '').toLowerCase()
  if (ALL_ADDRESSES.has(bind)) return true
  // Bound to one address: only a connection to that address (or its loopback name) reaches it.
  if (LOOPBACK.has(bind)) return LOOPBACK.has(host) || host === bind
  return host === bind
}

/** Null when every database address `service` would use is one of the thread's readable services; else why not. */
function containerRefusal(input: GuardInput, service: string): string | null {
  const env = input.serviceEnvironments?.[service]
  if (env === undefined || env === null) return GUARD_REFUSAL.containerEnv
  const addresses = databaseAddressesFrom(env)
  if (addresses.length === 0) return GUARD_REFUSAL.noAddresses
  const own = new Set(input.plan.readableServices.map((name) => name.toLowerCase()))
  for (const address of addresses) {
    const parts = splitAddress(address)
    if (parts === null) return GUARD_REFUSAL.unreadable
    if (!own.has(parts.host)) return GUARD_REFUSAL.foreign
  }
  return null
}

export function guardMigration(input: GuardInput): GuardedCommand {
  const { plan } = input

  if (input.composeService !== undefined) {
    if (!plan.readableServices.includes(input.composeService)) return { kind: 'refused', reason: GUARD_REFUSAL.service }
    const refusal = containerRefusal(input, input.composeService)
    return refusal === null ? { kind: 'service', service: input.composeService } : { kind: 'refused', reason: refusal }
  }

  const command = input.command.trim()
  if (command === '') return { kind: 'refused', reason: GUARD_REFUSAL.empty }

  if (plan.appService !== null) {
    if (!plan.readableServices.includes(plan.appService)) return { kind: 'refused', reason: GUARD_REFUSAL.service }
    const refusal = containerRefusal(input, plan.appService)
    return refusal === null ? { kind: 'inside', service: plan.appService, command } : { kind: 'refused', reason: refusal }
  }

  const addresses = [...new Set(input.databaseAddresses.map((address) => address.trim()).filter((a) => a !== ''))]
  if (addresses.length === 0) return { kind: 'refused', reason: GUARD_REFUSAL.noAddresses }

  for (const address of addresses) {
    const parts = splitAddress(address)
    if (parts === null) return { kind: 'refused', reason: GUARD_REFUSAL.unreadable }
    if (!LOCAL_HOSTS.has(parts.host)) return { kind: 'refused', reason: GUARD_REFUSAL.foreign }
    if (!plan.publishedPorts.some((published) => reaches(parts.host, parts.port, published))) {
      return { kind: 'refused', reason: GUARD_REFUSAL.unproven }
    }
  }
  return { kind: 'local', command, addresses }
}

// ─── database addresses from a project's environment ────────────────────────

/** Default ports by URL scheme. */
const SCHEME_PORT: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  'postgresql+psycopg': 5432,
  'postgresql+psycopg2': 5432,
  'postgresql+asyncpg': 5432,
  mysql: 3306,
  'mysql+pymysql': 3306,
  'mysql+mysqldb': 3306,
  'mysql+aiomysql': 3306,
  mariadb: 3306,
  redis: 6379,
  rediss: 6379,
  mongodb: 27017,
  amqp: 5672,
  amqps: 5671,
  sqlserver: 1433,
  mssql: 1433,
}

/** Schemes that name a database server, whatever variable holds the URL. */
const DATABASE_SCHEMES = new Set(['postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'rediss', 'mongodb', 'sqlserver', 'mssql', 'cockroachdb'])

/** True when `value` is a URL whose scheme (before any `+driver`) is a database server's. */
function isDatabaseUrl(value: string): boolean {
  const match = /^\s*([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  if (match === null) return false
  return DATABASE_SCHEMES.has(match[1]!.toLowerCase().split('+')[0]!)
}

/** Schemes whose database is a local file, not a server: no network address. */
const FILE_SCHEMES = new Set(['sqlite', 'sqlite3', 'file'])

/** URL variables that name a database. */
const URL_VARS = new Set(['DATABASE_URL', 'REDIS_URL', 'MONGO_URL', 'MONGODB_URI', 'MONGODB_URL', 'MONGO_URI'])
const URL_VAR_SUFFIX = /_DATABASE_URL$|_DB_URL$/

/** Host and port variable pairs, with the port the server uses when none is set. */
const HOST_PORT_VARS: Array<{ host: string; port: string; fallback: number | null }> = [
  { host: 'POSTGRES_HOST', port: 'POSTGRES_PORT', fallback: 5432 },
  { host: 'PGHOST', port: 'PGPORT', fallback: 5432 },
  { host: 'MYSQL_HOST', port: 'MYSQL_PORT', fallback: 3306 },
  { host: 'REDIS_HOST', port: 'REDIS_PORT', fallback: 6379 },
  { host: 'MONGO_HOST', port: 'MONGO_PORT', fallback: 27017 },
  { host: 'DB_HOST', port: 'DB_PORT', fallback: null },
  { host: 'DATABASE_HOST', port: 'DATABASE_PORT', fallback: null },
]

const joinAddress = (host: string, port: number | string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`

/**
 * The addresses one database URL points at. A URL that cannot be read comes
 * back as written, so the guard refuses it instead of it vanishing.
 */
export function addressesFromUrl(value: string): string[] {
  const text = value.trim()
  if (text === '') return []
  const match = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(text)
  if (match === null) {
    return /^(sqlite3?|file):/i.test(text) ? [] : [text]
  }
  const scheme = match[1]!.toLowerCase()
  if (FILE_SCHEMES.has(scheme)) return []
  const hosts = match[2]!
  // A DNS-discovered server, or one with no host (a local socket), is never provable.
  if (scheme.endsWith('+srv') || hosts === '' || text.includes('${')) return [text]
  const fallback = SCHEME_PORT[scheme] ?? null
  const out: string[] = []
  for (const part of hosts.split(',')) {
    const v6 = /^\[([^\]]+)\](?::(\d*))?$/.exec(part)
    const plain = /^([^:]+)(?::(\d*))?$/.exec(part)
    const host = v6?.[1] ?? plain?.[1]
    const port = v6?.[2] ?? plain?.[2]
    if (host === undefined) {
      out.push(text)
      continue
    }
    const resolved = port !== undefined && port !== '' ? port : fallback
    // No port and no default: written host only, which the guard cannot prove.
    out.push(resolved === null ? host : joinAddress(host, resolved))
  }
  return out
}

/**
 * Every database address a project's environment names, as `host:port` —
 * URL variables (DATABASE_URL, any *_DATABASE_URL, REDIS_URL, MONGO_URL,
 * MONGODB_URI) and host/port pairs (POSTGRES_*, PG*, MYSQL_*, REDIS_*, …),
 * with each server's usual port when none is written. A port without its host
 * comes back without a host, so the guard refuses it rather than assume.
 */
export function databaseAddressesFrom(env: Record<string, string>): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    // Named database variables, and ANY variable holding a database URL
    // (DIRECT_URL, POSTGRES_PRISMA_URL, SQLALCHEMY_DATABASE_URI, …): one
    // proven address must never hide another the tool may use instead.
    if (URL_VARS.has(key) || URL_VAR_SUFFIX.test(key) || isDatabaseUrl(value)) out.push(...addressesFromUrl(value))
  }
  for (const pair of HOST_PORT_VARS) {
    const host = env[pair.host]?.trim() ?? ''
    const port = env[pair.port]?.trim() ?? ''
    if (host === '' && port === '') continue
    if (host === '') {
      out.push(`:${port}`)
      continue
    }
    if (host.startsWith('/')) {
      // A socket folder: a server on this computer that is not a published port.
      out.push(host)
      continue
    }
    const resolved = port !== '' ? port : pair.fallback
    out.push(resolved === null ? host : joinAddress(host, resolved))
  }
  return [...new Set(out)]
}
