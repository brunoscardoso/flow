/**
 * COMPOSE DESCRIPTION — what a project's Docker Compose file says about each
 * service beyond its name: the named volumes it keeps data in, the host folders
 * it binds, whether it mounts the project's code, the ports it publishes, and
 * which service is the app. Run suggestions, the per-thread plan
 * (`compose-thread.ts`) and the Docker group all read THIS description, so the
 * Compose file has one reader (allowed-pattern #14).
 *
 * PURE: text in, data out. No fs, no child process, no electron. Finding the
 * file goes through the injected `SuggestFs` port (`readComposeDescription`).
 *
 * NO YAML DEPENDENCY. The app has none, and Compose files use a small part of
 * YAML. The reader below handles block maps, block sequences, flow sequences of
 * scalars, quoted and plain scalars, and block scalars (skipped). What it does
 * not understand — anchors, aliases, merge keys, tags, `extends`, `profiles`,
 * volume names from environment variables — makes THAT service unreadable with
 * a sentence saying why. It is never guessed: a guessed mount is a thread
 * writing into another thread's data.
 *
 * Reasons are shown to people, so they speak in the terms of the thing on
 * screen and name no config key or path (forbidden-pattern #12).
 */
import { join } from 'path'

// ─── public shape ────────────────────────────────────────────────────────────

/** A named Docker volume a service mounts (`data:/var/lib/postgresql/data`). */
export interface ComposeVolumeMount {
  volume: string
  target: string
  readOnly: boolean
}

/** A host folder or file a service binds (`./src:/app/src`, `/srv/pg:/data`). */
export interface ComposeBindMount {
  source: string
  target: string
  readOnly: boolean
  /** True for `.`-relative sources, which resolve against the Compose project directory. */
  relative: boolean
  /** A relative source that climbs out of the project directory (`../shared`). */
  outside: boolean
  /** True when this bind is read as the project's code (see `looksLikeCodeMount`). */
  code: boolean
}

/**
 * A published port. `published: null` means Docker picks the host port itself
 * (`"3000"` or `"127.0.0.1::3000"`), so nothing on this computer can be assumed
 * to be that service.
 */
export interface ComposePort {
  target: number
  published: number | null
  hostIp: string | null
  protocol: string
}

export interface ReadableComposeService {
  name: string
  readable: true
  image: string | null
  /** The build context (`.` when `build:` is a map without one), or null when the service only pulls an image. */
  build: string | null
  volumes: ComposeVolumeMount[]
  binds: ComposeBindMount[]
  /**
   * Container paths of anonymous volumes (`- /app/node_modules`). Docker KEEPS
   * these across a recreate, so a runner switching threads must renew them.
   */
  anonymousVolumes: string[]
  mountsCode: boolean
  ports: ComposePort[]
  /** Port entries the reader could not resolve (environment variables, mismatched ranges), as written. */
  unresolvedPorts: string[]
}

export interface UnreadableComposeService {
  name: string
  readable: false
  /** A plain-language sentence for the panel. */
  reason: string
}

export type ComposeService = ReadableComposeService | UnreadableComposeService

/** A top-level volume declaration. */
export interface ComposeVolumeDecl {
  name: string
  /**
   * Why this volume is shared by every thread whatever Flow does — created
   * outside Compose, or backed by a host folder — or null when it can be
   * given to a thread.
   */
  shared: string | null
}

export interface ComposeDescription {
  /** Every service, in file order, with the same names `composeServices` reads. */
  services: ComposeService[]
  volumes: ComposeVolumeDecl[]
  /**
   * The service that mounts the code: the only one that does, else the only
   * one of those with a build. Null when none mounts the code or the choice is
   * ambiguous — a migration is never pointed at a guess.
   */
  appService: string | null
  /** File-level things the reader did not follow, as plain sentences. */
  problems: string[]
}

// ─── file detection ──────────────────────────────────────────────────────────

/** The file names Compose itself looks for, in its own order of preference. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

/** The override files Compose loads beside its file when it is run without `-f`. */
export const COMPOSE_OVERRIDE_FILES = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
]

