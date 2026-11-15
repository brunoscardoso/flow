// Ask the Blueprint at Workspace level, in main (plan `ask_the_blueprint_workspace`,
// Phase 2): the gate's project→root map, per-project context, the run's
// sessions, sources, facts and save, and suggested connections. Every
// dependency is faked; writes are asserted by the CLI argv that was RUN.

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), removeHandler: jest.fn() } }))

import type { AskStateEvent } from '../../shared/ask-contract'
import type { BlueprintFeatureNode, BlueprintWorkspaceGraph, BlueprintWorkspaceProject } from '../../shared/ipc-contract'
import type { CagedSessionParams, CliRunResult } from '../agent/learn-session'
import { gatherAskContext, type AskContextDeps, type AskResolvedScope, type AskScopeProject } from './ask-context'
import { resolveAskScope, type AskScopeReads } from './ask-ipc'
import {
  ASK_WORKSPACE_DIG_MAX_READS,
  resolveSources,
  runAsk,
  sessionRootsOf,
  suggestConnections,
  type AskDeps,
  type AskRunInput,
} from './ask-orchestrator'

const node = (patch: Partial<BlueprintFeatureNode>): BlueprintFeatureNode =>
  ({ name: patch.id, slug: 'x', summary: '', kind: 'core', ...patch }) as BlueprintFeatureNode

const BACKEND = '/work/backend'
const FRONTEND = '/work/frontend'

function project(slug: string, rootPath: string | null, ids: string[]): AskScopeProject {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    rootPath,
    flowDir: rootPath !== null ? `${rootPath}/flow` : `/ws/projects/${slug}`,
    graph: { nodes: ids.map((id) => node({ id })), edges: [] },
  }
}

