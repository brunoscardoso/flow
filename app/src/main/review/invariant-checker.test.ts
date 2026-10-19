import type { BlueprintGraph } from '../../shared/ipc-contract'
import {
  MAX_MODULES_PER_PASS,
  buildInvariantPrompt,
  buildInvariantRoundsEntries,
  groupChangedFilesByModule,
  parseInvariantModelOutput,
  runInvariantCheck,
  type InvariantCheckerDeps,
  type InvariantVerdictCache,
} from './invariant-checker'

const graph = (dirs: string[]): BlueprintGraph =>
  ({
    version: 1,
    derivedAt: 't',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes: dirs.map((dir) => ({
      id: `module:${dir}`,
      kind: 'module',
      label: dir,
      sourceFile: dir,
      meta: {},
    })),
    edges: [],
  }) as unknown as BlueprintGraph

const DOC = ['# api', '', '## Invariants', '- All routes are versioned (`routes.ts`)'].join('\n')

const MODEL_REPLY = JSON.stringify([
  { invariant: 'All routes are versioned', verdict: 'violates', filePath: 'src/api/routes.ts', evidence: '+app.get("/raw")' },
])

function makeDeps(overrides: Partial<InvariantCheckerDeps> = {}): {
  deps: InvariantCheckerDeps
  runModel: jest.Mock
  store: { cache: InvariantVerdictCache }
} {
  const store = { cache: { version: 2 as const, entries: {} } }
  const runModel = jest.fn(async () => MODEL_REPLY)
  const deps: InvariantCheckerDeps = {
    readDoc: () => DOC,
    diffFor: async () => '+app.get("/raw")',
    runModel,
    loadCache: () => store.cache,
    saveCache: (cache) => {
      store.cache = cache
    },
    ...overrides,
  }
  return { deps, runModel, store }
}

describe('groupChangedFilesByModule', () => {
  it('rolls files to the deepest owning module dir; unowned files drop', () => {
    const g = graph(['src', 'src/api'])
    const grouped = groupChangedFilesByModule(g, [
      'src/api/routes.ts',
      'src/other.ts',
      'docs/readme.md',
    ])
    expect(grouped.get('src/api')).toEqual(['src/api/routes.ts'])
    expect(grouped.get('src')).toEqual(['src/other.ts'])
    expect(grouped.size).toBe(2)
  })
})

describe('parseInvariantModelOutput', () => {
  it('accepts fenced/prose-wrapped arrays and drops junk entries', () => {
    const raw = `Sure!\n\`\`\`json\n${JSON.stringify([
      { invariant: 'ok', verdict: 'touches', filePath: 'a.ts', evidence: 'e' },
      { invariant: '', verdict: 'touches', filePath: 'a.ts' },
      { invariant: 'bad verdict', verdict: 'maybe', filePath: 'a.ts' },
      { invariant: 'foreign file', verdict: 'clear', filePath: 'zz.ts' },
    ])}\n\`\`\``
    const verdicts = parseInvariantModelOutput(raw, 'm', ['a.ts'])
    expect(verdicts).toEqual([
      { module: 'm', invariant: 'ok', verdict: 'touches', filePath: 'a.ts', evidence: 'e' },
    ])
  })

  it('never throws on garbage', () => {
    expect(parseInvariantModelOutput('not json', 'm', [])).toEqual([])
    expect(parseInvariantModelOutput('[{"broken"', 'm', [])).toEqual([])
  })
})