/** The read-only half of `SuggestFs` this module needs. */
export interface ComposeFs {
  readFile(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
}

export interface ComposeFileDescription {
  /** The Compose file's name inside `root` (one of `COMPOSE_FILES`). */
  file: string
  text: string
  description: ComposeDescription
  /**
   * The project's own override file, when it has one. Compose only loads it
   * when no `-f` is given, so a runner that passes `-f` must pass it too.
   */
  projectOverride: string | null
}

/** The first Compose file in `root`, described — or null when there is none. Never throws on a bad file. */
export async function readComposeDescription(root: string, fs: ComposeFs): Promise<ComposeFileDescription | null> {
  for (const file of COMPOSE_FILES) {
    const text = await fs.readFile(join(root, file))
    if (text === null) continue
    let projectOverride: string | null = null
    for (const candidate of COMPOSE_OVERRIDE_FILES) {
      if (await fs.exists(join(root, candidate))) {
        projectOverride = candidate
        break
      }
    }
    return { file, text, description: describeCompose(text), projectOverride }
  }
  return null
}

/** Whether `root` holds a Compose file — existence only, nothing is read. Never throws. */
export async function hasComposeFile(root: string, fs: Pick<ComposeFs, 'exists'>): Promise<boolean> {
  for (const file of COMPOSE_FILES) {
    try {
      if (await fs.exists(join(root, file))) return true
    } catch {
      // unreadable: try the next name
    }
  }
  return false
}

/** How long one "has a Compose file" answer is reused per project. */
export const COMPOSE_PRESENCE_TTL_MS = 5_000

/**
 * `hasComposeFile`, cached per project for a few seconds (allowed-pattern
 * #20): the thread list, the delete confirm and the archive hook ask the same
 * question about the same projects in bursts. A project with no Compose file
 * is answered here and never reaches Docker.
 */
export function createComposePresence(
  fs: Pick<ComposeFs, 'exists'>,
  options: { ttlMs?: number; now?: () => number } = {},
): (root: string) => Promise<boolean> {
  const ttl = options.ttlMs ?? COMPOSE_PRESENCE_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; has: boolean }>()
  return async (root) => {
    const cached = cache.get(root)
    if (cached !== undefined && now() - cached.at < ttl) return cached.has
    const has = await hasComposeFile(root, fs)
    cache.set(root, { at: now(), has })
    return has
  }
}

// ─── service names (the original indentation reader) ─────────────────────────

/**
 * Top-level service names under `services:` — read by indentation. This stays
 * the authority for WHICH services exist, so run suggestions are exactly what
 * they were before the description was added.
 */
export function composeServices(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const services: string[] = []
  let inServices = false
  let childIndent: number | null = null
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(raw.trim())
      childIndent = null
      continue
    }
    if (!inServices) continue
    if (childIndent === null) childIndent = indent
    if (indent !== childIndent) continue
    const match = /^["']?([A-Za-z0-9._-]+)["']?\s*:/.exec(raw.trim())
    if (match !== null) services.push(match[1]!)
  }
  return services
}

// ─── a small YAML subset reader ──────────────────────────────────────────────

interface YLine {
  indent: number
  text: string
}

type Special = 'anchor' | 'alias' | 'tag' | 'flow-map'

type YNode =
  | { kind: 'map'; entries: Array<[string, YNode]> }
  | { kind: 'seq'; items: YNode[] }
  | { kind: 'scalar'; value: string | null }
  | { kind: 'special'; why: Special }

class YamlSubsetError extends Error {}

/** Cuts a trailing comment: a `#` outside quotes that starts the line or follows whitespace. */
function stripComment(raw: string): string {
  let single = false
  let double = false
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at]!
    if (double && char === '\\') {
      at += 1
      continue
    }
    if (char === '"' && !single) double = !double
    else if (char === "'" && !double) single = !single
    else if (char === '#' && !single && !double && (at === 0 || /\s/.test(raw[at - 1]!))) return raw.slice(0, at)
  }
  return raw
}

