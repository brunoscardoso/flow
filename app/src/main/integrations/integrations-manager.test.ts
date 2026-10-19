// IntegrationsManager tests — PAT storage (via a fake CredentialsManager) and
// issue fetch (via an injected fetch). No real network, no real file.

import type { CredentialsManager } from '../credentials'
import {
  IntegrationsManager,
  MissingTokenError,
  IssueFetchError,
  type FetchFn,
  type HttpResponse,
} from './integrations-manager'
import type { IssueRef } from '../issue-ref'
import type { BytesResponse, FetchBytesFn } from './integrations-manager'

/** In-memory CredentialsManager stand-in. */
function fakeCredentials(): CredentialsManager {
  const store: Record<string, Record<string, unknown>> = {}
  return {
    get: (service: string) => store[service] ?? null,
    set: (service: string, creds: Record<string, unknown>) => {
      store[service] = { ...store[service], ...creds }
    },
    delete: (service: string) => {
      delete store[service]
    },
    listServices: () => Object.keys(store),
  } as unknown as CredentialsManager
}

function okResponse(body: unknown): HttpResponse {
  return { ok: true, status: 200, json: async () => body }
}
function errResponse(status: number): HttpResponse {
  return { ok: false, status, json: async () => ({}) }
}

/** A fetch that answers the Connect-time verification GET (#1503) with 200. */
const verifyOkFetch: FetchFn = async () => okResponse({ login: 'octo' })

