import { blueprintCoverageLabel } from './coverage-label'

describe('blueprintCoverageLabel', () => {
  it('reports the native parse percent, rounded', () => {
    const label = blueprintCoverageLabel({
      filesScanned: 82,
      filesTotal: 100,
      graphifyEnriched: false,
    })
    expect(label.percent).toBe(82)
    expect(label.text).toBe('code graph: 82% parsed · usage edges: native-only')
  })

  it('rounds to the nearest whole percent', () => {
    expect(blueprintCoverageLabel({ filesScanned: 1, filesTotal: 3, graphifyEnriched: false }).percent).toBe(33)
    expect(blueprintCoverageLabel({ filesScanned: 2, filesTotal: 3, graphifyEnriched: false }).percent).toBe(67)
  })

  it('reads `enriched` when graphify enriched the derive', () => {
    const label = blueprintCoverageLabel({ filesScanned: 50, filesTotal: 50, graphifyEnriched: true })
    expect(label.usageState).toBe('enriched')
    expect(label.text).toBe('code graph: 100% parsed · usage edges: enriched')
  })

  it('reads `building` while the code graph is still building', () => {
    const label = blueprintCoverageLabel({
      filesScanned: 10,
      filesTotal: 40,
      graphifyEnriched: false,
      graphifyBuild: 'building',
    })
    expect(label.usageState).toBe('building')
  })

  it('reads `native-only` when the graphify build failed', () => {
    const label = blueprintCoverageLabel({
      filesScanned: 40,
      filesTotal: 40,
      graphifyEnriched: false,
      graphifyBuild: 'failed',
    })
    expect(label.usageState).toBe('native-only')
  })

  it('yields 0% (never NaN) when the total is zero or missing', () => {
    expect(blueprintCoverageLabel({ filesScanned: 0, filesTotal: 0, graphifyEnriched: false }).percent).toBe(0)
  })

  it('clamps a stale scanned count so it can never exceed 100%', () => {
    expect(blueprintCoverageLabel({ filesScanned: 120, filesTotal: 100, graphifyEnriched: false }).percent).toBe(100)
  })
})