function yamlLines(text: string): YLine[] {
  const out: YLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (/^(---|\.\.\.)$/.test(line)) {
      // A second document would be a second Compose file in one; Compose rejects it too.
      if (out.length > 0) throw new YamlSubsetError('several documents')
      continue
    }
    out.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  return out
}

const isSeqItem = (text: string): boolean => text === '-' || text.startsWith('- ')

/** `key: rest` → its parts, or null when the text is not a mapping entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  const double = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+(.*))?$/.exec(text)
  if (double !== null) return { key: unquoteDouble(`"${double[1]!}"`), rest: double[2] ?? '' }
  const single = /^'((?:[^']|'')*)'\s*:(?:\s+(.*))?$/.exec(text)
  if (single !== null) return { key: single[1]!.replace(/''/g, "'"), rest: single[2] ?? '' }
  if (/^[-[\]{}"'&*!|>%@`,]/.test(text) && !text.startsWith('<<')) return null
  const plain = /^(.+?)\s*:(?:\s+(.*))?$/.exec(text)
  if (plain === null) return null
  return { key: plain[1]!, rest: plain[2] ?? '' }
}

function unquoteDouble(text: string): string {
  try {
    return JSON.parse(text) as string
  } catch {
    return text.slice(1, -1)
  }
}

/** One scalar as written inline: quoted, plain, or a flow-sequence member. */
function inlineScalar(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) throw new YamlSubsetError('a quoted value that does not close')
    return unquoteDouble(trimmed)
  }
  if (trimmed.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(trimmed)) throw new YamlSubsetError('a quoted value that does not close')
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/** Splits a flow sequence's inside on commas outside quotes. */
function flowItems(inside: string): string[] {
  const items: string[] = []
  let current = ''
  let single = false
  let double = false
  for (let at = 0; at < inside.length; at += 1) {
    const char = inside[at]!
    if (double && char === '\\') {
      current += char + (inside[at + 1] ?? '')
      at += 1
      continue
    }
    if (char === '"' && !single) double = !double
    if (char === "'" && !double) single = !single
    if (char === ',' && !single && !double) {
      items.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') items.push(current)
  return items
}

function inlineNode(rest: string): YNode {
  if (rest.startsWith('*')) return { kind: 'special', why: 'alias' }
  if (rest.startsWith('&')) return { kind: 'special', why: 'anchor' }
  if (rest.startsWith('!')) return { kind: 'special', why: 'tag' }
  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) throw new YamlSubsetError('a list that does not close')
    const inside = rest.slice(1, -1)
    if (/[[\]{}]/.test(inside.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, ''))) {
      throw new YamlSubsetError('a nested inline list')
    }
    return { kind: 'seq', items: flowItems(inside).map((item) => ({ kind: 'scalar', value: inlineScalar(item) })) }
  }
  if (rest.startsWith('{')) {
    if (/^\{\s*\}$/.test(rest)) return { kind: 'map', entries: [] }
    return { kind: 'special', why: 'flow-map' }
  }
  return { kind: 'scalar', value: inlineScalar(rest) }
}

