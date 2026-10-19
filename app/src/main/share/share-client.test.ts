/**
 * The publish client — the only code in Flow that talks to the share host.
 *
 * Everything external is injected and recorded: the files it reads, the
 * requests it makes, the clock. The session token is a recognisable string so
 * the tests can prove it goes to the Authorization header and nowhere else.
 */
import { createHash } from 'crypto'
import { join } from 'path'

import type { ShareSummary } from '../../shared/share-contract'
import type { RejectedSession } from '../auth/auth-session'
import type { StoredIdentity } from '../auth/identity-store'
import { createShareClient, invitesSkippedOf, SHARE_GET_CACHE_MS, type ShareFetch } from './share-client'
import type { ProjectIds } from './share-project-id'
import { createMemoryShareRecords } from './share-records'

let warnSpy: jest.SpyInstance
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warnSpy.mockRestore()
})

const ROOT = '/work/plan-flow'
const DOC = 'flow/discovery/discovery_feature-view-sharing_v2.md'
const PAGE = 'flow/discovery/discovery_feature-view-sharing_v2.walkthrough.html'
const TOKEN = 'SESSION-TOKEN-eyJzdWIiOiJnaXRodWJ8MSJ9.c2lnbmF0dXJl'
const BASE = 'https://planflow.sh'
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const PAGE_MTIME = Date.parse('2026-10-01T11:00:00.000Z')

const SUBJECT = 'github|1'
const PROJECT_ID = '0123456789abcdef0123456789abcdef'
const SLUG = 'feature-view-sharing'
const RECORD = { subject: SUBJECT, projectId: PROJECT_ID, slug: SLUG, id: 'shareABCD1234' }

const WALKTHROUGH = '<!doctype html><html><body>walkthrough</body></html>'
const DISCOVERY = '# Feature view sharing\n\nBody.'

/** Other files in the project that must never be read. */
const FILES: Record<string, string> = {
  [join(ROOT, PAGE)]: WALKTHROUGH,
  [join(ROOT, DOC)]: DISCOVERY,
  [join(ROOT, '.env')]: 'SECRET=1',
  [join(ROOT, 'flow/discovery/discovery_feature-view-sharing_v1.md')]: 'old',
}

function summary(over: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id: 'shareABCD1234',
    url: 'https://planflow.sh/v/shareABCD1234',
    project: 'plan-flow',
    slug: 'feature-view-sharing',
    title: 'Feature view sharing',
    version: 1,
    discoveryVersion: 2,
    pageModifiedAt: new Date(PAGE_MTIME).toISOString(),
    publishedAt: new Date(NOW).toISOString(),
    access: { emails: ['ada@client.io'], domains: [] },
    accessCount: 1,
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  redirect: string
}

/** Project ids held in memory: `existing` never mints; `ensure` mints `minted` once. */
function memoryProjectIds(initial: string | null, minted = 'fedcba9876543210fedcba9876543210') {
  let held = initial
  const ensured: string[] = []
  const ids: ProjectIds = {
    existing: async () => held,
    ensure: async (root) => {
      ensured.push(root)
      held ??= minted
      return held
    },
  }
  return { ids, ensured, current: () => held }
}

