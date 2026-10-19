/**
 * The publish client's hardening — review findings H3, L-4, L-5, L-6, the
 * endpoint validation and the sender check — proven against REAL files and a
 * REAL socket where the finding is about the real thing:
 *
 *  · H3: a symlinked walkthrough (or discovery) is refused and nothing is sent;
 *    a symlinked `flow/` directory with real files still shares.
 *  · L-5: a same-size rewrite between look and press is refused, no request.
 *  · L-4: every request says `redirect: 'error'`; a real 307 is not followed.
 *  · L-6: a summary whose link is on another origin is 'unavailable'.
 *
 * Every refusal asserts the positive first (allowed-pattern #28) and the
 * absence of the side effect after (allowed-pattern #24).
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  constants as fsConstants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ShareSummary } from '../../shared/share-contract'
import { appEntryFor, isAppEntryUrl, opensExternally, shouldBlockNavigation } from './app-entry'
import { createShareClient, isShareSummary, type ShareFetch } from './share-client'
import { configuredShareEndpoint, shareLinkOrigin } from './share-endpoint'
import { guardedOpenFlags, NotARegularFileError, readGuardedFile, type GuardFs, type ShareFileGuard } from './share-file-guard'
import { isAppMainFrame } from './share-ipc'
import { createMemoryShareRecords } from './share-records'

let warnSpy: jest.SpyInstance
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warnSpy.mockRestore()
})

const TOKEN = 'SESSION-TOKEN-hardening-eyJzdWIiOiJnaXRodWJ8MSJ9'
const BASE = 'https://planflow.sh'
const SLUG = 'ledger-sync'
const DOC = `flow/discovery/discovery_${SLUG}_v1.md`
const PAGE_NAME = `discovery_${SLUG}_v1.walkthrough.html`
const DOC_NAME = `discovery_${SLUG}_v1.md`
const WALKTHROUGH = '<!doctype html><p>ledger</p>'
const DISCOVERY = '# Ledger sync\n\nBody.'
const SECRET = 'PRIVATE KEY — must never leave the machine'

const PROJECT_ID = '0123456789abcdef0123456789abcdef'
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

function summary(over: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id: 'shareABCD1234',
    url: 'https://planflow.sh/v/shareABCD1234',
    project: 'proj',
    slug: SLUG,
    title: 'Ledger sync',
    version: 1,
    discoveryVersion: 1,
    pageModifiedAt: '2026-10-01T10:00:00.000Z',
    publishedAt: '2026-10-01T10:00:00.000Z',
    access: { emails: ['a@b.io'], domains: [] },
    accessCount: 1,
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-share-hardening-')))
  temps.push(dir)
  return dir
}

/** A project root with a real `flow/discovery/` holding both files. */
function project(opts: { walkthrough?: string; discovery?: string } = {}): string {
  const root = join(tempDir(), 'proj')
  mkdirSync(join(root, 'flow', 'discovery'), { recursive: true })
  writeFileSync(join(root, 'flow', 'discovery', PAGE_NAME), opts.walkthrough ?? WALKTHROUGH)
  writeFileSync(join(root, 'flow', 'discovery', DOC_NAME), opts.discovery ?? DISCOVERY)
  return root
}

interface Call {
  url: string
  init: Parameters<ShareFetch>[1]
}

/** A client over the REAL filesystem (default no-follow reader) and a recorded fetch. */
function realFsClient(root: string, respond: (call: Call) => { status: number; json: unknown } = () => ({ status: 201, json: summary() })) {
  const calls: Call[] = []
  const client = createShareClient({
    endpoint: () => BASE,
    identity: { load: () => ({ subject: 'github|1', displayName: null, token: TOKEN, expiresAt: null }) },
    fetch: async (url, init) => {
      const call = { url, init }
      calls.push(call)
      const answer = respond(call)
      return { status: answer.status, json: async () => answer.json }
    },
    isKnownRoot: (candidate) => candidate === root,
    projectLabelFor: () => 'proj',
    projectIds: { existing: async () => PROJECT_ID, ensure: async () => PROJECT_ID },
    // Recorded as shared, so `get` asks the host (R2-M7 is covered in share-client.test.ts).
    records: createMemoryShareRecords([{ subject: 'github|1', projectId: PROJECT_ID, slug: SLUG, id: 'shareABCD1234' }]),
    onSessionRejected: () => {},
  })
  return { client, calls }
}

