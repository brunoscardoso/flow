/**
 * THE KNOWLEDGE-REPO ADDRESS GRAMMAR — one parser for every address the app
 * hands to git, wherever it came from: a person typing it, a host tool
 * answering it, or (most dangerously) a line in a COMMITTED file that anybody
 * who can land a commit in the code repo can write.
 *
 * The cases both sides must agree on live in `git-remote-fixtures.json`, and
 * the CLI's own parser (src/cli, ESM, which this CJS bundle cannot import) is
 * pinned to the same file by its own parity test. Add a case there, never in
 * only one test.
 *
 * What is accepted is deliberately narrow:
 *
 *  · `https://[user@]host[:port]/path` — the credential helper serves these;
 *  · `ssh://[user@]host[:port]/path` and scp-like `user@host:path` — the
 *    person's SSH keys serve these.
 *
 * `http://` and `git://` are `insecure-remote`; a password or token anywhere
 * in the address (user info, an scp password, a secret query parameter) is
 * `credentials-in-url`; everything else refused is `invalid-remote`.
 *
 * Everything else is refused before git ever sees it: an option-shaped
 * address (`--upload-pack=…`, `-oProxyCommand=…`), a transport helper
 * (`ext::`, `fd::`), a local path or `file://`, plain `http://`, a query or
 * fragment, a dot segment, whitespace, and anything carrying a password or a
 * token in the address itself. A refusal's `detail` is a sentence a person can
 * read: no commands, paths or setting names (forbidden-pattern #12).
 */

export type GitRemoteProvider = 'github' | 'azure' | 'gitlab' | 'bitbucket' | 'other'

export type GitRemoteRefusal = 'invalid-remote' | 'insecure-remote' | 'credentials-in-url'

export type GitRemoteVerdict =
  | {
      ok: true
      /** The address as given, trimmed. This exact string is what git receives. */
      url: string
      /** Lower-case host name, without a port. */
      host: string
      provider: GitRemoteProvider
      transport: 'https' | 'ssh'
      /** Path segments as written (no `.git` removed). */
      segments: string[]
    }
  | { ok: false; reason: GitRemoteRefusal; detail: string }

export type KnowledgeBranchVerdict = { ok: true; branch: string } | { ok: false; reason: 'invalid-branch'; detail: string }

const SENTENCES = {
  invalid:
    "That isn't a repository address Flow can use. Copy the address from the repository's clone button — its secure web address or its SSH address.",
  insecure: "That address sends everything unencrypted. Use the repository's secure web address instead.",
  credentials:
    'That address carries a password or token. Give the plain address; signing in is handled by your git sign-in.',
  branch: "That branch name won't work.",
} as const

/** The sentence for a refusal — the one wording, wherever the refusal is reported. */
export function gitRemoteRefusalDetail(reason: GitRemoteRefusal | 'invalid-branch'): string {
  switch (reason) {
    case 'insecure-remote':
      return SENTENCES.insecure
    case 'credentials-in-url':
      return SENTENCES.credentials
    case 'invalid-branch':
      return SENTENCES.branch
    case 'invalid-remote':
      return SENTENCES.invalid
  }
}

const refuse = (reason: GitRemoteRefusal): GitRemoteVerdict => ({ ok: false, reason, detail: gitRemoteRefusalDetail(reason) })

