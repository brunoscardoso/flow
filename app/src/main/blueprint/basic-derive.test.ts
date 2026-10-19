// Basic blueprint derivation — the in-memory fallback graph main generates
// itself when the full CLI derive is unavailable. Pure given the injected
// fs; must always mark the result `basic: true`, emit the SAME nested
// folder-tree shape as the CLI's folder spine (module nodes + `contains`
// edges), and never invent attribution edges.

import { deriveBasicGraph, type BasicDeriveFs, type BasicDirEntry } from './basic-derive'

const ROOT = '/work/project'

function dir(name: string): BasicDirEntry {
  return { name, isDirectory: true, isFile: false }
}

function file(name: string): BasicDirEntry {
  return { name, isDirectory: false, isFile: true }
}

function fsWith(options: {
  dirs?: Record<string, BasicDirEntry[]>
  files?: Record<string, string>
}): BasicDeriveFs {
  return {
    readFile: (path) => Promise.resolve(options.files?.[path] ?? null),
    listDir: (path) => Promise.resolve(options.dirs?.[path] ?? []),
  }
}

describe('deriveBasicGraph', () => {
  it('derives the nested folder tree under src/ with path ids and contains edges', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src'), dir('node_modules'), file('package.json')],
          [`${ROOT}/src`]: [dir('cli'), dir('shared'), dir('.hidden'), file('readme.md')],
          [`${ROOT}/src/cli`]: [file('index.ts'), dir('commands')],
          [`${ROOT}/src/cli/commands`]: [file('init.ts'), file('update.ts')],
          [`${ROOT}/src/shared`]: [file('types.ts')],
          [`${ROOT}/src/.hidden`]: [file('x.ts')],
          [`${ROOT}/node_modules`]: [file('dep.js')],
        },
      }),
    )
    expect(graph?.nodes).toEqual([
      {
        id: 'module:src/cli',
        kind: 'module',
        label: 'cli',
        sourceFile: 'src/cli',
        meta: { depth: 1, childDirs: 1, fileCount: 1 },
      },
      {
        id: 'module:src/cli/commands',
        kind: 'module',
        label: 'commands',
        sourceFile: 'src/cli/commands',
        meta: { depth: 2, childDirs: 0, fileCount: 2 },
      },
      {
        id: 'module:src/shared',
        kind: 'module',
        label: 'shared',
        sourceFile: 'src/shared',
        meta: { depth: 1, childDirs: 0, fileCount: 1 },
      },
    ])
    expect(graph?.edges).toEqual([
      { source: 'module:src/cli', target: 'module:src/cli/commands', relation: 'contains' },
    ])
  })

  it('attributes loose files directly in src/ to the special src module', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src')],
          [`${ROOT}/src`]: [file('index.ts'), dir('cli')],
          [`${ROOT}/src/cli`]: [file('run.ts')],
        },
      }),
    )
    expect(graph?.nodes.map((node) => node.id)).toEqual(['module:src', 'module:src/cli'])
    const srcNode = graph?.nodes.find((node) => node.id === 'module:src')
    // The special src module covers only the loose file's count, but the
    // spine still links it to src/cli — both depth 1, CLI parity.
    expect(srcNode?.meta).toEqual({ depth: 1, childDirs: 1, fileCount: 1 })
    const cliNode = graph?.nodes.find((node) => node.id === 'module:src/cli')
    expect(cliNode?.meta).toEqual({ depth: 1, childDirs: 0, fileCount: 1 })
    expect(graph?.edges).toEqual([
      { source: 'module:src', target: 'module:src/cli', relation: 'contains' },
    ])
  })

  it('rolls directories deeper than the depth cap into their cap ancestor', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src')],
          [`${ROOT}/src`]: [dir('a')],
          [`${ROOT}/src/a`]: [dir('b')],
          [`${ROOT}/src/a/b`]: [dir('c')],
          [`${ROOT}/src/a/b/c`]: [dir('d')],
          [`${ROOT}/src/a/b/c/d`]: [dir('e'), file('deep.ts')],
          [`${ROOT}/src/a/b/c/d/e`]: [file('deeper.ts')],
        },
      }),
    )
    // Depth cap 4 (src/a, src/a/b, src/a/b/c, src/a/b/c/d): both files land
    // on src/a/b/c/d — deep.ts directly, deeper.ts rolled up.
    expect(graph?.nodes.map((node) => node.id)).toEqual([
      'module:src/a',
      'module:src/a/b',
      'module:src/a/b/c',
      'module:src/a/b/c/d',
    ])
    const capped = graph?.nodes.find((node) => node.id === 'module:src/a/b/c/d')
    expect(capped?.meta).toEqual({ depth: 4, childDirs: 0, fileCount: 2, rolledUp: true })
    expect(graph?.edges).toHaveLength(3)
  })

  it('falls back to repo-root dirs as depth 1 when there is no src/ tree', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('api'), dir('docs'), dir('node_modules'), dir('dist'), file('loose.py')],
          [`${ROOT}/api`]: [file('server.py'), dir('routes')],
          [`${ROOT}/api/routes`]: [file('users.py')],
          [`${ROOT}/docs`]: [file('readme.md')],
          [`${ROOT}/node_modules`]: [file('x.js')],
          [`${ROOT}/dist`]: [file('bundle.js')],
        },
      }),
    )
    // Loose root files have no module; docs has no source files → skipped.
    expect(graph?.nodes).toEqual([
      {
        id: 'module:api',
        kind: 'module',
        label: 'api',
        sourceFile: 'api',
        meta: { depth: 1, childDirs: 1, fileCount: 1 },
      },
      {
        id: 'module:api/routes',
        kind: 'module',
        label: 'routes',
        sourceFile: 'api/routes',
        meta: { depth: 2, childDirs: 0, fileCount: 1 },
      },
    ])
    expect(graph?.edges).toEqual([
      { source: 'module:api', target: 'module:api/routes', relation: 'contains' },
    ])
  })

  it('maps curated SDK dependencies to integrations (deps + devDeps, scoped prefixes)', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        files: {
          [`${ROOT}/package.json`]: JSON.stringify({
            dependencies: { stripe: '^1', '@anthropic-ai/claude-agent-sdk': '^0.3' },
            devDependencies: { '@aws-sdk/client-s3': '^3', lodash: '^4' },
          }),
        },
      }),
    )
    expect(graph?.nodes.filter((node) => node.kind === 'integration')).toEqual([
      { id: 'integration:stripe', kind: 'integration', label: 'stripe', sourceFile: 'package.json' },
      {
        id: 'integration:anthropic',
        kind: 'integration',
        label: 'anthropic',
        sourceFile: 'package.json',
      },
      { id: 'integration:aws', kind: 'integration', label: 'aws', sourceFile: 'package.json' },
    ])
  })

  it('maps datastore clients and config files (deduped by datastore name)', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: { [ROOT]: [file('drizzle.config.ts'), file('knexfile.js')] },
        files: {
          [`${ROOT}/package.json`]: JSON.stringify({
            dependencies: { 'better-sqlite3': '^12', 'drizzle-orm': '^0.30' },
          }),
          [`${ROOT}/prisma/schema.prisma`]: 'datasource db {}',
        },
      }),
    )
    const datastores = graph?.nodes.filter((node) => node.kind === 'datastore')
    expect(datastores?.map((node) => node.id).sort()).toEqual([
      'datastore:drizzle',
      'datastore:knex',
      'datastore:prisma',
      'datastore:sqlite',
    ])
    // The dependency hit wins the sourceFile for drizzle (first push, dedup).
    expect(datastores?.find((node) => node.id === 'datastore:drizzle')?.sourceFile).toBe(
      'package.json',
    )
  })

  it('leaves package.json-derived categories unattached (no exposes/uses edges)', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src')],
          [`${ROOT}/src`]: [dir('main')],
          [`${ROOT}/src/main`]: [file('db.ts')],
        },
        files: {
          [`${ROOT}/package.json`]: JSON.stringify({
            dependencies: { 'better-sqlite3': '^12', stripe: '^1' },
          }),
        },
      }),
    )
    expect(graph?.edges.every((edge) => edge.relation === 'contains')).toBe(true)
  })

  it('produces the basic shape: contains-only edges, no mustReview, basic coverage + flag', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src')],
          [`${ROOT}/src`]: [dir('main')],
          [`${ROOT}/src/main`]: [file('index.ts')],
        },
      }),
    )
    expect(graph?.basic).toBe(true)
    expect(graph?.edges).toEqual([])
    expect(graph?.mustReview).toBeUndefined()
    expect(graph?.coverage).toEqual({
      filesScanned: 0,
      filesTotal: 0,
      extractorsRun: ['basic'],
      graphifyEnriched: false,
    })
    expect(graph?.version).toBe(1)
    expect(Number.isNaN(Date.parse(graph?.derivedAt ?? ''))).toBe(false)
  })

  it('returns null when nothing at all is found (zero nodes — empty dir)', async () => {
    expect(await deriveBasicGraph(ROOT, fsWith({}))).toBeNull()
  })

  it('tolerates a corrupt package.json (module nodes still derived)', async () => {
    const graph = await deriveBasicGraph(
      ROOT,
      fsWith({
        dirs: {
          [ROOT]: [dir('src')],
          [`${ROOT}/src`]: [dir('app')],
          [`${ROOT}/src/app`]: [file('main.ts')],
        },
        files: { [`${ROOT}/package.json`]: 'not json' },
      }),
    )
    expect(graph?.nodes.map((node) => node.id)).toEqual(['module:src/app'])
  })
})