const REVIEWED = {
  walkthroughBytes: Buffer.byteLength(WALKTHROUGH),
  discoveryBytes: Buffer.byteLength(DISCOVERY),
  walkthroughSha256: sha(WALKTHROUGH),
  discoverySha256: sha(DISCOVERY),
}

function publishOf(root: string, reviewed = REVIEWED) {
  return { rootPath: root, docPath: DOC, reviewed, access: { emails: ['a@b.io'], domains: [] }, notify: false }
}

describe('H3 — the two files are read without following a symlink', () => {
  it('a regular project shares, and get reports each file with its sha256', async () => {
    const root = project()
    const { client, calls } = realFsClient(root, () => ({ status: 404, json: { error: 'not-found' } }))
    const got = await client.get(root, DOC)
    expect(got).toMatchObject({
      ok: true,
      local: {
        files: [
          { part: 'walkthrough', name: PAGE_NAME, bytes: REVIEWED.walkthroughBytes, sha256: REVIEWED.walkthroughSha256 },
          { part: 'discovery', name: DOC_NAME, bytes: REVIEWED.discoveryBytes, sha256: REVIEWED.discoverySha256 },
        ],
      },
    })
    expect(calls).toHaveLength(1)
  })

  it('a walkthrough that is a symlink to a secret is refused, and NOTHING is fetched', async () => {
    // The positive: the same project with a real page publishes.
    const good = project()
    const ok = realFsClient(good)
    expect(await ok.client.publish(publishOf(good))).toMatchObject({ ok: true })
    expect(ok.calls).toHaveLength(1)

    const root = project()
    const secret = join(tempDir(), 'id_ed25519')
    writeFileSync(secret, SECRET)
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    rmSync(page)
    symlinkSync(secret, page)

    const { client, calls } = realFsClient(root)
    const got = await client.get(root, DOC)
    expect(got).toMatchObject({ ok: false, reason: 'unreadable' })
    const published = await client.publish(
      publishOf(root, { ...REVIEWED, walkthroughBytes: Buffer.byteLength(SECRET), walkthroughSha256: sha(SECRET) }),
    )
    expect(published).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
    expect(JSON.stringify([got, published])).not.toContain(SECRET)
    expect(JSON.stringify([got, published])).not.toContain(TOKEN)
  })

  it('a discovery that is a symlink is refused, and NOTHING is fetched', async () => {
    const root = project()
    const secret = join(tempDir(), '.env')
    writeFileSync(secret, `# ${SECRET}`)
    const doc = join(root, 'flow', 'discovery', DOC_NAME)
    rmSync(doc)
    symlinkSync(secret, doc)
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
  })

  it('a hard-linked walkthrough (nlink > 1) is refused, and NOTHING is fetched', async () => {
    const root = project()
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, SECRET)
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    rmSync(page)
    linkSync(secret, page)
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
  })

  it('a walkthrough that is a directory is refused', async () => {
    const root = project()
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    rmSync(page)
    mkdirSync(page)
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
  })

  it('a missing walkthrough is still "no feature view yet"', async () => {
    const root = project()
    rmSync(join(root, 'flow', 'discovery', PAGE_NAME))
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'page-missing' })
    expect(calls).toEqual([])
  })

  it('a symlinked flow/ directory with real files still shares — only the last component is no-follow', async () => {
    const vault = join(tempDir(), 'vault-flow')
    mkdirSync(join(vault, 'discovery'), { recursive: true })
    writeFileSync(join(vault, 'discovery', PAGE_NAME), WALKTHROUGH)
    writeFileSync(join(vault, 'discovery', DOC_NAME), DISCOVERY)
    const root = join(tempDir(), 'proj')
    mkdirSync(root)
    symlinkSync(vault, join(root, 'flow'))

    const { client, calls } = realFsClient(root)
    const published = await client.publish(publishOf(root))
    expect(published).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { walkthroughHtml?: string; discoveryMarkdown?: string }
    expect(body.walkthroughHtml).toBe(WALKTHROUGH)
    expect(body.discoveryMarkdown).toBe(DISCOVERY)
  })

  it('readGuardedFile reads bytes and mtime from the same handle', async () => {
    const root = project()
    const read = await readGuardedFile(join(root, 'flow', 'discovery', PAGE_NAME), guardOf(root))
    expect(read.content?.toString('utf8')).toBe(WALKTHROUGH)
    expect(read.size).toBe(Buffer.byteLength(WALKTHROUGH))
    expect(read.mtimeMs).toBeGreaterThan(0)
  })
})

