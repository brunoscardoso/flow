import { EventEmitter } from 'events'

import { runFeatureIndexing, runFeatures } from './feature-runner'
import type { BundledCli } from './derive-runner'

const cli: BundledCli = { execPath: '/bin/electron', cliPath: '/app/cli.js' } as BundledCli

function fakeSpawn(stdout: string): { spawnFn: any; args: string[][] } {
  const args: string[][] = []
  const spawnFn = (_exec: string, argv: string[]) => {
    args.push(argv)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (stdout.length > 0) child.stdout.emit('data', stdout)
      child.emit('close', 0)
    })
    return child
  }
  return { spawnFn, args }
}

const valid = JSON.stringify({
  nodes: [
    { id: 'feature:auth', slug: 'auth', name: 'Auth', kind: 'core', understanding: 'learned', active: false, anchorCount: 3 },
    { id: 'feature:tok', slug: 'tok', name: 'Tokens', kind: 'child', parent: 'feature:auth', understanding: 'none', active: true, anchorCount: 1 },
  ],
  edges: [{ from: 'feature:auth', to: 'feature:tok' }],
})

describe('runFeatures', () => {
  it('parses a valid graph and calls the right verb', async () => {
    const { spawnFn, args } = fakeSpawn(valid)
    const result = await runFeatures(cli, '/repo', { spawnFn })
    expect(result.available).toBe(true)
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[1].parent).toBe('feature:auth')
    expect(result.edges).toEqual([{ from: 'feature:auth', to: 'feature:tok' }])
    expect(args[0]).toEqual(['/app/cli.js', 'blueprint', 'features', 'graph', '--json'])
  })

  it('is unavailable on a refusal line, unparseable output, or no CLI', async () => {
    expect((await runFeatures(cli, '/r', { spawnFn: fakeSpawn('features refused: x\n').spawnFn })).reason)
      .toBe('features refused: x')
    expect((await runFeatures(cli, '/r', { spawnFn: fakeSpawn('{nope').spawnFn })).reason)
      .toBe('unparseable features output')
    expect((await runFeatures(null, '/r')).reason).toBe('bundled CLI unavailable')
  })

  it('carries `domain` through to the board — the root ring is built from it', async () => {
    // Without this pass-through the CLI's domain field dies at the IPC edge and
    // the board's whole domain layer stays inert, which is exactly what it did
    // between Phase 3 and Phase 4.
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          { id: 'feature:a', slug: 'a', name: 'A', kind: 'core', domain: 'Agent', understanding: 'none', active: false, anchorCount: 0 },
          { id: 'feature:b', slug: 'b', name: 'B', kind: 'core', domain: '   ', understanding: 'none', active: false, anchorCount: 0 },
          { id: 'feature:c', slug: 'c', name: 'C', kind: 'core', understanding: 'none', active: false, anchorCount: 0 },
        ],
        edges: [],
      }),
    )
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes[0].domain).toBe('Agent')
    // Absent stays absent — a blank is not a domain named "".
    expect(result.nodes[1].domain).toBeUndefined()
    expect(result.nodes[2].domain).toBeUndefined()
  })

  it('carries `size` through — both numbers or neither', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          { id: 'feature:a', slug: 'a', name: 'A', kind: 'core', understanding: 'none', active: false, anchorCount: 1, size: { files: 40, lines: 6000 } },
          { id: 'feature:b', slug: 'b', name: 'B', kind: 'core', understanding: 'none', active: false, anchorCount: 1, size: { files: 3 } },
          { id: 'feature:c', slug: 'c', name: 'C', kind: 'core', understanding: 'none', active: false, anchorCount: 1 },
        ],
        edges: [],
      }),
    )
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes[0].size).toEqual({ files: 40, lines: 6000 })
    expect(result.nodes[1].size).toBeUndefined()
    expect(result.nodes[2].size).toBeUndefined()
  })

  it('lets a `part` node through, with the feature it belongs to', async () => {
    // THE SEAM THAT ATE THE PARTS. This guard used to admit `core` and `child`
    // only, so every part node the CLI emitted died here — in main, before the
    // renderer could map it. A ring fix alone would have changed nothing.
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          { id: 'feature:chats', slug: 'chats', name: 'Chats', kind: 'core', understanding: 'learned', active: false, anchorCount: 9 },
          {
            id: 'feature:chats/sse-events-endpoint',
            slug: 'chats',
            name: 'SSE events endpoint',
            kind: 'part',
            parent: 'feature:chats',
            partOf: 'chats',
            understanding: 'learned',
            active: false,
            anchorCount: 2,
          },
        ],
        edges: [],
      }),
    )
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes.map((n) => n.kind)).toEqual(['core', 'part'])
    expect(result.nodes[1].partOf).toBe('chats')
    expect(result.nodes[1].parent).toBe('feature:chats')
    // Absent stays absent — the owning feature claims no `partOf` of its own.
    expect(result.nodes[0].partOf).toBeUndefined()
  })

  it('DROPS a malformed node rather than rendering a half-understood board', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          { id: 'feature:ok', slug: 'ok', name: 'OK', kind: 'core', understanding: 'stale', active: false, anchorCount: 0 },
          { id: 'feature:bad', slug: 'bad', name: 'Bad', kind: 'core', understanding: 'wat', active: false, anchorCount: 0 },
          { id: 'feature:nokind', slug: 'n', name: 'N', kind: 'sideways', understanding: 'none', active: false, anchorCount: 0 },
        ],
        edges: [{ from: 'a' }, { from: 'x', to: 'y' }],
      }),
    )
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes.map((n) => n.id)).toEqual(['feature:ok'])
    expect(result.edges).toEqual([{ from: 'x', to: 'y' }])
  })

  /**
   * Phase 8. The one rule: an UNKNOWN never becomes a zero. A CLI that sent no
   * gap report told us nothing, and a default-shaped `{features: 0, ...}` would
   * be read by the board as a clean bill of health from a check never run.
   */
  describe('limitations (Phase 8)', () => {
    it('is null when the CLI sent none — unknown, never "nothing is missing"', async () => {
      const result = await runFeatures(cli, '/r', { spawnFn: fakeSpawn(valid).spawnFn })
      expect(result.limitations).toBeNull()
    })

    it('is null on every unavailable path', async () => {
      expect((await runFeatures(null, '/r')).limitations).toBeNull()
      expect((await runFeatures(cli, '/r', { spawnFn: fakeSpawn('{nope').spawnFn })).limitations)
        .toBeNull()
    })

    it('is null when the block is present but not a measurement', async () => {
      const { spawnFn } = fakeSpawn(
        JSON.stringify({ nodes: [], edges: [], limitations: { content: {}, views: {} } }),
      )
      expect((await runFeatures(cli, '/r', { spawnFn })).limitations).toBeNull()
    })

    it("carries the validator's errors through verbatim", async () => {
      const errors = ["component 'session' quotes 'a.ts' lines 522..530, but it has 451"]
      const { spawnFn } = fakeSpawn(
        JSON.stringify({
          nodes: [],
          edges: [],
          limitations: {
            content: { features: 28, withParts: 0, withLearned: 0, unreadable: 0 },
            views: {
              total: 1,
              valid: 0,
              broken: 1,
              orphaned: 1,
              failures: [
                {
                  slug: 'feature-view',
                  path: '/p',
                  state: 'invalid',
                  orphaned: true,
                  orphanReason: 'names no feature',
                  errors,
                },
              ],
            },
          },
        }),
      )
      const result = await runFeatures(cli, '/r', { spawnFn })
      expect(result.limitations?.content.features).toBe(28)
      expect(result.limitations?.views.failures[0].errors).toEqual(errors)
      expect(result.limitations?.views.failures[0].orphanReason).toBe('names no feature')
    })

    it('drops a malformed failure entry rather than inventing fields for it', async () => {
      const { spawnFn } = fakeSpawn(
        JSON.stringify({
          nodes: [],
          edges: [],
          limitations: {
            content: { features: 2, withParts: 1, withLearned: -4, unreadable: 'x' },
            views: { total: 1, valid: 0, broken: 1, orphaned: 0, failures: [{ path: '/p' }, { slug: 'ok' }] },
          },
        }),
      )
      const result = await runFeatures(cli, '/r', { spawnFn })
      expect(result.limitations?.content).toEqual({
        features: 2,
        withParts: 1,
        withLearned: 0,
        unreadable: 0,
      })
      expect(result.limitations?.views.failures.map((f) => f.slug)).toEqual(['ok'])
      expect(result.limitations?.views.failures[0].errors).toEqual([])
    })
  })
})