/** Parses lines that hold one block (a map or a sequence). Throws `YamlSubsetError` on what it does not read. */
function parseBlock(source: YLine[]): YNode {
  // Copied, because a `- key: value` item is rewritten in place as a map line.
  const lines = source.map((line) => ({ ...line }))
  let at = 0

  const block = (indent: number): YNode => (isSeqItem(lines[at]!.text) ? seq(indent) : map(indent))

  const skipDeeper = (indent: number): void => {
    while (at < lines.length && lines[at]!.indent > indent) at += 1
  }

  /** The value after `key:` (or after `- `) whose line sits at `indent`. */
  const value = (indent: number, rest: string, sameIndentSeq: boolean): YNode => {
    const next = lines[at]
    if (rest === '') {
      if (next !== undefined && next.indent > indent) return block(next.indent)
      // Compose files often write a list at the key's own indentation.
      if (sameIndentSeq && next !== undefined && next.indent === indent && isSeqItem(next.text)) return seq(indent)
      return { kind: 'scalar', value: null }
    }
    if (/^[|>][-+0-9]*$/.test(rest)) {
      // A block scalar (a script, a long command): its text never matters here.
      skipDeeper(indent)
      return { kind: 'scalar', value: '' }
    }
    if (/^[&!]\S+$/.test(rest)) {
      // An anchor or tag on a nested block: read past it, report what it is.
      value(indent, '', sameIndentSeq)
      return { kind: 'special', why: rest.startsWith('&') ? 'anchor' : 'tag' }
    }
    const node = inlineNode(rest)
    if (node.kind === 'scalar') {
      // A plain scalar may continue on deeper lines.
      while (at < lines.length && lines[at]!.indent > indent) {
        node.value = `${node.value ?? ''} ${lines[at]!.text}`
        at += 1
      }
    } else if (at < lines.length && lines[at]!.indent > indent) {
      throw new YamlSubsetError('an inline value followed by more lines')
    }
    return node
  }

  const map = (indent: number): YNode => {
    const entries: Array<[string, YNode]> = []
    while (at < lines.length) {
      const line = lines[at]!
      if (line.indent < indent) break
      if (line.indent > indent) throw new YamlSubsetError('unexpected indentation')
      if (isSeqItem(line.text)) break
      const entry = splitKey(line.text)
      if (entry === null) throw new YamlSubsetError('a line that is not a setting')
      at += 1
      entries.push([entry.key, value(indent, entry.rest, true)])
    }
    return { kind: 'map', entries }
  }

  const seq = (indent: number): YNode => {
    const items: YNode[] = []
    while (at < lines.length) {
      const line = lines[at]!
      if (line.indent < indent) break
      if (line.indent > indent) throw new YamlSubsetError('unexpected indentation')
      if (!isSeqItem(line.text)) break
      const rest = line.text === '-' ? '' : line.text.slice(1).trimStart()
      if (rest !== '' && isSeqItem(rest)) throw new YamlSubsetError('a list inside a list item')
      const quotedScalar = /^["']/.test(rest) && splitKey(rest) === null
      if (rest !== '' && !quotedScalar && splitKey(rest) !== null) {
        // `- key: value` opens a map whose entries align with `key`.
        const column = indent + (line.text.length - rest.length)
        lines[at] = { indent: column, text: rest }
        items.push(map(column))
        continue
      }
      at += 1
      items.push(value(indent, rest, false))
    }
    return { kind: 'seq', items }
  }

  if (lines.length === 0) return { kind: 'scalar', value: null }
  const node = block(lines[0]!.indent)
  if (at < lines.length) throw new YamlSubsetError('lines after the end of a block')
  return node
}

// ─── node helpers ────────────────────────────────────────────────────────────

function entry(node: YNode, key: string): YNode | undefined {
  if (node.kind !== 'map') return undefined
  return node.entries.find(([name]) => name === key)?.[1]
}

function scalar(node: YNode | undefined): string | null {
  return node !== undefined && node.kind === 'scalar' ? node.value : null
}

const isTrue = (node: YNode | undefined): boolean => /^(true|yes|on)$/i.test(scalar(node) ?? '')

/** The first anchor, alias, tag or merge key anywhere under `node`. */
function findReuse(node: YNode): 'anchor' | 'alias' | 'tag' | 'merge' | null {
  if (node.kind === 'special') return node.why === 'flow-map' ? null : node.why
  if (node.kind === 'seq') {
    for (const item of node.items) {
      const found = findReuse(item)
      if (found !== null) return found
    }
  }
  if (node.kind === 'map') {
    for (const [key, child] of node.entries) {
      if (key === '<<') return 'merge'
      const found = findReuse(child)
      if (found !== null) return found
    }
  }
  return null
}

// ─── reasons (shown to people) ───────────────────────────────────────────────

const REASON = {
  unparsed: "Flow couldn't read this service's settings, so it runs as written, without data of its own.",
  empty: 'This service has no settings, so it runs as written.',
  reuse: 'This service reuses settings written elsewhere in the file, which Flow does not read yet, so it runs as written.',
  extends: "This service builds on another service's settings, which Flow does not read yet, so it runs as written.",
  profiles: 'This service only starts with a chosen profile, so Flow leaves it as written.',
  variable:
    'One of its storage mounts is named through an environment variable, so Flow cannot tell which data it keeps.',
  mount: "One of its storage mounts is written in a way Flow doesn't read yet, so it runs as written.",
  volumeName: "One of its volume names isn't one Docker accepts, so Flow leaves the service as written.",
  ports: "Its port list is written in a way Flow doesn't read yet, so it runs as written.",
  tooWide: 'It publishes a port range too wide to read, so it runs as written.',
} as const

const SHARED = {
  external: 'This volume is created outside the Compose file, so every conversation shares it.',
  hostFolder: 'This volume is stored in a folder on this computer, so every conversation shares it.',
  unreadable: "Flow couldn't read how this volume is declared, so every conversation shares it.",
} as const

// ─── mounts ──────────────────────────────────────────────────────────────────

/** Docker's own rule for volume names. */
export const DOCKER_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** Folder names and container paths that hold data, not code. */
const DATA_NAME =
  /^(\.?data|.*[-_]data|data[-_].*|pgdata|db|dbdata|mysql|mariadb|postgres|postgresql|redis|mongo|mongodb|volumes?|storage|tmp|temp|logs?|backups?|cache|\.cache|uploads|minio|elasticsearch|es|certs?|secrets?|\.docker|docker)$/i
const DATA_TARGET =
  /^\/(var\/lib|var\/log|data|bitnami|etc|docker-entrypoint-initdb\.d|run|tmp|certs?|secrets?)(\/|$)|(^|\/)(data|pgdata|logs?)\/?$/i

/**
 * True when a relative bind reads as THE PROJECT'S CODE. The rule, kept small
 * on purpose so a person can predict it:
 *
 * - the host side is `.`-relative and stays inside the project (`.`, `./`,
 *   `./src`, `./apps/web` — never `../x`);
 * - none of its folders is a data or log name (`./pgdata`, `./data/redis`);
 * - its last part is not a file (`./nginx.conf`, `./init.sql`), which is config;
 * - the container side is not a data, config or init location (`/var/lib/…`,
 *   `/etc/…`, `/docker-entrypoint-initdb.d`, `…/data`).
 */
export function looksLikeCodeMount(source: string, target: string): boolean {
  if (!source.startsWith('.')) return false
  const parts = source.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return false
  if (parts.some((part) => DATA_NAME.test(part))) return false
  const last = parts[parts.length - 1]
  // `.env`-style dotfiles and `name.ext` files are config, not code folders.
  if (last !== undefined && (/^[^.].*\.[A-Za-z0-9]+$/.test(last) || /^\.[A-Za-z0-9]/.test(last))) return false
  return !DATA_TARGET.test(target)
}

type Mount =
  | { kind: 'volume'; mount: ComposeVolumeMount }
  | { kind: 'bind'; mount: ComposeBindMount }
  | { kind: 'anonymous'; target: string }
  | { kind: 'ignored' }
  | { kind: 'unreadable'; reason: string }

function bindOf(source: string, target: string, readOnly: boolean): Mount {
  const relative = source.startsWith('.')
  const outside = relative && source.split('/').includes('..')
  return {
    kind: 'bind',
    mount: { source, target, readOnly, relative, outside, code: relative && looksLikeCodeMount(source, target) },
  }
}

const isHostPath = (source: string): boolean => /^(\.|\/|~)/.test(source)

function shortMount(text: string): Mount {
  if (text.includes('$')) return { kind: 'unreadable', reason: REASON.variable }
  const parts = text.split(':')
  if (parts.length > 3 || parts.some((part) => part === '')) return { kind: 'unreadable', reason: REASON.mount }
  if (parts.length === 1) return { kind: 'anonymous', target: parts[0]! }
  const [source, target, mode] = parts as [string, string, string | undefined]
  const readOnly = (mode ?? '').split(',').includes('ro')
  if (isHostPath(source)) return bindOf(source, target, readOnly)
  if (!DOCKER_VOLUME_NAME.test(source)) return { kind: 'unreadable', reason: REASON.volumeName }
  return { kind: 'volume', mount: { volume: source, target, readOnly } }
}

function longMount(node: YNode): Mount {
  const type = scalar(entry(node, 'type'))
  const source = scalar(entry(node, 'source'))
  const target = scalar(entry(node, 'target'))
  const readOnly = isTrue(entry(node, 'read_only'))
  if ([type, source, target].some((value) => value !== null && value.includes('$'))) {
    return { kind: 'unreadable', reason: REASON.variable }
  }
  if (target === null || target === '') return { kind: 'unreadable', reason: REASON.mount }
  // tmpfs keeps nothing; pipes, clusters and image mounts hold no thread data.
  if (type === 'tmpfs' || type === 'npipe' || type === 'cluster' || type === 'image') return { kind: 'ignored' }
  if (type === 'bind' || (type === null && source !== null && isHostPath(source))) {
    if (source === null || source === '') return { kind: 'unreadable', reason: REASON.mount }
    return bindOf(source, target, readOnly)
  }
  if (type === 'volume' || type === null) {
    if (source === null || source === '') return { kind: 'anonymous', target }
    if (!DOCKER_VOLUME_NAME.test(source)) return { kind: 'unreadable', reason: REASON.volumeName }
    return { kind: 'volume', mount: { volume: source, target, readOnly } }
  }
  return { kind: 'unreadable', reason: REASON.mount }
}

// ─── ports ───────────────────────────────────────────────────────────────────

/** The widest range expanded port by port; anything wider is not guessed at. */
const MAX_PORT_RANGE = 256

function portRange(text: string): number[] | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text)
  if (match === null) return null
  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  if (to < from || from > 65535 || to > 65535) return null
  if (to - from + 1 > MAX_PORT_RANGE) return []
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}

