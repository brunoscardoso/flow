import {
  HOST_TOOLS_TTL_MS,
  azureOrganizationName,
  createHostTools,
  isValidAzureProject,
  isValidGitHubOwner,
  isValidRepoName,
  parseAzureDefaults,
  parseAzureProjects,
  parseGhLogin,
  type HostTool,
  type HostToolRun,
  type HostToolSpawner,
} from './host-tools'

/**
 * The host tools as a table keyed by tool + argv. Anything absent THROWS: the
 * test asserts the exact question asked, and nothing here ever runs the real
 * `gh` or `az`.
 */
function fakeSpawner(table: Record<string, Partial<HostToolRun> | (() => Partial<HostToolRun>)>): {
  spawn: HostToolSpawner
  calls: Array<{ tool: HostTool; args: string[] }>
} {
  const calls: Array<{ tool: HostTool; args: string[] }> = []
  return {
    calls,
    spawn: async (tool, args) => {
      calls.push({ tool, args: [...args] })
      const key = `${tool} ${args.join(' ')}`
      const entry = table[key]
      if (entry === undefined) throw new Error(`unexpected host tool call: ${key}`)
      const answer = typeof entry === 'function' ? entry() : entry
      return { ok: true, stdout: '', stderr: '', ...answer }
    },
  }
}

const GH_STATUS = 'gh auth status --hostname github.com'
const AZ_ACCOUNT = 'az account show --output json'
const AZ_EXTENSION = 'az extension show --name azure-devops --output json'
const AZ_DEFAULTS = 'az devops configure --list'
const SIGNED_IN_AZURE = {
  [AZ_ACCOUNT]: { stdout: '{"user":{"name":"devuser@acme.com"}}' },
  [AZ_EXTENSION]: { stdout: '{"name":"azure-devops"}' },
  [AZ_DEFAULTS]: { stdout: '[defaults]\norganization = https://dev.azure.com/acme\nproject = Orbit\n' },
}

function tools(table: Parameters<typeof fakeSpawner>[0], now: () => number = () => 0) {
  const fake = fakeSpawner(table)
  return { ...fake, hostTools: createHostTools({ spawn: fake.spawn, now }) }
}

describe('validation', () => {
  it('owners, names, organizations and projects: no leading dash, a strict character set', () => {
    expect(isValidGitHubOwner('devuser')).toBe(true)
    expect(isValidGitHubOwner('acme-team')).toBe(true)
    for (const bad of ['', '-x', 'a b', 'a/b', '--help', 'x-']) expect(isValidGitHubOwner(bad)).toBe(false)
    expect(isValidRepoName('orbit-app-flow')).toBe(true)
    expect(isValidRepoName('notes.v2')).toBe(true)
    for (const bad of ['', '-x', '.hidden', 'a b', 'a/b', 'x.git', '--upload-pack=x']) expect(isValidRepoName(bad)).toBe(false)
    expect(isValidAzureProject('Orbit')).toBe(true)
    expect(isValidAzureProject('Orbit App')).toBe(true)
    for (const bad of ['', '-x', ' lead', 'a/b', 'a;b', '_x', 'end.']) expect(isValidAzureProject(bad)).toBe(false)
  })

  it('reads an organization name from any configured spelling', () => {
    expect(azureOrganizationName('https://dev.azure.com/acme')).toBe('acme')
    expect(azureOrganizationName('https://dev.azure.com/acme/')).toBe('acme')
    expect(azureOrganizationName('https://acme.visualstudio.com/')).toBe('acme')
    expect(azureOrganizationName('acme')).toBe('acme')
    expect(azureOrganizationName('--org=x')).toBeNull()
  })
})

describe('parsing tool output', () => {
  it('the GitHub login, from either version of the status line', () => {
    expect(parseGhLogin('github.com\n  ✓ Logged in to github.com account devuser (keyring)\n')).toBe('devuser')
    expect(parseGhLogin('✓ Logged in to github.com as devuser (oauth_token)')).toBe('devuser')
    expect(parseGhLogin('You are not logged into any GitHub hosts.')).toBeNull()
  })

  it('Azure defaults and project lists, current and old shapes', () => {
    expect(parseAzureDefaults(SIGNED_IN_AZURE[AZ_DEFAULTS].stdout)).toEqual({ organization: 'acme', project: 'Orbit' })
    expect(parseAzureDefaults('[defaults]\norganization =\n')).toEqual({ organization: null, project: null })
    expect(parseAzureProjects('{"value":[{"name":"Orbit"},{"name":"-bad"}],"continuationToken":null}')).toEqual(['Orbit'])
    expect(parseAzureProjects('[{"name":"Old"}]')).toEqual(['Old'])
    expect(parseAzureProjects('not json')).toEqual([])
  })
})

