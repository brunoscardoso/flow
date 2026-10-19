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

const summary = (remote: string | null): WorkspaceSummary => ({ name: 'Acme', slug: 'acme', path: '/f/workspaces/acme', remote, isDefault: true })

function harness(options: {
  table?: Record<string, Partial<HostToolRun>>
  remote?: string | null
  setRemote?: WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>
  unsetRemote?: WorkspaceAnswer<{ workspace: WorkspaceSummary; changed: boolean }>
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
    workspaces: [{ ...summary(options.remote ?? null), projects: [] }],
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
    },
    hostTools,
    sync: {
      syncNow: async (slug) => {
        received.push({ syncNow: slug })
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