function guardOf(root: string, over: Partial<ShareFileGuard> = {}): ShareFileGuard {
  return { flowDir: join(root, 'flow'), subdir: 'discovery', maxBytes: 2 * 1024 * 1024, ...over }
}

/** The real filesystem, with the platform's flags replaced — Windows has no O_NOFOLLOW. */
function fsWithFlags(constants: GuardFs['constants'], over: Partial<GuardFs> = {}): GuardFs {
  return {
    lstat: (path) => fsPromises.lstat(path),
    realpath: (path) => fsPromises.realpath(path),
    open: (path, flags) => fsPromises.open(path, flags),
    constants,
    ...over,
  }
}

const WINDOWS_LIKE = { O_RDONLY: fsConstants.O_RDONLY }

describe('R2-M5 — the guard holds where O_NOFOLLOW does not exist', () => {
  it('with no O_NOFOLLOW (Windows), a regular file reads and a symlinked one is refused', async () => {
    const root = project()
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    // The positive: the flag-less guard reads a real file.
    const read = await readGuardedFile(page, guardOf(root), fsWithFlags(WINDOWS_LIKE))
    expect(read.content?.toString('utf8')).toBe(WALKTHROUGH)

    const secret = join(tempDir(), 'id_ed25519')
    writeFileSync(secret, SECRET)
    rmSync(page)
    symlinkSync(secret, page)
    expect(guardedOpenFlags(WINDOWS_LIKE)).toBe(fsConstants.O_RDONLY)
    await expect(readGuardedFile(page, guardOf(root), fsWithFlags(WINDOWS_LIKE))).rejects.toMatchObject({
      why: 'symlink',
    })
  })

  it('a file swapped between lstat and open is refused (inode mismatch)', async () => {
    const root = project()
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    const other = join(root, 'flow', 'discovery', 'other.html')
    writeFileSync(other, SECRET)
    // The positive: unswapped, it reads.
    expect((await readGuardedFile(page, guardOf(root), fsWithFlags(WINDOWS_LIKE))).content).not.toBeNull()
    // lstat sees the page; open lands on a different file — what a racing swap does.
    const swapped = fsWithFlags(WINDOWS_LIKE, { open: (_path, flags) => fsPromises.open(other, flags) })
    await expect(readGuardedFile(page, guardOf(root), swapped)).rejects.toMatchObject({ why: 'swapped' })
  })

  it('the open flags add no-follow and non-blocking where the platform has them', () => {
    const flags = guardedOpenFlags(fsConstants)
    expect(flags & fsConstants.O_RDONLY).toBe(fsConstants.O_RDONLY)
    if (fsConstants.O_NOFOLLOW !== undefined) expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW)
    if (fsConstants.O_NONBLOCK !== undefined) expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK)
  })
})

const posixOnly = process.platform === 'win32' ? describe.skip : describe