describe('detect', () => {
  it('probes both tools in parallel and answers who is signed in', async () => {
    const t = tools({
      [GH_STATUS]: { stderr: 'github.com\n  ✓ Logged in to github.com account devuser (keyring)\n' },
      ...SIGNED_IN_AZURE,
    })
    expect(await t.hostTools.detect()).toEqual({
      github: { available: true, login: 'devuser' },
      azure: { available: true, organization: 'acme' },
    })
  })

  it('a tool that is missing or signed out is simply not available', async () => {
    const t = tools({
      [GH_STATUS]: { ok: false, stderr: 'You are not logged into any GitHub hosts.' },
      [AZ_ACCOUNT]: { ok: false, missing: true },
      [AZ_EXTENSION]: { ok: false, missing: true },
      [AZ_DEFAULTS]: { ok: false, missing: true },
    })
    expect(await t.hostTools.detect()).toEqual({ github: { available: false }, azure: { available: false } })
  })

  it('the Azure CLI without its DevOps extension is not available', async () => {
    const t = tools({
      [GH_STATUS]: { ok: false },
      [AZ_ACCOUNT]: { stdout: '{}' },
      [AZ_EXTENSION]: { ok: false, stderr: "The extension azure-devops is not installed." },
      [AZ_DEFAULTS]: { ok: false },
    })
    expect((await t.hostTools.detect()).azure).toEqual({ available: false })
  })

  it('is cached for the TTL on the injected clock, then probes again', async () => {
    let now = 0
    const t = tools({ [GH_STATUS]: { stdout: 'Logged in to github.com account devuser' }, ...SIGNED_IN_AZURE }, () => now)
    await t.hostTools.detect()
    const first = t.calls.length
    // POSITIVE FIRST: the first detection really probed.
    expect(first).toBe(4)
    now = HOST_TOOLS_TTL_MS - 1
    await t.hostTools.detect()
    expect(t.calls).toHaveLength(first)
    now = HOST_TOOLS_TTL_MS
    await t.hostTools.detect()
    expect(t.calls).toHaveLength(first * 2)
    t.hostTools.forgetDetection()
    await t.hostTools.detect()
    expect(t.calls).toHaveLength(first * 3)
  })
})

