/**
 * CONNECTING A WORKSPACE TO A SHARED REPOSITORY — the host tools, the CLI's
 * set-remote/unset-remote (behind the registry) and the one sync after.
 *
 * The host tools are the REAL `createHostTools` over a spawner faked as a table
 * keyed by tool + argv that THROWS on anything absent (allowed-pattern #24):
 * each test asserts the exact questions asked, and nothing here can run the
 * real `gh` or `az`. The registry and the sync engine are recording fakes.
 */

import type { WorkspaceAnswer, WorkspaceSummary, WorkspaceSyncStatus, WorkspacesList } from '../../shared/workspaces-contract'
import { createHostTools, type HostTool, type HostToolRun } from './host-tools'
import { createWorkspaceRemoteSetup } from './workspace-remote'

const GH_STATUS = 'gh auth status --hostname github.com'
const AZ_ACCOUNT = 'az account show --output json'
const AZ_EXTENSION = 'az extension show --name azure-devops --output json'
const AZ_DEFAULTS = 'az devops configure --list'
const CREATE = 'gh repo create --private --disable-wiki --description=Workspace knowledge kept in sync by Flow -- acme/acme-knowledge'
const VIEW = 'gh repo view --json url,sshUrl -- acme/acme-knowledge'
const CREATED_URL = 'https://github.com/acme/acme-knowledge'

const SYNCED: WorkspaceSyncStatus = { state: 'synced', lastSyncedAt: '2026-10-06T12:00:00.000Z', detail: null, asks: [], reviews: [] }
const LOCAL: WorkspaceSyncStatus = { state: 'local-only', lastSyncedAt: null, detail: null, asks: [], reviews: [] }

const summary = (remote: string | null, branch: string | null = 'main'): WorkspaceSummary => ({
  name: 'Acme',
  slug: 'acme',
  path: '/f/workspaces/acme',
  remote,
  branch,
  branchMove: null,
  isDefault: true,
})

function harness(options: {
  table?: Record<string, Partial<HostToolRun>>
  remote?: string | null
  setRemote?: WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>
  unsetRemote?: WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>
  /** The branch the Workspace is on before the change. */
  branch?: string | null
  /** What the sync after a change answers (default: synced). */
  syncStatus?: WorkspaceSyncStatus
  setBranch?: WorkspaceAnswer<{ workspace: WorkspaceSummary; previous: string | null; changed: boolean }>
} = {}) {
  const hostCalls: string[] = []
  const received: unknown[] = []
  const table = options.table ?? {}
  const hostTools = createHostTools({
    spawn: async (tool: HostTool, args) => {
      const key = `${tool} ${args.join(' ')}`
      hostCalls.push(key)
      const entry = table[key]
      if (entry === undefined) throw new Error(`unexpected host tool call: ${key}`)
      return { ok: true, stdout: '', stderr: '', ...entry }
    },
    now: () => 0,
  })
  const list: WorkspaceAnswer<WorkspacesList> = {
    ok: true,
    flowFolder: '/f',
    workspaces: [{ ...summary(options.remote ?? null, options.branch === undefined ? 'main' : options.branch), projects: [] }],
    unreadable: [],
  }
  const setup = createWorkspaceRemoteSetup({
    registry: {
      list: async () => list,
      setRemote: async (slug, remote, setOptions) => {
        received.push({ setRemote: [slug, remote, setOptions ?? {}] })
        return options.setRemote ?? { ok: true, workspace: summary(remote), changed: true }
      },
      unsetRemote: async (slug) => {
        received.push({ unsetRemote: slug })
        return options.unsetRemote ?? { ok: true, workspace: summary(null), changed: true }
      },
      branches: async (slug, remote) => {
        received.push({ branches: [slug, remote] })
        return { ok: true, branches: [{ name: 'knowledge', pullRequestOnly: false }], defaultBranch: 'main', suggestion: { name: 'knowledge', source: 'in-use' } }
      },
      setBranch: async (slug, branch, branchOptions) => {
        received.push({ setBranch: [slug, branch, branchOptions ?? {}] })
        return options.setBranch ?? { ok: true, workspace: summary('https://h/r', branch), previous: 'main', changed: true }
      },
    },
    hostTools,
    sync: {
      syncNow: async (slug) => {
        received.push({ syncNow: slug })
        if (options.syncStatus !== undefined) return options.syncStatus
        return options.setRemote?.ok === false ? LOCAL : received.some((entry) => 'unsetRemote' in (entry as object)) ? LOCAL : SYNCED
      },
    },
  })
  return { setup, hostCalls, received }
}