function harness(
  opts: {
    identity?: StoredIdentity | null
    respond?: (call: Recorded) => { status: number; json: unknown }
    files?: Record<string, string>
    /** The project's sharing id; null = the project never had one. Default PROJECT_ID. */
    projectId?: string | null
    /** Seed the local record that this account shared the discovery. Default true. */
    recorded?: boolean
  } = {},
) {
  const reads: string[] = []
  const files = opts.files ?? FILES
  const requests: Recorded[] = []
  let clock = NOW
  const identity: StoredIdentity | null =
    opts.identity === undefined ? { subject: 'github|1', displayName: 'Ada', token: TOKEN, expiresAt: null } : opts.identity
  const respond = opts.respond ?? (() => ({ status: 200, json: summary() }))
  const fetch: ShareFetch = async (url, init) => {
    const call: Recorded = {
      url,
      method: init.method,
      headers: { ...init.headers },
      redirect: init.redirect,
      ...(init.body === undefined ? {} : { body: init.body }),
    }
    requests.push(call)
    const answer = respond(call)
    return { status: answer.status, json: async () => answer.json }
  }
  const projectIds = memoryProjectIds(opts.projectId === undefined ? PROJECT_ID : opts.projectId)
  const records = createMemoryShareRecords(opts.recorded === false ? [] : [RECORD])
  const rejections: RejectedSession[] = []
  const client = createShareClient({
    endpoint: () => BASE,
    identity: { load: () => identity },
    fetch,
    isKnownRoot: (root) => root === ROOT,
    projectIds: projectIds.ids,
    records,
    onSessionRejected: (rejected) => {
      rejections.push(rejected)
    },
    readFile: async (abs) => {
      reads.push(abs)
      const content = files[abs]
      if (content === undefined) throw Object.assign(new Error(`ENOENT ${abs}`), { code: 'ENOENT' })
      const buffer = Buffer.from(content, 'utf8')
      return { content: buffer, size: buffer.length, mtimeMs: PAGE_MTIME }
    },
    now: () => clock,
  })
  return {
    client,
    reads,
    requests,
    rejections,
    records,
    projectIds,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const REVIEWED = {
  walkthroughBytes: bytes(WALKTHROUGH),
  discoveryBytes: bytes(DISCOVERY),
  walkthroughSha256: sha(WALKTHROUGH),
  discoverySha256: sha(DISCOVERY),
}

/** Every value a call returned, serialised — where a leaked token would show. */
function everythingReturned(...values: unknown[]): string {
  return JSON.stringify(values)
}

describe('what is read and what is sent', () => {
  it('get reads exactly the walkthrough page and the discovery, and reports them by name and size', async () => {
    const h = harness({ respond: () => ({ status: 404, json: { error: 'not-found' } }) })
    const result = await h.client.get(ROOT, DOC)
    expect(result).toEqual({
      ok: true,
      share: null,
      local: {
        project: 'plan-flow',
        slug: 'feature-view-sharing',
        title: 'Feature view sharing',
        discoveryVersion: 2,
        pageModifiedAt: new Date(PAGE_MTIME).toISOString(),
        files: [
          {
            part: 'walkthrough',
            name: 'discovery_feature-view-sharing_v2.walkthrough.html',
            bytes: REVIEWED.walkthroughBytes,
            sha256: REVIEWED.walkthroughSha256,
          },
          {
            part: 'discovery',
            name: 'discovery_feature-view-sharing_v2.md',
            bytes: REVIEWED.discoveryBytes,
            sha256: REVIEWED.discoverySha256,
          },
        ],
        totalBytes: REVIEWED.walkthroughBytes + REVIEWED.discoveryBytes,
        maxBytes: 2 * 1024 * 1024,
      },
    })
    expect(h.reads).toEqual([join(ROOT, PAGE), join(ROOT, DOC)])
  })

  it('publish reads exactly the two files and sends exactly the contract body', async () => {
    const h = harness({ respond: () => ({ status: 201, json: summary() }) })
    const result = await h.client.publish({
      rootPath: ROOT,
      docPath: DOC,
      reviewed: REVIEWED,
      access: { emails: [' Ada@Client.IO '], domains: ['Acme.com'] },
      notify: true,
    })
    expect(result).toEqual({ ok: true, share: summary() })
    expect(h.reads).toEqual([join(ROOT, PAGE), join(ROOT, DOC)])
    expect(h.requests).toHaveLength(1)
    const [call] = h.requests
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(`${BASE}/api/shares`)
    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ['access', 'discoveryMarkdown', 'discoveryVersion', 'notify', 'pageModifiedAt', 'project', 'projectId', 'slug', 'title', 'walkthroughHtml'].sort(),
    )
    expect(body).toEqual({
      projectId: PROJECT_ID,
      project: 'plan-flow',
      slug: 'feature-view-sharing',
      title: 'Feature view sharing',
      discoveryVersion: 2,
      pageModifiedAt: new Date(PAGE_MTIME).toISOString(),
      walkthroughHtml: WALKTHROUGH,
      discoveryMarkdown: DISCOVERY,
      notify: true,
      access: { emails: ['ada@client.io'], domains: ['acme.com'] },
    })
  })

  it('refuses a path that is not a discovery doc in a known root, reading nothing', async () => {
    const ok = harness({ respond: () => ({ status: 404, json: { error: 'not-found' } }) })
    expect((await ok.client.get(ROOT, DOC)).ok).toBe(true)

    const h = harness()
    for (const [root, path] of [
      ['/somewhere/else', DOC],
      [ROOT, '.env'],
      [ROOT, PAGE],
      [ROOT, 'flow/discovery/../../.env.md'],
      [ROOT, 'flow/plans/plan_x_v1.md'],
      [ROOT, 'flow/discovery/nested/discovery_x_v1.md'],
    ] as const) {
      const result = await h.client.get(root, path)
      expect(result).toMatchObject({ ok: false, reason: 'not-a-discovery' })
    }
    expect(h.reads).toEqual([])
    expect(h.requests).toEqual([])
  })
})

describe('the session token stays in main', () => {
  it('is sent only as the Authorization header — never in a URL or a body', async () => {
    const h = harness({ respond: (call) => ({ status: call.method === 'GET' ? 200 : 200, json: call.url.endsWith('/views') ? { views: [] } : summary() }) })
    await h.client.get(ROOT, DOC)
    await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false })
    await h.client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] } })
    await h.client.revoke({ id: 'shareABCD1234', confirmed: true })
    await h.client.views('shareABCD1234')
    expect(h.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'PATCH', 'PATCH', 'GET'])
    for (const call of h.requests) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(call.url).not.toContain(TOKEN)
      expect(call.body ?? '').not.toContain(TOKEN)
      const otherHeaders = Object.entries(call.headers).filter(([name]) => name !== 'authorization')
      expect(JSON.stringify(otherHeaders)).not.toContain(TOKEN)
    }
  })

  it('never appears in anything a call returns — successes or refusals', async () => {
    const answers = [
      { status: 200, json: summary() },
      { status: 401, json: { error: 'session-expired' } },
      { status: 500, json: { error: `boom ${TOKEN}` } },
      { status: 200, json: { echoed: TOKEN } },
    ]
    let i = 0
    const h = harness({ respond: () => answers[Math.min(i++, answers.length - 1)] ?? { status: 500, json: null } })
    const results = [
      await h.client.get(ROOT, DOC),
      await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true }),
      await h.client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] } }),
      await h.client.views('shareABCD1234'),
    ]
    // The positive case: every call reached the host with the token…
    expect(h.requests).toHaveLength(4)
    expect(h.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toMatchObject({ ok: false, reason: 'session-expired' })
    expect(results[2]).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(results[3]).toMatchObject({ ok: false, reason: 'unavailable' })
    // …and none of what came back holds it.
    expect(everythingReturned(results)).not.toContain(TOKEN)
    expect(everythingReturned(results)).not.toContain('SESSION-TOKEN')
  })

  it('is not in what a network failure returns', async () => {
    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: 'github|1', displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async (url, init) => {
        throw Object.assign(new Error(`connect ECONNREFUSED ${url} ${init.headers.authorization}`), {
          code: 'ECONNREFUSED',
        })
      },
      isKnownRoot: () => true,
      projectIds: memoryProjectIds(PROJECT_ID).ids,
      records: createMemoryShareRecords(),
      onSessionRejected: () => {},
      readFile: async () => ({ content: Buffer.alloc(0), size: 0, mtimeMs: 0 }),
      now: () => NOW,
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await client.views('shareABCD1234')
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(everythingReturned(result)).not.toContain(TOKEN)
    // The log line carries the error CODE — never the message, never the headers.
    expect(JSON.stringify(warn.mock.calls)).toContain('ECONNREFUSED')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BASE)
    warn.mockRestore()
  })
})

