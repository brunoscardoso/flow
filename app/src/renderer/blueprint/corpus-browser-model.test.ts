// Corpus-browser model — pure logic, no DOM (node env). Covers the tab split,
// the learn-filter search contract (case-insensitive literal substring over
// name / path basename / feature slug), date sort with undated legacy entries
// pinned last in both directions, the inclusive date range, the feature
// pre-filter + clear, the explicit "no feature" group, the archived flag
// passthrough, and the empty index.

import type { BlueprintCorpusIndexEntry } from '../../shared/ipc-contract'
import {
  clearFeatureFilter,
  countCorpusTabs,
  deriveCorpusBrowserView,
  initialCorpusBrowserState,
  matchesCorpusSearch,
  type CorpusBrowserState,
} from './corpus-browser-model'

function entry(overrides: Partial<BlueprintCorpusIndexEntry> = {}): BlueprintCorpusIndexEntry {
  return {
    path: 'flow/plans/plan_alpha_v1.md',
    kind: 'change',
    featureSlug: 'alpha',
    name: 'Alpha Plan',
    created: '2026-08-01',
    indexed: '2026-08-10T12:00:00.000Z',
    archived: false,
    ...overrides,
  }
}

function state(overrides: Partial<CorpusBrowserState> = {}): CorpusBrowserState {
  return { ...initialCorpusBrowserState(), ...overrides }
}

function names(rows: { entry: BlueprintCorpusIndexEntry }[]): string[] {
  return rows.map((row) => row.entry.name)
}

describe('tab split', () => {
  const index = [
    entry({ name: 'Alpha Plan', kind: 'change' }),
    entry({ name: 'Beta Discovery', kind: 'discovery', path: 'flow/discovery/discovery_beta_v1.md' }),
    entry({ name: 'Gamma Plan', kind: 'change', path: 'flow/plans/plan_gamma_v1.md' }),
  ]

  it('the changes tab shows only kind=change entries', () => {
    const view = deriveCorpusBrowserView(index, state({ tab: 'changes' }))
    expect(names(view.rows)).toEqual(['Alpha Plan', 'Gamma Plan'])
    expect(view.totalInTab).toBe(2)
  })

  it('the discoveries tab shows only kind=discovery entries', () => {
    const view = deriveCorpusBrowserView(index, state({ tab: 'discoveries' }))
    expect(names(view.rows)).toEqual(['Beta Discovery'])
    expect(view.totalInTab).toBe(1)
  })

  it('countCorpusTabs reports per-tab totals over the whole index', () => {
    expect(countCorpusTabs(index)).toEqual({ changes: 2, discoveries: 1 })
  })

  it('countCorpusTabs counts each kind explicitly — an unknown kind inflates neither badge', () => {
    const withUnknown = [
      ...index,
      entry({ name: 'Mystery', kind: 'note' as BlueprintCorpusIndexEntry['kind'], path: 'flow/plans/plan_mystery_v1.md' }),
    ]
    expect(countCorpusTabs(withUnknown)).toEqual({ changes: 2, discoveries: 1 })
  })
})

describe('matchesCorpusSearch — the learn-filter contract', () => {
  it('matches case-insensitively as a literal substring of the name', () => {
    // Three cases: a whole word in another case, a substring that spans a word
    // boundary, and a near-miss that must NOT match.
    expect(matchesCorpusSearch(entry({ name: 'Chat Session Cache Rework' }), 'CACHE')).toBe(true)
    expect(matchesCorpusSearch(entry({ name: 'Chat Session Cache Rework' }), 'che rew')).toBe(true)
    expect(matchesCorpusSearch(entry({ name: 'Chat Session Cache Rework' }), 'reworks')).toBe(false)
  })

  it('matches the path BASENAME, not the directories', () => {
    const e = entry({ path: 'flow/plans/plan_corpus_browser_v1.md', name: 'Browser' })
    expect(matchesCorpusSearch(e, 'corpus_browser')).toBe(true)
    expect(matchesCorpusSearch(e, 'flow/plans')).toBe(false)
  })

  it('matches the feature slug, and never a null slug', () => {
    expect(matchesCorpusSearch(entry({ featureSlug: 'playbooks', name: 'X' }), 'PLAY')).toBe(true)
    expect(matchesCorpusSearch(entry({ featureSlug: null, name: 'X', path: 'a.md' }), 'play')).toBe(false)
  })

  it('a blank or whitespace-only query matches everything', () => {
    expect(matchesCorpusSearch(entry(), '')).toBe(true)
    expect(matchesCorpusSearch(entry(), '   ')).toBe(true)
  })

  it('narrows the derived view', () => {
    const index = [entry({ name: 'Alpha Plan' }), entry({ name: 'Beta Plan', path: 'flow/plans/plan_beta_v1.md' })]
    const view = deriveCorpusBrowserView(index, state({ search: 'beta' }))
    expect(names(view.rows)).toEqual(['Beta Plan'])
    expect(view.totalInTab).toBe(2)
  })
})

