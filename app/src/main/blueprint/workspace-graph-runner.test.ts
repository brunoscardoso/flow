import { EventEmitter } from 'events'

import { alignLocalPaths, parseWorkspaceGraphJson, runWorkspaceGraph } from './workspace-graph-runner'

const PAYLOAD = {
  action: 'workspace-graph',
  workspace: { name: 'Team', slug: 'team' },
  current: 'app',
  projects: [
    {
      id: 'github.com/acme/app',
      slug: 'app',
      name: 'app',
      description: 'The web app',
      colorIndex: 1,
      current: true,
      local: '/code/app',
      state: 'local',
      error: null,
      size: { source: 'measured', measuredAt: '2026-10-06T12:00:00.000Z' },
      graph: {
        nodes: [
          { id: 'feature:app::chats', slug: 'chats', name: 'Chats', kind: 'core', understanding: 'learned', active: false, anchorCount: 1, size: { files: 1, lines: 120 }, summary: 'x' },
          { id: 'broken', kind: 'core' },
        ],
        edges: [],
      },
      totals: { features: 1, parts: 0, changes: 0, lines: 120, files: 1, understood: { done: 1, total: 1 } },
      connections: 1,
    },
    {
      id: 'github.com/acme/core',
      slug: 'core',
      name: 'core',
      description: null,
      colorIndex: 0,
      current: false,
      local: null,
      state: 'unreadable',
      error: 'EACCES',
      size: { source: 'none', measuredAt: null },
      graph: null,
      totals: { features: 0, parts: 0, changes: 0, lines: null, files: null, understood: null },
      connections: 1,
    },
    { slug: 'no-id' },
  ],
  totals: { projects: 2 },
  links: [
    {
      ts: 't',
      author: null,
      kind: 'consumes',
      note: 'stream',
      from: { address: 'app/chats', project: 'app', ref: 'chats', type: 'feature', features: ['feature:app::chats'] },
      to: { address: 'core/endpoint:GET /x', project: 'core', ref: 'endpoint:GET /x', type: 'anchor', features: [] },
    },
    { kind: 'teleports', from: {}, to: {} },
  ],
  linksError: null,
  linksUnreadable: 0,
}