posixOnly('R2-M6 — a named pipe is refused promptly, never opened into a hang', () => {
  function fifoProject(): { root: string; page: string } {
    const root = project()
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    rmSync(page)
    execFileSync('mkfifo', [page])
    return { root, page }
  }

  it('a FIFO walkthrough is refused by lstat, and the client sends nothing', async () => {
    const { root, page } = fifoProject()
    const started = Date.now()
    await expect(readGuardedFile(page, guardOf(root))).rejects.toMatchObject({ why: 'not-a-file' })
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 5_000)

  it('even if lstat were fooled, O_NONBLOCK opens the FIFO without hanging and fstat refuses it', async () => {
    const { root, page } = fifoProject()
    const regular = join(root, 'flow', 'discovery', DOC_NAME)
    // lstat lies — reports a regular file — so only the second guard stands.
    const fooled = fsWithFlags(fsConstants, { lstat: () => fsPromises.lstat(regular) })
    await expect(readGuardedFile(page, guardOf(root), fooled)).rejects.toBeInstanceOf(NotARegularFileError)
  }, 5_000)
})

describe('R2-L9 — the files must sit in the real discovery directory of the resolved flow/', () => {
  it('a flow/discovery that is a symlink to a directory elsewhere is refused, nothing sent', async () => {
    const root = project()
    const elsewhere = join(tempDir(), 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, PAGE_NAME), WALKTHROUGH)
    writeFileSync(join(elsewhere, DOC_NAME), DISCOVERY)
    rmSync(join(root, 'flow', 'discovery'), { recursive: true })
    symlinkSync(elsewhere, join(root, 'flow', 'discovery'))

    await expect(readGuardedFile(join(root, 'flow', 'discovery', PAGE_NAME), guardOf(root))).rejects.toMatchObject({
      why: 'outside',
    })
    const { client, calls } = realFsClient(root)
    expect(await client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(calls).toEqual([])
  })

  it('a file in the archive is checked against the archive, not the discovery directory', async () => {
    const root = project()
    mkdirSync(join(root, 'flow', 'archive'))
    writeFileSync(join(root, 'flow', 'archive', PAGE_NAME), WALKTHROUGH)
    const page = join(root, 'flow', 'archive', PAGE_NAME)
    expect((await readGuardedFile(page, guardOf(root, { subdir: 'archive' }))).content).not.toBeNull()
    await expect(readGuardedFile(page, guardOf(root, { subdir: 'discovery' }))).rejects.toMatchObject({ why: 'outside' })
  })
})

describe('R2-L10 — size is checked before bytes are read', () => {
  it('a file over the cap reports its size and reads nothing; at the cap it reads', async () => {
    const root = project({ walkthrough: 'x'.repeat(10) })
    const page = join(root, 'flow', 'discovery', PAGE_NAME)
    const reads: number[] = []
    const counting = fsWithFlags(fsConstants, {
      open: async (path, flags) => {
        const handle = await fsPromises.open(path, flags)
        const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>
        ;(handle as unknown as { read: unknown }).read = async (...args: unknown[]) => {
          const result = await read(...args)
          reads.push(result.bytesRead)
          return result
        }
        return handle
      },
    })
    const atCap = await readGuardedFile(page, guardOf(root, { maxBytes: 10 }), counting)
    expect(atCap.content?.toString('utf8')).toBe('x'.repeat(10))
    expect(reads.length).toBeGreaterThan(0)

    reads.length = 0
    const over = await readGuardedFile(page, guardOf(root, { maxBytes: 9 }), counting)
    expect(over).toMatchObject({ content: null, size: 10 })
    expect(reads).toEqual([])
  })

  it('an oversized walkthrough is "too-large" to publish with NO request, and get says how big', async () => {
    const big = 'y'.repeat(2 * 1024 * 1024 + 1)
    const root = project({ walkthrough: big })
    const { client, calls } = realFsClient(root)
    const got = await client.get(root, DOC)
    if (!got.ok) throw new Error(`expected facts, got ${got.reason}`)
    expect(got.local.totalBytes).toBeGreaterThan(got.local.maxBytes)
    calls.length = 0
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'too-large' })
    expect(calls).toEqual([])
  })
})