describe('which hosts can create a repository from here', () => {
  it('a signed-in GitHub tool offers the account and its organizations; a missing Azure tool offers nothing', async () => {
    const { setup, hostCalls } = harness({
      table: {
        [GH_STATUS]: { stderr: 'github.com\n  ✓ Logged in to github.com account devuser (keyring)\n' },
        [AZ_ACCOUNT]: { ok: false, missing: true },
        [AZ_EXTENSION]: { ok: false, missing: true },
        [AZ_DEFAULTS]: { ok: false, missing: true },
        'gh api user --jq .login': { stdout: 'devuser\n' },
        'gh api user/orgs --paginate --jq .[].login': { stdout: 'acme\n' },
      },
    })
    expect(await setup.hostTools()).toEqual({
      github: { available: true, login: 'devuser', owners: [{ login: 'devuser', type: 'user' }, { login: 'acme', type: 'org' }] },
      azure: { available: false, organizations: [] },
    })
    expect(hostCalls.some((call) => call.includes('repo create'))).toBe(false)
  })

  it('a signed-in Azure tool offers its organization and projects', async () => {
    const { setup } = harness({
      table: {
        [GH_STATUS]: { ok: false, stderr: 'You are not logged into any GitHub hosts.' },
        [AZ_ACCOUNT]: { stdout: '{"user":{"name":"devuser@acme.com"}}' },
        [AZ_EXTENSION]: { stdout: '{"name":"azure-devops"}' },
        [AZ_DEFAULTS]: { stdout: '[defaults]\norganization = https://dev.azure.com/acme\n' },
        'az devops project list --org=https://dev.azure.com/acme --output json': { stdout: '{"value":[{"name":"Platform"}]}' },
      },
    })
    expect(await setup.hostTools()).toEqual({
      github: { available: false, owners: [] },
      azure: { available: true, organizations: [{ name: 'acme', projects: ['Platform'] }] },
    })
  })
})