describe('parseWorkspaceGraphJson', () => {
  it("carries a project's folder rows through the same narrowing as the board's own read", () => {
    const folders = { rows: [{ path: 'src/chats', lines: 100, files: 1, share: 0.83 }], folderCount: 1, spread: false, pinned: false, pinMissing: null, files: 1, lines: 120 }
    const payload = JSON.parse(JSON.stringify(PAYLOAD))
    payload.projects[0].graph.nodes[0].folders = folders
    const graph = parseWorkspaceGraphJson(JSON.stringify(payload))
    expect(graph.projects[0].graph?.nodes[0].folders).toEqual(folders)
  })

  it('narrows the map, dropping malformed projects, nodes and links', () => {
    const graph = parseWorkspaceGraphJson(`some log line\n${JSON.stringify(PAYLOAD)}\n`)
    expect(graph.available).toBe(true)
    expect(graph.workspace).toEqual({ name: 'Team', slug: 'team' })
    expect(graph.projects.map((project) => project.slug)).toEqual(['app', 'core'])
    const [app, core] = graph.projects
    expect(app.graph?.nodes.map((node) => node.id)).toEqual(['feature:app::chats'])
    expect(app).toMatchObject({ current: true, local: '/code/app', sizeSource: 'measured', totals: { lines: 120, understood: { done: 1, total: 1 } } })
    expect(core).toMatchObject({ state: 'unreadable', error: 'EACCES', graph: null, local: null })
    expect(graph.links).toHaveLength(1)
    expect(graph.links?.[0]).toMatchObject({ kind: 'consumes', note: 'stream', to: { type: 'anchor', features: [] } })
    expect(graph.linksError).toBeNull()
  })

  it('carries how each connection is known, and how far connections learning has got', () => {
    const end = (project: string, ref: string) => ({ address: `${project}/${ref}`, project, ref, type: 'feature', features: [] })
    const graph = parseWorkspaceGraphJson(
      JSON.stringify({
        ...PAYLOAD,
        links: [
          { kind: 'calls', from: end('app', 'chats'), to: end('core', 'engine'), source: 'learned', evidence: 'model' },
          { kind: 'calls', from: end('app', 'auth'), to: end('core', 'auth'), source: 'learned', evidence: 'code' },
          { kind: 'relates', from: end('app', 'x'), to: end('core', 'y') },
          { kind: 'relates', from: end('app', 'z'), to: end('core', 'w'), source: 'learned', evidence: 'guess' },
        ],
        learning: { pairs: 3, learned: 1, pending: 2, blocked: 0, lastCheckedAt: '2026-10-06T12:00:00.000Z' },
      }),
    )
    expect(graph.links?.map((link) => link.learned ?? null)).toEqual(['model', 'code', null, null])
    expect(graph.learning).toEqual({ pairs: 3, learned: 1, pending: 2, blocked: 0, lastCheckedAt: '2026-10-06T12:00:00.000Z' })
    expect(parseWorkspaceGraphJson(JSON.stringify(PAYLOAD)).learning).toBeNull()
  })

  it('carries a links failure as a reason, with the projects intact', () => {
    const graph = parseWorkspaceGraphJson(JSON.stringify({ ...PAYLOAD, links: null, linksError: 'EISDIR: illegal operation' }))
    expect(graph.available).toBe(true)
    expect(graph.links).toBeNull()
    expect(graph.linksError).toBe('EISDIR: illegal operation')
    expect(graph.projects).toHaveLength(2)
  })

  it('a refusal is unavailable, with the CLI’s sentence', () => {
    const graph = parseWorkspaceGraphJson(
      `${JSON.stringify({ action: 'workspace-graph', refused: 'no-workspace', detail: 'this repository is in no Workspace' })}\nblueprint refused: no-workspace — …\n`,
    )
    expect(graph).toMatchObject({ available: false, reason: 'this repository is in no Workspace', projects: [] })
  })

  it('no output or garbage is unavailable, never a throw', () => {
    expect(parseWorkspaceGraphJson('').available).toBe(false)
    expect(parseWorkspaceGraphJson('not json').available).toBe(false)
  })
})

describe('runWorkspaceGraph', () => {
  function fakeSpawn(stdout: string, record: string[][] = []) {
    return ((execPath: string, args: string[]) => {
      record.push([execPath, ...args])
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.kill = () => undefined
      setImmediate(() => {
        child.stdout.emit('data', stdout)
        child.emit('close', 0)
      })
      return child
    }) as unknown as typeof import('child_process').spawn
  }

  it('asks the CLI for the root’s Workspace map, asynchronously', async () => {
    const calls: string[][] = []
    const graph = await runWorkspaceGraph({ execPath: '/electron', cliPath: '/cli.js' }, '/code/app', {
      spawnFn: fakeSpawn(JSON.stringify(PAYLOAD), calls),
    })
    expect(graph.available).toBe(true)
    expect(calls).toEqual([['/electron', '/cli.js', 'blueprint', 'workspace', 'graph', '--target', '/code/app', '--json']])
  })

  it('with no CLI it is unavailable', async () => {
    expect((await runWorkspaceGraph(null, '/code/app')).available).toBe(false)
  })
})

describe('alignLocalPaths', () => {
  it('names a checkout by the root Flow registered for it, and leaves others alone', async () => {
    const graph = parseWorkspaceGraphJson(
      JSON.stringify({
        ...PAYLOAD,
        projects: [
          { ...PAYLOAD.projects[0], local: '/private/var/code/app' },
          { ...PAYLOAD.projects[1], local: '/private/var/code/core' },
        ],
      }),
    )
    const resolve = async (path: string): Promise<string> => (path.startsWith('/var/') ? `/private${path}` : path)
    const aligned = await alignLocalPaths(graph, ['/var/code/app'], resolve)
    expect(aligned.projects.map((project) => project.local)).toEqual(['/var/code/app', '/private/var/code/core'])
  })
})
