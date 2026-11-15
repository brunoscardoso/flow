// Ask the Blueprint's registered channels (plan `ask_the_blueprint_workspace`,
// Phase 4): the gate in front of `ask:start`, the Workspace list read, and
// `ask:saveConnection` — the ONLY way a suggested connection is recorded.
// The bundled CLI is faked as a recorder, so a write is asserted by the argv
// that was RUN, and a refusal by the ABSENCE of any write (allowed-pattern #24).

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown> | unknown>()
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (event: unknown, request: unknown) => unknown) => {
      handlers.set(channel, fn)
    }),
    removeHandler: jest.fn((channel: string) => {
      handlers.delete(channel)
    }),
  },
}))

const cliCalls: Array<{ cwd: string; args: string[] }> = []
let cliReply: (args: string[]) => { ok: boolean; stdout: string } = () => ({ ok: true, stdout: '' })
const sessionStarts: unknown[] = []
jest.mock('../agent/learn-session', () => ({
  ...jest.requireActual('../agent/learn-session'),
  runBundledCliCapturing: jest.fn(async (_cli: unknown, cwd: string, args: string[]) => {
    cliCalls.push({ cwd, args: [...args] })
    return cliReply(args)
  }),
  runCagedSession: jest.fn(async (params: unknown) => {
    sessionStarts.push(params)
    return ''
  }),
}))
jest.mock('./workspace-graph-runner', () => ({
  runWorkspaceGraph: jest.fn(async () => ({
    available: true,
    reason: null,
    workspace: { name: 'Team', slug: 'team' },
    projects: [], // a Workspace whose projects are not readable at all
    links: [],
    linksError: null,
  })),
  alignLocalPaths: jest.fn(async (graph: unknown) => graph),
  recentWorkspaceGraph: jest.fn(() => null),
  rememberWorkspaceGraph: jest.fn(),
}))
jest.mock('./feature-runner', () => ({ runFeatures: jest.fn(async () => ({ nodes: [], edges: [] })) }))

import { registerAskChannels, type AskChannelDependencies } from './ask-ipc'

const ROOT = '/work/frontend'

function register(): { dispose: () => void; call: (channel: string, request: unknown) => Promise<any> } {
  const deps = {
    roots: { getRoots: () => [{ rootPath: ROOT }] },
    bundledCli: {},
    threadStore: {},
    routing: () => null,
    authEnv: async () => undefined,
    broadcast: jest.fn(),
  } as unknown as AskChannelDependencies
  const dispose = registerAskChannels(deps)
  return {
    dispose,
    call: async (channel, request) => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({}, request)
    },
  }
}

const connection = { from: 'frontend/chats', to: 'backend/chat-engine', kind: 'calls', fromProject: 'frontend', toProject: 'backend' }

beforeEach(() => {
  cliCalls.length = 0
  sessionStarts.length = 0
  handlers.clear()
  cliReply = () => ({ ok: true, stdout: '' })
})

describe('ask:saveConnection', () => {
  it('records one connection through the Workspace link writer, with the Workspace and the root it was asked from', async () => {
    cliReply = () => ({ ok: true, stdout: `${JSON.stringify({ action: 'link-knowledge', recorded: true })}\n` })
    const ask = register()
    const result = await ask.call('ask:saveConnection', { rootId: ROOT, workspace: 'team', connection: { ...connection, note: 'chat posts' } })
    expect(result).toEqual({ ok: true, recorded: true })
    expect(cliCalls).toHaveLength(1)
    expect(cliCalls[0].cwd).toBe(ROOT)
    expect(cliCalls[0].args).toEqual([
      'workspace', 'link-knowledge', '--target', ROOT, '--workspace', 'team',
      '--from=frontend/chats', '--to=backend/chat-engine', '--kind=calls', '--note=chat posts', '--json',
    ])
    ask.dispose()
  })

  it('an already-recorded link comes back as recorded: false, not as a failure', async () => {
    cliReply = () => ({ ok: true, stdout: `${JSON.stringify({ action: 'link-knowledge', recorded: false })}\n` })
    const ask = register()
    await expect(ask.call('ask:saveConnection', { rootId: ROOT, workspace: 'team', connection })).resolves.toEqual({ ok: true, recorded: false })
    ask.dispose()
  })

  it('refuses a root Flow does not have open, a bad Workspace and a one-project connection — and runs nothing', async () => {
    const ask = register()
    const transcripts = [
      await ask.call('ask:saveConnection', { rootId: '/elsewhere', workspace: 'team', connection }),
      await ask.call('ask:saveConnection', { rootId: ROOT, workspace: '../team', connection }),
      await ask.call('ask:saveConnection', { rootId: ROOT, workspace: 'team', connection: { ...connection, to: 'frontend/other', toProject: 'frontend' } }),
      await ask.call('ask:saveConnection', { rootId: ROOT, workspace: 'team', connection: { ...connection, kind: 'owns' } }),
    ]
    for (const result of transcripts) expect(result).toEqual({ ok: false, detail: expect.any(String) })
    // The sentences name the problem, never a command or a path (forbidden #12).
    for (const result of transcripts) expect(result.detail).not.toMatch(/planflow|--|\/work/)
    expect(cliCalls).toEqual([])
    ask.dispose()
  })

  it("relays the writer's refusal as a sentence without its command hint", async () => {
    cliReply = () => ({ ok: false, stdout: 'workspace refused: unknown-project — frontend is not in this Workspace; run `planflow-ai workspace add` first.\n' })
    const ask = register()
    const result = await ask.call('ask:saveConnection', { rootId: ROOT, workspace: 'team', connection })
    expect(result.ok).toBe(false)
    expect(result.detail).not.toMatch(/planflow-ai/)
    ask.dispose()
  })
})