describe('create one on a signed-in host', () => {
  const CREATE_TABLE = {
    [CREATE]: {},
    [VIEW]: { stdout: JSON.stringify({ url: CREATED_URL, sshUrl: 'git@github.com:acme/acme-knowledge.git' }) },
  }

  it('creates a PRIVATE repository, connects the Workspace to its https address, then syncs once', async () => {
    const { setup, hostCalls, received } = harness({ table: CREATE_TABLE })
    expect(await setup.createRemote({ slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge' })).toEqual({
      ok: true,
      remote: CREATED_URL,
      status: SYNCED,
    })
    expect(hostCalls).toEqual([CREATE, VIEW])
    expect(received).toEqual([{ setRemote: ['acme', CREATED_URL, {}] }, { syncNow: 'acme' }])
  })

  it('never creates a repository for a Workspace that already shares elsewhere, unless replacing was chosen', async () => {
    const shared = harness({ table: CREATE_TABLE, remote: 'https://gitlab.com/acme/old.git' })
    const answer = await shared.setup.createRemote({ slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge' })
    expect(answer).toMatchObject({ ok: false, reason: 'remote-exists' })
    expect(shared.hostCalls).toEqual([])
    expect(shared.received).toEqual([])

    const replacing = harness({ table: CREATE_TABLE, remote: 'https://gitlab.com/acme/old.git' })
    const replaced = await replacing.setup.createRemote({ slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge', replace: true })
    expect(replaced).toMatchObject({ ok: true, remote: CREATED_URL })
    expect(replacing.received).toEqual([{ setRemote: ['acme', CREATED_URL, { replace: true }] }, { syncNow: 'acme' }])
  })

  it('a taken name answers a free one to offer, and connects nothing', async () => {
    const { setup, received } = harness({ table: { [CREATE]: { ok: false, stderr: 'GraphQL: Name already exists on this account (createRepository)' } } })
    const answer = await setup.createRemote({ slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge' })
    expect(answer).toMatchObject({ ok: false, reason: 'name-taken', suggestion: 'acme-knowledge-2' })
    if (answer.ok) throw new Error('expected a refusal')
    expect(answer.detail).not.toMatch(/gh |GraphQL|createRepository/)
    expect(received).toEqual([])
  })

  it('an invalid owner is refused before any tool runs', async () => {
    const { setup, hostCalls } = harness()
    expect(await setup.createRemote({ slug: 'acme', provider: 'github', owner: '--help', name: 'acme-knowledge' })).toMatchObject({
      ok: false,
      reason: 'invalid-request',
    })
    expect(hostCalls).toEqual([])
  })

  it('created but not connected: the address comes back so the person can still connect to it', async () => {
    const { setup, received } = harness({
      table: CREATE_TABLE,
      setRemote: { ok: false, reason: 'sync-busy', detail: 'The Workspace is syncing right now. Try again in a moment.', payload: {} },
    })
    const answer = await setup.createRemote({ slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge' })
    expect(answer).toMatchObject({ ok: false, reason: 'sync-busy', created: CREATED_URL })
    if (answer.ok) throw new Error('expected a refusal')
    expect(answer.detail).toContain('The repository was created')
    expect(received).toEqual([{ setRemote: ['acme', CREATED_URL, {}] }])
  })
})

describe('use an existing repository, or disconnect', () => {
  it('connects by address and answers the sync that followed', async () => {
    const { setup, received, hostCalls } = harness()
    expect(await setup.setRemote({ slug: 'acme', remote: 'git@gitlab.com:acme/knowledge.git' })).toEqual({
      ok: true,
      remote: 'git@gitlab.com:acme/knowledge.git',
      status: SYNCED,
    })
    expect(received).toEqual([{ setRemote: ['acme', 'git@gitlab.com:acme/knowledge.git', {}] }, { syncNow: 'acme' }])
    expect(hostCalls).toEqual([])
  })

  it('a refusal is a plain sentence, and nothing syncs', async () => {
    const { setup, received } = harness({
      setRemote: { ok: false, reason: 'credentials-in-url', detail: 'That address has a password or token in it.', payload: {} },
    })
    expect(await setup.setRemote({ slug: 'acme', remote: 'https://x:y@github.com/a/b' })).toEqual({
      ok: false,
      reason: 'credentials-in-url',
      detail: 'That address has a password or token in it.',
    })
    expect(received).toHaveLength(1)
  })

  it('disconnecting keeps everything here, then syncs — local-only', async () => {
    const { setup, received } = harness()
    expect(await setup.unsetRemote('acme')).toEqual({ ok: true, remote: null, status: LOCAL })
    expect(received).toEqual([{ unsetRemote: 'acme' }, { syncNow: 'acme' }])
  })
})

describe('a chosen branch is checked by the sync that follows', () => {
  const PR_ONLY: WorkspaceSyncStatus = { state: 'no-access', cause: 'pull-request-required', lastSyncedAt: null, detail: 'x', asks: [], reviews: [] }
  const NO_ACCESS: WorkspaceSyncStatus = { state: 'no-access', cause: 'access', lastSyncedAt: null, detail: 'x', asks: [], reviews: [] }

  it('a usable branch connects: the branch reaches the registry, and the sync is the answer', async () => {
    const { setup, received } = harness({ branch: 'main' })
    const result = await setup.setRemote({ slug: 'acme', remote: 'https://h/r', branch: 'knowledge' })
    expect(result).toEqual({ ok: true, remote: 'https://h/r', status: SYNCED })
    expect(received).toEqual([{ setRemote: ['acme', 'https://h/r', { branch: 'knowledge' }] }, { syncNow: 'acme' }])
  })

  it('a branch that only takes pull requests is put back and refused with its cause, so the dialog asks again', async () => {
    const { setup, received } = harness({ branch: 'knowledge', syncStatus: PR_ONLY })
    const result = await setup.setRemote({ slug: 'acme', remote: 'https://h/r', branch: 'main' })
    // POSITIVE FIRST: the connect and the check really ran.
    expect(received.slice(0, 2)).toEqual([{ setRemote: ['acme', 'https://h/r', { branch: 'main' }] }, { syncNow: 'acme' }])
    expect(received[2]).toEqual({ setBranch: ['acme', 'knowledge', { restore: true }] })
    expect(result).toEqual({
      ok: false,
      reason: 'branch-unusable',
      cause: 'pull-request-required',
      restored: 'knowledge',
      detail: 'main only accepts changes through pull requests, so Flow can’t save knowledge there. The Workspace stays on knowledge. Choose another branch.',
    })
  })

  it('choosing the branch it is already on still takes the CHOICE back, so sync may move off it by itself', async () => {
    const { setup, received } = harness({ branch: 'main', syncStatus: PR_ONLY })
    const result = await setup.setRemote({ slug: 'acme', remote: 'https://h/r', branch: 'main' })
    expect(received).toContainEqual({ setBranch: ['acme', 'main', { restore: true }] })
    expect(result).toMatchObject({ ok: false, reason: 'branch-unusable', restored: null })
  })

  it('a cause no branch can fix is never blamed on the branch: the Workspace stays where it was put', async () => {
    const { setup, received } = harness({ branch: 'main', syncStatus: NO_ACCESS })
    const result = await setup.setRemote({ slug: 'acme', remote: 'https://h/r', branch: 'knowledge' })
    expect(received).toContainEqual({ syncNow: 'acme' })
    expect(received.filter((entry) => 'setBranch' in (entry as object))).toEqual([])
    expect(result).toEqual({ ok: true, remote: 'https://h/r', status: NO_ACCESS })
  })

  it('without a chosen branch, nothing is checked or put back — the sync moves it by itself as before', async () => {
    const { setup, received } = harness({ branch: 'main', syncStatus: PR_ONLY })
    const result = await setup.setRemote({ slug: 'acme', remote: 'https://h/r' })
    expect(received).toEqual([{ setRemote: ['acme', 'https://h/r', {}] }, { syncNow: 'acme' }])
    expect(result.ok).toBe(true)
  })

  it('Change branch: switches, checks, and on failure puts the old branch back', async () => {
    const ok = harness({ branch: 'main' })
    expect(await ok.setup.setBranch({ slug: 'acme', branch: 'knowledge' })).toEqual({ ok: true, remote: 'https://h/r', status: SYNCED })
    expect(ok.received).toEqual([{ setBranch: ['acme', 'knowledge', {}] }, { syncNow: 'acme' }])

    const bad = harness({ branch: 'knowledge', syncStatus: { ...PR_ONLY, cause: 'unrelated-history' } })
    const result = await bad.setup.setBranch({ slug: 'acme', branch: 'notes' })
    expect(bad.received).toEqual([
      { setBranch: ['acme', 'notes', {}] },
      { syncNow: 'acme' },
      { setBranch: ['acme', 'knowledge', { restore: true }] },
    ])
    expect(result).toMatchObject({ ok: false, reason: 'branch-unusable', cause: 'unrelated-history', restored: 'knowledge' })
  })

  it('a refused switch is reported as it is, and nothing is synced', async () => {
    const { setup, received } = harness({
      setBranch: { ok: false, reason: 'branch-diverged', detail: 'diverged', payload: {} },
    })
    expect(await setup.setBranch({ slug: 'acme', branch: 'notes' })).toEqual({ ok: false, reason: 'branch-diverged', detail: 'diverged' })
    expect(received.filter((entry) => 'syncNow' in (entry as object))).toEqual([])
  })

  it('branches are handed on as the registry read them', async () => {
    const { setup, received } = harness()
    expect(await setup.branches({ slug: 'acme', remote: 'https://h/r' })).toEqual({
      ok: true,
      branches: [{ name: 'knowledge', pullRequestOnly: false }],
      defaultBranch: 'main',
      suggestion: { name: 'knowledge', source: 'in-use' },
    })
    expect(received).toEqual([{ branches: ['acme', 'https://h/r'] }])
  })
})