/** Longest address accepted. Real ones are under 200 characters. */
const MAX_REMOTE_LENGTH = 2048
/** A host label: letters, digits, inner dashes. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** A path segment: no leading dash, unreserved characters and percent escapes only. */
const SEGMENT = /^(?!-)(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/
/** A user name before `@`: a plain account name (git, an org name). */
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Personal access tokens by their published prefixes, and anything long enough to be one. */
const TOKEN_LIKE = /^(?:gh[opusr]_|github_pat_|glpat-|glptt-|gldt-|ATBB|xox[abp]-)|^[A-Za-z0-9_-]{32,}$/
const SCP_LIKE = /^([^@/:\s]+)@([^:/\s]+):(.+)$/
/** scp-like with a password: `user:secret@host:path`. */
const SCP_WITH_PASSWORD = /^[^@/\s]*:[^@/\s]*@[^:/\s]+:/
const URL_FORM = /^(https|ssh|http|git):\/\/([^/?#\s]*)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i
/** A query parameter that carries a secret (`access_token`, `private_token`, `password`, …). */
const SECRET_PARAM = /(?:^|[?&])[^=&]*(?:token|password|passwd|secret)[^=&]*=/i

function parseHost(raw: string): { host: string } | null {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(raw)
  if (match === null) return null
  const host = match[1].toLowerCase()
  // One letter is a Windows drive (`C:repo`), never a host.
  if (host.length < 2) return null
  if (match[2] !== undefined) {
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  }
  const labels = host.split('.')
  if (labels.length === 0 || !labels.every((label) => HOST_LABEL.test(label))) return null
  return { host }
}

function parseSegments(path: string): string[] | null {
  const segments = path.split('/')
  // A leading slash (url path, or scp `host:/abs`) leaves one empty head; a trailing one, an empty tail.
  if (segments[0] === '') segments.shift()
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop()
  if (segments.length === 0) return null
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return null
    if (segment === '.' || segment === '..') return null
  }
  return segments
}

export function providerOfHost(host: string): GitRemoteProvider {
  if (host === 'github.com' || host === 'ssh.github.com') return 'github'
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure'
  if (host === 'gitlab.com') return 'gitlab'
  if (host === 'bitbucket.org') return 'bitbucket'
  return 'other'
}

/** Is this one of the addresses Flow lets git use for knowledge? See the module header. */
export function parseGitRemote(raw: unknown): GitRemoteVerdict {
  if (typeof raw !== 'string') return refuse('invalid-remote')
  const url = raw.trim()
  if (url === '' || url.length > MAX_REMOTE_LENGTH) return refuse('invalid-remote')
  // Option-shaped, control characters, backslashes, whitespace: never an address.
  if (url.startsWith('-') || /[\u0000- \u007f\\]/.test(url)) return refuse('invalid-remote')

  const form = URL_FORM.exec(url)
  if (form !== null) {
    const scheme = form[1].toLowerCase()
    const authority = form[2]
    let hostPart = authority
    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const userInfo = authority.slice(0, at)
      hostPart = authority.slice(at + 1)
      // A password, or a "user name" that is really a token: credentials, refused as such.
      if (userInfo.includes(':') || TOKEN_LIKE.test(userInfo)) return refuse('credentials-in-url')
      if (!USER_NAME.test(userInfo)) return refuse('invalid-remote')
    }
    // A secret in the query is still a credential; any other query or fragment is just not an address.
    if (form[4] !== undefined && SECRET_PARAM.test(form[4])) return refuse('credentials-in-url')
    if (scheme === 'http' || scheme === 'git') return refuse('insecure-remote')
    if (form[4] !== undefined || form[5] !== undefined) return refuse('invalid-remote')
    const host = parseHost(hostPart)
    if (host === null) return refuse('invalid-remote')
    const segments = parseSegments(form[3] ?? '')
    if (segments === null) return refuse('invalid-remote')
    return {
      ok: true,
      url,
      host: host.host,
      provider: providerOfHost(host.host),
      transport: scheme === 'https' ? 'https' : 'ssh',
      segments,
    }
  }

  // Anything else with a scheme (`file://`, `ext::`, `fd::`) is refused outright.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|:)/.test(url)) return refuse('invalid-remote')

  if (SCP_WITH_PASSWORD.test(url)) return refuse('credentials-in-url')
  const scp = SCP_LIKE.exec(url)
  if (scp !== null) {
    if (TOKEN_LIKE.test(scp[1])) return refuse('credentials-in-url')
    if (!USER_NAME.test(scp[1])) return refuse('invalid-remote')
    const host = parseHost(scp[2])
    if (host === null || scp[2].includes(':')) return refuse('invalid-remote')
    const segments = parseSegments(scp[3])
    if (segments === null) return refuse('invalid-remote')
    return { ok: true, url, host: host.host, provider: providerOfHost(host.host), transport: 'ssh', segments }
  }
  // A bare path (absolute or relative) or a host without a user: never a knowledge repo.
  return refuse('invalid-remote')
}

/**
 * The repository an address names, spelling aside — https vs ssh, `.git` or
 * not, letter case. Azure's ssh forms (`ssh.dev.azure.com:v3/org/project/repo`,
 * `vs-ssh.visualstudio.com:v3/…`), its https form (`org/project/_git/repo`) and
 * the legacy `org.visualstudio.com[/DefaultCollection]` all agree, and GitHub's
 * ssh-over-443 host (`ssh.github.com`) is github.com.
 *
 * A PORT OF THE CLI's `remoteIdentity` (src/cli/handlers/knowledge-migration.ts),
 * which is the source of truth: it is the id a Workspace gives a project, so
 * the app and the CLI must name every repository the same. The step order —
 * fold, then lowercase the whole thing — is the CLI's, so even case-sensitive
 * matches (`DefaultCollection`, `_git`, `v3`) agree. The shared fixture list's
 * `identities` pins both sides.
 */
export function remoteIdentity(raw: string): string | null {
  const parsed = parseGitRemote(raw)
  if (!parsed.ok) return null
  let host = parsed.host
  let segments = [...parsed.segments]
  if (host === 'ssh.github.com') host = 'github.com'
  if (providerOfHost(host) === 'azure') {
    if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
      if (segments[0] === 'v3') segments = segments.slice(1)
    } else if (host.endsWith('.visualstudio.com')) {
      segments = [
        host.slice(0, -'.visualstudio.com'.length),
        ...segments.filter((segment) => segment !== 'DefaultCollection'),
      ]
    }
    host = 'dev.azure.com'
    segments = segments.filter((segment) => segment !== '_git')
  }
  if (segments.length === 0) return null
  const last = segments.length - 1
  segments[last] = segments[last].replace(/\.git$/i, '')
  return `${host}/${segments.join('/')}`.toLowerCase()
}

/** Do two addresses name the same repository? Unparseable addresses only match themselves exactly. */
export function sameGitRemote(a: string, b: string): boolean {
  const left = remoteIdentity(a)
  const right = remoteIdentity(b)
  if (left === null || right === null) return a.trim() === b.trim()
  return left === right
}

/**
 * A branch name git accepts AND that can never be read as an option: git's
 * `check-ref-format` rules for one branch, plus no leading dash or slash.
 */
export function parseKnowledgeBranch(raw: unknown): KnowledgeBranchVerdict {
  const bad: KnowledgeBranchVerdict = { ok: false, reason: 'invalid-branch', detail: SENTENCES.branch }
  if (typeof raw !== 'string') return bad
  const branch = raw
  if (branch === '' || branch.length > 200 || branch === '@') return bad
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) return bad
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return bad
  if (/[\u0000- \u007f~^:?*[\\]/.test(branch)) return bad
  for (const component of branch.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) return bad
  }
  return { ok: true, branch }
}

/** The name a person knows the host by — "GitHub", "Azure DevOps", …, or the host itself. */
export function providerLabel(provider: GitRemoteProvider, host: string): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'azure':
      return 'Azure DevOps'
    case 'gitlab':
      return 'GitLab'
    case 'bitbucket':
      return 'Bitbucket'
    case 'other':
      return host
  }
}