describe('ask:start', () => {
  const request = { rootId: ROOT, question: 'How do chats reach the engine?', tags: [], conversationIds: [] }

  it('a Workspace with no readable project is refused with a sentence, and nothing runs or is saved', async () => {
    const ask = register()
    const result = await ask.call('ask:start', { ...request, workspace: { workspace: 'team', projects: [] } })
    expect(result).toEqual({ ok: false, detail: expect.not.stringMatching(/planflow|--|\//) })
    // Let the (never scheduled) background run have its chance.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sessionStarts).toEqual([])
    expect(cliCalls.filter((call) => call.args[1] === 'qa')).toEqual([])
    ask.dispose()
  })

  it('refuses a malformed Workspace slug and an unopened root before any read', async () => {
    const ask = register()
    await expect(ask.call('ask:start', { ...request, workspace: { workspace: '../x', projects: [] } })).resolves.toMatchObject({ ok: false })
    await expect(ask.call('ask:start', { ...request, rootId: '/elsewhere' })).resolves.toMatchObject({ ok: false })
    await expect(ask.call('ask:start', { ...request, question: '   ' })).resolves.toMatchObject({ ok: false })
    expect(cliCalls).toEqual([])
    ask.dispose()
  })

  it('a project ask (no workspace) starts as before: an id at once, no Workspace map read', async () => {
    const ask = register()
    const result = await ask.call('ask:start', request)
    expect(result).toMatchObject({ ok: true, askId: expect.stringMatching(/^ask-/) })
    ask.dispose()
    expect(cliCalls.some((call) => call.args[0] === 'workspace' && call.args[1] === 'status')).toBe(false)
  })
})

describe('ask:list and ask:stale in Workspace scope', () => {
  it('list reads the Workspace log with the tags, and never the per-feature project read', async () => {
    cliReply = () => ({ ok: true, stdout: `${JSON.stringify({ action: 'qa-list', threads: [] })}\n` })
    const ask = register()
    const result = await ask.call('ask:list', { rootId: ROOT, featureIds: ['feature:chats'], workspace: { workspace: 'team', tags: ['project:backend'] } })
    expect(result).toEqual({ ok: true, threads: [] })
    expect(cliCalls).toHaveLength(1)
    expect(cliCalls[0].args).toEqual(['blueprint', 'qa', 'list', '--workspace', 'team', '--target', ROOT, '--tag=project:backend', '--json'])
    ask.dispose()
  })

  it('stale carries each result\'s not-checked projects only in Workspace scope', async () => {
    cliReply = () => ({
      ok: true,
      stdout: `${JSON.stringify({ action: 'qa-stale', results: [{ id: 'wqa-1', stale: false, changedFiles: [], missingFiles: [], notChecked: ['mobile'] }] })}\n`,
    })
    const ask = register()
    const inWorkspace = await ask.call('ask:stale', { rootId: ROOT, featureId: null, workspace: { workspace: 'team', tags: [] } })
    expect(inWorkspace.results[0]).toMatchObject({ id: 'wqa-1', notChecked: ['mobile'] })
    const inProject = await ask.call('ask:stale', { rootId: ROOT, featureId: 'feature:chats' })
    expect(inProject.results[0]).not.toHaveProperty('notChecked')
    expect(cliCalls[1].args).toEqual(['blueprint', 'qa', 'stale', '--feature', 'feature:chats', '--json'])
    ask.dispose()
  })
})
