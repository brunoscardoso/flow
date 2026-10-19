/**
 * CREATING A WORKSPACE'S SHARED REPOSITORY WITH THE TOOLS THIS MACHINE IS SIGNED IN TO.
 *
 * Restored from the retired per-project knowledge sync (commit 3c330c11,
 * removed with it in 41a6322d) and re-pointed at Workspaces: the design and
 * its hardening are unchanged — only the shapes it answers moved into this
 * module, and what it creates is now one Workspace's repository.
 *
 * Flow holds no hosting credential of its own. To create a repository it asks
 * the host's own command-line tool, which the person signed in to themselves:
 *
 *  · the GitHub CLI (`gh`), for GitHub;
 *  · the Azure CLI with its DevOps extension (`az`), for Azure DevOps.
 *
 * Anything else (GitLab, Bitbucket, a self-hosted server) is CONNECTED to, not
 * created: the person makes the repository on their host and pastes its
 * address.
 *
 * Rules that shape the code:
 *
 *  · ARGV ONLY, never a shell; every value is validated BEFORE anything is
 *    spawned (no leading dash, a strict character set), passed as `--flag=value`
 *    where the tool takes flags, and after `--` where it takes positionals.
 *  · ASYNC, parallel, each call bounded by a timeout (allowed-pattern #19).
 *  · What the tools are signed in as is cached for the app session with a short
 *    TTL and an injected clock (allowed-pattern #20) — a settings panel opening
 *    and closing does not respawn two CLIs each time.
 *  · Failures become plain sentences (forbidden-pattern #12): not signed in, the
 *    name is taken (with a free name to offer), no permission. Raw output is a
 *    diagnostic for logs only.
 *  · The spawner is INJECTED. Tests never run the real `gh` or `az`.
 */

import { execFile } from 'node:child_process'

import { parseGitRemote } from '../../shared/git-remote'
import type { WorkspaceHostProvider } from '../../shared/workspaces-contract'

type KnowledgeHostProvider = WorkspaceHostProvider

/** Which tools are installed and signed in, and as whom. */
export interface HostToolsDetection {
  github: { available: boolean; login?: string }
  azure: { available: boolean; organization?: string }
}

/** What `createRepo` is asked, already split by host. */
export type CreateRepoRequest =
  | { provider: 'github'; owner: string; name: string }
  | { provider: 'azure'; organization: string; project: string; name: string }

/** Where a new repository could go, for one host. */
export type CreateTargetsResult =
  | { ok: true; provider: 'github'; owners: Array<{ login: string; type: 'user' | 'org' }> }
  | { ok: true; provider: 'azure'; organizations: Array<{ name: string; projects: string[] }>; detail?: string }
  | { ok: false; reason: string; detail: string }

type KnowledgeHostTools = HostToolsDetection
type KnowledgeCreateTargetsResult = CreateTargetsResult
type KnowledgeCreateRepoRequest = CreateRepoRequest

/** One probe of a tool (status, an API read). */
export const HOST_TOOL_PROBE_TIMEOUT_MS = 15_000
/** Creating a repository talks to the host twice; give it room. */
export const HOST_TOOL_CREATE_TIMEOUT_MS = 60_000
/** How long a detection answer is reused. Short: a person may sign in meanwhile. */
export const HOST_TOOLS_TTL_MS = 60_000
const HOST_TOOL_MAX_BUFFER = 4 * 1024 * 1024
/** The description every repository Flow creates carries. */
export const KNOWLEDGE_REPO_DESCRIPTION = 'Workspace knowledge kept in sync by Flow'

export type HostTool = 'gh' | 'az'

export interface HostToolRun {
  ok: boolean
  stdout: string
  stderr: string
  /** The tool is not installed (or not on this app's path). */
  missing?: boolean
  timedOut?: boolean
  /** For logs only. */
  error?: string
}