describe('runInvariantCheck', () => {
  it('returns verdict shapes from the mocked runner + a checked report', async () => {
    const { deps, runModel } = makeDeps()
    const result = await runInvariantCheck(
      { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] },
      deps,
    )
    expect(runModel).toHaveBeenCalledTimes(1)
    expect(result.verdicts).toEqual([
      {
        module: 'src/api',
        invariant: 'All routes are versioned',
        verdict: 'violates',
        filePath: 'src/api/routes.ts',
        evidence: '+app.get("/raw")',
      },
    ])
    expect(result.modules).toEqual([{ module: 'src/api', status: 'checked', cached: false }])
    expect(buildInvariantPrompt).toBeDefined()
  })

  it('cache hit = ZERO runner calls, same verdicts (NFR2)', async () => {
    const { deps, runModel } = makeDeps()
    const input = { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] }
    const first = await runInvariantCheck(input, deps)
    const second = await runInvariantCheck(input, deps)
    expect(runModel).toHaveBeenCalledTimes(1)
    expect(second.verdicts).toEqual(first.verdicts)
    expect(second.modules[0]).toEqual({ module: 'src/api', status: 'checked', cached: true })
  })

  it('doc or diff change busts the cache', async () => {
    const { deps, runModel } = makeDeps()
    const input = { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] }
    await runInvariantCheck(input, deps)
    deps.diffFor = async () => '+something else'
    await runInvariantCheck(input, deps)
    expect(runModel).toHaveBeenCalledTimes(2)
  })

  it('cache stays O(modules): distinct-diff passes REPLACE a module entry, never accrete (#1682)', async () => {
    const { deps, store } = makeDeps()
    const input = { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] }
    for (let i = 0; i < 10; i += 1) {
      deps.diffFor = async () => `+edit-${i}`
      await runInvariantCheck(input, deps)
    }
    expect(Object.keys(store.cache.entries)).toEqual(['src/api'])
    // The surviving entry is the LIVE one: the last diff state still hits.
    const { deps: reload } = makeDeps()
    reload.diffFor = async () => '+edit-9'
    reload.loadCache = () => store.cache
    const runModel = jest.fn(async () => MODEL_REPLY)
    reload.runModel = runModel
    const result = await runInvariantCheck(input, reload)
    expect(runModel).not.toHaveBeenCalled()
    expect(result.modules[0]).toEqual({ module: 'src/api', status: 'checked', cached: true })
  })

  it('over-cap modules are reported not-checked, never silent', async () => {
    const dirs = Array.from({ length: MAX_MODULES_PER_PASS + 2 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const { deps } = makeDeps()
    const result = await runInvariantCheck(
      { graph: graph(dirs), changedFiles: dirs.map((d) => `${d}/f.ts`) },
      deps,
    )
    const notChecked = result.modules.filter((m) => m.status === 'not-checked')
    expect(notChecked).toHaveLength(2)
    expect(notChecked[0].reason).toContain('pass cap')
    expect(result.modules).toHaveLength(dirs.length)
  })

  it('oversized module diff → not-checked (too large)', async () => {
    const { deps, runModel } = makeDeps({ diffFor: async () => 'x'.repeat(33 * 1024) })
    const result = await runInvariantCheck(
      { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] },
      deps,
    )
    expect(runModel).not.toHaveBeenCalled()
    expect(result.modules[0].status).toBe('not-checked')
    expect(result.modules[0].reason).toContain('too large')
  })

  it('legacy doc without the section → no-invariants ("no invariants learned yet")', async () => {
    const { deps, runModel } = makeDeps({ readDoc: () => '# api\n\nold doc' })
    const result = await runInvariantCheck(
      { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] },
      deps,
    )
    expect(runModel).not.toHaveBeenCalled()
    expect(result.modules[0]).toEqual({
      module: 'src/api',
      status: 'no-invariants',
      reason: 'no invariants learned yet',
    })
  })

  it('"(none observed)" doc → no-invariants with its own reason', async () => {
    const { deps } = makeDeps({ readDoc: () => '## Invariants\n- (none observed)' })
    const result = await runInvariantCheck(
      { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] },
      deps,
    )
    expect(result.modules[0].reason).toBe('none observed at learn time')
  })

  it('model unavailable (null) → not-checked, never throws', async () => {
    const { deps } = makeDeps({ runModel: async () => null })
    const result = await runInvariantCheck(
      { graph: graph(['src/api']), changedFiles: ['src/api/routes.ts'] },
      deps,
    )
    expect(result.modules[0]).toEqual({
      module: 'src/api',
      status: 'not-checked',
      reason: 'model unavailable',
    })
  })
})

describe('buildInvariantRoundsEntries', () => {
  it('fingerprints <module>+<invariant>+<file>; clear verdicts are not recorded', () => {
    const now = new Date('2026-07-22T10:00:00.000Z')
    const entries = buildInvariantRoundsEntries(
      [
        { module: 'src/api', invariant: 'inv', verdict: 'violates', filePath: 'src/api/a.ts', evidence: 'e' },
        { module: 'src/api', invariant: 'inv', verdict: 'clear', filePath: 'src/api/b.ts', evidence: '' },
      ],
      now,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      ts: '2026-07-22T10:00:00.000Z',
      type: 'review_verdict',
      phase: null,
      finding_fingerprint: 'src/api+inv+src/api/a.ts',
      classification: 'kept',
      reason: 'violates: e',
    })
    expect(entries[0].anchors).toEqual([{ kind: 'file', ref: 'src/api/a.ts', file: 'src/api/a.ts' }])
  })
})