describe('listCreateTargets', () => {
  it('GitHub: the person first, then their organizations; anything malformed is dropped', async () => {
    const t = tools({
      'gh api user --jq .login': { stdout: 'devuser\n' },
      'gh api user/orgs --paginate --jq .[].login': { stdout: 'acme\n-evil\ndevuser\n' },
    })
    expect(await t.hostTools.listCreateTargets('github')).toEqual({
      ok: true,
      provider: 'github',
      owners: [
        { login: 'devuser', type: 'user' },
        { login: 'acme', type: 'org' },
      ],
    })
  })

  it('GitHub signed out: a plain sentence', async () => {
    const t = tools({
      'gh api user --jq .login': { ok: false, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
      'gh api user/orgs --paginate --jq .[].login': { ok: false },
    })
    const result = await t.hostTools.listCreateTargets('github')
    expect(result).toMatchObject({ ok: false, reason: 'not-signed-in' })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.detail).not.toMatch(/gh auth|`|--/)
  })

  it("Azure: the configured organization and its projects, asked with the organization's address", async () => {
    const t = tools({
      ...SIGNED_IN_AZURE,
      [GH_STATUS]: { ok: false },
      'az devops project list --org=https://dev.azure.com/acme --output json': { stdout: '{"value":[{"name":"Orbit"},{"name":"Saturn"}]}' },
    })
    expect(await t.hostTools.listCreateTargets('azure')).toEqual({
      ok: true,
      provider: 'azure',
      organizations: [{ name: 'acme', projects: ['Orbit', 'Saturn'] }],
    })
  })

  it('Azure with no configured organization: nothing to choose from, and a sentence saying why', async () => {
    const t = tools({
      [GH_STATUS]: { ok: false },
      [AZ_ACCOUNT]: { stdout: '{}' },
      [AZ_EXTENSION]: { stdout: '{}' },
      [AZ_DEFAULTS]: { stdout: '[defaults]\n' },
    })
    const result = await t.hostTools.listCreateTargets('azure')
    expect(result).toMatchObject({ ok: true, provider: 'azure', organizations: [] })
  })
})

describe('createRepo', () => {
  it('GitHub: private, no wiki, positional after --, then the https address from the tool', async () => {
    const t = tools({
      'gh repo create --private --disable-wiki --description=Workspace knowledge kept in sync by Flow -- devuser/notes': {},
      'gh repo view --json url,sshUrl -- devuser/notes': { stdout: '{"url":"https://github.com/devuser/notes","sshUrl":"git@github.com:devuser/notes.git"}' },
    })
    expect(await t.hostTools.createRepo({ provider: 'github', owner: 'devuser', name: 'notes' })).toEqual({
      ok: true,
      url: 'https://github.com/devuser/notes',
    })
  })

  it('Azure: --flag=value only, and the remote address the tool answers', async () => {
    const t = tools({
      'az repos create --name=notes --project=Orbit App --org=https://dev.azure.com/acme --output json': {
        stdout: '{"name":"notes","remoteUrl":"https://acme@dev.azure.com/acme/Orbit%20App/_git/notes"}',
      },
    })
    expect(await t.hostTools.createRepo({ provider: 'azure', organization: 'acme', project: 'Orbit App', name: 'notes' })).toEqual({
      ok: true,
      url: 'https://acme@dev.azure.com/acme/Orbit%20App/_git/notes',
    })
  })

  it('refuses option-shaped or malformed values before spawning anything', async () => {
    const t = tools({})
    const bad = [
      { provider: 'github' as const, owner: '--help', name: 'notes' },
      { provider: 'github' as const, owner: 'devuser', name: '-x' },
      { provider: 'github' as const, owner: 'devuser', name: 'a b' },
      { provider: 'azure' as const, organization: '-acme', project: 'P', name: 'notes' },
      { provider: 'azure' as const, organization: 'acme', project: '--org=evil', name: 'notes' },
    ]
    for (const request of bad) {
      expect(await t.hostTools.createRepo(request)).toMatchObject({ ok: false, reason: 'invalid-request' })
    }
    expect(t.calls).toEqual([])
  })

  it('maps failures to plain sentences: signed out, a taken name (with a free one), no permission, missing tool', async () => {
    const create = 'gh repo create --private --disable-wiki --description=Workspace knowledge kept in sync by Flow -- devuser/notes'
    const cases: Array<[Partial<HostToolRun>, string]> = [
      [{ ok: false, stderr: 'HTTP 401: Bad credentials (https://api.github.com/user/repos)\nTry authenticating with:  gh auth login' }, 'not-signed-in'],
      [{ ok: false, stderr: 'GraphQL: Name already exists on this account (createRepository)' }, 'name-taken'],
      [{ ok: false, stderr: 'HTTP 403: Resource not accessible by integration' }, 'no-permission'],
      [{ ok: false, missing: true }, 'tool-missing'],
      [{ ok: false, timedOut: true }, 'timed-out'],
      [{ ok: false, stderr: 'something else' }, 'failed'],
    ]
    for (const [run, reason] of cases) {
      const t = tools({ [create]: run })
      const result = await t.hostTools.createRepo({ provider: 'github', owner: 'devuser', name: 'notes' })
      expect(result).toMatchObject({ ok: false, reason })
      if (result.ok) throw new Error('expected a failure')
      expect(result.detail).not.toMatch(/`|--|gh auth|HTTP/)
      if (reason === 'name-taken') expect(result.suggestion).toBe('notes-2')
    }
  })

  it('an address the tool answers in a form the grammar refuses is not used', async () => {
    const t = tools({
      'az repos create --name=notes --project=Orbit --org=https://dev.azure.com/acme --output json': {
        stdout: '{"remoteUrl":"--upload-pack=x"}',
      },
    })
    expect(await t.hostTools.createRepo({ provider: 'azure', organization: 'acme', project: 'Orbit', name: 'notes' })).toMatchObject({
      ok: false,
      reason: 'failed',
    })
  })
})