type PortRead = { ports: ComposePort[] } | { unresolved: true } | { tooWide: true }

function pairPorts(published: string | null, target: string, hostIp: string | null, protocol: string): PortRead {
  const targets = portRange(target)
  const hosts = published === null ? null : portRange(published)
  if (targets === null || (published !== null && hosts === null)) return { unresolved: true }
  if (targets.length === 0 || (hosts !== null && hosts.length === 0)) return { tooWide: true }
  if (hosts !== null && hosts.length !== targets.length && hosts.length !== 1) return { unresolved: true }
  return {
    ports: targets.map((port, index) => ({
      target: port,
      published: hosts === null ? null : (hosts.length === 1 ? hosts[0]! : hosts[index]!),
      hostIp,
      protocol,
    })),
  }
}

function shortPort(text: string): PortRead {
  if (text.includes('$')) return { unresolved: true }
  const [address, protocol = 'tcp'] = text.split('/') as [string, string | undefined]
  let hostIp: string | null = null
  let rest = address
  const v6 = /^\[([^\]]+)\]:(.*)$/.exec(address)
  if (v6 !== null) {
    hostIp = v6[1]!
    rest = v6[2]!
  }
  const parts = rest.split(':')
  if (v6 === null && parts.length === 3) {
    hostIp = parts.shift()!
  }
  if (parts.length === 1) return pairPorts(null, parts[0]!, hostIp, protocol)
  if (parts.length === 2) return pairPorts(parts[0] === '' ? null : parts[0]!, parts[1]!, hostIp, protocol)
  return { unresolved: true }
}

