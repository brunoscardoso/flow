import type {
  BlueprintDrift,
  BlueprintDriftNode,
  BlueprintDriftOrigin,
  BlueprintSystemChange,
} from '../../shared/ipc-contract'
import { driftViewModel } from './drift-panel-model'

function node(
  nodeId: string,
  origin: BlueprintDriftOrigin,
  overrides: Partial<BlueprintDriftNode> = {},
): BlueprintDriftNode {
  return {
    nodeId,
    label: nodeId,
    origin,
    changedFiles: [`${nodeId}.ts`],
    dependents: 0,
    acked: false,
    ...overrides,
  }
}

function sys(
  path: string,
  fileClass: BlueprintSystemChange['fileClass'],
  overrides: Partial<BlueprintSystemChange> = {},
): BlueprintSystemChange {
  return { path, fileClass, origin: 'external', acked: false, ...overrides }
}

function drift(overrides: Partial<BlueprintDrift> = {}): BlueprintDrift {
  return { nodes: [], system: [], shown: 0, overflow: 0, ...overrides }
}

describe('driftViewModel', () => {
  it('splits external (dominant) from yours/agent (dimmed), preserving order', () => {
    const vm = driftViewModel(
      drift({
        nodes: [
          node('a', 'external'),
          node('b', 'yours'),
          node('c', 'external'),
          node('d', 'agent'),
        ],
      }),
    )
    expect(vm.external.map((n) => n.nodeId)).toEqual(['a', 'c'])
    expect(vm.selfAgent.map((n) => n.nodeId)).toEqual(['b', 'd'])
  })

  it('buckets system changes by fileClass in deterministic order, dropping empty buckets', () => {
    const vm = driftViewModel(
      drift({
        system: [
          sys('app.config.ts', 'config'),
          sys('package-lock.json', 'dependency'),
          sys('schema.sql', 'schema'),
          sys('yarn.lock', 'dependency'),
        ],
      }),
    )
    expect(vm.system.map((g) => g.fileClass)).toEqual(['dependency', 'schema', 'config'])
    expect(vm.system[0].changes.map((c) => c.path)).toEqual(['package-lock.json', 'yarn.lock'])
    expect(vm.system[0].label).toBe('Dependencies')
    expect(vm.system[1].changes).toHaveLength(1)
  })

  it('emits an overflow label only when overflow > 0', () => {
    expect(driftViewModel(drift({ overflow: 0 })).overflowLabel).toBeNull()
    expect(driftViewModel(drift({ overflow: 3 })).overflowLabel).toBe('…and 3 more')
  })

  it('reports hasEntries true when only system changes exist', () => {
    expect(driftViewModel(drift({ system: [sys('lock', 'dependency')] })).hasEntries).toBe(true)
    expect(driftViewModel(drift({ nodes: [node('a', 'external')] })).hasEntries).toBe(true)
  })

  it('maps an empty / undefined drift to an empty view (backward compatible)', () => {
    for (const empty of [driftViewModel(undefined), driftViewModel(null), driftViewModel(drift())]) {
      expect(empty.external).toEqual([])
      expect(empty.selfAgent).toEqual([])
      expect(empty.system).toEqual([])
      expect(empty.overflowLabel).toBeNull()
      expect(empty.hasEntries).toBe(false)
    }
  })
})

describe('driftViewModel map changes (OQ1 — graph-delta absorption)', () => {
  const items = [
    { rank: 1, severity: 'crit' as const, title: 'New external integration: Stripe', detail: '', nodeId: 'integration:stripe', source: 'graph-delta' },
    { rank: 2, severity: 'high' as const, title: 'Data store gained tables: orders', detail: '', source: 'graph-delta' },
    { rank: 3, severity: 'ask' as const, title: 'Escalation: something', detail: '', source: 'rounds' },
    { rank: 4, severity: 'high' as const, title: 'God node touched: x (99 edges)', detail: '', source: 'graphify' },
  ]

  it('absorbs ONLY graph-delta items — rounds/graphify sources stay out', () => {
    const vm = driftViewModel(undefined, items)
    expect(vm.mapChanges).toEqual([
      { title: 'New external integration: Stripe', severity: 'crit', nodeId: 'integration:stripe' },
      { title: 'Data store gained tables: orders', severity: 'high', nodeId: null },
    ])
  })

  it('map changes alone make the panel worth opening (hasEntries)', () => {
    const vm = driftViewModel(undefined, items)
    expect(vm.hasEntries).toBe(true)
  })

  it('no must-review input → empty map changes (backward compatible)', () => {
    expect(driftViewModel(undefined).mapChanges).toEqual([])
    expect(driftViewModel(undefined).hasEntries).toBe(false)
  })
})