describe('L-5 — the review is a content hash, not a size', () => {
  it('a same-size edit after review is refused with NO request; the reviewed content publishes', async () => {
    const root = project()
    const { client, calls } = realFsClient(root)
    const got = await client.get(root, DOC)
    if (!got.ok) throw new Error(`expected facts, got ${got.reason}`)
    const reviewed = {
      walkthroughBytes: got.local.files[0]?.bytes ?? -1,
      discoveryBytes: got.local.files[1]?.bytes ?? -1,
      walkthroughSha256: got.local.files[0]?.sha256 ?? '',
      discoverySha256: got.local.files[1]?.sha256 ?? '',
    }
    calls.length = 0

    // Same length, different content.
    const edited = WALKTHROUGH.replace('ledger', 'LEDGER')
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(WALKTHROUGH))
    writeFileSync(join(root, 'flow', 'discovery', PAGE_NAME), edited)
    expect(await client.publish(publishOf(root, reviewed))).toMatchObject({ ok: false, reason: 'changed-since-review' })
    expect(calls).toEqual([])

    // Put back what was reviewed: it publishes, with exactly those bytes.
    writeFileSync(join(root, 'flow', 'discovery', PAGE_NAME), WALKTHROUGH)
    expect(await client.publish(publishOf(root, reviewed))).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toMatchObject({ walkthroughHtml: WALKTHROUGH })
  })

  it('sizes alone, or a malformed hash, are not a review', async () => {
    const root = project()
    const { client, calls } = realFsClient(root)
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    calls.length = 0
    for (const reviewed of [
      { walkthroughBytes: REVIEWED.walkthroughBytes, discoveryBytes: REVIEWED.discoveryBytes },
      { ...REVIEWED, walkthroughSha256: 'abc' },
      { ...REVIEWED, discoverySha256: REVIEWED.discoverySha256.toUpperCase() },
    ]) {
      expect(await client.publish(publishOf(root, reviewed as typeof REVIEWED))).toMatchObject({
        ok: false,
        reason: 'changed-since-review',
      })
    }
    expect(calls).toEqual([])
  })
})

describe('L-4 — redirects are never followed', () => {
  it("every request says redirect: 'error'", async () => {
    const root = project()
    const { client, calls } = realFsClient(root, (call) => ({
      status: 200,
      json: call.url.endsWith('/views') ? { views: [] } : summary(),
    }))
    await client.get(root, DOC)
    await client.publish(publishOf(root))
    await client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] } })
    await client.revoke({ id: 'shareABCD1234', confirmed: true })
    await client.views('shareABCD1234')
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST', 'PATCH', 'PATCH', 'GET'])
    expect(calls.map((call) => call.init.redirect)).toEqual(['error', 'error', 'error', 'error', 'error'])
  })

  it('a 3xx that reaches the client is "unavailable", never an answer', async () => {
    const root = project()
    const { client, calls } = realFsClient(root, () => ({ status: 308, json: summary() }))
    expect(await client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(calls).toHaveLength(1)
  })

  describe('against a real socket', () => {
    let host: Server
    let elsewhere: Server
    const hostHits: string[] = []
    const elsewhereHits: Array<{ url: string | undefined; auth: string | undefined; body: string }> = []

    function listen(server: Server): Promise<number> {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
    }
    function bodyOf(request: IncomingMessage): Promise<string> {
      return new Promise((resolve) => {
        let body = ''
        request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
        request.on('end', () => resolve(body))
      })
    }

    let hostPort = 0
    let elsewherePort = 0
    beforeAll(async () => {
      elsewhere = createServer((request, response) => {
        void bodyOf(request).then((body) => {
          elsewhereHits.push({ url: request.url, auth: request.headers.authorization, body })
          response.writeHead(201, { 'content-type': 'application/json' })
          response.end(JSON.stringify(summary()))
        })
      })
      elsewherePort = await listen(elsewhere)
      host = createServer((request, response) => {
        void bodyOf(request).then(() => {
          hostHits.push(request.method ?? '')
          response.writeHead(307, { location: `http://127.0.0.1:${elsewherePort}/collect` })
          response.end()
        })
      })
      hostPort = await listen(host)
    })
    afterAll(async () => {
      await new Promise((resolve) => host.close(resolve))
      await new Promise((resolve) => elsewhere.close(resolve))
    })

    it('a 307 from the share host is "unavailable", and the files never reach the redirect target', async () => {
      const root = project()
      const client = createShareClient({
        endpoint: () => `http://127.0.0.1:${hostPort}`,
        identity: { load: () => ({ subject: 'github|1', displayName: null, token: TOKEN, expiresAt: null }) },
        // The REAL fetch — what main passes (index.ts).
        fetch: (url, init) => fetch(url, init),
        isKnownRoot: (candidate) => candidate === root,
        projectLabelFor: () => 'proj',
        projectIds: { existing: async () => PROJECT_ID, ensure: async () => PROJECT_ID },
        records: createMemoryShareRecords(),
        onSessionRejected: () => {},
      })
      const result = await client.publish(publishOf(root))
      // The positive: the host was reached and answered the redirect…
      expect(hostHits).toEqual(['POST'])
      // …the client said so plainly, without the token…
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
      // …and nothing went where the redirect pointed.
      expect(elsewhereHits).toEqual([])
    })
  })
})

