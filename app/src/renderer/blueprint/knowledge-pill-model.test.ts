import { driftNote, knowledgePillView, relativeAge } from './knowledge-pill-model'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const base = { understood: null, modules: null, run: null, connections: null, outOfSync: false, now: NOW }

describe('relativeAge', () => {
  it('says ages in plain words', () => {
    expect(relativeAge(null, NOW)).toBeNull()
    expect(relativeAge('garbage', NOW)).toBeNull()
    expect(relativeAge('2026-11-15T11:59:40Z', NOW)).toBe('just now')
    expect(relativeAge('2026-11-15T11:55:00Z', NOW)).toBe('5 minutes ago')
    expect(relativeAge('2026-11-15T09:00:00Z', NOW)).toBe('3 hours ago')
    expect(relativeAge('2026-11-14T12:00:00Z', NOW)).toBe('yesterday')
    expect(relativeAge('2026-11-13T12:00:00Z', NOW)).toBe('2 days ago')
  })
})

describe('knowledgePillView', () => {
  it('prints the share understood and fills the ring with it', () => {
    const view = knowledgePillView({ ...base, understood: { done: 3, total: 8 } })
    expect(view.line1).toBe('38% understood')
    expect(view.percent).toBe(38)
    expect(view.ring).toBeCloseTo(0.375)
  })

  it('says nothing is learned rather than 0% of nothing', () => {
    const view = knowledgePillView(base)
    expect(view.line1).toBe('Nothing learned yet')
    expect(view.ring).toBe(0)
    expect(view.line2).toBeNull()
  })

  it('a running pass leads, with its progress', () => {
    const view = knowledgePillView({
      ...base,
      modules: { learned: 120, total: 362, stale: 4 },
      run: { active: 1, queued: 2, current: 'src/auth' },
    })
    expect(view.line2).toBe('Learning · 120 of 362 modules')
    expect(view.busy).toBe(true)
    expect(view.title).toContain('Reading src/auth')
  })

  it('a connections run comes next', () => {
    const view = knowledgePillView({
      ...base,
      modules: { learned: 1, total: 2, stale: 1 },
      connections: { mode: 'learning', percent: 40, title: 'checking' },
    })
    expect(view.line2).toBe('Learning connections · 40%')
    expect(view.busy).toBe(true)
    expect(view.connections).toMatchObject({ action: null, busy: true, percent: 40 })
  })

  it('then drifted modules, as their own segment and the only note', () => {
    const view = knowledgePillView({ ...base, modules: { learned: 1, total: 2, stale: 3 } })
    expect(view.drift).toEqual({ count: 3, label: '3 drifted', title: '3 modules changed since Flow last read them — open to update' })
    expect(view.driftOnly).toBe(true)
    // The fallback "N of M modules read" gives way to the drift.
    expect(view.line2).toBeNull()
    expect(view.title).toContain('3 modules changed since Flow last read them')
  })

  it('drift stays beside a running pass, which keeps its own line', () => {
    const view = knowledgePillView({
      ...base,
      modules: { learned: 18, total: 486, stale: 31 },
      run: { active: 1, queued: 4, current: 'src/app' },
    })
    expect(view.line2).toBe('Learning · 18 of 486 modules')
    expect(view.drift?.label).toBe('31 drifted')
    expect(view.driftOnly).toBe(false)
  })

  it('no drift → no segment', () => {
    const view = knowledgePillView({ ...base, modules: { learned: 9, total: 40, stale: 0 } })
    expect(view.line2).toBe('9 of 40 modules read')
    expect(view.drift).toBeNull()
    expect(view.driftOnly).toBe(false)
  })

  it('then connections not learned, offering Learn connections in the panel', () => {
    const view = knowledgePillView({ ...base, connections: { mode: 'learn', title: 'Find how these projects talk' } })
    expect(view.line2).toBe('Connections not learned yet')
    expect(view.connections).toMatchObject({ action: 'learn', label: 'Learn connections' })
  })

  it('offers Update connections when pairs changed', () => {
    const view = knowledgePillView({
      ...base,
      connections: { mode: 'toggle', count: 5, pending: 2, updateTitle: '2 pairs changed', lastCheckedAt: null },
    })
    expect(view.line2).toBe('Connections need an update')
    expect(view.connections).toMatchObject({ action: 'update', label: 'Update connections', title: '2 pairs changed' })
  })

  it('says when connections were last updated', () => {
    const view = knowledgePillView({
      ...base,
      connections: { mode: 'toggle', count: 5, pending: 0, updateTitle: null, lastCheckedAt: '2026-11-13T12:00:00Z' },
    })
    expect(view.line2).toBe('Connections updated 2 days ago')
    expect(view.connections).toMatchObject({ action: null, label: '5 connections · updated 2 days ago' })
  })

  it('falls back to the modules read', () => {
    expect(knowledgePillView({ ...base, modules: { learned: 9, total: 40, stale: 0 } }).line2).toBe('9 of 40 modules read')
  })

  it('carries the out-of-sync dot', () => {
    const view = knowledgePillView({ ...base, outOfSync: true })
    expect(view.dot).toBe(true)
    expect(view.title).toContain('out of sync')
  })
})

describe('driftNote', () => {
  it('says one module in the singular and nothing for none', () => {
    expect(driftNote(1)).toEqual({ count: 1, label: '1 drifted', title: '1 module changed since Flow last read it — open to update' })
    expect(driftNote(0)).toBeNull()
    expect(driftNote(null)).toBeNull()
    expect(driftNote(undefined)).toBeNull()
  })
})
