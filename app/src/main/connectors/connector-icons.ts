// connector-icons — the ONE place a connector's icon is chosen (plan_connectors,
// Phase 3, note 6; order from flow/brain/decisions/connector-sign-in.md):
//
//   1. the icon the server itself declared (`serverInfo.icons`), the one for
//      the theme asked when there is one, else any;
//   2. an icon Flow ships for a well-known service, matched by a word of the
//      server's name or by the host of its address (connector-icon-assets.ts);
//   3. the site icon of the connector's website, or of its address host;
//   4. null — the renderer draws the initial on a hue from the name.
//
// Everything crosses IPC as a `data:` image: the renderer's CSP allows only
// `img-src 'self' data:`, on purpose, so a page can never be made to beacon to
// an address a server declared. The fetching happens HERE, in main, under
// limits: https only, a time limit, a size cap and an image content type.
// An SVG is served as `data:image/svg+xml;base64,…` for an <img>, which never
// runs its scripts; nothing here ever puts SVG markup into a page.
//
// Every fetched source is cached in memory and on disk under userData (file
// name = hash of the source address + theme). A source that failed is cached
// as a miss for a while, so a list shown again does not refetch it.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConnectorEntry, ConnectorIconHint, ConnectorIconTheme } from '../../shared/connectors'
import { inkFor, SHIPPED_ICONS } from './connector-icon-assets'

