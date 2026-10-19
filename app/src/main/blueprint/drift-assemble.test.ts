// Pure drift-assembler tests (drift feature, Phase 4) — no fs/git/spawn/Electron,
// so these run under plain `npx jest` (node env, ts-jest CJS). The assembler is
// the integration seam: it rolls drift-check entries up to graph nodes, picks
// origin/author/ack, ranks by blast radius, caps, and buckets system files.

import type { BlueprintGraph, BlueprintNode } from '../../shared/ipc-contract'
import type { DriftAck } from './drift-acks'
import {
  assembleDrift,
  ownerNodeId,
  DEFAULT_DRIFT_CAP,
  type AssembleDriftInput,
  type DriftAuthorInfo,
  type DriftEntryLike,
} from './drift-assemble'
import { buildDriftOwnerIndex } from './drift-owner'

// ── fixtures ────────────────────────────────────────────────────────────────

function node(id: string, overrides: Partial<BlueprintNode> = {}): BlueprintNode {
  return {
    id,
    kind: 'module',
    label: id,
    sourceFile: id.replace(/^module:/, ''),
    ...overrides,
  }
}

function graphOf(nodes: BlueprintNode[], edges: BlueprintGraph['edges'] = []): BlueprintGraph {
  return { version: 1, derivedAt: '2026-07-20T00:00:00.000Z', coverage: {} as never, nodes, edges }
}

/** Minimal input with sensible empty defaults; override per test. */
function input(overrides: Partial<AssembleDriftInput>): AssembleDriftInput {
  return {
    driftEntries: [],
    graph: null,
    authorsByPath: new Map<string, DriftAuthorInfo>(),
    dirtyPaths: new Set<string>(),
    currentUserEmail: 'me@here.com',
    inPlayNodeIds: new Set<string>(),
    acks: [],
    ...overrides,
  }
}

// ── rollup ──────────────────────────────────────────────────────────────────

describe('assembleDrift — node rollup', () => {
  it('rolls multiple source files under one nodeId into a single node, sorted', () => {
    const entries: DriftEntryLike[] = [
      { path: 'src/auth/b.ts', kind: 'changed', nodeId: 'module:src/auth' },
      { path: 'src/auth/a.ts', kind: 'changed', nodeId: 'module:src/auth' },
    ]
    const drift = assembleDrift(input({ driftEntries: entries, graph: graphOf([node('module:src/auth')]) }))
    expect(drift.nodes).toHaveLength(1)
    expect(drift.nodes[0].nodeId).toBe('module:src/auth')
    expect(drift.nodes[0].label).toBe('module:src/auth')
    expect(drift.nodes[0].changedFiles).toEqual(['src/auth/a.ts', 'src/auth/b.ts'])
  })

  it('resolves the owning node via graph sourceFile when the entry has no nodeId', () => {
    const g = graphOf([node('module:src/auth', { sourceFile: 'src/auth/a.ts', label: 'auth' })])
    const drift = assembleDrift(input({ driftEntries: [{ path: 'src/auth/a.ts', kind: 'changed' }], graph: g }))
    expect(drift.nodes).toHaveLength(1)
    expect(drift.nodes[0].nodeId).toBe('module:src/auth')
    expect(drift.nodes[0].label).toBe('auth')
  })

  it('drops an unattributable source file (no nodeId, no matching node)', () => {
    const drift = assembleDrift(input({ driftEntries: [{ path: 'src/orphan.ts', kind: 'changed' }], graph: null }))
    expect(drift.nodes).toHaveLength(0)
    expect(drift.system).toHaveLength(0)
  })
})

// ── origin precedence ───────────────────────────────────────────────────────

describe('assembleDrift — origin precedence across a node’s files', () => {
  const g = graphOf([node('n')])

  it('agent wins over yours and external', () => {
    const entries: DriftEntryLike[] = [
      { path: 'ext.ts', kind: 'changed', nodeId: 'n' },
      { path: 'dirty.ts', kind: 'changed', nodeId: 'n' },
      { path: 'agent.ts', kind: 'changed', nodeId: 'n' },
    ]
    const drift = assembleDrift(
      input({
        driftEntries: entries,
        graph: g,
        dirtyPaths: new Set(['dirty.ts']),
        inPlayNodeIds: new Set(['n']),
        authorsByPath: new Map([['ext.ts', { email: 'other@x.com' }]]),
      }),
    )
    expect(drift.nodes[0].origin).toBe('agent')
  })

  it('yours (dirty) wins over external when not in play', () => {
    const entries: DriftEntryLike[] = [
      { path: 'ext.ts', kind: 'changed', nodeId: 'n' },
      { path: 'dirty.ts', kind: 'changed', nodeId: 'n' },
    ]
    const drift = assembleDrift(
      input({
        driftEntries: entries,
        graph: g,
        dirtyPaths: new Set(['dirty.ts']),
        authorsByPath: new Map([['ext.ts', { email: 'other@x.com' }]]),
      }),
    )
    expect(drift.nodes[0].origin).toBe('yours')
  })

  it('external when a committed file was authored by someone else', () => {
    const drift = assembleDrift(
      input({
        driftEntries: [{ path: 'ext.ts', kind: 'changed', nodeId: 'n' }],
        graph: g,
        authorsByPath: new Map([['ext.ts', { email: 'other@x.com' }]]),
      }),
    )
    expect(drift.nodes[0].origin).toBe('external')
  })
})

