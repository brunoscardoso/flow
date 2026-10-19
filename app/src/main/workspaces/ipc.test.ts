/**
 * THE WORKSPACES CHANNELS — every request is checked and rebuilt in main.
 *
 * What is proven: an untrusted sender is refused, a root the renderer may not
 * address is refused (and a thread's checkout is answered as its project), a
 * field nobody reads is never passed on, `confirmCommit` reaches the registry
 * only as an explicit `true`, and the new verbs (rename, move a project,
 * delete, "Move it in") are rebuilt field by field.
 */
const mockHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => unknown): void => {
      mockHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      mockHandlers.delete(channel)
    },
  },
}))

import { IPC_INVOKE_CHANNELS } from '../../shared/ipc-contract'
import type { WorkspacesChangedEvent } from '../../shared/workspaces-contract'
import { registerWorkspaceChannels } from './ipc'
import type { WorkspaceLinkRequest, WorkspaceRegistry } from './workspace-registry'

const ROOT = '/projects/api'
const CHECKOUT = '/projects/.api-threads/fix-login'

const NO = { ok: false as const, reason: 'unavailable' as const, detail: 'x', payload: {} }

function harness(options: { trusted?: boolean } = {}) {
  const received: unknown[] = []
  const events: WorkspacesChangedEvent[] = []
  const stored = new Map<string, string[]>()
  const registry: WorkspaceRegistry = {
    list: async () => ({ ok: true, flowFolder: '/f', workspaces: [], unreadable: [] }),
    statusFor: async (root) => {
      received.push({ statusFor: root })
      return NO
    },
    membershipOf: async (roots) => {
      received.push({ membershipOf: [...roots] })
      return {
        ok: true,
        roots: roots.map((root) => ({
          root,
          workspace: root === ROOT ? 'acme' : null,
          project: root === ROOT ? 'github.com/acme/api' : null,
          linked: false,
        })),
      }
    },
    workspaceOfRoot: async () => null,
    create: async (name, remote) => {
      received.push({ create: [name, remote] })
      return NO
    },
    link: async (request: WorkspaceLinkRequest) => {
      received.push({ link: request })
      return NO
    },
    join: async (remote, name, joinOptions) => {
      received.push({ join: [remote, name] })
      if (joinOptions !== undefined) received.push({ joinOpenRoots: joinOptions.openRoots ?? [] })
      return NO
    },
    current: async () => ({ ok: true, slug: null }),
    setCurrent: async (slug) => {
      received.push({ setCurrent: slug })
      return { ok: true, slug }
    },
    describe: async () => NO,
    migrate: async () => NO,
    rename: async (slug, name) => {
      received.push({ rename: [slug, name] })
      return NO
    },
    moveProject: async (request) => {
      received.push({ moveProject: request })
      return { ok: true, to: request.to }
    },
    deleteWorkspace: async (slug) => {
      received.push({ delete: slug })
      return { ok: true, workspace: slug, moved: [] }
    },
    setRemote: async () => NO,
    unsetRemote: async () => NO,
    suggestJoin: async (root) => {
      received.push({ suggestJoin: root })
      return { ok: true, suggestion: { kind: 'none' } }
    },
    invalidate: () => undefined,
  }
  mockHandlers.clear()
  const dispose = registerWorkspaceChannels({
    registry,
    taskProjects: {
      get: (taskId) => stored.get(taskId) ?? [],
      set: (taskId, roots) => {
        stored.set(taskId, [...roots])
        return [...roots]
      },
      chosen: (taskId) => taskId === 'task-1',
    },
    taskExists: (taskId) => taskId === 'task-1',
    resolveRoot: (path) => (path === ROOT ? ROOT : path === CHECKOUT ? ROOT : null),
    isTrustedSender: () => options.trusted ?? true,
    openRoots: () => [ROOT],
    broadcastChanged: (event) => events.push(event),
    placement: {
      state: () => ({ migrating: false, issues: [] }),
      moveIn: async (root) => {
        received.push({ moveIn: root })
        return NO
      },
      retry: async (root) => {
        received.push({ retry: root })
      },
    },
    sync: {
      status: (slug) => {
        received.push({ syncStatus: slug })
        return { state: 'idle', lastSyncedAt: null, detail: null, asks: [], reviews: [] }
      },
      syncNow: async (slug) => {
        received.push({ syncNow: slug })
        return { state: 'synced', lastSyncedAt: null, detail: null, asks: [], reviews: [] }
      },
      resolve: async (request) => {
        received.push({ resolve: request })
        return { ok: true, status: { state: 'synced', lastSyncedAt: null, detail: null, asks: [], reviews: [] } }
      },
    },
    remote: {
      hostTools: async () => {
        received.push({ hostTools: true })
        return { github: { available: false, owners: [] }, azure: { available: false, organizations: [] } }
      },
      createRemote: async (request) => {
        received.push({ createRemote: request })
        return { ok: false, reason: 'failed', detail: 'x' }
      },
      setRemote: async (request) => {
        received.push({ setRemote: request })
        return { ok: true, remote: request.remote, status: { state: 'synced', lastSyncedAt: null, detail: null, asks: [], reviews: [] } }
      },
      unsetRemote: async (slug) => {
        received.push({ unsetRemote: slug })
        return { ok: true, remote: null, status: { state: 'local-only', lastSyncedAt: null, detail: null, asks: [], reviews: [] } }
      },
    },
    connections: {
      learn: async (root) => {
        received.push({ learnConnections: root })
        return { workspace: 'team', running: false, done: 1, total: 1, found: 2, error: null }
      },
      status: async (root) => {
        received.push({ connectionsStatus: root })
        return null
      },
    },
  })
  const call = (channel: string, request: unknown): Promise<unknown> => {
    const handler = mockHandlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(handler({}, request))
  }
  return { call, received, events, stored, dispose }
}