function scope(patch: Partial<AskResolvedScope> = {}): AskResolvedScope {
  return {
    workspace: { slug: 'team', name: 'Team' },
    projects: [
      project('backend', BACKEND, ['feature:chat-engine']),
      project('frontend', FRONTEND, ['feature:chats']),
      project('mobile', null, ['feature:login']),
    ],
    workspaceProjects: ['backend', 'frontend', 'mobile'],
    links: [{ kind: 'calls', from: 'frontend/chats', to: 'backend/chat-engine', fromProject: 'frontend', toProject: 'backend' }],
    ...patch,
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('resolveAskScope', () => {
  function wsProject(slug: string, local: string | null, patch: Partial<BlueprintWorkspaceProject> = {}): BlueprintWorkspaceProject {
    return {
      id: slug,
      slug,
      name: slug,
      description: null,
      colorIndex: 0,
      current: false,
      local,
      state: local !== null ? 'local' : 'remote',
      error: null,
      sizeSource: 'none',
      graph: { nodes: [node({ id: `feature:${slug}-x` })], edges: [] },
      totals: { features: 1, lines: null, understood: null },
      connections: 0,
      ...patch,
    }
  }
  const graph = (projects: BlueprintWorkspaceProject[]): BlueprintWorkspaceGraph => ({
    available: true,
    reason: null,
    workspace: { name: 'Team', slug: 'team' },
    projects,
    links: [],
    linksError: null,
  })
  const reads = (g: BlueprintWorkspaceGraph, roots: string[]): AskScopeReads => ({
    workspaceGraph: async () => g,
    knowledgeFolders: async () => new Map([['mobile', '/ws/projects/mobile']]),
    knownRoots: () => roots,
  })

  it('maps in-scope projects to roots open in Flow; a checkout Flow does not know is knowledge only', async () => {
    const g = graph([wsProject('backend', BACKEND), wsProject('frontend', FRONTEND), wsProject('mobile', null)])
    const result = await resolveAskScope(BACKEND, { workspace: 'team', projects: ['backend'] }, ['feature:frontend::x'], reads(g, [BACKEND]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scope.projects.map((p) => [p.slug, p.rootPath, p.flowDir])).toEqual([
      ['backend', BACKEND, `${BACKEND}/flow`],
      ['frontend', null, null], // on this computer, but not open in Flow
    ])
    expect(result.scope.workspaceProjects).toEqual(['backend', 'frontend', 'mobile'])
  })

  it('no project named = every project; a remote one reads its shared knowledge folder', async () => {
    const g = graph([wsProject('backend', BACKEND), wsProject('mobile', null)])
    const result = await resolveAskScope(BACKEND, { workspace: 'team', projects: [] }, [], reads(g, [BACKEND]))
    expect(result.ok && result.scope.projects.map((p) => [p.slug, p.flowDir])).toEqual([
      ['backend', `${BACKEND}/flow`],
      ['mobile', '/ws/projects/mobile'],
    ])
  })

  it('refuses another Workspace and a scope with nothing readable, with a sentence', async () => {
    const g = graph([wsProject('mobile', null, { graph: null, state: 'unreadable' })])
    await expect(resolveAskScope(BACKEND, { workspace: 'other', projects: [] }, [], reads(g, [BACKEND]))).resolves.toEqual({
      ok: false,
      detail: expect.stringMatching(/Workspace/),
    })
    const none = await resolveAskScope(BACKEND, { workspace: 'team', projects: [] }, [], reads(g, [BACKEND]))
    expect(none).toEqual({ ok: false, detail: expect.not.stringMatching(/planflow|--|\//) })
  })
})

// ── Context ─────────────────────────────────────────────────────────────────

describe('gatherAskContext in Workspace scope', () => {
  it('qualifies every id with its project, reads notes per project, and keeps links between in-scope projects', async () => {
    const notesRead: string[] = []
    const deps: AskContextDeps = {
      searchKnowledge: async () => [
        { file: 'backend/brain/features/chat-engine.md', title: 'Engine', snippet: '', project: 'backend' },
        { file: 'other/x.md', title: 'Elsewhere', snippet: '', project: 'other' },
      ],
      readFeatureGraph: async () => {
        throw new Error('the Workspace scope reads graphs from the Workspace map')
      },
      readNotes: async (flowDir) => {
        notesRead.push(flowDir)
        return [{ ts: '1', text: `note in ${flowDir}`, anchors: [] }]
      },
      threadStore: { getThread: () => null, listMessages: () => [], listToolCallPaths: () => [] },
      git: async () => ({ ok: false, stdout: '' }),
    }
    const s = scope({ projects: scope().projects.slice(0, 2) })
    const context = await gatherAskContext(
      { rootPath: BACKEND, question: 'q', tags: ['feature:frontend::chats'], conversationIds: [], workspace: s },
      deps,
    )
    expect(context.knownIds.sort()).toEqual(['feature:backend::chat-engine', 'feature:frontend::chats'])
    expect(context.features.find((f) => f.id === 'feature:frontend::chats')).toMatchObject({ tagged: true, project: 'frontend' })
    expect(notesRead.sort()).toEqual([`${BACKEND}/flow`, `${FRONTEND}/flow`])
    expect(context.notes.map((n) => n.project).sort()).toEqual(['backend', 'frontend'])
    expect(context.hits.map((h) => h.project)).toEqual(['backend'])
    expect(context.workspace?.links).toHaveLength(1)
    expect(context.workspace?.projects.map((p) => [p.slug, p.local])).toEqual([
      ['backend', true],
      ['frontend', true],
    ])
  })
})

// ── Sources ─────────────────────────────────────────────────────────────────

describe('resolveSources in Workspace scope', () => {
  const exists = new Set([`${BACKEND}|src/engine.ts`, `${FRONTEND}|src/chats.tsx`])
  const fileExists = async (root: string, rel: string): Promise<boolean> => exists.has(`${root}|${rel}`)
  const roots = { projects: scope().projects, cwdProject: 'backend' }
  const known = ['feature:backend::chat-engine', 'feature:frontend::chats', 'feature:mobile::login']

  it('resolves files by containing checkout or project prefix, features by project, and never a remote file', async () => {
    const sources = await resolveSources(
      roots,
      [
        { label: 'abs', file: `${FRONTEND}/src/chats.tsx` },
        { label: 'prefixed', file: 'frontend/src/chats.tsx', featureId: 'feature:chats' },
        { label: 'bare', file: 'src/engine.ts' },
        { label: 'missing', project: 'backend', file: 'src/nope.ts' },
        { label: 'remote', project: 'mobile', file: 'src/login.tsx', featureId: 'login' },
        { label: 'outside', file: '/etc/passwd' },
      ],
      known,
      fileExists,
    )
    expect(sources).toEqual([
      { n: null, label: 'abs', file: 'src/chats.tsx', project: 'frontend' },
      { n: 1, label: 'prefixed', featureId: 'feature:frontend::chats', file: 'src/chats.tsx', project: 'frontend' },
      { n: null, label: 'bare', file: 'src/engine.ts', project: 'backend' },
      { n: null, label: 'missing', project: 'backend' },
      { n: 2, label: 'remote', featureId: 'feature:mobile::login', project: 'mobile' },
      { n: null, label: 'outside' },
    ])
  })
})

// ── Suggested connections ───────────────────────────────────────────────────

describe('suggestConnections', () => {
  it('keeps touchpoints between two in-scope projects that are not recorded, normalised to the writer spelling', () => {
    const out = suggestConnections(
      [
        { from: 'frontend/chats', to: 'backend/chat-engine', kind: 'calls' }, // recorded
        { from: 'backend/chat-engine', to: 'frontend/chats', kind: 'relates' }, // recorded, other way
        { from: 'mobile/feature:mobile::login', to: 'backend/endpoint:POST /auth', kind: 'Calls', note: ' signs  in ' },
        { from: 'backend/x', to: 'backend/y', kind: 'calls' }, // same project
        { from: 'nowhere/x', to: 'backend/y', kind: 'calls' }, // not in scope
        { from: 'mobile/login', to: 'backend/y', kind: 'owns' }, // not a kind
      ],
      scope(),
    )
    expect(out).toEqual([
      {
        id: 'mobile/login|calls|backend/endpoint:POST /auth',
        kind: 'calls',
        fromProject: 'mobile',
        from: 'mobile/login',
        toProject: 'backend',
        to: 'backend/endpoint:POST /auth',
        note: 'signs in',
      },
    ])
  })
})

// ── The run ─────────────────────────────────────────────────────────────────

describe('runAsk in Workspace scope', () => {
  function harness(sessionReplies: Array<(params: CagedSessionParams) => Promise<string>>) {
    const sessions: CagedSessionParams[] = []
    const cli: Array<{ cwd: string; args: string[] }> = []
    const inputs: Array<Record<string, unknown>> = []
    const emitted: AskStateEvent[] = []
    const deps: AskDeps = {
      runSession: (params) => {
        sessions.push(params)
        const next = sessionReplies.shift()
        if (next === undefined) throw new Error('an unexpected session was started')
        return next(params)
      },
      runCli: async (cwd, args): Promise<CliRunResult> => {
        cli.push({ cwd, args: [...args] })
        if (args[1] === 'qa') return { ok: true, stdout: `${JSON.stringify({ action: 'qa-record', scope: 'workspace', entry: { id: 'wqa-1' } })}\n` }
        return { ok: true, stdout: '' }
      },
      git: async () => ({ ok: true, stdout: 'main\n' }),
      now: () => 0,
      gatherContext: async (input) =>
        gatherAskContext(input, {
          searchKnowledge: async () => [],
          readFeatureGraph: async () => ({ nodes: [], edges: [] }),
          readNotes: async () => [],
          threadStore: { getThread: () => null, listMessages: () => [], listToolCallPaths: () => [] },
          git: async () => ({ ok: false, stdout: '' }),
        }),
      routing: () => null,
      authEnv: async () => undefined,
      author: async () => 'Ana',
      fileExists: async (root, rel) => (root === BACKEND && rel === 'src/engine.ts') || (root === FRONTEND && rel === 'src/chats.tsx'),
      writeInputFile: async (json) => {
        inputs.push(JSON.parse(json) as Record<string, unknown>)
        return { path: '/tmp/in.json', cleanup: async () => undefined }
      },
      emit: (event) => emitted.push(event),
    }
    return { deps, sessions, cli, inputs, emitted }
  }

  const request = (s: AskResolvedScope): AskRunInput => ({
    askId: 'ask-1',
    rootId: FRONTEND,
    question: 'How do chats reach the engine?',
    tags: ['feature:frontend::chats', 'project:mobile', 'feature:chats'],
    conversationIds: [],
    stopSignal: new AbortController().signal,
    workspace: { workspace: 'team', projects: s.projects.map((p) => p.slug) },
    scope: s,
  })

  it('digs across local checkouts in one contained session, writes facts into their own project and saves through the Workspace verb', async () => {
    const h = harness([
      async () => JSON.stringify({ explanation: 'Probably HTTP.', knowledge: 'thin', sources: [] }),
      async (params) => {
        params.onRead?.(`${BACKEND}/src/engine.ts`)
        params.onRead?.(`${FRONTEND}/src/chats.tsx`)
        return JSON.stringify({
          explanation: 'Chats posts to the engine.',
          sources: [
            { label: 'Engine', project: 'backend', file: 'src/engine.ts', featureId: 'feature:backend::chat-engine' },
            { label: 'Login', project: 'mobile', featureId: 'feature:mobile::login', file: 'src/login.tsx' },
          ],
          facts: [
            { text: 'The engine listens on /chat.', project: 'backend', file: 'src/engine.ts' },
            { text: 'Chats posts messages.', file: 'frontend/src/chats.tsx' },
          ],
          connections: [{ from: 'mobile/login', to: 'backend/chat-engine', kind: 'calls' }],
        })
      },
    ])
    const s = scope()
    const result = await runAsk(request(s), h.deps)

    expect(result.outcome).toBe('done')
    // One session cwd at the board's own project; the other local checkout is an extra, contained root.
    expect(h.sessions[1].cwd).toBe(FRONTEND)
    expect(h.sessions[1].readRoots).toEqual([BACKEND])
    expect(h.sessions[0].readRoots).toEqual([BACKEND])
    expect(h.sessions[1].prompt).toContain(`${ASK_WORKSPACE_DIG_MAX_READS} file reads`)
    expect(h.sessions[1].prompt).toContain('mobile')

    expect(result.answer).toMatchObject({
      confidence: 'checked',
      projectsRead: ['backend', 'frontend'],
      knowledgeOnly: ['mobile'],
      factsLearned: 2,
      savedId: 'wqa-1',
      sources: [
        { n: 1, label: 'Engine', project: 'backend', file: 'src/engine.ts', featureId: 'feature:backend::chat-engine' },
        { n: 2, label: 'Login', project: 'mobile', featureId: 'feature:mobile::login' },
      ],
      suggestedConnections: [{ from: 'mobile/login', to: 'backend/chat-engine', kind: 'calls' }],
    })
    expect(result.answer?.sources[1]).not.toHaveProperty('file')

    const observes = h.cli.filter((call) => call.args[1] === 'observe')
    expect(observes.map((call) => [call.cwd, call.args[call.args.indexOf('--anchor') + 1]]).sort()).toEqual([
      [BACKEND, 'file:src/engine.ts'],
      [FRONTEND, 'file:src/chats.tsx'],
    ])
    const saves = h.cli.filter((call) => call.args[1] === 'qa')
    expect(saves).toHaveLength(1)
    expect(saves[0].args).toEqual(['blueprint', 'qa', 'record', '--workspace', 'team', '--target', FRONTEND, '--input', '/tmp/in.json', '--json'])
    expect(h.inputs[0]).toMatchObject({
      tags: ['feature:frontend::chats', 'project:mobile'], // the bare tag cannot be saved at Workspace level
      projectsRead: ['backend', 'frontend'],
      knowledgeOnly: ['mobile'],
    })
    // Nothing records a connection on its own.
    expect(h.cli.some((call) => call.args.includes('link-knowledge'))).toBe(false)
    expect(h.emitted.every((event) => event.workspace === 'team')).toBe(true)
  })

  it('with no in-scope project on this computer it answers from knowledge and never digs', async () => {
    const h = harness([async () => JSON.stringify({ explanation: 'From notes.', knowledge: 'thin', sources: [] })])
    const s = scope({ projects: [project('mobile', null, ['feature:login'])] })
    const result = await runAsk({ ...request(s), rootId: BACKEND }, h.deps)
    expect(h.sessions).toHaveLength(1)
    expect(h.sessions[0].readRoots).toEqual([])
    expect(result.answer).toMatchObject({ knowledgeOnly: ['mobile'], projectsRead: [], couldNotFind: expect.stringMatching(/computer/) })
    expect(sessionRootsOf(s, BACKEND)).toEqual({ cwd: BACKEND, cwdProject: null, readRoots: [], folders: [] })
  })

  it('a partial Workspace answer names the projects whose code was not read', async () => {
    const h = harness([
      async () => JSON.stringify({ explanation: 'Probably.', knowledge: 'thin', sources: [] }),
      (params) =>
        new Promise((resolve) => {
          params.abortSignal?.addEventListener('abort', () => resolve(''), { once: true })
          params.onRead?.(`${BACKEND}/src/engine.ts`)
        }),
    ])
    h.deps.limits = { digMaxReads: 1 }
    const result = await runAsk(request(scope()), h.deps)
    expect(result.outcome).toBe('partial')
    expect(result.answer?.projectsRead).toEqual(['backend'])
    expect(result.answer?.couldNotFind).toMatch(/Code not read in Frontend and Mobile\./)
  })
})