// ── author / commit (most recent) ────────────────────────────────────────────

describe('assembleDrift — author + commit picks the most recent', () => {
  it('uses the latest-dated file’s author name and commit hash', () => {
    const g = graphOf([node('n')])
    const authors = new Map<string, DriftAuthorInfo>([
      ['old.ts', { author: 'Old', email: 'me@here.com', hash: 'aaa', date: '2026-01-01' }],
      ['new.ts', { author: 'New', email: 'me@here.com', hash: 'bbb', date: '2026-06-01' }],
    ])
    const drift = assembleDrift(
      input({
        driftEntries: [
          { path: 'old.ts', kind: 'changed', nodeId: 'n' },
          { path: 'new.ts', kind: 'changed', nodeId: 'n' },
        ],
        graph: g,
        authorsByPath: authors,
      }),
    )
    expect(drift.nodes[0].author).toBe('New')
    expect(drift.nodes[0].commit).toBe('bbb')
  })

  it('omits author/commit when no authorship is known', () => {
    const drift = assembleDrift(
      input({ driftEntries: [{ path: 'a.ts', kind: 'added', nodeId: 'n' }], graph: graphOf([node('n')]) }),
    )
    expect(drift.nodes[0].author).toBeUndefined()
    expect(drift.nodes[0].commit).toBeUndefined()
  })
})

// ── ranking + cap + overflow ─────────────────────────────────────────────────

describe('assembleDrift — ranking, cap, overflow', () => {
  it('ranks by dependents desc (meta.degree), then nodeId', () => {
    const g = graphOf([
      node('a', { meta: { degree: 2 } }),
      node('b', { meta: { degree: 9 } }),
      node('c', { meta: { degree: 9 } }),
    ])
    const drift = assembleDrift(
      input({
        driftEntries: [
          { path: 'a.ts', kind: 'changed', nodeId: 'a' },
          { path: 'b.ts', kind: 'changed', nodeId: 'b' },
          { path: 'c.ts', kind: 'changed', nodeId: 'c' },
        ],
        graph: g,
      }),
    )
    // degree 9 (b, c — tie broken by nodeId), then degree 2 (a)
    expect(drift.nodes.map((n) => n.nodeId)).toEqual(['b', 'c', 'a'])
    expect(drift.nodes.map((n) => n.dependents)).toEqual([9, 9, 2])
  })

  it('falls back to incident-edge count when meta.degree is absent', () => {
    const g = graphOf(
      [node('a'), node('b')],
      [
        { source: 'a', target: 'x', relation: 'uses' },
        { source: 'y', target: 'a', relation: 'uses' },
      ],
    )
    const drift = assembleDrift(
      input({ driftEntries: [{ path: 'a.ts', kind: 'changed', nodeId: 'a' }], graph: g }),
    )
    expect(drift.nodes[0].dependents).toBe(2)
  })

  it('caps nodes and reports shown + overflow', () => {
    const entries: DriftEntryLike[] = []
    const nodes: BlueprintNode[] = []
    for (let i = 0; i < 5; i += 1) {
      nodes.push(node(`n${i}`, { meta: { degree: i } }))
      entries.push({ path: `n${i}.ts`, kind: 'changed', nodeId: `n${i}` })
    }
    const drift = assembleDrift(input({ driftEntries: entries, graph: graphOf(nodes), cap: 2 }))
    expect(drift.shown).toBe(2)
    expect(drift.overflow).toBe(3)
    expect(drift.nodes).toHaveLength(2)
    // Highest degree first: n4 (4), n3 (3)
    expect(drift.nodes.map((n) => n.nodeId)).toEqual(['n4', 'n3'])
  })

  it('defaults the cap to DEFAULT_DRIFT_CAP', () => {
    expect(DEFAULT_DRIFT_CAP).toBeGreaterThan(0)
    const entries: DriftEntryLike[] = []
    const nodes: BlueprintNode[] = []
    for (let i = 0; i < DEFAULT_DRIFT_CAP + 3; i += 1) {
      nodes.push(node(`n${i}`))
      entries.push({ path: `n${i}.ts`, kind: 'changed', nodeId: `n${i}` })
    }
    const drift = assembleDrift(input({ driftEntries: entries, graph: graphOf(nodes) }))
    expect(drift.shown).toBe(DEFAULT_DRIFT_CAP)
    expect(drift.overflow).toBe(3)
  })
})