describe('runFeatureIndexing (#1716)', () => {
  it('runs the index-only verb — the one that writes the corpus index without touching the store', async () => {
    const { spawnFn, args } = fakeSpawn('')
    const result = await runFeatureIndexing(cli, '/repo', { spawnFn: spawnFn as never })
    expect(result).toEqual({ ok: true, reason: null })
    expect(args[0]).toEqual(['/app/cli.js', 'blueprint', 'features', 'index'])
  })

  it('degrades without the bundled CLI instead of throwing', async () => {
    const result = await runFeatureIndexing(null, '/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('bundled CLI unavailable')
  })
})

describe('folders — where a feature lives (feature-home-folders Phase 3)', () => {
  const node = (folders: unknown) => ({
    id: 'feature:a',
    slug: 'a',
    name: 'A',
    kind: 'core',
    understanding: 'none',
    active: false,
    anchorCount: 1,
    folders,
  })

  it('carries a valid block through, row for row', async () => {
    const folders = {
      rows: [
        { path: 'src/components/automations', lines: 900, files: 60, share: 0.72, pinned: true },
        { path: '.', lines: 100, files: 2, share: 0.08 },
      ],
      folderCount: 5,
      spread: false,
      pinned: true,
      pinMissing: null,
      files: 70,
      lines: 1250,
    }
    const { spawnFn } = fakeSpawn(JSON.stringify({ nodes: [node(folders)], edges: [] }))
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes[0].folders).toEqual(folders)
  })

  it('drops malformed rows, clamps the share, caps at four', async () => {
    const rows = [
      { path: '', lines: 1, files: 1, share: 0.1 },
      { path: 'a', lines: Number.MAX_VALUE * 2, files: 1, share: 0.1 }, // Infinity after JSON → null
      { path: 'b', lines: 10, files: 1, share: 1.7 },
      { path: 'c', lines: 10, files: -1, share: 0.2 },
      { path: 'd', lines: 10, files: 1, share: -0.3 },
      { path: 'e', lines: 10, files: 1, share: 0.2, pinned: 'yes' },
      { path: 'f', lines: 10, files: 1, share: 0.2 },
      { path: 'g', lines: 10, files: 1, share: 0.2 },
      'not a row',
    ]
    const { spawnFn } = fakeSpawn(
      JSON.stringify({ nodes: [node({ rows, folderCount: 2, spread: true, pinned: true, files: 'x', lines: 50 })], edges: [] }),
    )
    const folders = (await runFeatures(cli, '/r', { spawnFn })).nodes[0].folders
    expect(folders?.rows.map((row) => row.path)).toEqual(['b', 'd', 'e', 'f'])
    expect(folders?.rows[0].share).toBe(1)
    expect(folders?.rows[1].share).toBe(0)
    expect(folders?.rows[2].pinned).toBeUndefined()
    // Never fewer folders than rows; a `pinned` the first row does not back is not believed.
    expect(folders?.folderCount).toBe(4)
    expect(folders?.pinned).toBe(false)
    expect(folders?.spread).toBe(true)
    expect(folders?.files).toBe(0)
  })

  it('leaves `folders` absent when nothing valid was sent — no rows, never a guess', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [node({ rows: [] }), node('src'), node(undefined), node({ rows: [{ path: 'x' }] })],
        edges: [],
      }),
    )
    const result = await runFeatures(cli, '/r', { spawnFn })
    expect(result.nodes.map((n) => n.folders)).toEqual([undefined, undefined, undefined, undefined])
  })

  it("carries the limitations' missing homes, and leaves them absent when the CLI could not say", async () => {
    const limitations = (missingHomes?: unknown) => ({
      content: { features: 1, withParts: 0, withLearned: 0, unreadable: 0 },
      views: { total: 0, valid: 0, broken: 0, orphaned: 0, failures: [] },
      ...(missingHomes === undefined ? {} : { missingHomes }),
    })
    const read = async (missingHomes?: unknown) =>
      (await runFeatures(cli, '/r', {
        spawnFn: fakeSpawn(JSON.stringify({ nodes: [], edges: [], limitations: limitations(missingHomes) })).spawnFn,
      })).limitations
    expect((await read())?.missingHomes).toBeUndefined()
    expect(
      (
        await read([
          { id: 'feature:a', feature: 'a', part: null, home: 'src/gone' },
          { id: 'feature:a#p', feature: 'a', part: 'Runner', home: 'src/also-gone' },
          { id: 'feature:b', feature: 'b', part: null },
        ])
      )?.missingHomes,
    ).toEqual([
      { id: 'feature:a', feature: 'a', part: null, home: 'src/gone' },
      { id: 'feature:a#p', feature: 'a', part: 'Runner', home: 'src/also-gone' },
    ])
  })
})