describe('the session token stays in main — redirects and symlinks', () => {
  it('is not in what a refused redirect returns, and every request refused to follow one', async () => {
    const seen: Array<Parameters<ShareFetch>[1]> = []
    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: 'github|1', displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async (_url, init) => {
        seen.push(init)
        // What Node's fetch throws for `redirect: 'error'` — with the token
        // planted in the message to prove nothing echoes it.
        throw new TypeError(`fetch failed ${init.headers.authorization}`, { cause: new Error('unexpected redirect') })
      },
      isKnownRoot: () => true,
      projectIds: memoryProjectIds(PROJECT_ID).ids,
      records: createMemoryShareRecords(),
      onSessionRejected: () => {},
      readFile: async () => ({ content: Buffer.alloc(0), size: 0, mtimeMs: 0 }),
      now: () => NOW,
    })
    const result = await client.views('shareABCD1234')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.redirect).toBe('error')
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(everythingReturned(result)).not.toContain(TOKEN)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TOKEN)
  })

  it('is not in what a symlink refusal returns, and no request is made', async () => {
    const h = harness()
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true })
    expect(h.requests).toHaveLength(1)

    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: 'github|1', displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async () => {
        throw new Error('must not be called')
      },
      isKnownRoot: () => true,
      projectIds: memoryProjectIds(PROJECT_ID).ids,
      records: createMemoryShareRecords([RECORD]),
      onSessionRejected: () => {},
      readFile: async () => {
        throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' })
      },
      now: () => NOW,
    })
    const results = [
      await client.get(ROOT, DOC),
      await client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false }),
    ]
    expect(results).toEqual([
      expect.objectContaining({ ok: false, reason: 'unreadable' }),
      expect.objectContaining({ ok: false, reason: 'unreadable' }),
    ])
    expect(everythingReturned(results)).not.toContain(TOKEN)
  })
})