// ── multi-root rollup ─────────────────────────────────────────────────────────

describe('assembleDrift — multi-root rollup', () => {
  it('rolls files under two source roots into independent nodes, each ranked by its own blast radius', () => {
    // A monorepo shape: one module per root, each owning several drifted files.
    const g = graphOf([
      node('module:app/src', { sourceFile: 'app/src', label: 'app/src', meta: { degree: 3 } }),
      node('module:packages/cli', { sourceFile: 'packages/cli', label: 'packages/cli', meta: { degree: 8 } }),
    ])
    const entries: DriftEntryLike[] = [
      { path: 'app/src/b.ts', kind: 'changed', nodeId: 'module:app/src' },
      { path: 'app/src/a.ts', kind: 'changed', nodeId: 'module:app/src' },
      { path: 'packages/cli/x.ts', kind: 'changed', nodeId: 'module:packages/cli' },
    ]
    const drift = assembleDrift(input({ driftEntries: entries, graph: g }))

    // Two roots → two independent nodes, ranked across roots by blast radius:
    // packages/cli (8) outranks app/src (3), regardless of entry/root order.
    expect(drift.nodes.map((n) => n.nodeId)).toEqual(['module:packages/cli', 'module:app/src'])
    expect(drift.nodes.map((n) => n.dependents)).toEqual([8, 3])
    // Each node rolls up only its OWN root's files (sorted), never the sibling's.
    expect(drift.nodes[0].changedFiles).toEqual(['packages/cli/x.ts'])
    expect(drift.nodes[1].changedFiles).toEqual(['app/src/a.ts', 'app/src/b.ts'])
  })
})

// ── huge pull (cap holds under load) ───────────────────────────────────────────

describe('assembleDrift — huge pull', () => {
  it('caps 100 drifted nodes to `cap`, reporting shown + overflow and keeping the highest blast radius', () => {
    const nodes: BlueprintNode[] = []
    const entries: DriftEntryLike[] = []
    for (let i = 0; i < 100; i += 1) {
      nodes.push(node(`n${i}`, { meta: { degree: i } }))
      entries.push({ path: `n${i}.ts`, kind: 'changed', nodeId: `n${i}` })
    }
    const drift = assembleDrift(input({ driftEntries: entries, graph: graphOf(nodes), cap: 20 }))

    expect(drift.shown).toBe(20)
    expect(drift.overflow).toBe(80)
    expect(drift.nodes).toHaveLength(20)
    // The cap keeps the TOP-ranked nodes (highest blast radius first): n99 … n80.
    expect(drift.nodes[0].nodeId).toBe('n99')
    expect(drift.nodes[0].dependents).toBe(99)
    expect(drift.nodes[19].nodeId).toBe('n80')
    // Every shown node outranks every dropped one — the lowest shown degree is 80.
    expect(Math.min(...drift.nodes.map((n) => n.dependents))).toBe(80)
  })
})

// ── system bucket ────────────────────────────────────────────────────────────

describe('assembleDrift — system bucket', () => {
  it('routes dependency/schema/config files to system, ranked by class then path', () => {
    const entries: DriftEntryLike[] = [
      { path: 'vite.config.ts', kind: 'changed' },
      { path: 'prisma/schema.prisma', kind: 'changed' },
      { path: 'package.json', kind: 'changed' },
    ]
    const drift = assembleDrift(input({ driftEntries: entries }))
    expect(drift.nodes).toHaveLength(0)
    expect(drift.system.map((s) => s.path)).toEqual([
      'package.json', // dependency (0)
      'prisma/schema.prisma', // schema (1)
      'vite.config.ts', // config (2)
    ])
    expect(drift.system.map((s) => s.fileClass)).toEqual(['dependency', 'schema', 'config'])
  })

  it('classifies a system file’s origin and carries its author', () => {
    const drift = assembleDrift(
      input({
        driftEntries: [{ path: 'package.json', kind: 'changed' }],
        authorsByPath: new Map([['package.json', { author: 'Ext', email: 'other@x.com' }]]),
      }),
    )
    expect(drift.system[0].origin).toBe('external')
    expect(drift.system[0].author).toBe('Ext')
  })
})