describe('L-6 — a share link must be on the share host', () => {
  it('a summary whose url is on another origin is "unavailable"', async () => {
    const root = project()
    const good = realFsClient(root, () => ({ status: 201, json: summary() }))
    expect(await good.client.publish(publishOf(root))).toMatchObject({ ok: true })

    for (const url of [
      'https://evil.example/v/shareABCD1234',
      'https://planflow.sh.evil.example/v/shareABCD1234',
      'https://user@planflow.sh/v/shareABCD1234',
      'http://planflow.sh/v/shareABCD1234',
      'https://planflow.sh:8443/v/shareABCD1234',
      'not a url',
    ]) {
      const h = realFsClient(root, () => ({ status: 201, json: summary({ url }) }))
      expect(await h.client.publish(publishOf(root))).toMatchObject({ ok: false, reason: 'unavailable' })
      const g = realFsClient(root, () => ({ status: 200, json: summary({ url }) }))
      expect(await g.client.get(root, DOC)).toMatchObject({ ok: false, reason: 'unavailable' })
    }
  })

  it('isShareSummary checks the origin it is given', () => {
    expect(isShareSummary(summary(), 'https://planflow.sh')).toBe(true)
    expect(isShareSummary(summary(), 'https://staging.planflow.sh')).toBe(false)
    expect(isShareSummary(summary(), '')).toBe(false)
  })

  it('the link origin is the endpoint origin, whatever its path', () => {
    expect(shareLinkOrigin('https://planflow.sh')).toBe('https://planflow.sh')
    expect(shareLinkOrigin('https://planflow.sh/base')).toBe('https://planflow.sh')
  })
})

describe('the endpoint is a bare https URL, parsed', () => {
  it('accepts an https origin, with or without a path, trimming trailing slashes', () => {
    expect(configuredShareEndpoint({ endpoint: 'https://planflow.sh' })).toBe('https://planflow.sh')
    expect(configuredShareEndpoint({ endpoint: ' https://planflow.sh/ ' })).toBe('https://planflow.sh')
    expect(configuredShareEndpoint({ endpoint: 'https://planflow.sh/base//' })).toBe('https://planflow.sh/base')
    expect(configuredShareEndpoint({ endpoint: 'HTTPS://PlanFlow.sh' })).toBe('https://planflow.sh')
  })

  it('refuses anything else as "nowhere"', () => {
    for (const endpoint of [
      '',
      'http://planflow.sh',
      'https://user:pw@planflow.sh',
      'https://user@planflow.sh',
      'https://planflow.sh/?x=1',
      'https://planflow.sh?',
      'https://planflow.sh/#frag',
      'https://planflow.sh#',
      'https://',
      'planflow.sh',
      'javascript:alert(1)',
    ]) {
      expect(configuredShareEndpoint({ endpoint })).toBeNull()
    }
  })
})