function longPort(node: YNode): PortRead {
  const target = scalar(entry(node, 'target'))
  const published = scalar(entry(node, 'published'))
  const hostIp = scalar(entry(node, 'host_ip'))
  const protocol = scalar(entry(node, 'protocol')) ?? 'tcp'
  if (target === null || [target, published, hostIp].some((value) => value !== null && value.includes('$'))) {
    return { unresolved: true }
  }
  return pairPorts(published === '' ? null : published, target, hostIp, protocol)
}

// ─── a service ───────────────────────────────────────────────────────────────

function unreadable(name: string, reason: string): UnreadableComposeService {
  return { name, readable: false, reason }
}

function describeService(name: string, body: YNode): ComposeService {
  if (body.kind === 'special') return unreadable(name, body.why === 'flow-map' ? REASON.unparsed : REASON.reuse)
  if (body.kind !== 'map') return unreadable(name, REASON.empty)
  if (findReuse(body) !== null) return unreadable(name, REASON.reuse)
  if (entry(body, 'extends') !== undefined) return unreadable(name, REASON.extends)
  if (entry(body, 'profiles') !== undefined) return unreadable(name, REASON.profiles)

  const buildNode = entry(body, 'build')
  let build: string | null = null
  if (buildNode !== undefined) {
    build = buildNode.kind === 'map' ? (scalar(entry(buildNode, 'context')) ?? '.') : (scalar(buildNode) ?? '.')
  }

  const volumes: ComposeVolumeMount[] = []
  const binds: ComposeBindMount[] = []
  const anonymousVolumes: string[] = []
  const volumesNode = entry(body, 'volumes')
  if (volumesNode !== undefined && !(volumesNode.kind === 'scalar' && volumesNode.value === null)) {
    if (volumesNode.kind !== 'seq') return unreadable(name, REASON.mount)
    for (const item of volumesNode.items) {
      const mount =
        item.kind === 'scalar' && item.value !== null
          ? shortMount(item.value)
          : item.kind === 'map'
            ? longMount(item)
            : ({ kind: 'unreadable', reason: REASON.mount } as const)
      if (mount.kind === 'unreadable') return unreadable(name, mount.reason)
      if (mount.kind === 'volume') volumes.push(mount.mount)
      if (mount.kind === 'bind') binds.push(mount.mount)
      if (mount.kind === 'anonymous') anonymousVolumes.push(mount.target)
    }
  }

  const ports: ComposePort[] = []
  const unresolvedPorts: string[] = []
  const portsNode = entry(body, 'ports')
  if (portsNode !== undefined && !(portsNode.kind === 'scalar' && portsNode.value === null)) {
    if (portsNode.kind !== 'seq') return unreadable(name, REASON.ports)
    for (const item of portsNode.items) {
      const read =
        item.kind === 'scalar' && item.value !== null
          ? shortPort(item.value)
          : item.kind === 'map'
            ? longPort(item)
            : null
      if (read === null) return unreadable(name, REASON.ports)
      if ('tooWide' in read) return unreadable(name, REASON.tooWide)
      if ('unresolved' in read) {
        unresolvedPorts.push(
          item.kind === 'scalar'
            ? (item.value ?? '')
            : `${scalar(entry(item, 'published')) ?? ''}:${scalar(entry(item, 'target')) ?? ''}`,
        )
        continue
      }
      ports.push(...read.ports)
    }
  }

  return {
    name,
    readable: true,
    image: scalar(entry(body, 'image')),
    build,
    volumes,
    binds,
    anonymousVolumes,
    mountsCode: binds.some((bind) => bind.code),
    ports,
    unresolvedPorts,
  }
}