describe('revoked elsewhere (review H4)', () => {
  it("an update answered 'revoked' says so in plain words and drops the cached share", async () => {
    let revoked = false
    const h = harness({
      respond: (call) =>
        call.method === 'POST' && revoked ? { status: 409, json: { error: 'revoked' } } : { status: 200, json: summary() },
    })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { revokedAt: null } })
    revoked = true
    const result = await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, notify: false })
    expect(result).toEqual({ ok: false, reason: 'revoked', message: expect.any(String) })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).not.toMatch(/planflow-ai|`|\/|\.flowconfig/)
    // The next get asks the server again instead of serving the stale live share.
    await h.client.get(ROOT, DOC)
    expect(h.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET'])
  })
})

describe('refusals made before anything leaves the machine', () => {
  it('changed-since-review: re-reads the files and makes NO request', async () => {
    const ok = harness({ respond: () => ({ status: 201, json: summary() }) })
    expect((await ok.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true })).ok).toBe(true)
    expect(ok.requests).toHaveLength(1)

    const h = harness()
    const result = await h.client.publish({
      rootPath: ROOT,
      docPath: DOC,
      reviewed: { ...REVIEWED, walkthroughSha256: sha('something else') },
      access: { emails: ['a@b.io'], domains: [] },
      notify: true,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'changed-since-review',
      message: expect.any(String),
    })
    expect(h.reads).toEqual([join(ROOT, PAGE), join(ROOT, DOC)])
    expect(h.requests).toEqual([])
  })

  it('a publish without reviewed sizes is refused with NO request', async () => {
    const h = harness()
    const result = await h.client.publish({ rootPath: ROOT, docPath: DOC, notify: true } as never)
    expect(result).toMatchObject({ ok: false, reason: 'changed-since-review' })
    expect(h.requests).toEqual([])
  })

  it('revoke without confirmed: true is refused with NO request', async () => {
    const ok = harness()
    expect(await ok.client.revoke({ id: 'shareABCD1234', confirmed: true })).toEqual({ ok: true, share: summary() })
    expect(ok.requests).toHaveLength(1)
    expect(JSON.parse(ok.requests[0]?.body ?? '{}')).toEqual({ revoke: true })

    const h = harness()
    for (const confirmed of [undefined, false, 'true', 1]) {
      const result = await h.client.revoke({ id: 'shareABCD1234', confirmed } as never)
      expect(result).toMatchObject({ ok: false, reason: 'not-confirmed' })
    }
    expect(h.requests).toEqual([])
  })

  it('updateAccess never revokes, even if asked to', async () => {
    const h = harness()
    await h.client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] }, revoke: true } as never)
    expect(h.requests).toHaveLength(1)
    expect(JSON.parse(h.requests[0]?.body ?? '{}')).not.toHaveProperty('revoke')
  })
})

describe('signed out', () => {
  it('returns a plain sentence and makes no request', async () => {
    const signedIn = harness()
    expect(await signedIn.client.get(ROOT, DOC)).toMatchObject({ ok: true })
    expect(signedIn.requests).toHaveLength(1)

    const h = harness({ identity: null })
    const result = await h.client.get(ROOT, DOC)
    expect(result).toEqual({ ok: false, reason: 'signed-out', message: 'Sign in to Flow to share this page.' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).not.toMatch(/planflow-ai|`|\/|\.flowconfig/)
    expect(h.requests).toEqual([])
  })

  it('an expired sign-in says so, and makes no request', async () => {
    const h = harness({ identity: { subject: 'github|1', displayName: null, token: TOKEN, expiresAt: NOW } })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: false, reason: 'session-expired' })
    expect(h.requests).toEqual([])
  })
})