describe('the sender check', () => {
  const ENTRY = 'file:///Applications/Flow.app/Contents/Resources/app/out/renderer/index.html'
  const mainFrame = { name: 'main', url: ENTRY }
  const sender = { mainFrame, id: 1 }
  const ours = (candidate: { id: number }) => candidate.id === 1
  const appUrl = (url: string) => url === ENTRY

  it("accepts the app window's own top frame, showing the app's own page", () => {
    expect(isAppMainFrame({ senderFrame: mainFrame, sender }, ours, appUrl)).toBe(true)
  })

  it('refuses a subframe, a gone frame, and a window that is not ours', () => {
    expect(isAppMainFrame({ senderFrame: { name: 'iframe', url: ENTRY }, sender }, ours, appUrl)).toBe(false)
    expect(isAppMainFrame({ senderFrame: null, sender }, ours, appUrl)).toBe(false)
    expect(isAppMainFrame({ senderFrame: undefined, sender }, ours, appUrl)).toBe(false)
    const other = { mainFrame, id: 2 }
    expect(isAppMainFrame({ senderFrame: mainFrame, sender: other }, ours, appUrl)).toBe(false)
  })

  it("R2-M8: refuses the app's own top frame once it shows another page", () => {
    for (const url of ['https://evil.example/', 'file:///tmp/dropped.html', 'about:blank', '', undefined]) {
      const navigated = { name: 'main', url }
      expect(isAppMainFrame({ senderFrame: navigated, sender: { mainFrame: navigated, id: 1 } }, ours, appUrl)).toBe(false)
    }
  })
})

describe('R2-M8 — the app entry and the main-window navigation guard', () => {
  const INDEX = '/Applications/Flow.app/Contents/Resources/app/out/renderer/index.html'

  it('packaged: only the built index.html is the app, whatever its query or fragment', () => {
    const entry = appEntryFor(undefined, INDEX)
    expect(entry.kind).toBe('file')
    expect(isAppEntryUrl(`file://${INDEX}`, entry)).toBe(true)
    expect(isAppEntryUrl(`file://${INDEX}?x=1#/threads`, entry)).toBe(true)
    for (const url of [
      'file:///Applications/Flow.app/Contents/Resources/app/out/renderer/other.html',
      'file:///Users/me/Downloads/dropped.html',
      'https://planflow.sh/',
      'about:blank',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isAppEntryUrl(url, entry)).toBe(false)
      expect(shouldBlockNavigation(url, entry)).toBe(true)
    }
    expect(shouldBlockNavigation(`file://${INDEX}`, entry)).toBe(false)
  })

  it('a path with spaces matches however it is percent-encoded', () => {
    const entry = appEntryFor(undefined, '/Users/me/My Apps/Flow/out/renderer/index.html')
    expect(isAppEntryUrl('file:///Users/me/My%20Apps/Flow/out/renderer/index.html', entry)).toBe(true)
  })

  it('dev: the Vite origin is the app — a reload (hot reload) is never blocked', () => {
    const entry = appEntryFor('http://localhost:5173', INDEX)
    expect(entry).toEqual({ kind: 'dev', origin: 'http://localhost:5173' })
    expect(shouldBlockNavigation('http://localhost:5173/', entry)).toBe(false)
    expect(shouldBlockNavigation('http://localhost:5173/index.html?t=1', entry)).toBe(false)
    expect(shouldBlockNavigation('http://localhost:5174/', entry)).toBe(true)
    expect(shouldBlockNavigation(`file://${INDEX}`, entry)).toBe(true)
    expect(shouldBlockNavigation('https://evil.example/', entry)).toBe(true)
  })

  it('a refused web link goes to the browser; a dropped file or a script URL just stops', () => {
    expect(opensExternally('https://planflow.sh/docs')).toBe(true)
    expect(opensExternally('http://example.com')).toBe(true)
    expect(opensExternally('file:///Users/me/Downloads/dropped.html')).toBe(false)
    expect(opensExternally('javascript:alert(1)')).toBe(false)
    expect(opensExternally('flow-page://walkthrough/')).toBe(false)
  })
})