describe('IntegrationsManager tokens', () => {
  it('stores a GitHub PAT and reports connected without leaking it', async () => {
    const creds = fakeCredentials()
    const mgr = new IntegrationsManager(creds, verifyOkFetch)
    await mgr.setToken({ provider: 'github', pat: 'ghp_secret' })
    const status = await mgr.status('github')
    expect(status.connected).toBe(true)
    expect(JSON.stringify(status)).not.toContain('ghp_secret')
  })

  it('reports the login the PAT verified as — Connected · <real identity> (#1503)', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), verifyOkFetch)
    await mgr.setToken({ provider: 'github', pat: 'ghp_secret' })
    expect(await mgr.status('github')).toMatchObject({ connected: true, identityHint: 'octo' })
  })

  it('requires site+email+apiToken for Jira and exposes the email as a hint only', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), verifyOkFetch)
    await expect(
      mgr.setToken({ provider: 'jira', site: '', email: 'a@b.c', apiToken: 't' }),
    ).rejects.toThrow()
    await mgr.setToken({ provider: 'jira', site: 'https://acme.atlassian.net/', email: 'a@b.c', apiToken: 't' })
    const status = await mgr.status('jira')
    expect(status).toMatchObject({ connected: true, identityHint: 'a@b.c' })
    // Status carries the email hint but never the apiToken.
    expect(JSON.stringify(status)).not.toContain('apiToken')
  })

  it('refuses a Jira site that is not a hostname, without any network call (#1503)', async () => {
    const fetchFn = jest.fn(verifyOkFetch)
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await expect(
      mgr.setToken({ provider: 'jira', site: 'hello world not a site', email: 'a@b.c', apiToken: 'x' }),
    ).rejects.toThrow(/doesn't look like a Jira site/)
    expect(fetchFn).not.toHaveBeenCalled()
    expect((await mgr.status('jira')).connected).toBe(false)
  })

  it('refuses a Jira email that is not email-shaped, without any network call (#1503)', async () => {
    const fetchFn = jest.fn(verifyOkFetch)
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await expect(
      mgr.setToken({ provider: 'jira', site: 'acme.atlassian.net', email: 'nonsense-not-an-email', apiToken: 'x' }),
    ).rejects.toThrow(/doesn't look like an email address/)
    expect(fetchFn).not.toHaveBeenCalled()
    expect((await mgr.status('jira')).connected).toBe(false)
  })

  it('verifies a Jira credential against /myself and stores NOTHING on a 401 (#1503)', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      seenUrl = url
      return errResponse(401)
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await expect(
      mgr.setToken({ provider: 'jira', site: 'acme.atlassian.net', email: 'a@b.c', apiToken: 'bad' }),
    ).rejects.toThrow(/rejected the credential/)
    expect(seenUrl).toBe('https://acme.atlassian.net/rest/api/3/myself')
    expect((await mgr.status('jira')).connected).toBe(false)
  })

  it('a rejected PAT does not replace a working gh CLI login (#1503)', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), async () => errResponse(401), () => 'gho_gh')
    await expect(mgr.setToken({ provider: 'github', pat: 'ghp_bogus' })).rejects.toThrow(
      /rejected the credential/,
    )
    // The CLI-derived connection is untouched — nothing was stored.
    expect(await mgr.status('github')).toMatchObject({ connected: true, identityHint: 'via gh CLI' })
  })

  it('an unreachable provider refuses the Connect rather than storing blind (#1503)', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    await expect(
      mgr.setToken({ provider: 'jira', site: 'acme.atlassian.net', email: 'a@b.c', apiToken: 't' }),
    ).rejects.toThrow(/Could not reach jira/)
    expect((await mgr.status('jira')).connected).toBe(false)
  })

  it('clearToken disconnects (no gh fallback available)', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), verifyOkFetch, () => null)
    await mgr.setToken({ provider: 'github', pat: 'x' })
    mgr.clearToken('github')
    expect((await mgr.status('github')).connected).toBe(false)
  })

  it('reuses the gh CLI token for GitHub when no PAT is stored', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), undefined, () => 'gho_from_gh')
    const status = await mgr.status('github')
    expect(status).toMatchObject({ connected: true, identityHint: 'via gh CLI' })
    // The gh token is a fallback only — never surfaced.
    expect(JSON.stringify(status)).not.toContain('gho_from_gh')
  })

  it('reuses the az CLI token for Azure when no PAT is stored', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), undefined, () => null, () => 'az_tok')
    const status = await mgr.status('azure')
    expect(status).toMatchObject({ connected: true, identityHint: 'via az CLI' })
    expect(JSON.stringify(status)).not.toContain('az_tok')
  })

  it('resolves an ASYNC CLI token fn without blocking (#174)', async () => {
    // A promise-returning resolver models the real execFile-based default; the
    // status path must await it rather than treating the Promise as truthy.
    const azFn = jest.fn(async () => 'az_async_tok')
    const mgr = new IntegrationsManager(fakeCredentials(), undefined, () => null, azFn)
    expect(await mgr.status('azure')).toMatchObject({ connected: true, identityHint: 'via az CLI' })
    const asyncNull = jest.fn(async () => null)
    const mgr2 = new IntegrationsManager(fakeCredentials(), undefined, asyncNull)
    expect(await mgr2.status('github')).toEqual({ connected: false })
  })

  it('caches the CLI token across repeated status checks — shells out once per TTL (#174)', async () => {
    const ghFn = jest.fn(() => 'gho_cached')
    let clock = 1_000
    const mgr = new IntegrationsManager(fakeCredentials(), undefined, ghFn, undefined, () => clock)
    await mgr.status('github')
    await mgr.status('github')
    expect(ghFn).toHaveBeenCalledTimes(1) // second check hits the cache
    clock += 30_001 // advance past the TTL
    await mgr.status('github')
    expect(ghFn).toHaveBeenCalledTimes(2) // cache expired → resolves again
  })

  it('a stored GitHub PAT takes precedence over the gh CLI token', async () => {
    const creds = fakeCredentials()
    let seenAuth = ''
    const fetchFn: FetchFn = async (_url, init) => {
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ number: 1, title: 't', body: '', state: 'open', html_url: 'https://github.com/o/r/issues/1' })
    }
    const mgr = new IntegrationsManager(creds, fetchFn, () => 'gho_gh')
    await mgr.setToken({ provider: 'github', pat: 'ghp_stored' })
    await mgr.fetchIssue({ provider: 'github', owner: 'o', repo: 'r', number: 1, key: 'o/r#1' })
    expect(seenAuth).toBe('Bearer ghp_stored')
  })
})