export interface IconResponse {
  ok: boolean
  status: number
  /** The final address after redirects, when the fetch reports it. */
  url?: string
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type IconFetchFn = (url: string, init: { signal?: AbortSignal; redirect?: 'follow' }) => Promise<IconResponse>

export interface IconFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

interface CachedIcon {
  dataUri: string | null
  at: number
}

/** The memory half of the cache, plus the fetches in flight. Share one per app. */
export interface IconCache {
  memory: Map<string, CachedIcon>
  pending: Map<string, Promise<string | null>>
}

export function createIconCache(): IconCache {
  return { memory: new Map(), pending: new Map() }
}

export interface IconDeps {
  fetch?: IconFetchFn
  /** Where fetched icons are kept between runs (`<userData>/connector-icons`); null = memory only. */
  cacheDir?: string | null
  fs?: IconFs
  now?: () => number
  cache?: IconCache
  timeoutMs?: number
  maxBytes?: number
  /** How long a failed source is left alone before it is tried again. */
  missTtlMs?: number
  /** How long a fetched icon is kept before it is fetched again. */
  hitTtlMs?: number
}

export const ICON_TIMEOUT_MS = 5_000
export const MAX_ICON_BYTES = 256 * 1024
export const ICON_MISS_TTL_MS = 60 * 60_000
export const ICON_HIT_TTL_MS = 30 * 24 * 60 * 60_000

/** The image types an icon may be. */
const ICON_MIME: Readonly<Record<string, string>> = {
  'image/svg+xml': 'image/svg+xml',
  'image/png': 'image/png',
  'image/x-icon': 'image/x-icon',
  'image/vnd.microsoft.icon': 'image/x-icon',
  'image/ico': 'image/x-icon',
  'image/webp': 'image/webp',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
}

const defaultCache = createIconCache()
const nodeFs: IconFs = { readFile, writeFile, mkdir }

function mimeOf(contentType: string | null | undefined): string | null {
  if (contentType === null || contentType === undefined) return null
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return ICON_MIME[base] ?? null
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * A declared `data:` icon, checked and normalized to base64: an image type
 * from the list, under the size cap. Anything else is null.
 */
export function normalizeDataIcon(src: string, maxBytes = MAX_ICON_BYTES): string | null {
  const match = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/is.exec(src)
  if (match === null) return null
  const mime = mimeOf(match[1])
  if (mime === null) return null
  const params = (match[2] ?? '').toLowerCase()
  const payload = match[3] ?? ''
  let bytes: Buffer
  try {
    bytes = params.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    return null
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function hostOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

/** The declared icons in the order to try: the theme asked, then unthemed, then the rest. */
export function orderedHints(hints: readonly ConnectorIconHint[], theme: ConnectorIconTheme): ConnectorIconHint[] {
  const rank = (hint: ConnectorIconHint): number => {
    const own = hint.theme?.toLowerCase()
    if (own === theme) return 0
    if (own === undefined || own === '') return 1
    return 2
  }
  return [...hints].sort((a, b) => rank(a) - rank(b))
}

/** The shipped icon for a well-known service, by a word of the name or by host. */
export function shippedIconFor(entry: Pick<ConnectorEntry, 'name' | 'displayName' | 'host' | 'websiteUrl'>, theme: ConnectorIconTheme): string | null {
  const words = new Set(`${entry.name} ${entry.displayName}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== ''))
  const hosts = [entry.host?.toLowerCase(), hostOfUrl(entry.websiteUrl)].filter((host): host is string => host !== undefined)
  for (const icon of SHIPPED_ICONS) {
    const byName = icon.names.some((name) => words.has(name))
    const byHost = hosts.some((host) => icon.hosts.some((known) => host === known || host.endsWith(`.${known}`)))
    if (byName || byHost) return svgDataUri(icon.svg(inkFor(theme)))
  }
  return null
}

/** The site icon addresses to try: the website's, then the address host's. */
export function siteIconSources(entry: Pick<ConnectorEntry, 'host' | 'websiteUrl'>): string[] {
  const sources: string[] = []
  if (entry.websiteUrl !== undefined && isHttps(entry.websiteUrl)) {
    sources.push(`${new URL(entry.websiteUrl).origin}/favicon.ico`)
  }
  if (entry.host !== undefined && entry.host !== '') {
    const fromHost = `https://${entry.host}/favicon.ico`
    if (isHttps(fromHost) && !sources.includes(fromHost)) sources.push(fromHost)
  }
  return sources
}

class IconSource {
  readonly #deps: Required<Omit<IconDeps, 'cacheDir'>> & { cacheDir: string | null }

  constructor(deps: IconDeps) {
    this.#deps = {
      fetch: deps.fetch ?? (globalThis.fetch as unknown as IconFetchFn),
      cacheDir: deps.cacheDir ?? null,
      fs: deps.fs ?? nodeFs,
      now: deps.now ?? Date.now,
      cache: deps.cache ?? defaultCache,
      timeoutMs: deps.timeoutMs ?? ICON_TIMEOUT_MS,
      maxBytes: deps.maxBytes ?? MAX_ICON_BYTES,
      missTtlMs: deps.missTtlMs ?? ICON_MISS_TTL_MS,
      hitTtlMs: deps.hitTtlMs ?? ICON_HIT_TTL_MS,
    }
  }

  #fresh(cached: CachedIcon): boolean {
    const ttl = cached.dataUri === null ? this.#deps.missTtlMs : this.#deps.hitTtlMs
    return this.#deps.now() - cached.at < ttl
  }

  #file(key: string): string | null {
    return this.#deps.cacheDir === null ? null : join(this.#deps.cacheDir, `${key}.json`)
  }

  async #readDisk(key: string): Promise<CachedIcon | null> {
    const file = this.#file(key)
    if (file === null) return null
    try {
      const parsed = JSON.parse(await this.#deps.fs.readFile(file, 'utf8')) as Partial<CachedIcon>
      if (typeof parsed.at !== 'number') return null
      if (parsed.dataUri !== null && (typeof parsed.dataUri !== 'string' || !parsed.dataUri.startsWith('data:image/'))) return null
      return { dataUri: parsed.dataUri, at: parsed.at }
    } catch {
      return null
    }
  }

  async #writeDisk(key: string, cached: CachedIcon): Promise<void> {
    const file = this.#file(key)
    if (file === null || this.#deps.cacheDir === null) return
    try {
      await this.#deps.fs.mkdir(this.#deps.cacheDir, { recursive: true })
      await this.#deps.fs.writeFile(file, JSON.stringify(cached), 'utf8')
    } catch (error) {
      console.warn('[Connectors] keeping an icon failed:', error)
    }
  }

  /** One source's icon: from memory, from disk, or fetched once (in-flight fetches are shared). */
  async get(url: string, theme: ConnectorIconTheme): Promise<string | null> {
    // A declared data: image needs no fetch and no cache — only checking.
    if (url.startsWith('data:')) return normalizeDataIcon(url, this.#deps.maxBytes)
    if (!isHttps(url)) return null
    const key = createHash('sha256').update(`${url}\u0000${theme}`).digest('hex').slice(0, 40)
    const { memory, pending } = this.#deps.cache
    const remembered = memory.get(key)
    if (remembered !== undefined && this.#fresh(remembered)) return remembered.dataUri
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight
    const work = (async () => {
      const onDisk = await this.#readDisk(key)
      if (onDisk !== null && this.#fresh(onDisk)) {
        memory.set(key, onDisk)
        return onDisk.dataUri
      }
      const dataUri = await this.#fetch(url)
      const cached = { dataUri, at: this.#deps.now() }
      memory.set(key, cached)
      await this.#writeDisk(key, cached)
      return dataUri
    })()
    pending.set(key, work)
    try {
      return await work
    } finally {
      pending.delete(key)
    }
  }

  async #fetch(url: string): Promise<string | null> {
    if (!isHttps(url)) return null
    try {
      const response = await this.#deps.fetch(url, { signal: AbortSignal.timeout(this.#deps.timeoutMs), redirect: 'follow' })
      if (!response.ok) return null
      if (response.url !== undefined && response.url !== '' && !isHttps(response.url)) return null
      const mime = mimeOf(response.headers.get('content-type'))
      if (mime === null) return null
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > this.#deps.maxBytes) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > this.#deps.maxBytes) return null
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      // Late, refused, offline — a miss either way; it is cached as one.
      return null
    }
  }
}

/**
 * The icon for one connector in one theme, as a `data:` image, or null when
 * the renderer should draw the initial. Never throws.
 */
export async function resolveConnectorIcon(
  entry: ConnectorEntry,
  theme: ConnectorIconTheme,
  deps: IconDeps = {},
): Promise<string | null> {
  const source = new IconSource(deps)
  for (const hint of orderedHints(entry.iconHints, theme)) {
    const icon = await source.get(hint.src, theme)
    if (icon !== null) return icon
  }
  const shipped = shippedIconFor(entry, theme)
  if (shipped !== null) return shipped
  for (const url of siteIconSources(entry)) {
    const icon = await source.get(url, theme)
    if (icon !== null) return icon
  }
  return null
}
