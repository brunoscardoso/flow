import { EventEmitter } from 'events'

import { runBrief } from './brief-runner'
import type { BundledCli } from './derive-runner'

const cli: BundledCli = { execPath: '/bin/electron', cliPath: '/app/cli.js' } as BundledCli

/** A fake child process that emits `stdout` then closes. */
function fakeSpawn(stdout: string): { spawnFn: any; args: string[][] } {
  const args: string[][] = []
  const spawnFn = (_exec: string, argv: string[]) => {
    args.push(argv)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      kill: () => void
    }
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

const validDelta = JSON.stringify({
  nodes: [
    { nodeId: 'module:src/a', kind: 'stable', existsToday: true, label: 'a' },
    { nodeId: 'module:src/new', kind: 'new', existsToday: false, label: 'new' },
  ],
  wires: [
    { from: 'module:src/a', to: 'module:src/new', delta: 'added', labelBefore: '', labelAfter: 'writes', drawnToday: false },
  ],
  fails: ['persist throws'],
  unchanged: 'The UI is identical.',
  anchors: [{ ref: 'module:src/a', resolved: true }],
  steps: [{ title: 'Problem', kicker: 'Problem', body: 'It duplicates.', decisions: [], rejected: [] }],
})

describe('runBrief', () => {
  it('parses a valid delta and passes --plan/--json to the CLI', async () => {
    const { spawnFn, args } = fakeSpawn(validDelta)
    const result = await runBrief(cli, '/repo', 'my-plan', { spawnFn })
    expect(result.available).toBe(true)
    expect(result.nodes).toHaveLength(2)
    expect(result.wires[0].drawnToday).toBe(false)
    expect(result.unchanged).toBe('The UI is identical.')
    expect(result.fails).toEqual(['persist throws'])
    expect(result.anchors).toEqual([{ ref: 'module:src/a', resolved: true }])
    expect(result.steps[0].kicker).toBe('Problem')
    expect(args[0]).toEqual(['/app/cli.js', 'blueprint', 'brief', '--plan', 'my-plan', '--json'])
  })

  it('names the document VERSION with --path when the door named one', async () => {
    const { spawnFn, args } = fakeSpawn(validDelta)
    await runBrief(cli, '/repo', 'my-plan', { spawnFn, doc: 'flow/discovery/discovery_my-plan_v1.md' })
    expect(args[0]).toEqual([
      '/app/cli.js', 'blueprint', 'brief', '--plan', 'my-plan',
      '--path', 'flow/discovery/discovery_my-plan_v1.md', '--json',
    ])
  })

  it('carries the docPath the CLI described, and omits it when an older CLI sent none', async () => {
    const pinned = fakeSpawn(JSON.stringify({ ...JSON.parse(validDelta), docPath: 'flow/discovery/discovery_my-plan_v1.md' }))
    const result = await runBrief(cli, '/repo', 'my-plan', { spawnFn: pinned.spawnFn, doc: 'flow/discovery/discovery_my-plan_v1.md' })
    expect(result.docPath).toBe('flow/discovery/discovery_my-plan_v1.md')
    const older = fakeSpawn(validDelta)
    expect('docPath' in (await runBrief(cli, '/repo', 'my-plan', { spawnFn: older.spawnFn }))).toBe(false)
  })

  it('is unavailable when the CLI refuses (a plain line, not JSON)', async () => {
    const { spawnFn } = fakeSpawn("brief refused: no compiled story for 'x'\n")
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.available).toBe(false)
    expect(result.reason).toBe("brief refused: no compiled story for 'x'")
    expect(result.nodes).toEqual([])
  })

  it('is unavailable on unparseable output rather than throwing', async () => {
    const { spawnFn } = fakeSpawn('{not json')
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.available).toBe(false)
    expect(result.reason).toBe('unparseable brief output')
  })

  it('is unavailable with no bundled CLI', async () => {
    const result = await runBrief(null, '/repo', 'x')
    expect(result.available).toBe(false)
    expect(result.reason).toBe('bundled CLI unavailable')
  })

  it('DROPS a malformed entry instead of painting a half-understood delta', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          { nodeId: 'module:ok', kind: 'modify', existsToday: true, label: 'ok' },
          { nodeId: 'module:bad', kind: 'not-a-kind', existsToday: true, label: 'bad' },
          { kind: 'new', existsToday: false, label: 'no id' },
        ],
        wires: [{ from: 'a', to: 'b', delta: 'sideways', drawnToday: true }],
        fails: ['keep', 42],
        anchors: [{ ref: 'x', resolved: 'yes' }],
        steps: [{ body: 'no title' }],
      }),
    )
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.available).toBe(true)
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['module:ok'])
    expect(result.wires).toEqual([])
    expect(result.fails).toEqual(['keep'])
    expect(result.anchors).toEqual([])
    expect(result.steps).toEqual([])
  })

  it('is unavailable on empty output', async () => {
    const { spawnFn } = fakeSpawn('')
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.available).toBe(false)
    expect(result.reason).toBe('no output')
  })

  // ── the proposal layer (discovery-view) ──────────────────────────────────
  //
  // The fixture is the REAL payload this repo's store emits, not an invented
  // one: the runner used to drop every field below, which meant the board
  // could not have shown a prediction even after the CLI learned to compute
  // one. A parser that silently narrows is how that kind of gap survives.

  const withProposals = JSON.stringify({
    nodes: [
      {
        nodeId: 'module:src/cli/commands',
        kind: 'modify',
        existsToday: true,
        label: 'commands',
        provenance: {
          source: 'proposal',
          predicted: true,
          proposals: [
            {
              fingerprint: 'plan_change-record-parts_v1+module:src/cli/commands',
              label: 'Refusal channel + stranded-part count',
              detail: 'refuseFeatures moves from stdout to stderr.',
              change: 'changed',
              state: 'proposed',
              kind: 'module',
              resolvedAnchors: ['src/cli/commands'],
              source: {
                plan: 'plan_change-record-parts_v1',
                doc: 'discovery_change-record-parts_v1',
                kind: 'discovery',
              },
            },
          ],
        },
      },
    ],
    wires: [],
    fails: [],
    anchors: [],
    steps: [],
    proposed: {
      nodes: [
        {
          nodeId: 'module:src/cli/commands',
          kind: 'modify',
          existsToday: true,
          label: 'commands',
          provenance: { source: 'proposal', predicted: true, proposals: [] },
        },
      ],
      sources: [
        {
          plan: 'plan_change-record-parts_v1',
          doc: 'discovery_change-record-parts_v1',
          kind: 'discovery',
        },
      ],
      nothingProposed: false,
      summary: 'proposed: 1 node(s) from 1 source(s) — 0 new, 1 changed',
      skipped: [],
    },
  })

  it('carries per-node provenance through instead of dropping it', async () => {
    const { spawnFn } = fakeSpawn(withProposals)
    const result = await runBrief(cli, '/repo', 'x', { spawnFn, feature: 'feature:y' })
    const provenance = result.nodes[0].provenance
    expect(provenance?.predicted).toBe(true)
    expect(provenance?.source).toBe('proposal')
    // The label AND the detail. A mark without them is theatre on the
    // CHANGED-only case, which is the ordinary one.
    expect(provenance?.proposals[0].label).toBe('Refusal channel + stranded-part count')
    expect(provenance?.proposals[0].detail).toBe('refuseFeatures moves from stdout to stderr.')
    expect(provenance?.proposals[0].source.kind).toBe('discovery')
  })

  it('carries the proposal layer, sources included', async () => {
    const { spawnFn } = fakeSpawn(withProposals)
    const result = await runBrief(cli, '/repo', 'x', { spawnFn, feature: 'feature:y' })
    expect(result.proposed?.nothingProposed).toBe(false)
    expect(result.proposed?.sources[0].doc).toBe('discovery_change-record-parts_v1')
    expect(result.proposed?.summary).toContain('1 changed')
  })

  it('omits the layer entirely when the CLI emitted none', async () => {
    // NOT an empty layer. "Nobody asked" and "nothing is proposed" are
    // different facts, and the board's door reads them apart.
    const { spawnFn } = fakeSpawn(validDelta)
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.proposed).toBeUndefined()
    expect(result.nodes[0].provenance).toBeUndefined()
  })

  it('reads a layer that claims proposals but has no drawable node as nothing proposed', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [],
        wires: [],
        fails: [],
        anchors: [],
        steps: [],
        proposed: { nodes: [], sources: [], nothingProposed: false, summary: '', skipped: [] },
      }),
    )
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.proposed?.nothingProposed).toBe(true)
  })

  it('drops a claim with no source rather than drawing an unattributed one', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          {
            nodeId: 'module:src/a',
            kind: 'modify',
            existsToday: true,
            label: 'a',
            provenance: {
              source: 'proposal',
              predicted: true,
              proposals: [{ fingerprint: 'f', label: 'orphan' }],
            },
          },
        ],
        wires: [],
        fails: [],
        anchors: [],
        steps: [],
      }),
    )
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    // The node survives; the unattributable claim does not — a prediction with
    // no named source is the one thing the provenance band cannot honour.
    expect(result.nodes[0].provenance?.proposals).toEqual([])
  })

  it('treats malformed provenance as no answer, never as "not predicted"', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        nodes: [
          {
            nodeId: 'module:src/a',
            kind: 'stable',
            existsToday: true,
            label: 'a',
            provenance: { source: 'nonsense', predicted: 'maybe' },
          },
        ],
        wires: [],
        fails: [],
        anchors: [],
        steps: [],
      }),
    )
    const result = await runBrief(cli, '/repo', 'x', { spawnFn })
    expect(result.nodes[0].provenance).toBeUndefined()
  })
})

describe('parseTouches — what a document touches', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const { parseTouches } = require('./brief-runner') as typeof import('./brief-runner')
    expect(
      parseTouches([
        { project: 'orbit-app', root: '/x/orbit-app', featureId: 'feature:orbit-app::artifacts', featureName: 'Artifacts', parts: [{ id: 'p', name: 'Viewer' }, { id: 3 }], anchors: 2, specific: 2 },
        { project: null, root: null, featureId: 'feature:core', featureName: '', parts: 'no', anchors: -1, specific: 'x' },
        { featureName: 'no id' },
        null,
        'text',
      ]),
    ).toEqual([
      { project: 'orbit-app', root: '/x/orbit-app', featureId: 'feature:orbit-app::artifacts', featureName: 'Artifacts', parts: [{ id: 'p', name: 'Viewer' }], anchors: 2, specific: 2 },
      { project: null, root: null, featureId: 'feature:core', featureName: 'feature:core', parts: [], anchors: 0, specific: 0 },
    ])
  })
})