describe('a failed publish', () => {
  it('reports a sentence and leaves the cached share as it was', async () => {
    let fail = false
    const h = harness({
      respond: (call) =>
        call.method === 'POST' && fail
          ? { status: 503, json: { error: 'unavailable' } }
          : { status: 200, json: summary({ version: call.method === 'POST' ? 2 : 1 }) },
    })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { version: 1 } })
    fail = true
    const result = await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true })
    expect(result).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'The share service is having trouble right now. Nothing was changed — try again in a moment.',
    })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { version: 1 } })
    expect(h.requests.map((r) => r.method)).toEqual(['GET', 'POST'])
  })
})

describe('the get cache', () => {
  it('reuses the server answer for 30 s, then asks again', async () => {
    const h = harness()
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { id: 'shareABCD1234' } })
    expect(h.requests).toHaveLength(1)

    h.advance(SHARE_GET_CACHE_MS - 1)
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { id: 'shareABCD1234' } })
    expect(h.requests).toHaveLength(1)
    // The local facts are read fresh every time.
    expect(h.reads).toHaveLength(4)

    h.advance(1)
    await h.client.get(ROOT, DOC)
    expect(h.requests).toHaveLength(2)
    expect(SHARE_GET_CACHE_MS).toBe(30_000)
  })

  it('a publish refreshes the cached answer', async () => {
    let published = false
    const h = harness({
      respond: (call) =>
        call.method === 'POST'
          ? ((published = true), { status: 201, json: summary({ version: 2 }) })
          : { status: published ? 500 : 404, json: { error: 'not-found' } },
    })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: null })
    await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { version: 2 } })
    expect(h.requests.map((r) => r.method)).toEqual(['GET', 'POST'])
  })
})

