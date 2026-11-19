import type { ConnectorEntry } from '../../shared/connectors'
import {
  createIconCache,
  normalizeDataIcon,
  orderedHints,
  resolveConnectorIcon,
  type IconFetchFn,
  type IconFs,
  type IconResponse,
} from './connector-icons'

function entry(overrides: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    name: 'acme',
    displayName: 'Acme',
    source: 'account',
    transport: 'web',
    status: 'connected',
    tools: [],
    iconHints: [],
    removable: true,
    askFirst: [],
    ...overrides,
  }
}

function response(body: string, contentType: string | null, extra: Partial<IconResponse> = {}): IconResponse {
  const bytes = Buffer.from(body)
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ...extra,
  }
}

/** A fake fetch keyed by address; anything absent throws (no real network). */
function fakeFetch(table: Record<string, () => IconResponse>) {
  const calls: string[] = []
  const fetch: IconFetchFn = async (url) => {
    calls.push(url)
    const answer = table[url]
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`)
    return answer()
  }
  return { fetch, calls }
}

function memoryFs() {
  const files = new Map<string, string>()
  const fs: IconFs = {
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    writeFile: async (path, data) => void files.set(path, data),
    mkdir: async () => undefined,
  }
  return { fs, files }
}

const decode = (dataUri: string | null): string =>
  dataUri === null ? '' : Buffer.from(dataUri.split(',')[1] ?? '', 'base64').toString('utf8')

describe('resolveConnectorIcon', () => {
  it('prefers the declared icon for the theme asked, fetched in main', async () => {
    const { fetch, calls } = fakeFetch({
      'https://acme.dev/dark.svg': () => response('<svg>dark</svg>', 'image/svg+xml'),
    })
    const icon = await resolveConnectorIcon(
      entry({
        iconHints: [
          { src: 'https://acme.dev/light.png', theme: 'light' },
          { src: 'https://acme.dev/dark.svg', theme: 'dark' },
        ],
      }),
      'dark',
      { fetch, cache: createIconCache() },
    )
    expect(calls).toEqual(['https://acme.dev/dark.svg'])
    expect(icon?.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(decode(icon)).toBe('<svg>dark</svg>')
  })

  it('orders hints: theme match, then unthemed, then the other theme', () => {
    const ordered = orderedHints(
      [
        { src: 'a', theme: 'light' },
        { src: 'b' },
        { src: 'c', theme: 'dark' },
      ],
      'dark',
    )
    expect(ordered.map((hint) => hint.src)).toEqual(['c', 'b', 'a'])
  })

  it('serves a declared data: image without fetching, normalized to base64', async () => {
    const { fetch, calls } = fakeFetch({})
    const icon = await resolveConnectorIcon(
      entry({ iconHints: [{ src: 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E' }] }),
      'light',
      { fetch, cache: createIconCache() },
    )
    expect(calls).toEqual([])
    expect(decode(icon)).toBe('<svg></svg>')
    expect(normalizeDataIcon('data:text/html;base64,PGI+')).toBeNull()
  })

  it('falls back to a shipped icon by name or host when the declared one fails', async () => {
    const { fetch } = fakeFetch({ 'https://mcp.linear.app/icon.png': () => response('nope', 'text/html') })
    const byName = await resolveConnectorIcon(
      entry({ name: 'claude.ai Linear', displayName: 'Linear', iconHints: [{ src: 'https://mcp.linear.app/icon.png' }] }),
      'light',
      { fetch, cache: createIconCache() },
    )
    expect(decode(byName)).toContain('#5E6AD2')
    const byHost = await resolveConnectorIcon(entry({ name: 'tickets', displayName: 'Tickets', host: 'mcp.sentry.dev' }), 'dark', {
      fetch,
      cache: createIconCache(),
    })
    expect(decode(byHost)).toContain('#362D59')
  })

  it('draws a monochrome shipped icon in the theme’s ink', async () => {
    const { fetch } = fakeFetch({})
    const light = decode(await resolveConnectorIcon(entry({ name: 'github' }), 'light', { fetch, cache: createIconCache() }))
    const dark = decode(await resolveConnectorIcon(entry({ name: 'github' }), 'dark', { fetch, cache: createIconCache() }))
    expect(light).toContain('#1A1A1A')
    expect(dark).toContain('#F2F2F2')
  })

  it('then tries the site icon of the website, then of the address host, then answers null', async () => {
    const { fetch, calls } = fakeFetch({
      'https://acme.dev/favicon.ico': () => ({ ...response('', null), ok: false, status: 404 }),
      'https://mcp.acme.dev/favicon.ico': () => response('ICO', 'image/x-icon'),
    })
    const icon = await resolveConnectorIcon(entry({ websiteUrl: 'https://acme.dev/docs', host: 'mcp.acme.dev' }), 'light', {
      fetch,
      cache: createIconCache(),
    })
    expect(calls).toEqual(['https://acme.dev/favicon.ico', 'https://mcp.acme.dev/favicon.ico'])
    expect(icon).toBe(`data:image/x-icon;base64,${Buffer.from('ICO').toString('base64')}`)

    const none = await resolveConnectorIcon(entry(), 'light', { fetch, cache: createIconCache() })
    expect(none).toBeNull()
  })

  it('refuses non-https sources, oversize bodies, non-image types and http redirects', async () => {
    const big = 'x'.repeat(300 * 1024)
    const { fetch, calls } = fakeFetch({
      'https://a.dev/big.png': () => response(big, 'image/png'),
      'https://a.dev/page': () => response('<html>', 'text/html; charset=utf-8'),
      'https://a.dev/moved.png': () => response('PNG', 'image/png', { url: 'http://a.dev/moved.png' }),
    })
    const icon = await resolveConnectorIcon(
      entry({
        iconHints: [
          { src: 'http://a.dev/plain.png' },
          { src: 'https://a.dev/big.png' },
          { src: 'https://a.dev/page' },
          { src: 'https://a.dev/moved.png' },
        ],
      }),
      'light',
      { fetch, cache: createIconCache() },
    )
    expect(icon).toBeNull()
    expect(calls).not.toContain('http://a.dev/plain.png')
  })

  it('refuses a body declared larger than the cap before reading it', async () => {
    let read = false
    const { fetch } = fakeFetch({
      'https://a.dev/i.png': () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'image/png' : name === 'content-length' ? '999999' : null) },
        arrayBuffer: async () => {
          read = true
          return new ArrayBuffer(1)
        },
      }),
    })
    expect(await resolveConnectorIcon(entry({ iconHints: [{ src: 'https://a.dev/i.png' }] }), 'light', { fetch, cache: createIconCache() })).toBeNull()
    expect(read).toBe(false)
  })

  it('caches hits in memory and on disk, and reuses the disk copy in a new run', async () => {
    const { fs, files } = memoryFs()
    const first = fakeFetch({ 'https://a.dev/i.png': () => response('PNG', 'image/png') })
    const cache = createIconCache()
    const deps = { fs, cacheDir: '/userData/connector-icons', now: () => 1_000 }
    const hint = entry({ iconHints: [{ src: 'https://a.dev/i.png' }] })
    const a = await resolveConnectorIcon(hint, 'light', { ...deps, fetch: first.fetch, cache })
    const b = await resolveConnectorIcon(hint, 'light', { ...deps, fetch: first.fetch, cache })
    expect(a).toBe(b)
    expect(first.calls).toHaveLength(1)
    expect([...files.keys()]).toHaveLength(1)
    expect([...files.keys()][0]?.startsWith('/userData/connector-icons/')).toBe(true)

    const second = fakeFetch({})
    const c = await resolveConnectorIcon(hint, 'light', { ...deps, fetch: second.fetch, cache: createIconCache() })
    expect(c).toBe(a)
    expect(second.calls).toEqual([])
  })

  it('caches a failed fetch as a miss for a while, then tries again', async () => {
    let clock = 0
    let attempts = 0
    const fetch: IconFetchFn = async () => {
      attempts += 1
      throw new Error('offline')
    }
    const cache = createIconCache()
    const deps = { fetch, cache, now: () => clock, missTtlMs: 60_000 }
    const target = entry({ iconHints: [{ src: 'https://a.dev/i.png' }] })
    expect(await resolveConnectorIcon(target, 'light', deps)).toBeNull()
    clock = 30_000
    expect(await resolveConnectorIcon(target, 'light', deps)).toBeNull()
    expect(attempts).toBe(1)
    clock = 61_000
    await resolveConnectorIcon(target, 'light', deps)
    expect(attempts).toBe(2)
  })

  it('shares one fetch between concurrent asks', async () => {
    let release: (() => void) | undefined
    let attempts = 0
    const fetch: IconFetchFn = async () => {
      attempts += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return response('PNG', 'image/png')
    }
    const cache = createIconCache()
    const target = entry({ iconHints: [{ src: 'https://a.dev/i.png' }] })
    const both = Promise.all([
      resolveConnectorIcon(target, 'light', { fetch, cache }),
      resolveConnectorIcon(target, 'light', { fetch, cache }),
    ])
    await new Promise((resolve) => setImmediate(resolve))
    release?.()
    const [a, b] = await both
    expect(attempts).toBe(1)
    expect(a).toBe(b)
  })
})
