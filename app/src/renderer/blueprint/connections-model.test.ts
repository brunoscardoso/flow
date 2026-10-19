import { buildConnections, type NodeIndexEntry } from './connections-model'
import type { UsageNeighborhood } from './neighborhood'

const neighborhood: UsageNeighborhood = {
  focus: 'module:src/lib',
  dependents: ['module:src/api', 'module:src/jobs'],
  dependencies: ['integration:smtp'],
  dependentCounts: { 'module:src/api': 3, 'module:src/jobs': 1 },
  dependencyCounts: { 'integration:smtp': 2 },
  dependentRelations: { 'module:src/api': ['imports'], 'module:src/jobs': ['calls'] },
  dependencyRelations: { 'integration:smtp': ['uses'] },
}

const index: Record<string, NodeIndexEntry> = {
  'module:src/api': { label: 'api', sourceFile: 'src/api', detail: 'learned' },
  'module:src/jobs': { label: 'jobs', sourceFile: 'src/jobs' },
  'integration:smtp': { label: 'SMTP', sourceFile: 'src/lib/mailer.ts' },
}

const lookup = (id: string): NodeIndexEntry | null => index[id] ?? null

describe('buildConnections', () => {
  it('groups into usedBy (dependents) and uses (dependencies)', () => {
    const c = buildConnections(neighborhood, lookup)
    expect(c.usedBy.map((r) => r.nodeId)).toEqual(['module:src/api', 'module:src/jobs'])
    expect(c.uses.map((r) => r.nodeId)).toEqual(['integration:smtp'])
  })

  it('sorts rows by usage count descending', () => {
    const c = buildConnections(neighborhood, lookup)
    expect(c.usedBy[0]).toMatchObject({ label: 'api', count: 3 })
    expect(c.usedBy[1]).toMatchObject({ label: 'jobs', count: 1 })
  })

  it('carries label + sourceFile for jump-to-code', () => {
    const c = buildConnections(neighborhood, lookup)
    expect(c.uses[0]).toEqual({
      nodeId: 'integration:smtp',
      label: 'SMTP',
      count: 2,
      sourceFile: 'src/lib/mailer.ts',
      provenance: 'native',
    })
  })

  it('marks native (imports/uses/exposes) vs graphify (calls) provenance', () => {
    const c = buildConnections(neighborhood, lookup)
    const byId = new Map(c.usedBy.map((r) => [r.nodeId, r]))
    expect(byId.get('module:src/api')?.provenance).toBe('native') // imports
    expect(byId.get('module:src/jobs')?.provenance).toBe('graphify') // calls only
    expect(c.uses[0].provenance).toBe('native') // uses
  })

  it('folds a semantic detail label onto the row when the index has one', () => {
    const c = buildConnections(neighborhood, lookup)
    const api = c.usedBy.find((r) => r.nodeId === 'module:src/api')
    expect(api?.detail).toBe('learned')
    // A node without a detail carries no detail field.
    const jobs = c.usedBy.find((r) => r.nodeId === 'module:src/jobs')
    expect(jobs?.detail).toBeUndefined()
  })

  it('falls back to an id-derived label and null sourceFile when unindexed', () => {
    const c = buildConnections(neighborhood, () => null)
    expect(c.usedBy[0]).toMatchObject({ label: 'api', sourceFile: null })
    expect(c.uses[0]).toMatchObject({ label: 'smtp', sourceFile: null })
  })

  it('breaks count ties by label', () => {
    const tied: UsageNeighborhood = {
      focus: 'f',
      dependents: ['module:z', 'module:a'],
      dependencies: [],
      dependentCounts: { 'module:z': 1, 'module:a': 1 },
      dependencyCounts: {},
      dependentRelations: { 'module:z': ['imports'], 'module:a': ['imports'] },
      dependencyRelations: {},
    }
    const c = buildConnections(tied, () => null)
    expect(c.usedBy.map((r) => r.label)).toEqual(['a', 'z'])
  })

  it('yields empty lists for an island node', () => {
    const island: UsageNeighborhood = {
      focus: 'f',
      dependents: [],
      dependencies: [],
      dependentCounts: {},
      dependencyCounts: {},
      dependentRelations: {},
      dependencyRelations: {},
    }
    const c = buildConnections(island, lookup)
    expect(c.usedBy).toEqual([])
    expect(c.uses).toEqual([])
  })
})