/** Run one host tool once. Never rejects. Injected in tests. */
export type HostToolSpawner = (
  tool: HostTool,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<HostToolRun>

export interface HostToolsDeps {
  spawn: HostToolSpawner
  now: () => number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export type CreateRepoResult =
  | { ok: true; url: string }
  | { ok: false; reason: CreateRepoFailure; detail: string; suggestion?: string; diagnostic?: string }

export type CreateRepoFailure =
  | 'invalid-request'
  | 'tool-missing'
  | 'not-signed-in'
  | 'name-taken'
  | 'no-permission'
  | 'timed-out'
  | 'failed'

export interface HostTools {
  /** Which tools are installed and signed in, and as whom. Cached per session (short TTL). */
  detect(): Promise<KnowledgeHostTools>
  /** Where a new repository could go: GitHub owners, or Azure organizations and their projects. */
  listCreateTargets(provider: KnowledgeHostProvider): Promise<KnowledgeCreateTargetsResult>
  /** Create a PRIVATE, empty repository; answers its https clone address. */
  createRepo(request: KnowledgeCreateRepoRequest): Promise<CreateRepoResult>
  /** Drop the cached detection (after a create, or when a person asks to look again). */
  forgetDetection(): void
}

// ── Validation (before anything is spawned) ────────────────────────────────

/** A GitHub user or organization login. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** A repository name both hosts accept: starts with a letter or digit. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** An Azure DevOps organization name. */
const AZURE_ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/
/** Characters Azure DevOps refuses in a project name (and a few that would be risky in argv). */
const AZURE_PROJECT_FORBIDDEN = /[\u0000-\u001f\u007f\\/:*?"'<>|;#$%&{}+=[\],@~^`]/

export function isValidGitHubOwner(owner: string): boolean {
  return GITHUB_OWNER.test(owner) && !owner.endsWith('-')
}

export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name) && !name.endsWith('.git') && !name.endsWith('.')
}

export function isValidAzureOrganization(organization: string): boolean {
  return AZURE_ORGANIZATION.test(organization)
}

export function isValidAzureProject(project: string): boolean {
  return (
    project.length > 0 &&
    project.length <= 64 &&
    project.trim() === project &&
    !/^[-._]/.test(project) &&
    !project.endsWith('.') &&
    !AZURE_PROJECT_FORBIDDEN.test(project)
  )
}

/** `notes` → `notes-2`; `notes-2` → `notes-3`. */
export function suggestRepoName(name: string): string {
  const numbered = /^(.*)-(\d+)$/.exec(name)
  if (numbered !== null) return `${numbered[1]}-${Number(numbered[2]) + 1}`
  return `${name}-2`
}

/** An organization's address on Azure DevOps. Only ever built from a validated name. */
export function azureOrganizationUrl(organization: string): string {
  return `https://dev.azure.com/${organization}`
}

/**
 * The organization NAME from a configured default (`https://dev.azure.com/acme`,
 * `https://acme.visualstudio.com/`, or a bare `acme`). Null when it is none of them.
 */
export function azureOrganizationName(configured: string): string | null {
  const value = configured.trim()
  const devAzure = /^https:\/\/dev\.azure\.com\/([^/?#\s]+)\/?$/i.exec(value)
  const legacy = /^https:\/\/([^./?#\s]+)\.visualstudio\.com\/?$/i.exec(value)
  const name = devAzure?.[1] ?? legacy?.[1] ?? value
  return isValidAzureOrganization(name) ? name : null
}

// ── Sentences (may reach the UI) ────────────────────────────────────────────

const SENTENCES = {
  invalidOwner: "Choose who owns the new repository — that account name isn't one GitHub uses.",
  invalidName: "That repository name won't work. Use letters, numbers, dots, dashes and underscores, starting with a letter or number.",
  invalidOrganization: "That organization name isn't one Azure DevOps uses.",
  invalidProject: "That project name isn't one Azure DevOps accepts.",
  invalidProvider: 'Choose where to create the repository.',
  githubMissing: "The GitHub command-line tool isn't installed on this computer, so Flow can't create a repository there. Create it on GitHub and connect to it instead.",
  azureMissing: "The Azure command-line tool with its DevOps extension isn't set up on this computer, so Flow can't create a repository there. Create it in Azure DevOps and connect to it instead.",
  githubSignedOut: "The GitHub command-line tool on this computer isn't signed in. Sign in to it, then try again.",
  azureSignedOut: "The Azure command-line tool on this computer isn't signed in. Sign in to it, then try again.",
  nameTaken: (suggestion: string): string => `A repository with that name already exists. Try "${suggestion}" instead.`,
  noPermission: "Your account can't create repositories there. Choose another owner, or ask an administrator.",
  timedOut: "Creating the repository took too long to answer. Check your connection and try again.",
  failed: "Flow couldn't create the repository. Nothing was changed; try again in a moment.",
  unexpected: "The repository was created, but its address came back in a form Flow can't use. Connect to it with its address instead.",
  noOrganization: "No Azure DevOps organization is set up on this computer's Azure command-line tool.",
  listFailed: "Flow couldn't read where a new repository could go. Try again in a moment.",
} as const

// ── Output parsing ─────────────────────────────────────────────────────────

/** `Logged in to github.com account devuser (keyring)` — or the older `… as devuser`. */
const GH_LOGIN = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/

export function parseGhLogin(output: string): string | null {
  const login = GH_LOGIN.exec(output)?.[1] ?? null
  return login !== null && isValidGitHubOwner(login) ? login : null
}

/** `organization = https://dev.azure.com/acme` out of `az devops configure --list`. */
export function parseAzureDefaults(output: string): { organization: string | null; project: string | null } {
  const value = (key: string): string | null => {
    const match = new RegExp(`^\\s*${key}\\s*=[ \\t]*(\\S.*?)\\s*$`, 'm').exec(output)
    return match === null ? null : match[1]
  }
  const organization = value('organization')
  return { organization: organization === null ? null : azureOrganizationName(organization), project: value('project') }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `az devops project list` answers `{ value: [...] }` on current versions and a bare array on old ones. */
export function parseAzureProjects(stdout: string): string[] {
  const parsed = parseJson(stdout)
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { value?: unknown }).value)
      ? ((parsed as { value: unknown[] }).value)
      : []
  return list
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && isValidAzureProject(name))
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

const NOT_SIGNED_IN = /not logged in|gh auth login|az login|authentication required|HTTP 401|bad credentials|AADSTS|TF400813|please run .?login/i
const NAME_TAKEN = /already exists|name already exists|TF400948|TF200016/i
const NO_PERMISSION = /HTTP 403|permission|forbidden|not authorized|must be an owner|resource not accessible|TF401027|TF401019|VS800075/i

function failureOf(run: HostToolRun, provider: KnowledgeHostProvider, name: string): CreateRepoResult {
  const text = `${run.stderr}\n${run.stdout}\n${run.error ?? ''}`
  const diagnostic = (run.stderr || run.error || '').trim()
  if (run.missing === true) {
    return { ok: false, reason: 'tool-missing', detail: provider === 'github' ? SENTENCES.githubMissing : SENTENCES.azureMissing }
  }
  if (run.timedOut === true) return { ok: false, reason: 'timed-out', detail: SENTENCES.timedOut, diagnostic }
  if (NAME_TAKEN.test(text)) {
    const suggestion = suggestRepoName(name)
    return { ok: false, reason: 'name-taken', detail: SENTENCES.nameTaken(suggestion), suggestion, diagnostic }
  }
  if (NOT_SIGNED_IN.test(text)) {
    return {
      ok: false,
      reason: 'not-signed-in',
      detail: provider === 'github' ? SENTENCES.githubSignedOut : SENTENCES.azureSignedOut,
      diagnostic,
    }
  }
  if (NO_PERMISSION.test(text)) return { ok: false, reason: 'no-permission', detail: SENTENCES.noPermission, diagnostic }
  return { ok: false, reason: 'failed', detail: SENTENCES.failed, diagnostic }
}

// ── The real spawner ───────────────────────────────────────────────────────

/** Quiet, non-interactive, colorless: the tools answer for a program, not a terminal. */
const HOST_TOOL_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
  AZURE_CORE_NO_COLOR: 'true',
  AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
  AZURE_CORE_COLLECT_TELEMETRY: 'false',
}

/**
 * `execFile`, never a shell. `env` is a function so the caller can hand over
 * the person's own PATH (a GUI-launched app cannot see Homebrew's folder —
 * see agent/runtime/tool-path.ts).
 */
export function createHostToolSpawner(env: () => Promise<NodeJS.ProcessEnv>): HostToolSpawner {
  return async (tool, args, options) => {
    const childEnv = { ...(await env()), ...HOST_TOOL_ENV }
    return new Promise<HostToolRun>((resolveRun) => {
      execFile(
        tool,
        [...args],
        { env: childEnv, encoding: 'utf8', maxBuffer: HOST_TOOL_MAX_BUFFER, timeout: options.timeoutMs, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error === null) {
            resolveRun({ ok: true, stdout: String(stdout), stderr: String(stderr) })
            return
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          resolveRun({
            ok: false,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error.message,
            ...(failure.code === 'ENOENT' ? { missing: true } : {}),
            ...(failure.killed === true || failure.signal === 'SIGKILL' ? { timedOut: true } : {}),
          })
        },
      )
    })
  }
}

// ── Host tools ─────────────────────────────────────────────────────────────

export function createHostTools(deps: HostToolsDeps): HostTools {
  const log = deps.log ?? ((): void => undefined)
  let cached: { at: number; answer: Promise<KnowledgeHostTools> } | null = null
  const probe = (tool: HostTool, args: readonly string[]): Promise<HostToolRun> =>
    deps.spawn(tool, args, { timeoutMs: HOST_TOOL_PROBE_TIMEOUT_MS })

  async function detectGitHub(): Promise<KnowledgeHostTools['github']> {
    const status = await probe('gh', ['auth', 'status', '--hostname', 'github.com'])
    if (!status.ok) return { available: false }
    // `gh auth status` prints to stderr on some versions and stdout on others.
    const login = parseGhLogin(`${status.stdout}\n${status.stderr}`)
    return login === null ? { available: true } : { available: true, login }
  }

  async function detectAzure(): Promise<KnowledgeHostTools['azure']> {
    const [account, extension, defaults] = await Promise.all([
      probe('az', ['account', 'show', '--output', 'json']),
      probe('az', ['extension', 'show', '--name', 'azure-devops', '--output', 'json']),
      probe('az', ['devops', 'configure', '--list']),
    ])
    if (!account.ok || !extension.ok) return { available: false }
    const organization = defaults.ok ? parseAzureDefaults(defaults.stdout).organization : null
    return organization === null ? { available: true } : { available: true, organization }
  }

  function detect(): Promise<KnowledgeHostTools> {
    const now = deps.now()
    if (cached !== null && now - cached.at < HOST_TOOLS_TTL_MS) return cached.answer
    const answer = Promise.all([detectGitHub(), detectAzure()])
      .then(([github, azure]) => ({ github, azure }))
      .catch((error: unknown): KnowledgeHostTools => {
        log('detecting host tools failed', { error: String(error) })
        return { github: { available: false }, azure: { available: false } }
      })
    cached = { at: now, answer }
    return answer
  }

  async function listCreateTargets(provider: KnowledgeHostProvider): Promise<KnowledgeCreateTargetsResult> {
    if (provider === 'github') {
      const [user, orgs] = await Promise.all([
        probe('gh', ['api', 'user', '--jq', '.login']),
        probe('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login']),
      ])
      if (!user.ok) {
        log('listing GitHub owners failed', { diagnostic: user.stderr || user.error })
        const failure = failureOf(user, 'github', '')
        return {
          ok: false,
          reason: failure.ok ? 'failed' : failure.reason,
          detail: failure.ok || failure.reason === 'failed' ? SENTENCES.listFailed : failure.detail,
        }
      }
      const login = lines(user.stdout)[0] ?? ''
      const owners: Array<{ login: string; type: 'user' | 'org' }> = []
      if (isValidGitHubOwner(login)) owners.push({ login, type: 'user' })
      for (const org of orgs.ok ? lines(orgs.stdout) : []) {
        if (isValidGitHubOwner(org) && !owners.some((owner) => owner.login === org)) owners.push({ login: org, type: 'org' })
      }
      return { ok: true, provider: 'github', owners }
    }
    if (provider === 'azure') {
      const tools = await detect()
      const organization = tools.azure.organization
      if (!tools.azure.available) return { ok: false, reason: 'tool-missing', detail: SENTENCES.azureMissing }
      if (organization === undefined) return { ok: true, provider: 'azure', organizations: [], detail: SENTENCES.noOrganization }
      const listed = await probe('az', ['devops', 'project', 'list', `--org=${azureOrganizationUrl(organization)}`, '--output', 'json'])
      if (!listed.ok) {
        log('listing Azure DevOps projects failed', { diagnostic: listed.stderr || listed.error })
        const failure = failureOf(listed, 'azure', '')
        return {
          ok: false,
          reason: failure.ok ? 'failed' : failure.reason,
          detail: failure.ok || failure.reason === 'failed' ? SENTENCES.listFailed : failure.detail,
        }
      }
      return { ok: true, provider: 'azure', organizations: [{ name: organization, projects: parseAzureProjects(listed.stdout) }] }
    }
    return { ok: false, reason: 'invalid-request', detail: SENTENCES.invalidProvider }
  }

  async function createGitHub(owner: string, name: string): Promise<CreateRepoResult> {
    const full = `${owner}/${name}`
    const created = await deps.spawn(
      'gh',
      ['repo', 'create', '--private', '--disable-wiki', `--description=${KNOWLEDGE_REPO_DESCRIPTION}`, '--', full],
      { timeoutMs: HOST_TOOL_CREATE_TIMEOUT_MS },
    )
    if (!created.ok) return failureOf(created, 'github', name)
    const viewed = await probe('gh', ['repo', 'view', '--json', 'url,sshUrl', '--', full])
    const parsed = viewed.ok ? parseJson(viewed.stdout) : null
    const url = typeof parsed === 'object' && parsed !== null ? (parsed as { url?: unknown }).url : undefined
    // https: the person's credential helper serves it; an SSH user's git still
    // reaches it through their own `insteadOf` rule if they keep one.
    const verdict = parseGitRemote(typeof url === 'string' ? url : `https://github.com/${full}`)
    if (!verdict.ok || verdict.provider !== 'github' || verdict.transport !== 'https') {
      return { ok: false, reason: 'failed', detail: SENTENCES.unexpected }
    }
    return { ok: true, url: verdict.url }
  }

  async function createAzure(organization: string, project: string, name: string): Promise<CreateRepoResult> {
    const created = await deps.spawn(
      'az',
      ['repos', 'create', `--name=${name}`, `--project=${project}`, `--org=${azureOrganizationUrl(organization)}`, '--output', 'json'],
      { timeoutMs: HOST_TOOL_CREATE_TIMEOUT_MS },
    )
    if (!created.ok) return failureOf(created, 'azure', name)
    const parsed = parseJson(created.stdout)
    const remoteUrl = typeof parsed === 'object' && parsed !== null ? (parsed as { remoteUrl?: unknown }).remoteUrl : undefined
    const verdict = parseGitRemote(remoteUrl)
    if (!verdict.ok || verdict.provider !== 'azure' || verdict.transport !== 'https') {
      return { ok: false, reason: 'failed', detail: SENTENCES.unexpected }
    }
    return { ok: true, url: verdict.url }
  }

  async function createRepo(request: KnowledgeCreateRepoRequest): Promise<CreateRepoResult> {
    const invalid = (detail: string): CreateRepoResult => ({ ok: false, reason: 'invalid-request', detail })
    const name = request.name
    if (!isValidRepoName(name)) return invalid(SENTENCES.invalidName)
    let result: CreateRepoResult
    if (request.provider === 'github') {
      if (!isValidGitHubOwner(request.owner)) return invalid(SENTENCES.invalidOwner)
      result = await createGitHub(request.owner, name)
    } else if (request.provider === 'azure') {
      if (!isValidAzureOrganization(request.organization)) return invalid(SENTENCES.invalidOrganization)
      if (!isValidAzureProject(request.project)) return invalid(SENTENCES.invalidProject)
      result = await createAzure(request.organization, request.project, name)
    } else {
      return invalid(SENTENCES.invalidProvider)
    }
    if (!result.ok && result.diagnostic !== undefined && result.diagnostic !== '') {
      log('creating a Workspace repository failed', { reason: result.reason, diagnostic: result.diagnostic })
    }
    return result
  }

  return {
    detect,
    listCreateTargets,
    createRepo,
    forgetDetection: () => {
      cached = null
    },
  }
}
