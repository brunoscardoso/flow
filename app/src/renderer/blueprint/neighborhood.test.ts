import { usageNeighborhood, type UsageEdge } from './neighborhood'

// Identity resolver: raw ids already ARE display ids in these fixtures.
const identity = (id: string): string | null => id

describe('usageNeighborhood', () => {
  const edges: UsageEdge[] = [
    { source: 'module:src/api', target: 'module:src/lib', relation: 'imports' },
    { source: 'module:src/jobs', target: 'module:src/lib', relation: 'imports' },
    { source: 'module:src/lib', target: 'integration:smtp', relation: 'uses' },
    { source: 'module:src/api', target: 'module:src/jobs', relation: 'imports' },
    { source: 'module:src', target: 'module:src/lib', relation: 'contains' }, // spine — ignored
  ]

  it('collects dependents (who uses the focus) and dependencies (what it uses)', () => {
    const nb = usageNeighborhood(edges, 'module:src/lib', identity)
    expect(nb.focus).toBe('module:src/lib')
    expect(nb.dependents).toEqual(['module:src/api', 'module:src/jobs'])
    expect(nb.dependencies).toEqual(['integration:smtp'])
  })

  it('excludes the layout-only `contains` spine', () => {
    const nb = usageNeighborhood(edges, 'module:src/lib', identity)
    expect(nb.dependents).not.toContain('module:src')
  })

  it('drops self/intra-card edges once both endpoints roll to the focus', () => {
    // With a resolver that rolls both api and lib into one display card, the
    // api→lib edge becomes intra-card and must not appear on either side.
    const rollToParent = (id: string): string | null =>
      id === 'module:src/api' || id === 'module:src/lib' ? 'module:src' : id
    const nb = usageNeighborhood(edges, 'module:src', rollToParent)
    expect(nb.dependents).not.toContain('module:src')
    expect(nb.dependencies).not.toContain('module:src')
    // jobs→lib(→src) makes jobs a dependent; api(→src)→jobs makes jobs a
    // dependency too (mutual). src uses smtp. The intra-card api→lib is dropped.
    expect(nb.dependents).toEqual(['module:src/jobs'])
    expect(nb.dependencies).toEqual(['integration:smtp', 'module:src/jobs'])
  })

  it('lists a mutually-connected node in both dependents and dependencies', () => {
    const mutual: UsageEdge[] = [
      { source: 'a', target: 'b', relation: 'imports' },
      { source: 'b', target: 'a', relation: 'imports' },
    ]
    const nb = usageNeighborhood(mutual, 'a', identity)
    expect(nb.dependents).toEqual(['b'])
    expect(nb.dependencies).toEqual(['b'])
  })

  it('ignores endpoints that resolve to nothing on the board', () => {
    const offBoard = (id: string): string | null => (id === 'module:src/jobs' ? null : id)
    const nb = usageNeighborhood(edges, 'module:src/lib', offBoard)
    expect(nb.dependents).toEqual(['module:src/api'])
  })

  it('returns empty lists for a node with no usage edges', () => {
    const nb = usageNeighborhood(edges, 'module:src/isolated', identity)
    expect(nb.dependents).toEqual([])
    expect(nb.dependencies).toEqual([])
  })
})