describe('R2-M7 — opening a view asks the share host nothing unless this account shared it', () => {
  it('a recorded discovery is looked up by project id and slug — never by folder name', async () => {
    // The positive: with a record, get asks once, by id.
    const h = harness()
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { id: 'shareABCD1234' } })
    expect(h.requests).toHaveLength(1)
    const url = new URL(h.requests[0]?.url ?? '')
    expect(url.pathname).toBe('/api/shares')
    expect([...url.searchParams.keys()].sort()).toEqual(['projectId', 'slug'])
    expect(url.searchParams.get('projectId')).toBe(PROJECT_ID)
    expect(url.searchParams.get('slug')).toBe(SLUG)
    expect(h.requests[0]?.url).not.toContain('plan-flow')
  })

  it('a never-shared discovery makes ZERO requests, and mints nothing', async () => {
    const h = harness({ recorded: false })
    const result = await h.client.get(ROOT, DOC)
    // The local facts are still there for the Share dialog…
    expect(result).toMatchObject({ ok: true, share: null, local: { slug: SLUG, title: 'Feature view sharing' } })
    expect(h.reads).toEqual([join(ROOT, PAGE), join(ROOT, DOC)])
    // …and nothing left the machine.
    expect(h.requests).toEqual([])
    expect(h.projectIds.ensured).toEqual([])
  })

  it('a project with no sharing id makes ZERO requests, and get never mints one', async () => {
    const h = harness({ projectId: null })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: null })
    expect(h.requests).toEqual([])
    expect(h.projectIds.ensured).toEqual([])
    expect(h.projectIds.current()).toBeNull()
  })

  it('a record that belongs to another account asks nothing', async () => {
    const h = harness({ identity: { subject: 'github|2', displayName: null, token: TOKEN, expiresAt: null } })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: null })
    expect(h.requests).toEqual([])
  })

  it('"Check sharing status" asks without a record, mints the project id, and records what it finds', async () => {
    const h = harness({ recorded: false, projectId: null })
    const result = await h.client.check(ROOT, DOC)
    expect(result).toMatchObject({ ok: true, share: { id: 'shareABCD1234' } })
    expect(h.projectIds.ensured).toEqual([ROOT])
    expect(h.requests).toHaveLength(1)
    expect(new URL(h.requests[0]?.url ?? '').searchParams.get('projectId')).toBe('fedcba9876543210fedcba9876543210')
    expect(h.records.all()).toEqual([
      { subject: SUBJECT, projectId: 'fedcba9876543210fedcba9876543210', slug: SLUG, id: 'shareABCD1234' },
    ])
    // Now that it is recorded, opening the view asks (the cache answers here).
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: { id: 'shareABCD1234' } })
  })

  it('"Check sharing status" finding nothing records nothing', async () => {
    const h = harness({ recorded: false, respond: () => ({ status: 404, json: { error: 'not-found' } }) })
    expect(await h.client.check(ROOT, DOC)).toMatchObject({ ok: true, share: null })
    expect(h.requests).toHaveLength(1)
    expect(h.records.all()).toEqual([])
  })

  it('a server 404 for a recorded share removes the record; the next open asks nothing', async () => {
    const h = harness({ respond: () => ({ status: 404, json: { error: 'not-found' } }) })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: true, share: null })
    expect(h.requests).toHaveLength(1)
    expect(h.records.all()).toEqual([])
    h.advance(SHARE_GET_CACHE_MS)
    await h.client.get(ROOT, DOC)
    expect(h.requests).toHaveLength(1)
  })

  it('a publish records the share; a revoke keeps the record', async () => {
    const h = harness({
      recorded: false,
      respond: (call) =>
        call.method === 'PATCH'
          ? { status: 200, json: summary({ revokedAt: new Date(NOW).toISOString() }) }
          : { status: 201, json: summary() },
    })
    await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false })
    expect(h.records.all()).toEqual([RECORD])
    expect(await h.client.revoke({ id: 'shareABCD1234', confirmed: true })).toMatchObject({ ok: true })
    expect(h.records.all()).toEqual([RECORD])
  })

  it('an update answered 404 removes the record for that share id', async () => {
    const h = harness({ respond: () => ({ status: 404, json: { error: 'not-found' } }) })
    expect(await h.client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] } })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(h.records.all()).toEqual([])
  })

  it('a publish mints the project id when the project has none, and sends it', async () => {
    const h = harness({ recorded: false, projectId: null, respond: () => ({ status: 201, json: summary() }) })
    await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false })
    expect(h.projectIds.ensured).toEqual([ROOT])
    expect(JSON.parse(h.requests[0]?.body ?? '{}')).toMatchObject({ projectId: 'fedcba9876543210fedcba9876543210', project: 'plan-flow' })
  })

  it('a project id that cannot be stored refuses the publish, and sends nothing', async () => {
    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: SUBJECT, displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async () => {
        throw new Error('must not be called')
      },
      isKnownRoot: () => true,
      projectIds: {
        existing: async () => null,
        ensure: async () => {
          throw Object.assign(new Error(`EACCES ${ROOT}/flow/.flowconfig`), { code: 'EACCES' })
        },
      },
      records: createMemoryShareRecords(),
      onSessionRejected: () => {},
      readFile: async (abs) => {
        const content = Buffer.from(FILES[abs] ?? '', 'utf8')
        return { content, size: content.length, mtimeMs: PAGE_MTIME }
      },
      now: () => NOW,
    })
    const result = await client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false })
    expect(result).toMatchObject({ ok: false, reason: 'project-settings' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).not.toMatch(/planflow-ai|`|\/|\.flowconfig|share_project_id/)
  })
})

describe('R2-L10 — a file over the cap is reported by size, never read or sent', () => {
  function oversized() {
    const requests: string[] = []
    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: SUBJECT, displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async (url) => {
        requests.push(url)
        return { status: 201, json: async () => summary() }
      },
      isKnownRoot: () => true,
      projectIds: memoryProjectIds(PROJECT_ID).ids,
      records: createMemoryShareRecords(),
      onSessionRejected: () => {},
      readFile: async (abs) =>
        abs.endsWith('.html')
          ? { content: null, size: 3 * 1024 * 1024, mtimeMs: PAGE_MTIME }
          : { content: Buffer.from(DISCOVERY), size: bytes(DISCOVERY), mtimeMs: PAGE_MTIME },
      now: () => NOW,
    })
    return { client, requests }
  }

  it('get reports the total over the cap', async () => {
    const { client } = oversized()
    const result = await client.get(ROOT, DOC)
    if (!result.ok) throw new Error(`expected facts, got ${result.reason}`)
    expect(result.local.totalBytes).toBeGreaterThan(result.local.maxBytes)
    expect(result.local.files[0]).toMatchObject({ part: 'walkthrough', bytes: 3 * 1024 * 1024, sha256: '' })
  })

  it('publish is refused "too-large" with NO request', async () => {
    const { client, requests } = oversized()
    expect(await client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false })).toMatchObject({
      ok: false,
      reason: 'too-large',
    })
    expect(requests).toEqual([])
  })
})

describe('R2-L5 — invites the server skipped are reported', () => {
  it('a positive invitesSkipped is returned beside the share — not inside it', async () => {
    const h = harness({ respond: () => ({ status: 201, json: { ...summary(), invitesSkipped: 3 } }) })
    const result = await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true })
    expect(result).toEqual({ ok: true, share: summary(), invitesSkipped: 3 })
    const updated = await h.client.updateAccess({ id: 'shareABCD1234', access: { emails: ['a@b.io'], domains: [] }, notify: true })
    expect(updated).toEqual({ ok: true, share: summary(), invitesSkipped: 3 })
  })

  it('absent, zero or malformed is "nobody skipped"', async () => {
    for (const value of [undefined, 0, -1, 1.5, '3', null, Number.NaN]) {
      expect(invitesSkippedOf({ invitesSkipped: value })).toBe(0)
    }
    expect(invitesSkippedOf(null)).toBe(0)
    expect(invitesSkippedOf({ invitesSkipped: 2 })).toBe(2)
    const h = harness({ respond: () => ({ status: 201, json: { ...summary(), invitesSkipped: 'lots' } }) })
    const result = await h.client.publish({ rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: true })
    expect(result).toEqual({ ok: true, share: summary() })
  })
})

describe('local logs carry error codes, never absolute paths', () => {
  it('an unreadable file is logged by code and file name only', async () => {
    const h = harness({ files: { [join(ROOT, DOC)]: DISCOVERY } })
    // Missing page: the reader's error message carries the absolute path.
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: false, reason: 'page-missing' })
    const logged = JSON.stringify(warnSpy.mock.calls)
    expect(logged).toContain('ENOENT')
    expect(logged).not.toContain(ROOT)
  })
})

describe('a refused session is reported, so the rest of the app signs out too', () => {
  const PUBLISH = { rootPath: ROOT, docPath: DOC, reviewed: REVIEWED, access: { emails: ['a@b.io'], domains: [] }, notify: false }

  it.each([
    [401, 'unauthenticated'],
    [401, 'session-expired'],
    [403, 'identity-disabled'],
  ] as const)('a %i %s on a presented token reports it once, naming that token', async (status, error) => {
    const h = harness({ respond: () => ({ status, json: { error } }) })
    const result = await h.client.publish(PUBLISH)
    // POSITIVE FIRST (allowed-pattern #28): the token really went to the host.
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(result).toMatchObject({ ok: false, reason: error })
    expect(h.rejections).toEqual([{ reason: error, token: TOKEN }])
  })

  it('a stored sign-in past its expiry is reported without asking the host', async () => {
    const h = harness({ identity: { subject: 'github|1', displayName: null, token: TOKEN, expiresAt: NOW } })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: false, reason: 'session-expired' })
    expect(h.requests).toEqual([])
    expect(h.rejections).toEqual([{ reason: 'session-expired', token: TOKEN }])
  })

  it('a rejected session reads as a sign-in that is no longer valid — one plain sentence', async () => {
    const h = harness({ respond: () => ({ status: 401, json: { error: 'unauthenticated' } }) })
    const result = await h.client.publish(PUBLISH)
    expect(result).toEqual({
      ok: false,
      reason: 'unauthenticated',
      message: 'Your Flow sign-in is no longer valid. Sign in again to share.',
    })
  })

  it('reports nothing for trouble that says nothing about the session', async () => {
    const answers: Array<{ status: number; json: unknown }> = [
      { status: 503, json: { error: 'unavailable' } },
      { status: 500, json: null },
      // The right word on the wrong status is the service misbehaving.
      { status: 503, json: { error: 'unauthenticated' } },
      { status: 429, json: { error: 'rate-limited' } },
      { status: 404, json: { error: 'not-found' } },
    ]
    let i = 0
    const h = harness({ respond: () => answers[i++] ?? { status: 500, json: null } })
    const results = []
    for (let n = 0; n < answers.length; n += 1) results.push(await h.client.publish(PUBLISH))
    // Every one of them really reached the host with the token…
    expect(h.requests).toHaveLength(answers.length)
    expect(results.every((r) => !r.ok)).toBe(true)
    // …and none of them is a verdict on the session.
    expect(h.rejections).toEqual([])
  })

  it('reports nothing when the host could not be reached at all', async () => {
    const rejections: RejectedSession[] = []
    let attempts = 0
    const client = createShareClient({
      endpoint: () => BASE,
      identity: { load: () => ({ subject: SUBJECT, displayName: null, token: TOKEN, expiresAt: null }) },
      fetch: async () => {
        attempts += 1
        throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' })
      },
      isKnownRoot: () => true,
      projectIds: memoryProjectIds(PROJECT_ID).ids,
      records: createMemoryShareRecords([RECORD]),
      onSessionRejected: (rejected) => {
        rejections.push(rejected)
      },
      readFile: async (abs) => {
        const buffer = Buffer.from(FILES[abs] ?? '', 'utf8')
        return { content: buffer, size: buffer.length, mtimeMs: PAGE_MTIME }
      },
      now: () => NOW,
    })
    expect(await client.publish(PUBLISH)).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(attempts).toBe(1)
    expect(rejections).toEqual([])
  })

  it('a signed-out computer reports nothing — there was no session to refuse', async () => {
    const h = harness({ identity: null })
    expect(await h.client.get(ROOT, DOC)).toMatchObject({ ok: false, reason: 'signed-out' })
    expect(h.rejections).toEqual([])
  })
})