// ─── sections of the file ────────────────────────────────────────────────────

/** Each top-level key's own lines (the key line excluded). Lists at column 0 belong to the key above them. */
function topLevelSections(lines: YLine[]): Map<string, { rest: string; body: YLine[] }> {
  const sections = new Map<string, { rest: string; body: YLine[] }>()
  let current: { rest: string; body: YLine[] } | null = null
  for (const line of lines) {
    if (line.indent === 0 && !isSeqItem(line.text)) {
      const found = splitKey(line.text)
      current = { rest: found?.rest ?? '', body: [] }
      if (found !== null) sections.set(found.key, current)
      continue
    }
    current?.body.push(line)
  }
  return sections
}

/** Each direct child of a block: its key, the inline rest, and its own lines. */
function childSections(body: YLine[]): Array<{ key: string; rest: string; body: YLine[] }> {
  const out: Array<{ key: string; rest: string; body: YLine[] }> = []
  if (body.length === 0) return out
  const childIndent = body[0]!.indent
  for (const line of body) {
    if (line.indent <= childIndent && !(line.indent === childIndent && isSeqItem(line.text))) {
      const found = splitKey(line.text)
      if (found !== null && line.indent === childIndent) out.push({ key: found.key, rest: found.rest, body: [] })
      continue
    }
    out[out.length - 1]?.body.push(line)
  }
  return out
}