describe('IntegrationsManager fetchIssue', () => {
  const githubRef: IssueRef = { provider: 'github', owner: 'o', repo: 'r', number: 5, key: 'o/r#5' }
  const jiraRef: IssueRef = { provider: 'jira', key: 'ABC-1', site: 'acme.atlassian.net' }

  it('fetches a GitHub issue with a Bearer header and normalizes it', async () => {
    const creds = fakeCredentials()
    let seenUrl = ''
    let seenAuth = ''
    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({
        number: 5,
        title: 'Bug',
        body: 'desc',
        state: 'open',
        html_url: 'https://github.com/o/r/issues/5',
      })
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    const issue = await mgr.fetchIssue(githubRef)
    expect(seenUrl).toBe('https://api.github.com/repos/o/r/issues/5')
    expect(seenAuth).toBe('Bearer ghp_x')
    expect(issue).toMatchObject({ key: 'o/r#5', title: 'Bug', status: 'open' })
  })

  it('fetches a Jira issue with Basic auth against the ref site', async () => {
    const creds = fakeCredentials()
    let seenUrl = ''
    let seenAuth = ''
    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ key: 'ABC-1', fields: { summary: 'S', status: { name: 'To Do' } } })
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    await mgr.setToken({ provider: 'jira', site: 'acme.atlassian.net', email: 'a@b.c', apiToken: 'tok' })
    const issue = await mgr.fetchIssue(jiraRef)
    expect(seenUrl).toBe('https://acme.atlassian.net/rest/api/3/issue/ABC-1')
    expect(seenAuth).toBe(`Basic ${Buffer.from('a@b.c:tok').toString('base64')}`)
    expect(issue).toMatchObject({ key: 'ABC-1', title: 'S', status: 'To Do' })
  })

  it('SECURITY: never sends the Jira token to a host from the pasted URL', async () => {
    const creds = fakeCredentials()
    const seenUrls: string[] = []
    const fetchFn: FetchFn = async (url) => {
      seenUrls.push(url)
      return okResponse({})
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    await mgr.setToken({ provider: 'jira', site: 'acme.atlassian.net', email: 'a@b.c', apiToken: 'tok' })
    // A crafted "Jira URL" for an attacker host must be refused, and the
    // fetch (which carries the Basic-auth token) must NEVER fire. The only
    // request so far is Connect's own verification GET against the real site.
    const evilRef: IssueRef = { provider: 'jira', key: 'ABC-1', site: 'evil.com' }
    await expect(mgr.fetchIssue(evilRef)).rejects.toBeInstanceOf(IssueFetchError)
    expect(seenUrls).toEqual(['https://acme.atlassian.net/rest/api/3/myself'])
  })

  it('treats the connected-site host as case-insensitive — same site differing only in case is allowed (#276)', async () => {
    const creds = fakeCredentials()
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      seenUrl = url
      return okResponse({ key: 'ABC-1', fields: { summary: 'S', status: { name: 'To Do' } } })
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    // Site configured with uppercase letters (as pasted), issue URL host lowercase.
    await mgr.setToken({ provider: 'jira', site: 'https://Acme.Atlassian.net', email: 'a@b.c', apiToken: 'tok' })
    const ref: IssueRef = { provider: 'jira', key: 'ABC-1', site: 'acme.atlassian.net' }
    const issue = await mgr.fetchIssue(ref)
    // Not refused — the fetch fires against the canonical (lowercase) host.
    expect(seenUrl).toBe('https://acme.atlassian.net/rest/api/3/issue/ABC-1')
    expect(issue).toMatchObject({ key: 'ABC-1', title: 'S' })
  })

  const azureRef: IssueRef = {
    provider: 'azure',
    kind: 'workitem',
    org: 'o',
    project: 'p',
    id: 42,
    key: 'o/p#42',
  }

  it('fetches an Azure work item with Basic PAT auth (empty username)', async () => {
    const creds = fakeCredentials()
    let seenUrl = ''
    let seenAuth = ''
    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ id: 42, fields: { 'System.Title': 'WI', 'System.State': 'New' } })
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    await mgr.setToken({ provider: 'azure', pat: 'azpat', org: 'o', project: 'p' })
    const issue = await mgr.fetchIssue(azureRef)
    expect(seenUrl).toBe('https://dev.azure.com/o/p/_apis/wit/workitems/42?api-version=7.0')
    expect(seenAuth).toBe(`Basic ${Buffer.from(':azpat').toString('base64')}`)
    expect(issue).toMatchObject({ key: 'o/p#42', title: 'WI', status: 'New' })
  })

  it('fetches an Azure work item using the az CLI token (Bearer) when no PAT', async () => {
    let seenAuth = ''
    const fetchFn: FetchFn = async (_url, init) => {
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ id: 42, fields: { 'System.Title': 'WI', 'System.State': 'New' } })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => null, () => 'az_access_token')
    const issue = await mgr.fetchIssue(azureRef)
    expect(seenAuth).toBe('Bearer az_access_token')
    expect(issue).toMatchObject({ key: 'o/p#42' })
  })

  it('a stored Azure PAT (Basic) takes precedence over the az CLI token', async () => {
    const creds = fakeCredentials()
    let seenAuth = ''
    const fetchFn: FetchFn = async (_url, init) => {
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ id: 42, fields: {} })
    }
    const mgr = new IntegrationsManager(creds, fetchFn, () => null, () => 'az_tok')
    await mgr.setToken({ provider: 'azure', pat: 'azpat', org: 'o', project: 'p' })
    await mgr.fetchIssue(azureRef)
    expect(seenAuth).toBe(`Basic ${Buffer.from(':azpat').toString('base64')}`)
  })

  it('throws MissingTokenError for Azure when no PAT and no az login', async () => {
    const mgr = new IntegrationsManager(
      fakeCredentials(),
      async () => okResponse({}),
      () => null,
      () => null,
    )
    await expect(mgr.fetchIssue(azureRef)).rejects.toBeInstanceOf(MissingTokenError)
  })

  it('fetches an Azure PULL REQUEST via the git PR API', async () => {
    const creds = fakeCredentials()
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      seenUrl = url
      return okResponse({
        pullRequestId: 120160,
        title: 'Fix the build',
        description: 'PR body',
        status: 'active',
        _links: { web: { href: 'https://dev.azure.com/o/p/_git/repo/pullrequest/120160' } },
      })
    }
    const mgr = new IntegrationsManager(creds, fetchFn)
    await mgr.setToken({ provider: 'azure', pat: 'azpat', org: 'o', project: 'p' })
    const prRef: IssueRef = {
      provider: 'azure',
      kind: 'pr',
      org: 'o',
      project: 'p',
      repo: 'repo',
      id: 120160,
      key: 'o/p/repo!120160',
    }
    const issue = await mgr.fetchIssue(prRef)
    expect(seenUrl).toBe(
      'https://dev.azure.com/o/p/_apis/git/repositories/repo/pullRequests/120160?api-version=7.0',
    )
    expect(issue).toMatchObject({
      key: 'o/p/repo!120160',
      title: 'Fix the build',
      status: 'active',
      url: 'https://dev.azure.com/o/p/_git/repo/pullrequest/120160',
    })
  })

  it('throws MissingTokenError when no token is configured (and no gh)', async () => {
    const mgr = new IntegrationsManager(fakeCredentials(), async () => okResponse({}), () => null)
    await expect(mgr.fetchIssue(githubRef)).rejects.toBeInstanceOf(MissingTokenError)
  })

  it('fetches a GitHub issue using the gh CLI token when no PAT is stored', async () => {
    let seenAuth = ''
    const fetchFn: FetchFn = async (_url, init) => {
      seenAuth = init?.headers?.['Authorization'] ?? ''
      return okResponse({ number: 5, title: 'Bug', body: 'x', state: 'open', html_url: 'https://github.com/o/r/issues/5' })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => 'gho_ghtoken')
    const issue = await mgr.fetchIssue(githubRef)
    expect(seenAuth).toBe('Bearer gho_ghtoken')
    expect(issue).toMatchObject({ key: 'o/r#5' })
  })

  it('maps 401/404 to a typed IssueFetchError with the status', async () => {
    const creds = fakeCredentials()
    // Connect's verification GET (/user) succeeds; the issue fetch 404s.
    const mgr = new IntegrationsManager(creds, async (url) =>
      url.endsWith('/user') ? okResponse({ login: 'octo' }) : errResponse(404),
    )
    await mgr.setToken({ provider: 'github', pat: 'x' })
    await expect(mgr.fetchIssue(githubRef)).rejects.toMatchObject({
      name: 'IssueFetchError',
      status: 404,
    })
  })

  it('maps a non-JSON 200 body to a typed IssueFetchError, not a raw SyntaxError (#275)', async () => {
    const creds = fakeCredentials()
    // A 200 whose body is HTML (proxy/WAF interstitial) — json() rejects.
    const nonJson: HttpResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    }
    // Connect's verification GET (/user) succeeds; the issue fetch gets HTML.
    const mgr = new IntegrationsManager(creds, async (url) =>
      url.endsWith('/user') ? okResponse({ login: 'octo' }) : nonJson,
    )
    await mgr.setToken({ provider: 'github', pat: 'x' })
    await expect(mgr.fetchIssue(githubRef)).rejects.toMatchObject({
      name: 'IssueFetchError',
      status: 200,
    })
    // The friendly message, not the parser's "Unexpected token" text.
    await expect(mgr.fetchIssue(githubRef)).rejects.toThrow(/unexpected \(non-JSON\) response/)
  })
})

