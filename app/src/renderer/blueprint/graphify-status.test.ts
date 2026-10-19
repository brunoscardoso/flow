import { blueprintDegradedBanner, graphifyStatusLabel, hasUsageEdges } from './graphify-status'

describe('graphifyStatusLabel (#142)', () => {
  it('reads "graphify on" when the derive was enriched', () => {
    expect(graphifyStatusLabel({ graphifyEnriched: true })).toBe('graphify on')
  })

  it('reads "native only" (not "off") when the derive ran without graphify', () => {
    // Under always-on, a non-enriched derive means graphify was unavailable for
    // it — never a deliberate "off" — so the label must not say "off".
    expect(graphifyStatusLabel({ graphifyEnriched: false })).toBe('native only')
  })
})

describe('blueprintDegradedBanner (#535)', () => {
  it('announces a building code graph with no retry (it is running)', () => {
    const banner = blueprintDegradedBanner({ graphifyBuild: 'building' })
    expect(banner).toEqual({ text: 'Structure limited — building code graph…', retry: false })
  })

  it('announces a failed build WITH a retry affordance', () => {
    const banner = blueprintDegradedBanner({ graphifyBuild: 'failed' })
    expect(banner?.retry).toBe(true)
    expect(banner?.text).toContain('build didn’t finish')
  })

  it('shows nothing when a graph exists (no build lifecycle)', () => {
    expect(blueprintDegradedBanner({})).toBeNull()
    expect(blueprintDegradedBanner({ graphifyBuild: undefined })).toBeNull()
    expect(blueprintDegradedBanner({ graphifyEnriched: true })).toBeNull()
  })

  it('announces a native-only derive with genuinely NO usage edges (orbit-app)', () => {
    // The silent hole: graphifyEnriched=false and no graphifyBuild rendered a
    // graph with no imports/calls edges — so no connection lines — with no
    // banner at all. Retry is offered: a fresh derive relaunches the build.
    const banner = blueprintDegradedBanner({ graphifyEnriched: false })
    expect(banner?.retry).toBe(true)
    expect(banner?.text).toContain('connections not shown')
  })

  it('suppresses the native-only banner when native connection edges exist (#729)', () => {
    // Native extractors emit imports/uses/exposes edges (#727) — the board's
    // wires and connections panel work without graphify, so "connections not
    // shown" would contradict what the user sees.
    expect(
      blueprintDegradedBanner({ graphifyEnriched: false }, undefined, Date.now(), true),
    ).toBeNull()
  })

  it('hasUsageEdges recognizes drawable relations and ignores pure containment', () => {
    expect(hasUsageEdges([{ relation: 'contains' }])).toBe(false)
    expect(hasUsageEdges([{ relation: 'contains' }, { relation: 'imports' }])).toBe(true)
    expect(hasUsageEdges([{ relation: 'exposes' }])).toBe(true)
    expect(hasUsageEdges([])).toBe(false)
  })

  it('build lifecycle banners still show even when usage edges exist (structure incomplete)', () => {
    // A building/failed code graph is a real in-progress/failed state — native
    // edges existing doesn't make the *full* graph present, so keep those honest.
    const failed = blueprintDegradedBanner({ graphifyBuild: 'failed' }, undefined, Date.now(), true)
    expect(failed?.retry).toBe(true)
  })

  it('treats a fresh building state as live (no retry)', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z')
    const banner = blueprintDegradedBanner(
      { graphifyBuild: 'building' },
      '2026-07-20T11:55:00.000Z',
      now,
    )
    expect(banner?.retry).toBe(false)
    expect(banner?.text).toContain('building code graph')
  })

  it('offers retry once a building state outlives the stale window', () => {
    // orbit-app sat on "building…" for 3 days because the graph.json watcher
    // never fired — with retry:false there was nothing to click.
    const now = Date.parse('2026-07-20T12:00:00.000Z')
    const banner = blueprintDegradedBanner(
      { graphifyBuild: 'building' },
      '2026-07-17T11:34:00.000Z',
      now,
    )
    expect(banner?.retry).toBe(true)
    expect(banner?.text).toContain('stalled')
  })

  it('treats a building state as live when derivedAt is absent or unparseable', () => {
    expect(blueprintDegradedBanner({ graphifyBuild: 'building' })?.retry).toBe(false)
    expect(blueprintDegradedBanner({ graphifyBuild: 'building' }, 'not-a-date')?.retry).toBe(false)
  })
})