describe('workspaces channels', () => {
  it('registers every workspaces:* invoke channel of the contract, and disposes them', () => {
    const { dispose } = harness()
    const contract = IPC_INVOKE_CHANNELS.filter((channel) => channel.startsWith('workspaces:')).sort()
    expect([...mockHandlers.keys()].sort()).toEqual(contract)
    dispose()
    expect(mockHandlers.size).toBe(0)
  })

  it('refuses a sender outside the app window', async () => {
    const { call, received } = harness({ trusted: false })
    await expect(call('workspaces:list', {})).rejects.toThrow(/not available here/)
    await expect(call('workspaces:delete', { slug: 'acme' })).rejects.toThrow(/not available here/)
    expect(received).toEqual([])
  })

  it('refuses a root the renderer may not address, and answers a checkout as its project', async () => {
    const { call, received } = harness()
    await expect(call('workspaces:status', { rootPath: '/etc' })).rejects.toThrow(/unknown rootPath/)
    await call('workspaces:suggest', { rootPath: CHECKOUT })
    expect(received).toEqual([{ suggestJoin: ROOT }])
  })

  it('link passes only the fields it reads; confirmCommit only as an explicit true', async () => {
    const { call, received } = harness()
    await call('workspaces:link', { rootPath: ROOT, workspace: 'acme', confirmCommit: false, token: 'nope', target: '/elsewhere' })
    await call('workspaces:link', { rootPath: CHECKOUT, workspace: 'acme', projectId: 'github.com/acme/api', confirmCommit: true })
    await expect(call('workspaces:link', { rootPath: ROOT, workspace: 'acme', confirmCommit: 'yes' })).rejects.toThrow(/boolean/)
    expect(received).toEqual([
      { link: { repoPath: ROOT, workspace: 'acme' } },
      { link: { repoPath: ROOT, workspace: 'acme', projectId: 'github.com/acme/api', confirmCommit: true } },
    ])
  })

  it('membership answers each root under the path that was asked', async () => {
    const { call } = harness()
    expect(await call('workspaces:membership', { roots: [ROOT, CHECKOUT, '/etc'] })).toEqual({
      ok: true,
      roots: [
        { root: ROOT, workspace: 'acme', project: 'github.com/acme/api', linked: false },
        { root: CHECKOUT, workspace: 'acme', project: 'github.com/acme/api', linked: false },
        { root: '/etc', workspace: null, project: null, linked: false },
      ],
    })
  })

  it('validates create, join and setCurrent field by field', async () => {
    const { call, received } = harness()
    await call('workspaces:create', { name: 'Acme', extra: 1 })
    await call('workspaces:join', { remote: 'https://github.com/acme/k', name: 'Team' })
    await expect(call('workspaces:create', { name: 42 })).rejects.toThrow(/name/)
    await call('workspaces:setCurrent', { slug: null })
    await expect(call('workspaces:setCurrent', {})).rejects.toThrow(/slug/)
    // A join also hands over the projects open in the app (main's list, never the renderer's).
    expect(received).toEqual([
      { create: ['Acme', undefined] },
      { join: ['https://github.com/acme/k', 'Team'] },
      { joinOpenRoots: [ROOT] },
      { setCurrent: null },
    ])
  })

  it("a card's projects: stored as project roots, announced once, refused for an unknown task", async () => {
    const { call, stored, events } = harness()
    expect(await call('workspaces:setTaskProjects', { taskId: 'task-1', roots: [CHECKOUT] })).toEqual({ ok: true, roots: [ROOT] })
    expect(stored.get('task-1')).toEqual([ROOT])
    expect(await call('workspaces:taskProjects', { taskId: 'task-1' })).toEqual({ ok: true, roots: [ROOT] })
    await expect(call('workspaces:setTaskProjects', { taskId: 'task-2', roots: [] })).rejects.toThrow(/unknown task/)
    await expect(call('workspaces:setTaskProjects', { taskId: 'task-1', roots: ['/etc'] })).rejects.toThrow(/unknown roots/)
    expect(events).toEqual([{ cause: 'task-projects' }])
  })

  it("the board reads every card's projects in ONE call", async () => {
    const { call } = harness()
    await call('workspaces:setTaskProjects', { taskId: 'task-1', roots: [CHECKOUT] })
    expect(await call('workspaces:taskProjectsMany', { taskIds: ['task-1', 'task-9'] })).toEqual({
      ok: true,
      projects: { 'task-1': [ROOT], 'task-9': [] },
      // Which of them a person picked the projects of — only those.
      chosen: ['task-1'],
    })
    await expect(call('workspaces:taskProjectsMany', { taskIds: 'task-1' })).rejects.toThrow(/taskIds/)
  })

  it('rename, move a project and delete pass only the fields they read; a delete re-points the selection', async () => {
    const { call, received, events } = harness()
    await call('workspaces:rename', { slug: 'acme', name: 'Acme Corp', path: '/etc' })
    await call('workspaces:moveProject', { project: 'github.com/acme/api', to: 'beta', from: 'acme', confirm: true })
    await call('workspaces:moveProject', { project: 'github.com/acme/api', to: 'beta' })
    await call('workspaces:delete', { slug: 'beta', projects: ['x'] })
    await expect(call('workspaces:rename', { slug: 'acme' })).rejects.toThrow(/name/)
    await expect(call('workspaces:moveProject', { project: 'p', to: 7 })).rejects.toThrow(/to/)
    await expect(call('workspaces:delete', {})).rejects.toThrow(/slug/)
    expect(received).toEqual([
      { rename: ['acme', 'Acme Corp'] },
      { moveProject: { project: 'github.com/acme/api', to: 'beta', from: 'acme' } },
      { moveProject: { project: 'github.com/acme/api', to: 'beta' } },
      { delete: 'beta' },
    ])
    expect(events).toEqual([{ cause: 'current' }])
  })

  it('"Move it in" and a retry take an addressable root only, answered as its project', async () => {
    const { call, received } = harness()
    expect(await call('workspaces:placement', {})).toEqual({ migrating: false, issues: [] })
    await call('workspaces:moveIn', { rootPath: CHECKOUT })
    await call('workspaces:retryPlacement', { rootPath: ROOT })
    await expect(call('workspaces:moveIn', { rootPath: '/etc' })).rejects.toThrow(/unknown rootPath/)
    expect(received).toEqual([{ moveIn: ROOT }, { retry: ROOT }])
  })

  it('the sync channels take a slug, rebuild a decision field by field, and never pass on a file take', async () => {
    const h = harness()
    await h.call('workspaces:syncStatus', { slug: 'acme', extra: 1 })
    await h.call('workspaces:syncNow', { slug: 'acme' })
    await h.call('workspaces:resolve', { slug: 'acme', path: 'projects/api/brain/decisions/q.md', take: 'ours', text: 'ignored', file: '/etc/passwd' })
    await h.call('workspaces:resolve', { slug: 'acme', path: 'projects/api/notes.md', take: 'text', text: 'merged\n' })
    await h.call('workspaces:resolve', { slug: 'acme', id: 'ask-1', path: 'projects/api/brain/decisions/q.md', take: 'theirs' })
    expect(h.received).toEqual([
      { syncStatus: 'acme' },
      { syncNow: 'acme' },
      { resolve: { slug: 'acme', path: 'projects/api/brain/decisions/q.md', take: 'ours' } },
      { resolve: { slug: 'acme', path: 'projects/api/notes.md', take: 'text', text: 'merged\n' } },
      // The item's id is carried through, so the CLI decides exactly that item.
      { resolve: { slug: 'acme', id: 'ask-1', path: 'projects/api/brain/decisions/q.md', take: 'theirs' } },
    ])
    await expect(h.call('workspaces:resolve', { slug: 'acme', path: 'a.md', take: 'file:/etc/passwd' })).rejects.toThrow(/take must be/)
    await expect(h.call('workspaces:resolve', { slug: 'acme', path: 'a.md', take: 'text' })).rejects.toThrow(/text must be/)
    await expect(h.call('workspaces:syncNow', { slug: 7 })).rejects.toThrow(/slug/)
    await expect(harness({ trusted: false }).call('workspaces:syncNow', { slug: 'acme' })).rejects.toThrow(/not available here/)
  })

  it('the shared-repository channels rebuild every request field by field; replace only as an explicit true', async () => {
    const h = harness()
    await h.call('workspaces:hostTools', { token: 'nope' })
    await h.call('workspaces:setRemote', { slug: 'acme', remote: 'https://gitlab.com/acme/k.git', replace: false, password: 'x' })
    await h.call('workspaces:setRemote', { slug: 'acme', remote: 'https://gitlab.com/acme/k.git', replace: true })
    await h.call('workspaces:createRemote', { slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge', organization: 'ignored', public: true })
    await h.call('workspaces:createRemote', { slug: 'acme', provider: 'azure', organization: 'acme', project: 'Platform', name: 'acme-knowledge', owner: 'ignored', replace: true })
    await h.call('workspaces:unsetRemote', { slug: 'acme', remote: 'x' })
    expect(h.received).toEqual([
      { hostTools: true },
      { setRemote: { slug: 'acme', remote: 'https://gitlab.com/acme/k.git' } },
      { setRemote: { slug: 'acme', remote: 'https://gitlab.com/acme/k.git', replace: true } },
      { createRemote: { slug: 'acme', provider: 'github', owner: 'acme', name: 'acme-knowledge' } },
      { createRemote: { slug: 'acme', provider: 'azure', organization: 'acme', project: 'Platform', name: 'acme-knowledge', replace: true } },
      { unsetRemote: 'acme' },
    ])
    await expect(h.call('workspaces:createRemote', { slug: 'acme', provider: 'gitlab', name: 'x' })).rejects.toThrow(/provider/)
    await expect(h.call('workspaces:createRemote', { slug: 'acme', provider: 'azure', organization: 'acme', name: 'x' })).rejects.toThrow(/project/)
    await expect(h.call('workspaces:setRemote', { slug: 'acme', remote: 7 })).rejects.toThrow(/remote/)
    await expect(h.call('workspaces:setRemote', { slug: 'acme', remote: 'https://x/y', replace: 'yes' })).rejects.toThrow(/boolean/)
    await expect(h.call('workspaces:unsetRemote', {})).rejects.toThrow(/slug/)
    await expect(harness({ trusted: false }).call('workspaces:unsetRemote', { slug: 'acme' })).rejects.toThrow(/not available here/)
  })

  it('connections learning takes an addressable root only, answered as its project', async () => {
    const h = harness()
    await expect(h.call('workspaces:learnConnections', { rootId: CHECKOUT })).resolves.toMatchObject({ found: 2 })
    await expect(h.call('workspaces:connectionsLearningStatus', { rootId: ROOT })).resolves.toBeNull()
    expect(h.received).toEqual([{ learnConnections: ROOT }, { connectionsStatus: ROOT }])
    await expect(h.call('workspaces:learnConnections', { rootId: '/elsewhere' })).rejects.toThrow(/unknown rootId/)
    await expect(h.call('workspaces:learnConnections', {})).rejects.toThrow(/rootId/)
  })
})