describe('every request carries a deadline (#1639)', () => {
  it('passes an abort signal on both the verify GET and the issue fetch', async () => {
    const signals: Array<AbortSignal | undefined> = []
    const fetchFn: FetchFn = async (_url, init) => {
      signals.push(init?.signal)
      return okResponse({ login: 'octo', number: 5, title: 'Bug', body: '', state: 'open', html_url: 'https://github.com/o/r/issues/5' })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    await mgr.fetchIssue({ provider: 'github', owner: 'o', repo: 'r', number: 5, key: 'o/r#5' })
    expect(signals).toHaveLength(2)
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('a host that accepts and never answers refuses the Connect in seconds, through the REAL fetch', async () => {
    // The #1639 reproduction, through the real code path: a silent TCP server
    // models a parked domain / wrong-but-routable site. No injected fetch — the
    // default transport must carry the deadline itself.
    const net = await import('node:net')
    const sockets: Array<import('node:net').Socket> = []
    const server = net.createServer((socket) => sockets.push(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      const mgr = new IntegrationsManager(fakeCredentials())
      const started = Date.now()
      await expect(
        mgr.setToken({
          provider: 'jira',
          site: `127.0.0.1:${address.port}`,
          email: 'a@b.c',
          apiToken: 'x',
        }),
      ).rejects.toThrow(/Could not reach jira to verify the credential/)
      // Well inside the 300s undici default the bug exposed; the deadline is 8s.
      expect(Date.now() - started).toBeLessThan(12_000)
    } finally {
      for (const socket of sockets) socket.destroy()
      server.close()
    }
  }, 20_000)
})

// ── listAssigned: what is on a tracker for the person signed in ───────────
//
// The board's Remote column asks this, and it is deliberately not the same
// question as a loop's queue: a queue is a repository's list that somebody
// pointed a loop at, and this is "what is mine, wherever it lives".

describe('IntegrationsManager listAssigned', () => {
  it('asks the SEARCH API for what is assigned to the user, wherever it lives', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetchFn: FetchFn = async (url, init) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      seenUrl = url
      seenMethod = init?.method ?? ''
      // Search wraps its results in `{ items }`, unlike `/issues`.
      return okResponse({
        items: [
          { number: 5, title: 'Bug', body: 'd', state: 'open', html_url: 'https://github.com/o/r/issues/5' },
        ],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    const items = await mgr.listAssigned('github')
    // `GET /issues` only covers repos the user owns or is an org member of, so
    // an issue assigned to them in someone else's repo was invisible. Search
    // with `assignee:@me` answers "assigned to me, wherever it lives".
    expect(seenUrl).toContain('https://api.github.com/search/issues?q=')
    expect(decodeURIComponent(seenUrl)).toContain('assignee:@me')
    expect(decodeURIComponent(seenUrl)).toContain('is:issue')
    expect(seenMethod).toBe('GET')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'o/r#5', title: 'Bug' })
  })

  it('drops PULL REQUESTS, which the search results can also carry', async () => {
    // A PR assigned for review is not a task to put on a backlog, and the
    // marker is the payload's own `pull_request` key.
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      return okResponse({
        items: [
          { number: 5, title: 'Issue', state: 'open', html_url: 'https://github.com/o/r/issues/5' },
          {
            number: 6,
            title: 'A PR',
            state: 'open',
            html_url: 'https://github.com/o/r/pull/6',
            pull_request: { url: 'x' },
          },
        ],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    expect((await mgr.listAssigned('github')).map((i) => i.title)).toEqual(['Issue'])
  })

  it('list mode runs the PERSON’S OWN query verbatim, not the assigned one', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      seenUrl = url
      return okResponse({ items: [] })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    await mgr.listAssigned('github', { mode: 'list', query: 'repo:acme/api label:bug' })
    const q = decodeURIComponent(seenUrl)
    expect(q).toContain('repo:acme/api label:bug')
    // The assigned query is NOT what ran — list means the saved query only.
    expect(q).not.toContain('assignee:@me')
  })

  it('list mode with an EMPTY query falls back to assigned, never an empty column', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      seenUrl = url
      return okResponse({ items: [] })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    await mgr.listAssigned('github', { mode: 'list', query: '   ' })
    // A person who set `list` then cleared the query still sees their assigned
    // work rather than a silently empty list.
    expect(decodeURIComponent(seenUrl)).toContain('assignee:@me')
  })

  it('both mode merges the two reads, DE-DUPLICATED by key', async () => {
    // The assigned read and the list read overlap on issue #5; it must appear
    // once, keeping its assigned-batch position.
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      const isList = decodeURIComponent(url).includes('label:bug')
      if (isList) {
        return okResponse({
          items: [
            { number: 5, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/5' },
            { number: 9, title: 'List-only', state: 'open', html_url: 'https://github.com/o/r/issues/9' },
          ],
        })
      }
      return okResponse({
        items: [
          { number: 5, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/5' },
          { number: 7, title: 'Assigned-only', state: 'open', html_url: 'https://github.com/o/r/issues/7' },
        ],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    const items = await mgr.listAssigned('github', { mode: 'both', query: 'label:bug' })
    expect(items.map((i) => i.key)).toEqual(['o/r#5', 'o/r#7', 'o/r#9'])
  })

  it('asks Jira through POST /search/jql — the GET form answers 410 Gone', async () => {
    // Reported live by the user as `jira request failed — HTTP 410`. Atlassian
    // removed the query-string search; the enhanced search takes its JQL in a
    // body, which is why this is the one POST in the file.
    let seenUrl = ''
    let seenMethod = ''
    let seenBody = ''
    const fetchFn: FetchFn = async (url, init) => {
      if (url.includes('/myself')) return okResponse({ displayName: 'A' })
      seenUrl = url
      seenMethod = init?.method ?? ''
      seenBody = init?.body ?? ''
      return okResponse({
        issues: [{ key: 'ABC-1', fields: { summary: 'S', status: { name: 'To Do' } } }],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({
      provider: 'jira',
      site: 'acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
    })
    const items = await mgr.listAssigned('jira')
    expect(seenUrl).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(seenMethod).toBe('POST')
    // `currentUser()` is Jira's own answer to "me": no account id is stored,
    // and it stays correct if the connected account changes.
    expect(seenBody).toContain('currentUser()')
    expect(items[0]).toMatchObject({ key: 'ABC-1', title: 'S' })
  })

  it('a 410 says the API was retired, not that a token is wrong', async () => {
    // A bare "HTTP 410" sends a person to check a credential that is fine.
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/myself')) return okResponse({ displayName: 'A' })
      return errResponse(410)
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({
      provider: 'jira',
      site: 'acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
    })
    await expect(mgr.listAssigned('jira')).rejects.toThrow(/retired/)
  })

  it('refuses without a credential rather than answering an empty list', async () => {
    // "You have nothing assigned" and "nobody could ask" are different answers.
    //
    // ASKED OF JIRA, not GitHub: GitHub's token resolution falls back to the
    // `gh` CLI's own login, so on a developer machine with `gh` signed in there
    // IS a token and this would assert the state of somebody's shell history.
    // Jira has no such fallback — a credential is stored or it is not.
    const mgr = new IntegrationsManager(fakeCredentials(), verifyOkFetch)
    await expect(mgr.listAssigned('jira')).rejects.toThrow()
  })

  it('says what Azure needs rather than guessing an organisation', async () => {
    // Azure's WIQL is scoped to one project and neither the org nor the project
    // is stored — guessing one would point somebody's token at a place they may
    // not be in.
    //
    // SEEDED PAST setToken ON PURPOSE. A connection made today cannot reach this
    // state: setToken requires the org and the project. One made BEFORE those
    // fields existed is a stored PAT with no place, and that connection is
    // still in somebody's keychain — which is the whole reason the message
    // exists. So the credential goes in the way that older version left it.
    const creds = fakeCredentials()
    creds.set('azure', { pat: 'azpat' })
    const mgr = new IntegrationsManager(creds, verifyOkFetch)
    await expect(mgr.listAssigned('azure')).rejects.toThrow(/organisation and project/)
  })
})

describe('IntegrationsManager imageData — the ticket\'s screenshots', () => {
  /** A bytes transport keyed by URL that THROWS on anything it was not told
   *  about, so a test asserts the request the code made, not just its answer. */
  function bytesFrom(
    table: Record<string, { status?: number; type?: string; body?: Buffer }>,
    seen?: { url: string; headers: Record<string, string> }[],
  ): FetchBytesFn {
    return async (url, init) => {
      seen?.push({ url, headers: init?.headers ?? {} })
      const entry = table[url]
      if (entry === undefined) throw new Error(`unexpected image fetch: ${url}`)
      const body = entry.body ?? Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const response: BytesResponse = {
        ok: (entry.status ?? 200) < 400,
        status: entry.status ?? 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? (entry.type ?? 'image/png') : null) },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      }
      return response
    }
  }

  function jiraCreds(): CredentialsManager {
    const creds = fakeCredentials()
    creds.set('jira', { email: 'a@b.c', apiToken: 'tok', site: 'acme.atlassian.net' })
    return creds
  }

  const JIRA_IMAGE = 'https://acme.atlassian.net/rest/api/3/attachment/content/1'

  it('fetches with the issue\'s own credential and answers with a data URI', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({ [JIRA_IMAGE]: { body: Buffer.from('PNGDATA') } }, seen),
    )
    const result = await mgr.imageData('jira', JIRA_IMAGE)
    expect(result.dataUri).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
    expect(result.bytes).toBe(7)
    expect(seen[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`,
    )
  })

  it('REFUSES a host the ticket named, and never makes the request', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({}, seen),
    )
    // Anyone who can comment on the ticket can put this address in it.
    await expect(mgr.imageData('jira', 'https://evil.example/beacon.png')).rejects.toThrow(
      /hosted somewhere other than Jira/,
    )
    // The refusal is not just loud — nothing left the machine (pattern #24).
    expect(seen).toEqual([])
  })

  it('refuses another Atlassian site, the way the issue read already does', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({}, seen),
    )
    await expect(
      mgr.imageData('jira', 'https://someone-else.atlassian.net/rest/api/3/attachment/content/1'),
    ).rejects.toThrow(/hosted somewhere other than Jira/)
    expect(seen).toEqual([])
  })

  it('says the credential may have expired when a 200 is not an image', async () => {
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      // The shape a lapsed session takes: a cheerful 200 carrying a sign-in page.
      bytesFrom({ [JIRA_IMAGE]: { type: 'text/html', body: Buffer.from('<html>') } }),
    )
    await expect(mgr.imageData('jira', JIRA_IMAGE)).rejects.toThrow(/not an image/)
  })

  it('names the size rather than sending a picture too big to show', async () => {
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({ [JIRA_IMAGE]: { body: Buffer.alloc(6 * 1024 * 1024) } }),
    )
    await expect(mgr.imageData('jira', JIRA_IMAGE)).rejects.toThrow(/6\.0 MB — too large/)
  })

  it('turns a 404 into what actually happened to the attachment', async () => {
    const mgr = new IntegrationsManager(
      jiraCreds(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({ [JIRA_IMAGE]: { status: 404 } }),
    )
    await expect(mgr.imageData('jira', JIRA_IMAGE)).rejects.toThrow(/attachment is gone/)
  })

  it('refuses without a credential before it refuses on the host', async () => {
    const mgr = new IntegrationsManager(
      fakeCredentials(),
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({}),
    )
    await expect(mgr.imageData('jira', JIRA_IMAGE)).rejects.toBeInstanceOf(MissingTokenError)
  })

  it('sends the Azure PAT as Basic to an attachment on dev.azure.com', async () => {
    const creds = fakeCredentials()
    creds.set('azure', { pat: 'azpat', org: 'o', project: 'p' })
    const url = 'https://dev.azure.com/o/p/_apis/wit/attachments/g?fileName=a.png'
    const seen: { url: string; headers: Record<string, string> }[] = []
    const mgr = new IntegrationsManager(
      creds,
      async () => okResponse({}),
      () => null,
      () => null,
      () => Date.now(),
      bytesFrom({ [url]: {} }, seen),
    )
    await mgr.imageData('azure', url)
    expect(seen[0]?.headers['Authorization']).toBe(`Basic ${Buffer.from(':azpat').toString('base64')}`)
  })
})

// ── previewList: what a query would return, before it is saved ────────────
//
// The save-time preview count. It runs the custom query VERBATIM in list mode,
// reusing the board read's cap and GitHub PR-drop so the number it shows is the
// number the board will show — not a looser one that would disagree with it.

describe('IntegrationsManager previewList', () => {
  it('runs the query verbatim and reports the matches, titles first', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      seenUrl = url
      return okResponse({
        items: [
          { number: 1, title: 'Alpha', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
          { number: 2, title: 'Beta', state: 'open', html_url: 'https://github.com/o/r/issues/2' },
        ],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    const items = await mgr.previewList('github', 'repo:acme/api is:issue')
    expect(decodeURIComponent(seenUrl)).toContain('repo:acme/api is:issue')
    // The assigned question is NOT what ran — a preview is of THIS query only.
    expect(decodeURIComponent(seenUrl)).not.toContain('assignee:@me')
    expect(items.map((i) => i.title)).toEqual(['Alpha', 'Beta'])
  })

  it('drops pull requests, exactly as the board read does — so the counts agree', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/user')) return okResponse({ login: 'octo' })
      return okResponse({
        items: [
          { number: 1, title: 'A real issue', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
          {
            number: 2,
            title: 'A PR',
            state: 'open',
            html_url: 'https://github.com/o/r/pull/2',
            pull_request: { url: 'x' },
          },
        ],
      })
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    expect((await mgr.previewList('github', 'repo:o/r')).map((i) => i.title)).toEqual(['A real issue'])
  })

  it('an empty query previews nothing and asks the tracker nothing', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('/user') ? okResponse({ login: 'octo' }) : okResponse({ items: [] }),
    )
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    fetchFn.mockClear()
    expect(await mgr.previewList('github', '   ')).toEqual([])
    // No search was issued for a blank query — a preview of nothing is nothing.
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a failed read — the IPC layer is what turns that into a fail-soft sentence', async () => {
    const fetchFn: FetchFn = async (url) =>
      url.includes('/user') ? okResponse({ login: 'octo' }) : errResponse(422)
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn)
    await mgr.setToken({ provider: 'github', pat: 'ghp_x' })
    await expect(mgr.previewList('github', 'not a real query')).rejects.toBeInstanceOf(IssueFetchError)
  })
})

describe('IntegrationsManager.closeIssue (#1885)', () => {
  const githubRef: IssueRef = {
    provider: 'github',
    owner: 'acme',
    repo: 'api',
    number: 42,
    key: 'acme/api#42',
  }
  type Call = { url: string; method: string; body: unknown }

  /** A fetch that records every call and answers 200 (or a chosen status). */
  function recordingFetch(status = 200): { fetchFn: FetchFn; calls: Call[] } {
    const calls: Call[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      })
      return status === 200 ? okResponse({}) : errResponse(status)
    }
    return { fetchFn, calls }
  }

  it('closes a GitHub issue: comments then PATCHes state closed/completed', async () => {
    const { fetchFn, calls } = recordingFetch()
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => 'gho_test')

    const result = await mgr.closeIssue(githubRef, { comment: 'done here' })

    expect(result).toEqual({ ok: true, provider: 'github', key: 'acme/api#42' })
    // The comment is posted BEFORE the close, so a failed close never orphans a
    // "closing this" note on a still-open issue.
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/acme/api/issues/42/comments',
      method: 'POST',
      body: { body: 'done here' },
    })
    expect(calls[1]).toEqual({
      url: 'https://api.github.com/repos/acme/api/issues/42',
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed' },
    })
    expect(calls).toHaveLength(2)
  })

  it('skips the comment call when none is given — just the PATCH', async () => {
    const { fetchFn, calls } = recordingFetch()
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => 'gho_test')
    await mgr.closeIssue(githubRef)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PATCH')
  })

  it('returns unsupported for Jira and Azure WITHOUT any network call', async () => {
    const jira = jest.fn<Promise<HttpResponse>, [string, unknown]>()
    const mgr = new IntegrationsManager(fakeCredentials(), jira as unknown as FetchFn)
    const jResult = await mgr.closeIssue({ provider: 'jira', key: 'ACME-1', site: null })
    const aResult = await mgr.closeIssue({
      provider: 'azure',
      kind: 'workitem',
      org: 'o',
      project: 'p',
      id: 5,
      key: 'o/p#5',
    })
    expect(jResult).toMatchObject({ ok: false, unsupported: true })
    expect(aResult).toMatchObject({ ok: false, unsupported: true })
    expect(jira).not.toHaveBeenCalled()
  })

  it('a missing GitHub token is a fail-soft ok:false, never a throw or a write', async () => {
    const { fetchFn, calls } = recordingFetch()
    // No stored PAT and a gh CLI resolver that finds nothing.
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => null)
    const result = await mgr.closeIssue(githubRef)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected failure')
    expect(result.unsupported).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('a rejected close is fail-soft: ok:false with a scope hint, never a throw', async () => {
    const { fetchFn } = recordingFetch(403)
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => 'gho_test')
    const result = await mgr.closeIssue(githubRef)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/scope/i)
  })

  it('a thrown transport is caught and returned, not propagated', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }
    const mgr = new IntegrationsManager(fakeCredentials(), fetchFn, () => 'gho_test')
    const result = await mgr.closeIssue(githubRef)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/Could not reach GitHub/)
  })
})