describe('date sort — undated legacy entries pin last in both directions', () => {
  const index = [
    entry({ name: 'Old', created: '2026-01-05', path: 'flow/plans/plan_old_v1.md' }),
    entry({ name: 'Legacy', created: undefined, indexed: undefined, path: 'flow/plans/plan_legacy_v1.md' }),
    entry({ name: 'New', created: '2026-08-01', path: 'flow/plans/plan_new_v1.md' }),
  ]

  it('descending: newest first, undated still last', () => {
    const view = deriveCorpusBrowserView(index, state({ sortDirection: 'desc' }))
    expect(names(view.rows)).toEqual(['New', 'Old', 'Legacy'])
  })

  it('ascending: oldest first, undated STILL last (not first)', () => {
    const view = deriveCorpusBrowserView(index, state({ sortDirection: 'asc' }))
    expect(names(view.rows)).toEqual(['Old', 'New', 'Legacy'])
  })

  it('flags undated rows and carries null as their date', () => {
    const view = deriveCorpusBrowserView(index, state())
    const legacy = view.rows.find((row) => row.entry.name === 'Legacy')
    expect(legacy).toMatchObject({ undated: true, date: null })
    const dated = view.rows.find((row) => row.entry.name === 'New')
    expect(dated).toMatchObject({ undated: false, date: '2026-08-01' })
  })

  it('sorts by the indexed field when it is the active sort field', () => {
    const byIndexed = [
      entry({ name: 'A', created: '2026-08-01', indexed: '2026-08-12T09:00:00.000Z', path: 'a.md' }),
      entry({ name: 'B', created: '2026-08-02', indexed: '2026-08-10T09:00:00.000Z', path: 'b.md' }),
    ]
    const view = deriveCorpusBrowserView(byIndexed, state({ sortField: 'indexed', sortDirection: 'desc' }))
    expect(names(view.rows)).toEqual(['A', 'B'])
  })

  it('breaks date ties by name for a deterministic order', () => {
    const tied = [
      entry({ name: 'Zeta', created: '2026-08-01', path: 'z.md' }),
      entry({ name: 'Alpha', created: '2026-08-01', path: 'a.md' }),
    ]
    const view = deriveCorpusBrowserView(tied, state({ sortDirection: 'desc' }))
    expect(names(view.rows)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('date range — inclusive, on the active sort field', () => {
  const index = [
    entry({ name: 'Before', created: '2026-07-31', path: 'a.md' }),
    entry({ name: 'OnFrom', created: '2026-08-01', path: 'b.md' }),
    entry({ name: 'Inside', created: '2026-08-05', path: 'c.md' }),
    entry({ name: 'OnTo', created: '2026-08-10', path: 'd.md' }),
    entry({ name: 'After', created: '2026-08-11', path: 'e.md' }),
    entry({ name: 'Legacy', created: undefined, indexed: undefined, path: 'f.md' }),
  ]

  it('keeps both boundary days (inclusive from AND to)', () => {
    const view = deriveCorpusBrowserView(
      index,
      state({ dateFrom: '2026-08-01', dateTo: '2026-08-10', sortDirection: 'asc' }),
    )
    expect(names(view.rows)).toEqual(['OnFrom', 'Inside', 'OnTo'])
  })

  it('treats a timestamp on the boundary day as inside the range', () => {
    const stamped = [entry({ name: 'LateOnTo', created: '2026-08-10T23:30:00.000Z', path: 'g.md' })]
    const view = deriveCorpusBrowserView(stamped, state({ dateFrom: '2026-08-10', dateTo: '2026-08-10' }))
    expect(names(view.rows)).toEqual(['LateOnTo'])
  })

  it('buckets an offset timestamp (git %aI author-local) to its UTC day', () => {
    // 00:30 on Jan 15 in +09:00 is 15:30 on Jan 14 UTC — the range compares
    // UTC days, not the raw string's local-day prefix.
    const offset = [entry({ name: 'Tokyo', created: '2026-01-15T00:30:00+09:00', path: 'h.md' })]
    const onUtcDay = deriveCorpusBrowserView(offset, state({ dateFrom: '2026-01-14', dateTo: '2026-01-14' }))
    expect(names(onUtcDay.rows)).toEqual(['Tokyo'])
    const onLocalDay = deriveCorpusBrowserView(offset, state({ dateFrom: '2026-01-15', dateTo: '2026-01-15' }))
    expect(names(onLocalDay.rows)).toEqual([])
  })

  it('supports open ends — only from, only to', () => {
    const fromOnly = deriveCorpusBrowserView(index, state({ dateFrom: '2026-08-10', sortDirection: 'asc' }))
    expect(names(fromOnly.rows)).toEqual(['OnTo', 'After'])
    const toOnly = deriveCorpusBrowserView(index, state({ dateTo: '2026-07-31', sortDirection: 'asc' }))
    expect(names(toOnly.rows)).toEqual(['Before'])
  })

  it('excludes undated entries while a range is active — no date, no range claim', () => {
    const view = deriveCorpusBrowserView(index, state({ dateFrom: '2026-01-01' }))
    expect(names(view.rows)).not.toContain('Legacy')
    const unranged = deriveCorpusBrowserView(index, state())
    expect(names(unranged.rows)).toContain('Legacy')
  })

  it('applies the range to the ACTIVE sort field', () => {
    const view = deriveCorpusBrowserView(
      index,
      state({ sortField: 'indexed', dateFrom: '2026-08-10', dateTo: '2026-08-10' }),
    )
    // Every dated fixture shares indexed 2026-08-10; created no longer decides.
    expect(names(view.rows)).toHaveLength(5)
  })
})

describe('feature pre-filter and clear', () => {
  const index = [
    entry({ name: 'Alpha Plan', featureSlug: 'alpha', path: 'a.md' }),
    entry({ name: 'Beta Plan', featureSlug: 'beta', path: 'b.md' }),
    entry({ name: 'Orphan Plan', featureSlug: null, path: 'c.md' }),
  ]

  it('initialCorpusBrowserState carries the opening feature slug', () => {
    expect(initialCorpusBrowserState('alpha').featureSlug).toBe('alpha')
    expect(initialCorpusBrowserState().featureSlug).toBeNull()
  })

  it('shows only the pre-filtered feature, hiding unparented entries too', () => {
    const view = deriveCorpusBrowserView(index, state({ featureSlug: 'alpha' }))
    expect(names(view.rows)).toEqual(['Alpha Plan'])
    expect(view.noFeatureRows).toEqual([])
  })

  it('clearFeatureFilter returns a NEW state with the filter off', () => {
    const filtered = state({ featureSlug: 'alpha' })
    const cleared = clearFeatureFilter(filtered)
    expect(cleared.featureSlug).toBeNull()
    expect(filtered.featureSlug).toBe('alpha')
    expect(names(deriveCorpusBrowserView(index, cleared).rows)).toEqual(['Alpha Plan', 'Beta Plan'])
  })
})

describe('the "no feature" group', () => {
  it('partitions unparented entries into noFeatureRows — grouped, never dropped', () => {
    const index = [
      entry({ name: 'Parented', featureSlug: 'alpha', created: '2026-08-02', path: 'a.md' }),
      entry({ name: 'Orphan New', featureSlug: null, created: '2026-08-03', path: 'b.md' }),
      entry({ name: 'Orphan Old', featureSlug: null, created: '2026-08-01', path: 'c.md' }),
    ]
    const view = deriveCorpusBrowserView(index, state({ sortDirection: 'desc' }))
    expect(names(view.rows)).toEqual(['Parented'])
    expect(names(view.noFeatureRows)).toEqual(['Orphan New', 'Orphan Old'])
    expect(view.totalInTab).toBe(3)
  })
})

describe('archived flag passthrough', () => {
  it('carries archived onto the row for the badge', () => {
    const index = [
      entry({ name: 'Live', archived: false, path: 'a.md' }),
      entry({ name: 'Archived', archived: true, path: 'flow/archive/plan_done_v1.md' }),
    ]
    const view = deriveCorpusBrowserView(index, state())
    expect(view.rows.find((row) => row.entry.name === 'Archived')?.archived).toBe(true)
    expect(view.rows.find((row) => row.entry.name === 'Live')?.archived).toBe(false)
  })
})

describe('empty index', () => {
  it('derives an empty view with zero totals', () => {
    expect(deriveCorpusBrowserView([], state())).toEqual({
      rows: [],
      noFeatureRows: [],
      totalInTab: 0,
    })
  })
})
