// IntegrationsManager — read-only Jira/GitHub access for the task list, via a
// stored Personal Access Token (no OAuth). Tokens live in CredentialsManager
// (~/.flow/credentials.json); their VALUES never leave main — status() returns
// names/hints only. The issue fetch is a plain authenticated REST GET; the
// `fetch` implementation is injected so the whole thing unit-tests offline.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CredentialsManager } from '../credentials'
import {
  normalizeAzureIssue,
  normalizeAzurePr,
  normalizeGithubIssue,
  normalizeJiraIssue,
  type IssueProvider,
  type IssueRef,
  type NormalizedIssue,
} from '../issue-ref'
import { imageHostAllowed, isImageContentType, MAX_IMAGE_BYTES } from './issue-images'
import type { IssueListMode } from '../../shared/ipc-contract'

/** How the board wants a provider's list built — the mode and, when the mode
 *  needs it, the native custom query. Defaults to the historical behaviour:
 *  what is assigned to you, no query. */
export interface AssignedOptions {
  mode: IssueListMode
  query: string
}

const DEFAULT_ASSIGNED_OPTIONS: AssignedOptions = { mode: 'assigned', query: '' }

/**
 * The outcome of `closeIssue` — the manager's FIRST tracker write.
 *
 * Never a thrown error: the close is a fail-soft side effect of moving a card to
 * Done (the lane move must never be blocked or reverted), so every failure is a
 * value the caller turns into a notification. `unsupported` distinguishes "this
 * provider's done-close isn't built yet" from "it tried and could not" — the two
 * read differently to a person and must not be collapsed into one sentence.
 */
export type CloseIssueResult =
  | { ok: true; provider: IssueProvider; key: string }
  | { ok: false; unsupported?: boolean; reason: string }

/** One ticket picture, fetched — the bytes inline, and how many there were. */
export interface IssueImageData {
  /** `data:image/png;base64,…` — what the page's own CSP already permits. */
  dataUri: string
  /** The decoded size, for the caller that wants to say how big it was. */
  bytes: number
}

/** The tracker's name, for a sentence a person reads. */
const PROVIDER_LABEL: Record<IssueProvider, string> = {
  jira: 'Jira',
  github: 'GitHub',
  azure: 'Azure DevOps',
}

