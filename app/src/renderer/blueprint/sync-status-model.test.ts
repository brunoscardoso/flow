import type {
  BlueprintAnnotation,
  BlueprintLearningEntry,
  BlueprintTierSummary,
} from '../../shared/ipc-contract'
import { computeSyncStatus, tierTalliesLine } from './sync-status-model'

function ann(
  status: 'active' | 'stale',
  files: string[],
): BlueprintAnnotation {
  return {
    ts: '2026-07-18T00:00:00Z',
    runId: null,
    type: 'decision',
    text: 't',
    anchors: files.map((file) => ({ kind: 'file', ref: file, file })),
    provenance: 'test',
    status,
  }
}

function learn(module: string, status: BlueprintLearningEntry['status']): BlueprintLearningEntry {
  return { module, status, notedAt: '2026-07-18T00:00:00Z' }
}

describe('computeSyncStatus', () => {
  it('counts stale annotations and groups them per file, most-stale first', () => {
    const s = computeSyncStatus({
      annotations: [
        ann('stale', ['a.ts']),
        ann('stale', ['a.ts']),
        ann('stale', ['b.ts']),
        ann('active', ['c.ts']),
      ],
      mtime: 1,
    })
    expect(s.annotations.total).toBe(4)
    expect(s.annotations.stale).toBe(3)
    expect(s.annotations.staleFiles).toEqual([
      { file: 'a.ts', count: 2 },
      { file: 'b.ts', count: 1 },
    ])
  })

  it('ignores anchors without a file', () => {
    const s = computeSyncStatus({
      annotations: [
        { ...ann('stale', []), anchors: [{ kind: 'symbol', ref: 'Foo' }] },
      ],
      mtime: 1,
    })
    expect(s.annotations.stale).toBe(1)
    expect(s.annotations.staleFiles).toEqual([])
  })

  it('tallies module learning-state and lists stale modules', () => {
    const s = computeSyncStatus({
      annotations: [],
      learning: [
        learn('mod/z', 'stale'),
        learn('mod/a', 'stale'),
        learn('mod/b', 'learned'),
        learn('mod/c', 'learning'),
        learn('mod/d', 'queued'),
      ],
      mtime: 1,
    })
    expect(s.modules).toMatchObject({ total: 5, learned: 1, learning: 1, queued: 1, stale: 2 })
    expect(s.modules.staleModules).toEqual(['mod/a', 'mod/z']) // sorted
  })

  it('surfaces graph mtime and first-build state', () => {
    const s = computeSyncStatus({ annotations: [], mtime: 123, graphifyBuild: 'building' })
    expect(s.graph).toEqual({ mtime: 123, building: 'building' })
  })

  it('outOfSync is true on ANY of: stale annotations / stale modules / build running-or-failed', () => {
    expect(computeSyncStatus({ annotations: [ann('stale', ['a.ts'])], mtime: 1 }).outOfSync).toBe(true)
    expect(computeSyncStatus({ annotations: [], learning: [learn('m', 'stale')], mtime: 1 }).outOfSync).toBe(true)
    expect(computeSyncStatus({ annotations: [], mtime: null, graphifyBuild: 'failed' }).outOfSync).toBe(true)
    expect(computeSyncStatus({ annotations: [], mtime: 1, graphifyBuild: 'building' }).outOfSync).toBe(true)
  })

  it('outOfSync is false when everything is in sync', () => {
    const s = computeSyncStatus({
      annotations: [ann('active', ['a.ts'])],
      learning: [learn('m', 'learned')],
      mtime: 1,
    })
    expect(s.outOfSync).toBe(false)
  })

  it('handles an empty snapshot (no annotations, no learning store)', () => {
    const s = computeSyncStatus({ annotations: [], mtime: null })
    expect(s).toMatchObject({
      annotations: { total: 0, stale: 0, staleFiles: [] },
      modules: { total: 0, stale: 0, staleModules: [] },
      graph: { mtime: null },
      outOfSync: false,
    })
  })
})

describe('tierTalliesLine', () => {
  function tiers(partial: Partial<BlueprintTierSummary>): BlueprintTierSummary {
    return {
      claimTotal: 0,
      corroborated: 0,
      contradicted: 0,
      unverifiable: 0,
      unadjudicated: 0,
      ...partial,
    }
  }

  it('returns null when the summary is absent or there are no claim docs', () => {
    expect(tierTalliesLine(undefined)).toBeNull()
    expect(tierTalliesLine(tiers({}))).toBeNull()
    expect(tierTalliesLine(tiers({ corroborated: 3 }))).toBeNull() // claimTotal still 0
  })

  it('renders the full line, folding unadjudicated + unverifiable into unverified', () => {
    expect(
      tierTalliesLine(
        tiers({ claimTotal: 14, corroborated: 9, contradicted: 3, unadjudicated: 1, unverifiable: 1 }),
      ),
    ).toBe('14 docs · 9 verified · 3 contradicted · 2 unverified')
  })

  it('omits zero verdict parts but always leads with the docs count', () => {
    expect(tierTalliesLine(tiers({ claimTotal: 5, unadjudicated: 5 }))).toBe('5 docs · 5 unverified')
    expect(tierTalliesLine(tiers({ claimTotal: 4, corroborated: 4 }))).toBe('4 docs · 4 verified')
    expect(tierTalliesLine(tiers({ claimTotal: 2, contradicted: 2 }))).toBe('2 docs · 2 contradicted')
  })

  it('uses the singular "doc" for a single claim file', () => {
    expect(tierTalliesLine(tiers({ claimTotal: 1, unverifiable: 1 }))).toBe('1 doc · 1 unverified')
  })
})