/** A child's node: its inline value, or its block. Throws on what the reader does not read. */
function childNode(child: { rest: string; body: YLine[] }): YNode {
  if (child.rest === '') return parseBlock(child.body)
  if (/^[&!]\S+$/.test(child.rest)) return { kind: 'special', why: child.rest.startsWith('&') ? 'anchor' : 'tag' }
  if (child.body.length > 0) throw new YamlSubsetError('an inline value followed by more lines')
  return inlineNode(child.rest)
}

function describeVolumeDecl(name: string, node: YNode | null): ComposeVolumeDecl {
  if (node === null) return { name, shared: SHARED.unreadable }
  if (node.kind === 'scalar' && node.value === null) return { name, shared: null }
  if (node.kind !== 'map' || findReuse(node) !== null) return { name, shared: SHARED.unreadable }
  const external = entry(node, 'external')
  // `external: true`, or the older `external: { name: … }`.
  if (isTrue(external) || external?.kind === 'map') return { name, shared: SHARED.external }
  const options = entry(node, 'driver_opts')
  if (options !== undefined && (entry(options, 'device') !== undefined || /bind/.test(scalar(entry(options, 'o')) ?? ''))) {
    return { name, shared: SHARED.hostFolder }
  }
  return { name, shared: null }
}

function pickAppService(services: ComposeService[]): string | null {
  const mounting = services.filter((service): service is ReadableComposeService => service.readable && service.mountsCode)
  if (mounting.length === 1) return mounting[0]!.name
  const built = mounting.filter((service) => service.build !== null)
  return built.length === 1 ? built[0]!.name : null
}

/** Reads a Compose file's text into a description. Never throws. */
export function describeCompose(text: string): ComposeDescription {
  const names = composeServices(text)
  let lines: YLine[]
  try {
    lines = yamlLines(text)
  } catch {
    return {
      services: names.map((name) => unreadable(name, REASON.unparsed)),
      volumes: [],
      appService: null,
      problems: ['This Compose file holds several documents, which Flow does not read.'],
    }
  }
  const sections = topLevelSections(lines)
  const problems: string[] = []
  if (sections.has('include')) problems.push('This Compose file includes other Compose files; their services are not read.')

  const serviceSections = new Map<string, { rest: string; body: YLine[] }>()
  const servicesSection = sections.get('services')
  if (servicesSection !== undefined) {
    for (const child of childSections(servicesSection.body)) serviceSections.set(child.key, child)
  }
  const services = names.map((name): ComposeService => {
    const child = serviceSections.get(name)
    if (child === undefined) return unreadable(name, REASON.unparsed)
    try {
      return describeService(name, childNode(child))
    } catch (error) {
      if (error instanceof YamlSubsetError) return unreadable(name, REASON.unparsed)
      throw error
    }
  })

  const volumes: ComposeVolumeDecl[] = []
  const volumesSection = sections.get('volumes')
  if (volumesSection !== undefined) {
    for (const child of childSections(volumesSection.body)) {
      let node: YNode | null
      try {
        node = childNode(child)
      } catch (error) {
        if (!(error instanceof YamlSubsetError)) throw error
        node = null
      }
      volumes.push(describeVolumeDecl(child.key, node))
    }
  }

  return { services, volumes, appService: pickAppService(services), problems }
}