/** A byte count, in the units a person thinks in. */
function describeBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${String(Math.round(bytes / 1024))} KB`
}

/** Minimal fetch surface — satisfied by global fetch, trivially faked in tests. */
export interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
export type FetchFn = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    /** JSON body, for the one endpoint that is a POST — see `assignedJira`. */
    body?: string
    signal?: AbortSignal
  },
) => Promise<HttpResponse>

/**
 * A response that carries BYTES rather than JSON — the one thing an image needs
 * and no other read in this file does.
 *
 * A SECOND TRANSPORT, NOT A WIDER `HttpResponse`. Adding `arrayBuffer` to the
 * shared shape would make every existing fake in the suite either implement a
 * method it never uses or declare it optional — and an optional method on the
 * one path that cannot work without it is a runtime branch that exists purely
 * for tests. This is injected separately and defaults to the same global fetch.
 */
export interface BytesResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}
export type FetchBytesFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' },
) => Promise<BytesResponse>

const execFileAsync = promisify(execFile)

/**
 * Deadline on every HTTP request this manager makes (#1639). Undici's fetch has
 * no overall deadline — a routable host that accepts and stays silent is held
 * until the 300s headersTimeout, which after #1638 meant a Connect that sat
 * unresolved for minutes on a typo'd site. Aligned with the module's own az
 * subprocess deadline (8s): the same "freezes the UI" concern as #174.
 */
const HTTP_DEADLINE_MS = 8_000

/**
 * How long a resolved CLI token (or its absence) is cached, so repeated status
 * checks don't re-shell on every render. Short enough that a fresh `gh`/`az`
 * login is reflected quickly (#174).
 */
const CLI_TOKEN_TTL_MS = 30_000

/** Resolves a GitHub token from the `gh` CLI, or null if unavailable. ASYNC so
 *  the Electron main event loop is never blocked (#174). Injected for tests so
 *  they never shell out; a sync fake is still accepted (awaited transparently). */
export type GhTokenFn = () => string | null | Promise<string | null>

const defaultGhToken: GhTokenFn = async () => {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null // gh not installed / not authenticated
  }
}

/** Resolves an Azure DevOps access token from the `az` CLI, or null. ASYNC (see
 *  GhTokenFn). Injected for tests so they never shell out. */
export type AzTokenFn = () => string | null | Promise<string | null>

// Well-known Azure DevOps resource (app) id — the audience for a DevOps token.
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'

const defaultAzToken: AzTokenFn = async () => {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '-o', 'tsv'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null // az not installed / not authenticated
  }
}

/** Secrets accepted by setToken (never returned anywhere). */
export type ProviderSecrets =
  | { provider: 'github'; pat: string }
  | { provider: 'jira'; site: string; email: string; apiToken: string }
  /**
   * Azure needs a PLACE as well as a credential. Unlike GitHub and Jira it has
   * no "everything of mine, everywhere" endpoint — a WIQL query is scoped to
   * one project — so the organisation and project are part of the connection
   * rather than something to guess at query time.
   */
  | { provider: 'azure'; pat: string; org: string; project: string }

export interface IntegrationStatus {
  connected: boolean
  /** A non-secret hint (e.g. the Jira email) — never the token. */
  identityHint?: string
}

/** No token configured for the provider the issue needs. */
/**
 * How many assigned items a provider is asked for.
 *
 * The column is the work in front of a person, not an archive. Fifty is more
 * than anyone has open and small enough to be one request to every provider.
 */
export const ASSIGNED_LIMIT = 50

export class MissingTokenError extends Error {
  constructor(public provider: IssueProvider) {
    super(`No ${provider} token configured — add one in Settings.`)
    this.name = 'MissingTokenError'
  }
}

/** The provider rejected or couldn't return the issue. */
export class IssueFetchError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'IssueFetchError'
  }
}

export class IntegrationsManager {
  /** Short-TTL cache of the CLI-resolved token (or its absence). The stored
   *  PROMISE dedupes concurrent resolvers so parallel status pills shell once. */
  private readonly cliTokenCache = new Map<
    'gh' | 'az',
    { promise: Promise<string | null>; expires: number }
  >()

  constructor(
    private readonly credentials: CredentialsManager,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
    private readonly ghTokenFn: GhTokenFn = defaultGhToken,
    private readonly azTokenFn: AzTokenFn = defaultAzToken,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly fetchBytesFn: FetchBytesFn = globalThis.fetch as unknown as FetchBytesFn,
  ) {}

  /** Resolve a CLI token through the short-TTL cache — the ONLY path that may
   *  shell out, so callers never re-invoke the CLI on every status check. */
  private resolveCliToken(key: 'gh' | 'az'): Promise<string | null> {
    const now = this.nowFn()
    const cached = this.cliTokenCache.get(key)
    if (cached && cached.expires > now) return cached.promise
    const fn = key === 'gh' ? this.ghTokenFn : this.azTokenFn
    // Promise.resolve() accepts both sync and async fakes; .catch keeps a
    // rejecting resolver from poisoning the cache (treated as "no token").
    const promise = Promise.resolve(fn()).catch(() => null)
    this.cliTokenCache.set(key, { promise, expires: now + CLI_TOKEN_TTL_MS })
    return promise
  }

  /**
   * The same GitHub token, for the CLI's own `gh` calls.
   *
   * TWO AUTH PATHS USED TO NOT MEET. The importer reads issues with the token
   * below; the tasks board's queue is read by the CLI shelling out to `gh`,
   * which knows only its own login. So "Connect GitHub" here left the board
   * still saying it could not read the list — a remedy that did not remedy.
   * `gh` honours GH_TOKEN, so handing it this one makes the dialog the single
   * place GitHub access is granted.
   */
  async githubTokenForCli(): Promise<string | null> {
    return this.githubToken()
  }

  /** GitHub token: an explicitly-stored PAT wins; otherwise reuse the `gh` CLI
   *  login so users already authenticated with gh never paste a token. */
  private async githubToken(): Promise<string | null> {
    const pat = str(this.credentials.get('github')?.['pat'])
    if (pat) return pat
    return this.resolveCliToken('gh')
  }

  /**
   * Store a provider's token (merged into CredentialsManager) — but only after
   * it has been seen to WORK. Presence used to be the whole check: any string
   * was stored verbatim and status() then painted the pill green, so a nonsense
   * site/email/token read as "Connected" until an import failed much later, and
   * a bogus GitHub PAT silently replaced a working gh CLI login (#1503). Now the
   * credential is shape-checked and then proven with the same authenticated
   * identity read the importer makes; a credential that never worked is refused
   * and nothing is stored.
   */
  async setToken(secrets: ProviderSecrets): Promise<void> {
    if (secrets.provider === 'github') {
      const pat = secrets.pat.trim()
      if (!pat) throw new Error('GitHub token is empty')
      const login = await this.verifyGithubPat(pat)
      this.credentials.set('github', { pat, identity: login })
    } else if (secrets.provider === 'azure') {
      const pat = secrets.pat.trim()
      const org = secrets.org.trim()
      const project = secrets.project.trim()
      if (!pat) throw new Error('Azure DevOps token is empty')
      if (/\s/.test(pat)) throw new Error('Azure DevOps token contains whitespace — check the paste')
      if (!org || !project) {
        throw new Error('Azure DevOps organisation and project are both required')
      }
      // A SEGMENT, NOT A PATH. Both go into a URL, so a value carrying a slash
      // or a query would be building a request against somewhere else — refused
      // here rather than encoded and sent (allowed-pattern #22: validate what
      // you were told).
      for (const [what, value] of [
        ['organisation', org],
        ['project', project],
      ] as const) {
        if (/[\s/?#]/.test(value)) {
          throw new Error(`Azure DevOps ${what} should be just its name — "${value}" is not`)
        }
      }
      // THE PAT IS PROVEN, now that there is somewhere to prove it against. It
      // used to be stored unverified with a comment saying no org was stored,
      // so there was no endpoint to test it on; the org IS the missing half, and
      // a credential that never worked should not paint the pill green (#1503's
      // rule, which Azure was the one provider to sit outside).
      const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      await this.getVerifyJson(
        'azure',
        `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}?api-version=7.0`,
        { Authorization: auth, Accept: 'application/json' },
      )
      this.credentials.set('azure', { pat, org, project })
    } else {
      if (!secrets.site.trim() || !secrets.email.trim() || !secrets.apiToken.trim()) {
        throw new Error('Jira site, email, and API token are all required')
      }
      const site = normalizeSite(secrets.site)
      if (!isHostname(site)) {
        throw new Error(`"${secrets.site.trim()}" doesn't look like a Jira site — expected a host like your-team.atlassian.net`)
      }
      const email = secrets.email.trim()
      if (!isEmailShaped(email)) {
        throw new Error(`"${email}" doesn't look like an email address`)
      }
      await this.verifyJiraCredential(site, email, secrets.apiToken)
      this.credentials.set('jira', { site, email, apiToken: secrets.apiToken })
    }
  }

  /** Prove a GitHub PAT against /user; returns the authenticated login. */
  private async verifyGithubPat(pat: string): Promise<string> {
    const raw = await this.getVerifyJson('github', 'https://api.github.com/user', {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    const login = typeof (raw as { login?: unknown })?.['login'] === 'string'
      ? ((raw as { login: string }).login)
      : ''
    return login
  }

  /** Prove a Jira site/email/token against /rest/api/3/myself. */
  private async verifyJiraCredential(site: string, email: string, apiToken: string): Promise<void> {
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
    await this.getVerifyJson('jira', `https://${site}/rest/api/3/myself`, {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    })
  }

  /** The ONE transport call — every request this manager makes carries the
   *  deadline, so a silent host fails in seconds, not minutes (#1639). */
  private deadlineFetch(
    url: string,
    headers: Record<string, string>,
    body?: string,
    method?: string,
  ): Promise<HttpResponse> {
    // GET UNLESS THERE IS A BODY. Every read this manager makes is a GET except
    // one — Jira's JQL search, which Atlassian moved to a POST when it removed
    // the query-string form (see `assignedJira`) — so the method follows the
    // body rather than being a parameter every caller has to think about.
    //
    // The explicit `method` is the ONE exception: a write (the first this manager
    // makes — `closeIssue`) needs PATCH, which the body rule cannot express. It
    // overrides only when given, so every existing read is byte-for-byte unchanged.
    const resolvedMethod = method ?? (body === undefined ? 'GET' : 'POST')
    return this.fetchFn(url, {
      method: resolvedMethod,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
    })
  }

  /** The verification GET — same transport as getJson, but worded for Connect:
   *  the failure is about the credential being entered, not an issue fetch. */
  private async getVerifyJson(
    provider: IssueProvider,
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let response: HttpResponse
    try {
      response = await this.deadlineFetch(url, headers)
    } catch (error) {
      throw new Error(`Could not reach ${provider} to verify the credential: ${describeFetchError(error)}`)
    }
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403
          ? `${provider} rejected the credential — check it`
          : `${provider} verification failed (HTTP ${response.status})`
      throw new Error(detail)
    }
    try {
      return await response.json()
    } catch {
      throw new Error(`${provider} verification returned an unexpected (non-JSON) response`)
    }
  }

  clearToken(provider: IssueProvider): void {
    this.credentials.delete(provider)
  }

  /** Connection status — names/hints only, never the token itself. ASYNC: CLI
   *  token resolution runs off the main event loop so opening Settings never
   *  freezes the UI (#174). A stored PAT short-circuits without shelling. */
  async status(provider: IssueProvider): Promise<IntegrationStatus> {
    if (provider === 'github') {
      // A stored PAT was verified at Connect time (#1503) — report the login it
      // proved out as, falling back to plain Connected for pre-#1503 stores.
      const gh = this.credentials.get('github')
      if (str(gh?.['pat'])) {
        const identity = str(gh?.['identity'])
        return identity ? { connected: true, identityHint: identity } : { connected: true }
      }
      return (await this.resolveCliToken('gh'))
        ? { connected: true, identityHint: 'via gh CLI' }
        : { connected: false }
    }
    if (provider === 'azure') {
      // A stored PAT reads as connected; otherwise report the az CLI reuse.
      if (str(this.credentials.get('azure')?.['pat'])) return { connected: true }
      return (await this.resolveCliToken('az'))
        ? { connected: true, identityHint: 'via az CLI' }
        : { connected: false }
    }
    const creds = this.credentials.get(provider)
    if (!creds) return { connected: false }
    const connected =
      typeof creds['apiToken'] === 'string' &&
      typeof creds['email'] === 'string' &&
      typeof creds['site'] === 'string'
    return {
      connected,
      identityHint: typeof creds['email'] === 'string' ? (creds['email'] as string) : undefined,
    }
  }

  /** Authenticated read-only fetch of one issue → normalized shape. */
  async fetchIssue(ref: IssueRef): Promise<NormalizedIssue> {
    if (ref.provider === 'github') return this.fetchGithub(ref)
    if (ref.provider === 'azure') return this.fetchAzure(ref)
    return this.fetchJira(ref)
  }

  /**
   * Close a tracker ticket — the manager's ONLY write toward a tracker.
   *
   * WHY IT IS HERE AND NOT THE LOOP'S `gh issue close`. That path is bound to the
   * queue model (a loop directive, a claim, an evidence gate) and deliberately
   * refuses a person-owned issue, leaving it to a PR's `Closes #n`. That restraint
   * is about an autonomous *agent*; a person dragging a promoted card to Done is
   * the authorization, and this card has no loop directive. So the close is a plain
   * authenticated REST write, symmetric with `fetchGithub` — same PAT, same
   * injected transport, offline-testable.
   *
   * FAIL-SOFT BY CONTRACT: it never throws. A missing token, an unreachable host,
   * or a rejection comes back as `{ ok: false, reason }`; the caller (the
   * `tasks:update` reaction) turns that into a toast and leaves the card in Done.
   *
   * GITHUB ONLY IN V1. Jira/Azure "done" is a workflow transition (Jira) or a
   * process-specific state (Azure), not a field write — surfaced as `unsupported`
   * rather than guessed. The comment, when given, is posted BEFORE the close so a
   * failed close does not orphan a "closing this" note on a still-open issue.
   */
  async closeIssue(ref: IssueRef, opts: { comment?: string } = {}): Promise<CloseIssueResult> {
    if (ref.provider !== 'github') {
      return {
        ok: false,
        unsupported: true,
        reason: `Closing ${PROVIDER_LABEL[ref.provider]} tickets from Done isn't supported yet.`,
      }
    }
    const pat = await this.githubToken()
    if (!pat) return { ok: false, reason: 'No GitHub token configured — add one in Settings.' }
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`
    try {
      const comment = opts.comment?.trim()
      if (comment) {
        const commentResp = await this.deadlineFetch(
          `${base}/comments`,
          headers,
          JSON.stringify({ body: comment }),
        )
        if (!commentResp.ok) {
          return { ok: false, reason: githubWriteReason('comment on', commentResp.status) }
        }
      }
      const resp = await this.deadlineFetch(
        base,
        headers,
        JSON.stringify({ state: 'closed', state_reason: 'completed' }),
        'PATCH',
      )
      if (!resp.ok) return { ok: false, reason: githubWriteReason('close', resp.status) }
      return { ok: true, provider: 'github', key: ref.key }
    } catch (error) {
      return { ok: false, reason: `Could not reach GitHub: ${describeFetchError(error)}` }
    }
  }

  /**
   * EVERYTHING ON THIS PROVIDER ASSIGNED TO THE PERSON SIGNED IN.
   *
   * The board's Remote column asks this. It is deliberately not the same
   * question as a loop's queue: a queue is a REPOSITORY's list of work somebody
   * pointed a loop at, and this is MY list — the issues that are mine, wherever
   * they live, on whichever tracker I have connected. A person opening the
   * board wants the second, which is why connecting GitHub is enough to get it
   * and no directive has to be edited.
   *
   * OPEN ONLY, AND CAPPED. The point of the column is the work in front of a
   * person; an unbounded history of everything ever assigned to them is a
   * different, worse feature. Each provider's own query says "unresolved" in
   * its own words.
   */
  async listAssigned(
    provider: IssueProvider,
    options: AssignedOptions = DEFAULT_ASSIGNED_OPTIONS,
  ): Promise<NormalizedIssue[]> {
    const query = options.query.trim()
    const wantAssigned = options.mode === 'assigned' || options.mode === 'both'
    const wantList = (options.mode === 'list' || options.mode === 'both') && query.length > 0
    // A MODE THAT ASKS FOR A LIST THERE IS NO QUERY FOR FALLS BACK TO ASSIGNED,
    // never to nothing: a person who set `list` and later cleared the query must
    // not get a silently empty column that reads as "nothing assigned". Run the
    // assigned read whenever the list read will not happen.
    const runAssigned = wantAssigned || !wantList

    const batches: NormalizedIssue[][] = []
    if (runAssigned) batches.push(await this.assignedFor(provider, null))
    if (wantList) batches.push(await this.assignedFor(provider, query))
    // De-duplicated by key, assigned batch first, capped like a single read —
    // the column is the work in front of a person, not an archive.
    return mergeAssigned(batches).slice(0, ASSIGNED_LIMIT)
  }

  /**
   * WHAT A CUSTOM QUERY WOULD RETURN — for a save-time preview, before the
   * query is stored and before the board reads it.
   *
   * Runs the query VERBATIM in list mode (the same call `both`/`list` make),
   * capped and de-duplicated exactly like a real read, and with the GitHub
   * PR-drop already applied inside `assignedFor` — so the preview count is the
   * count the board will show, not a looser number that would disagree with it
   * (C3). An empty query has nothing to preview and returns nothing rather than
   * falling back to the assigned read (which is a different question).
   *
   * Throws on a failed transport/credential like every read here; the IPC layer
   * turns that into a fail-soft `ok:false` sentence.
   */
  async previewList(provider: IssueProvider, query: string): Promise<NormalizedIssue[]> {
    const q = query.trim()
    if (q.length === 0) return []
    return mergeAssigned([await this.assignedFor(provider, q)]).slice(0, ASSIGNED_LIMIT)
  }

  /** One provider's list for one query — `null` runs the provider's default
   *  "assigned to me" query, a string runs that native query verbatim. */
  private assignedFor(provider: IssueProvider, query: string | null): Promise<NormalizedIssue[]> {
    if (provider === 'github') return this.assignedGithub(query)
    if (provider === 'jira') return this.assignedJira(query)
    return this.assignedAzure(query)
  }

  private async assignedGithub(customQuery: string | null): Promise<NormalizedIssue[]> {
    const pat = await this.githubToken()
    if (!pat) throw new MissingTokenError('github')
    // THE SEARCH API, not `GET /issues`. `GET /issues?filter=assigned` only
    // lists issues in repositories the user OWNS or is an organisation member
    // of — an issue assigned to them in a repo they merely collaborate on is
    // invisible to it, which surfaced as "Nothing assigned to you on GitHub"
    // for anyone whose work lives in someone else's repo. Search answers the
    // real question — "assigned to me, wherever it lives" — with `assignee:@me`,
    // GitHub's own word for the authenticated user, so no login has to be stored
    // (the same reason Jira uses `currentUser()`).
    //
    // A CUSTOM LIST RUNS THE PERSON'S OWN SEARCH VERBATIM — `repo:acme/api
    // label:bug`, whatever they saved. PRs are still dropped below (the column is
    // a task backlog), so a query without `is:issue` stays issues-only anyway.
    const q = customQuery ?? 'assignee:@me is:issue is:open archived:false'
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
      `&sort=updated&order=desc&per_page=${String(ASSIGNED_LIMIT)}`
    const raw = await this.getJson('github', url, {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    // Search wraps its results — `{ total_count, incomplete_results, items }` —
    // where `/issues` returned a bare array.
    const items = isRecord(raw) ? raw['items'] : null
    if (!Array.isArray(items)) return []
    return items
      // PULL REQUESTS ARE NOT ISSUES here. `is:issue` already excludes them
      // server-side; the `pull_request` key is a belt-and-suspenders guard for
      // anything the query somehow lets through.
      .filter((entry) => !isRecord(entry) || entry['pull_request'] === undefined)
      .map((entry) => normalizeGithubIssue(entry))
      .filter((issue) => issue.url.length > 0)
  }

  private async assignedJira(customQuery: string | null): Promise<NormalizedIssue[]> {
    const creds = this.credentials.get('jira')
    const email = str(creds?.['email'])
    const apiToken = str(creds?.['apiToken'])
    const site = str(creds?.['site'])
    if (!email || !apiToken || !site) throw new MissingTokenError('jira')
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
    // POST /search/jql, NOT GET /search. Atlassian removed the query-string
    // form — it answers `HTTP 410 Gone`, which is what the user saw — and
    // replaced it with the enhanced JQL search, which takes its query in a body.
    // The 410 is the whole reason this is the one POST in the file.
    //
    // `currentUser()` is Jira's own answer to "me": no account id has to be
    // stored, and it stays correct if the connected account changes.
    const raw = await this.getJson(
      'jira',
      `https://${site}/rest/api/3/search/jql`,
      { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      JSON.stringify({
        // A CUSTOM LIST RUNS THE PERSON'S OWN JQL VERBATIM; the default is the
        // assigned-and-unresolved query the column has always shown.
        jql: customQuery ?? 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
        maxResults: ASSIGNED_LIMIT,
        // THE FIELDS THE TICKET DRAWS. Jira returns only what is asked for, so
        // a field missing from this list is a field the ticket cannot show —
        // which is how priority, type and the two names arrived empty.
        fields: [
          'summary',
          'description',
          'status',
          'issuetype',
          'priority',
          'reporter',
          'assignee',
          // The screenshots. Jira keeps them in a list the description never
          // mentions, so without this the ticket has no pictures at all —
          // exactly the way it once had no priority.
          'attachment',
        ],
      }),
    )
    const issues = isRecord(raw) ? raw['issues'] : null
    if (!Array.isArray(issues)) return []
    return issues.map((entry) => normalizeJiraIssue(entry, site))
  }

  private async assignedAzure(customQuery: string | null): Promise<NormalizedIssue[]> {
    const creds = this.credentials.get('azure')
    const pat = str(creds?.['pat'])
    const org = str(creds?.['org'])
    const project = str(creds?.['project'])
    if (!pat) throw new MissingTokenError('azure')
    // AZURE SCOPES A QUERY TO ONE PROJECT — unlike the other two it has no
    // "everything of mine, everywhere" endpoint. A connection made before those
    // fields existed has a token and no place, and this says which is missing
    // rather than guessing an org and pointing somebody's token at it.
    if (!org || !project) {
      throw new IssueFetchError(
        'Azure DevOps needs an organisation and project — add them where you connected it.',
      )
    }
    const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
    const headers = { Authorization: auth, Accept: 'application/json' }
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`
    // TWO CALLS, BECAUSE WIQL ANSWERS WITH IDS. The query returns references
    // only; the fields come from a batch read of the ids it named. `@Me` is
    // Azure's own answer to "me", so no identity has to be stored.
    const query = await this.getJson(
      'azure',
      `${base}/_apis/wit/wiql?api-version=7.0&$top=${String(ASSIGNED_LIMIT)}`,
      headers,
      JSON.stringify({
        // A CUSTOM LIST RUNS THE PERSON'S OWN WIQL VERBATIM. It must still be a
        // flat query selecting `[System.Id]` — the two-call shape below reads the
        // fields from the ids WIQL names, exactly as the default does.
        query:
          customQuery ??
          'SELECT [System.Id] FROM WorkItems ' +
            "WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed', 'Done') " +
            'ORDER BY [System.ChangedDate] DESC',
      }),
    )
    const refs = isRecord(query) ? query['workItems'] : null
    if (!Array.isArray(refs) || refs.length === 0) return []
    const ids = refs
      .map((ref) => (isRecord(ref) && typeof ref['id'] === 'number' ? ref['id'] : null))
      .filter((id): id is number => id !== null)
      .slice(0, ASSIGNED_LIMIT)
    if (ids.length === 0) return []
    const batch = await this.getJson(
      'azure',
      `${base}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.0`,
      headers,
    )
    const items = isRecord(batch) ? batch['value'] : null
    if (!Array.isArray(items)) return []
    return items.map((raw) => {
      const id = isRecord(raw) && typeof raw['id'] === 'number' ? raw['id'] : 0
      return normalizeAzureIssue(raw, { org, project, id, key: `${project}#${String(id)}` })
    })
  }

  private async fetchAzure(
    ref: Extract<IssueRef, { provider: 'azure' }>,
  ): Promise<NormalizedIssue> {
    // A stored PAT authenticates with Basic; otherwise reuse the `az` CLI login
    // (an AAD access token) with Bearer — so users signed in with az never paste
    // a token. The token is resolved in main and never crosses IPC.
    const pat = str(this.credentials.get('azure')?.['pat'])
    let authorization: string
    if (pat) {
      authorization = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
    } else {
      const azToken = await this.resolveCliToken('az')
      if (!azToken) throw new MissingTokenError('azure')
      authorization = `Bearer ${azToken}`
    }
    const base = `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.project)}`
    const headers = { Authorization: authorization, Accept: 'application/json' }
    if (ref.kind === 'pr') {
      const url = `${base}/_apis/git/repositories/${encodeURIComponent(ref.repo)}/pullRequests/${ref.id}?api-version=7.0`
      return normalizeAzurePr(await this.getJson('azure', url, headers), ref)
    }
    const url = `${base}/_apis/wit/workitems/${ref.id}?api-version=7.0`
    return normalizeAzureIssue(await this.getJson('azure', url, headers), ref)
  }

  private async fetchGithub(
    ref: Extract<IssueRef, { provider: 'github' }>,
  ): Promise<NormalizedIssue> {
    const pat = await this.githubToken()
    if (!pat) throw new MissingTokenError('github')
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`
    const raw = await this.getJson('github', url, {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    return normalizeGithubIssue(raw)
  }

  private async fetchJira(ref: Extract<IssueRef, { provider: 'jira' }>): Promise<NormalizedIssue> {
    const creds = this.credentials.get('jira')
    const email = str(creds?.['email'])
    const apiToken = str(creds?.['apiToken'])
    const storedSite = str(creds?.['site'])
    if (!email || !apiToken || !storedSite) throw new MissingTokenError('jira')
    // SECURITY: the Basic-auth header carries the user's Jira token, so it must
    // ONLY ever go to the connected site — never a host taken from a pasted URL.
    // A URL for any other host is refused rather than leaking credentials.
    if (ref.site && normalizeSite(ref.site) !== storedSite) {
      throw new IssueFetchError(
        `This Jira URL points at "${normalizeSite(ref.site)}", not your connected site "${storedSite}".`,
      )
    }
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
    const url = `https://${storedSite}/rest/api/3/issue/${ref.key}`
    const raw = await this.getJson('jira', url, {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    })
    return normalizeJiraIssue(raw, storedSite)
  }

  /**
   * ONE PICTURE OFF A TICKET, as a data URI the renderer may draw.
   *
   * WHY MAIN FETCHES IT AT ALL. Two walls stand between a tracker's screenshot
   * and the card, and this method is the only thing that gets past either:
   *
   *  · THE CREDENTIAL. A Jira attachment, an Azure work-item attachment and a
   *    private repo's asset are all behind the same auth as the issue itself.
   *    A renderer `<img src>` sends no headers, and the token is deliberately
   *    never given to the renderer, so the renderer can never load one.
   *  · THE PAGE'S OWN POLICY. `img-src 'self' data:` — the renderer may not
   *    load a remote image at all. Loosening that to `https:` would let any
   *    ticket author beacon the user by putting an address in a description.
   *
   * So the bytes come back inline instead, which satisfies both: the request is
   * made where the credential lives, by a host allow-list rather than by
   * whatever a stranger typed into a ticket, and what reaches the page is a
   * data URI the existing policy already permits.
   *
   * ONE AT A TIME, ON DEMAND. A list of issues carries image ADDRESSES; the
   * bytes are asked for per picture as it is drawn (allowed-pattern #18), so a
   * Remote column of thirty tickets is not thirty megabytes of base64.
   */
  async imageData(provider: IssueProvider, url: string): Promise<IssueImageData> {
    const { headers, site } = await this.imageAuth(provider)
    // THE DOOR, AND IT IS SHUT FIRST. The address came out of a ticket body,
    // which anyone who can comment on that ticket can write — so the host is
    // checked before a credential-bearing request is built, not after.
    if (!imageHostAllowed({ provider, site }, url)) {
      throw new IssueFetchError(
        `That image is hosted somewhere other than ${PROVIDER_LABEL[provider]}, so Flow will not fetch it with your credentials.`,
      )
    }
    let response: BytesResponse
    try {
      response = await this.fetchBytesFn(url, {
        headers,
        signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
      })
    } catch (error) {
      throw new IssueFetchError(`Could not load the image: ${describeFetchError(error)}`)
    }
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403
          ? 'check your token / permissions'
          : response.status === 404
            ? 'the attachment is gone, or this account cannot see it'
            : `HTTP ${response.status}`
      throw new IssueFetchError(`Could not load the image — ${detail}`, response.status)
    }
    const contentType = response.headers.get('content-type')
    // A 200 IS NOT A PICTURE. An expired session commonly answers a sign-in
    // PAGE with a cheerful 200, and rendering that as an image gives a broken
    // frame where a reason belongs.
    if (!isImageContentType(contentType)) {
      throw new IssueFetchError(
        `${PROVIDER_LABEL[provider]} answered with something that is not an image — the credential may have expired.`,
      )
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new IssueFetchError(
        `That image is ${describeBytes(bytes.byteLength)} — too large to show here. Open it on the tracker.`,
      )
    }
    const mime = (contentType ?? 'image/png').split(';')[0]?.trim() ?? 'image/png'
    return { dataUri: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength }
  }

  /**
   * The header an image request carries, and the host it is allowed to reach.
   *
   * THE SAME RESOLUTION THE ISSUE READ USES, deliberately: an attachment is
   * behind the issue's own auth, so a second way of deciding who we are would
   * be a second thing to get wrong. Jira also returns its connected `site`,
   * because for Jira the allow-list IS that site and nothing else.
   */
  private async imageAuth(
    provider: IssueProvider,
  ): Promise<{ headers: Record<string, string>; site: string | null }> {
    // `*/*`, NOT `image/*`. Jira's attachment endpoint does not serve the bytes
    // itself — it answers a redirect to media services — and it refuses to
    // negotiate a narrow Accept, so `image/*` came back as a flat HTTP 406 on
    // every screenshot. Asking for anything is also the truthful request: what
    // comes back is checked by its Content-Type either way, which is the check
    // that actually decides whether this is a picture.
    const accept = '*/*'
    if (provider === 'github') {
      const pat = await this.githubToken()
      if (!pat) throw new MissingTokenError('github')
      return { headers: { Authorization: `Bearer ${pat}`, Accept: accept }, site: null }
    }
    if (provider === 'azure') {
      const pat = str(this.credentials.get('azure')?.['pat'])
      if (pat) {
        const auth = Buffer.from(`:${pat}`).toString('base64')
        return { headers: { Authorization: `Basic ${auth}`, Accept: accept }, site: null }
      }
      const azToken = await this.resolveCliToken('az')
      if (!azToken) throw new MissingTokenError('azure')
      return { headers: { Authorization: `Bearer ${azToken}`, Accept: accept }, site: null }
    }
    const creds = this.credentials.get('jira')
    const email = str(creds?.['email'])
    const apiToken = str(creds?.['apiToken'])
    const site = str(creds?.['site'])
    if (!email || !apiToken || !site) throw new MissingTokenError('jira')
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
    return { headers: { Authorization: `Basic ${auth}`, Accept: accept }, site }
  }

  private async getJson(
    provider: IssueProvider,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<unknown> {
    let response: HttpResponse
    try {
      response = await this.deadlineFetch(url, headers, body)
    } catch (error) {
      throw new IssueFetchError(`Could not reach ${provider}: ${describeFetchError(error)}`)
    }
    if (!response.ok) {
      const detail =
        response.status === 401 || response.status === 403
          ? 'check your token / permissions'
          : response.status === 404
            ? 'issue not found or no access'
            : // 410 GONE MEANS THE ENDPOINT WAS REMOVED, not that anything is
              // wrong with the person's account — a bare "HTTP 410" sends them
              // to check a token that is fine.
              response.status === 410
              ? 'that part of its API has been retired — Flow needs updating'
              : `HTTP ${response.status}`
      throw new IssueFetchError(`${provider} request failed — ${detail}`, response.status)
    }
    // Guard the parse: a 200 with a non-JSON body (a proxy/WAF interstitial, a
    // Cloudflare challenge, a maintenance/HTML page, or a misconfigured base URL)
    // would otherwise reject with a raw "SyntaxError: Unexpected token <" that
    // escapes verbatim to the renderer instead of the intended typed error (#275).
    // Must await so the catch sees the rejection rather than leaking the promise.
    try {
      return await response.json()
    } catch {
      throw new IssueFetchError(
        `${provider} returned an unexpected (non-JSON) response`,
        response.status,
      )
    }
  }
}

/**
 * Canonicalize a Jira site to a bare host: strip scheme + trailing slash and
 * lowercase. Hostnames are case-insensitive (RFC 3986/4343), so the connected-site
 * safety check must compare them case-insensitively — otherwise a site configured
 * with any uppercase letters (e.g. "Acme.atlassian.net") falsely refuses a same-site
 * browser URL whose host parses lowercase ("acme.atlassian.net") (#276). Applied at
 * both write (setToken) and check time, so stored and compared hosts are canonical.
 */
function normalizeSite(site: string): string {
  return site
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** A plain object, for the two list payloads that are shaped rather than flat. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Concatenate the read batches, DE-DUPLICATED BY KEY, first batch winning.
 *
 * `both` runs the assigned read and the list read separately, and an issue that
 * is both assigned to you AND matches your saved query would otherwise appear
 * twice. The assigned batch is passed first so a duplicate keeps its assigned
 * position. An issue with no key (a payload too malformed to normalize) is kept
 * — dropping it would hide it, and de-dup is not the place to filter.
 */
function mergeAssigned(batches: NormalizedIssue[][]): NormalizedIssue[] {
  const seen = new Set<string>()
  const out: NormalizedIssue[] = []
  for (const batch of batches) {
    for (const issue of batch) {
      if (issue.key.length > 0) {
        if (seen.has(issue.key)) continue
        seen.add(issue.key)
      }
      out.push(issue)
    }
  }
  return out
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** One line for a failed transport call. A deadline abort reads as the timeout
 *  it is, not as undici's "operation was aborted" (#1639). */
function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no response within ${HTTP_DEADLINE_MS / 1000}s`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * A GitHub write refusal, in a person's terms. 401/403 is nearly always a
 * read-only PAT: the token that lists issues fine cannot close them, and saying
 * "check the token scope" points at the real fix rather than a generic HTTP code.
 */
function githubWriteReason(action: 'close' | 'comment on', status: number): string {
  const detail =
    status === 401 || status === 403
      ? "check the token's scope (it may be read-only)"
      : status === 404
        ? 'issue not found or no access'
        : `HTTP ${status}`
  return `GitHub would not let Flow ${action} the issue — ${detail}.`
}

/** A normalized site must be a plausible DNS host — label.label at minimum.
 *  Placeholder-safe: nothing with spaces or without a dot can pass (#1503). */
function isHostname(site: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/.test(site)
}

/** Loose email shape — local@domain.tld. Rejects the obviously-not-an-email
 *  without pretending to implement RFC 5322 (#1503). */
function isEmailShaped(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