// ── acked flag ───────────────────────────────────────────────────────────────

describe('assembleDrift — acked flag', () => {
  const g = graphOf([node('n')])

  it('is true only when every committed file’s commit is acknowledged', () => {
    const authors = new Map<string, DriftAuthorInfo>([
      ['a.ts', { hash: 'c1', date: '1' }],
      ['b.ts', { hash: 'c2', date: '2' }],
    ])
    const acks: DriftAck[] = [
      { nodeId: 'n', commit: 'c1', ackedAt: '2026-01-01' },
      { nodeId: 'n', commit: 'c2', ackedAt: '2026-01-01' },
    ]
    const drift = assembleDrift(
      input({
        driftEntries: [
          { path: 'a.ts', kind: 'changed', nodeId: 'n' },
          { path: 'b.ts', kind: 'changed', nodeId: 'n' },
        ],
        graph: g,
        authorsByPath: authors,
        acks,
      }),
    )
    expect(drift.nodes[0].acked).toBe(true)
  })

  it('is false when one committed file is not acknowledged', () => {
    const authors = new Map<string, DriftAuthorInfo>([
      ['a.ts', { hash: 'c1' }],
      ['b.ts', { hash: 'c2' }],
    ])
    const drift = assembleDrift(
      input({
        driftEntries: [
          { path: 'a.ts', kind: 'changed', nodeId: 'n' },
          { path: 'b.ts', kind: 'changed', nodeId: 'n' },
        ],
        graph: g,
        authorsByPath: authors,
        acks: [{ nodeId: 'n', commit: 'c1', ackedAt: '2026-01-01' }],
      }),
    )
    expect(drift.nodes[0].acked).toBe(false)
  })

  it('is false when a file is uncommitted (no commit hash to ack)', () => {
    const drift = assembleDrift(
      input({
        driftEntries: [{ path: 'a.ts', kind: 'added', nodeId: 'n' }],
        graph: g,
        acks: [{ nodeId: 'n', commit: 'c1', ackedAt: '2026-01-01' }],
      }),
    )
    expect(drift.nodes[0].acked).toBe(false)
  })
})

// ── empty / bad inputs (fail-soft) ───────────────────────────────────────────

describe('assembleDrift — fail-soft', () => {
  it('returns empty buckets for no entries', () => {
    expect(assembleDrift(input({}))).toEqual({ nodes: [], system: [], shown: 0, overflow: 0 })
  })

  it('returns empty buckets for a non-array driftEntries', () => {
    const bad = input({}) as unknown as AssembleDriftInput
    ;(bad as { driftEntries: unknown }).driftEntries = null
    expect(assembleDrift(bad)).toEqual({ nodes: [], system: [], shown: 0, overflow: 0 })
  })

  it('skips structurally-bad entries without throwing', () => {
    const entries = [
      null,
      { kind: 'changed' }, // no path
      { path: 'a.ts', kind: 'changed', nodeId: 'n' },
    ] as unknown as DriftEntryLike[]
    const drift = assembleDrift(input({ driftEntries: entries, graph: graphOf([node('n')]) }))
    expect(drift.nodes).toHaveLength(1)
    expect(drift.nodes[0].nodeId).toBe('n')
  })
})

// ── ownerNodeId helper ───────────────────────────────────────────────────────

describe('ownerNodeId', () => {
  const empty = buildDriftOwnerIndex([])

  it('prefers an explicit nodeId', () => {
    expect(ownerNodeId({ path: 'a.ts', kind: 'changed', nodeId: 'n' }, empty)).toBe('n')
  })

  it('falls back to the sourceFile index', () => {
    const index = buildDriftOwnerIndex([{ id: 'n', sourceFile: 'a.ts' }])
    expect(ownerNodeId({ path: 'a.ts', kind: 'changed' }, index)).toBe('n')
  })

  it('rolls a module FILE up to its owning module node (#1155)', () => {
    // The regression this issue was filed for: module nodes own a directory,
    // so an exact-only index attributed nothing and the row was dropped.
    const index = buildDriftOwnerIndex([
      { id: 'module:src', sourceFile: 'src' },
      { id: 'module:src/core', sourceFile: 'src/core' },
    ])
    expect(ownerNodeId({ path: 'src/core/engine.ts', kind: 'changed' }, index)).toBe(
      'module:src/core',
    )
  })

  it('is undefined when neither resolves', () => {
    expect(ownerNodeId({ path: 'a.ts', kind: 'changed' }, empty)).toBeUndefined()
  })
})
