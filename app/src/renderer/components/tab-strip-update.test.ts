import { planStripUpdate, type StripSnapshot } from './tab-strip-update'
import type { TabDescriptor } from './fl-tabs'

const tab = (id: string, overrides: Partial<TabDescriptor> = {}): TabDescriptor => ({
  id,
  label: `Tab ${id}`,
  closable: true,
  renamable: true,
  ...overrides,
})

const snap = (tabs: TabDescriptor[], activeId: string | null): StripSnapshot => ({ tabs, activeId })

describe('planStripUpdate (#993)', () => {
  it('identical snapshots → none (idempotent — background churn is free)', () => {
    const prev = snap([tab('a'), tab('b')], 'b')
    const next = snap([tab('a'), tab('b')], 'b')
    expect(planStripUpdate(prev, next)).toEqual({ kind: 'none' })
  })

  it('a shadowed windowTitle change that leaves labels identical → none', () => {
    // terminal-panel builds `customTitle ?? cwdTitle ?? windowTitle` — a
    // windowTitle change under an OSC 7 cwdTitle produces identical
    // descriptors, and the strip must not move.
    const prev = snap([tab('a', { label: 'my-project' }), tab('b')], 'a')
    const next = snap([tab('a', { label: 'my-project' }), tab('b')], 'a')
    expect(planStripUpdate(prev, next)).toEqual({ kind: 'none' })
  })

  it('label-only change → patch that relabels, without scrolling', () => {
    const prev = snap([tab('a'), tab('b', { label: 'old' })], 'a')
    const next = snap([tab('a'), tab('b', { label: 'new' })], 'a')
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [1],
      redirty: [],
      activeChanged: false,
      scrollActiveIntoView: false,
    })
  })

  it('dirty-only change → patch that toggles the dot, without scrolling', () => {
    const prev = snap([tab('a'), tab('b')], 'a')
    const next = snap([tab('a'), tab('b', { dirty: true })], 'a')
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [],
      redirty: [1],
      activeChanged: false,
      scrollActiveIntoView: false,
    })
  })

  it('undefined and false are the same dirty state — no patch', () => {
    const prev = snap([tab('a', { dirty: undefined })], 'a')
    const next = snap([tab('a', { dirty: false })], 'a')
    expect(planStripUpdate(prev, next)).toEqual({ kind: 'none' })
  })

  it('active change with same tabs → patch AND scroll-into-view (user action)', () => {
    const prev = snap([tab('a'), tab('b')], 'a')
    const next = snap([tab('a'), tab('b')], 'b')
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [],
      redirty: [],
      activeChanged: true,
      scrollActiveIntoView: true,
    })
  })

  it('active cleared (null) → patch without scroll (nothing to scroll to)', () => {
    const prev = snap([tab('a')], 'a')
    const next = snap([tab('a')], null)
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [],
      redirty: [],
      activeChanged: true,
      scrollActiveIntoView: false,
    })
  })

  it('tab added → rebuild; scroll only if the active tab changed too', () => {
    const prev = snap([tab('a')], 'a')
    expect(planStripUpdate(prev, snap([tab('a'), tab('b')], 'a'))).toEqual({
      kind: 'rebuild',
      scrollActiveIntoView: false,
    })
    expect(planStripUpdate(prev, snap([tab('a'), tab('b')], 'b'))).toEqual({
      kind: 'rebuild',
      scrollActiveIntoView: true,
    })
  })

  it('tab removed → rebuild without scroll when the active tab is unchanged', () => {
    const prev = snap([tab('a'), tab('b'), tab('c')], 'c')
    expect(planStripUpdate(prev, snap([tab('a'), tab('c')], 'c'))).toEqual({
      kind: 'rebuild',
      scrollActiveIntoView: false,
    })
  })

  it('reorder → rebuild (ids at each index differ)', () => {
    const prev = snap([tab('a'), tab('b')], 'a')
    expect(planStripUpdate(prev, snap([tab('b'), tab('a')], 'a'))).toEqual({
      kind: 'rebuild',
      scrollActiveIntoView: false,
    })
  })

  it('structural field changes (icon / closable / renamable) → rebuild', () => {
    const prev = snap([tab('a')], 'a')
    expect(planStripUpdate(prev, snap([tab('a', { icon: 'terminal' })], 'a')).kind).toBe('rebuild')
    expect(planStripUpdate(prev, snap([tab('a', { closable: false })], 'a')).kind).toBe('rebuild')
    expect(planStripUpdate(prev, snap([tab('a', { renamable: false })], 'a')).kind).toBe('rebuild')
  })

  it('first render (empty prev) → rebuild with scroll to the new active tab', () => {
    const prev = snap([], null)
    expect(planStripUpdate(prev, snap([tab('a'), tab('b')], 'b'))).toEqual({
      kind: 'rebuild',
      scrollActiveIntoView: true,
    })
  })

  it('project accent added / removed / changed → rebuild (multi-project threads)', () => {
    const prev = snap([tab('a')], 'a')
    expect(planStripUpdate(prev, snap([tab('a', { accent: 'var(--fl-project-accent-1)' })], 'a')).kind).toBe('rebuild')
    const withAccent = snap([tab('a', { accent: 'var(--fl-project-accent-1)' })], 'a')
    expect(planStripUpdate(withAccent, snap([tab('a')], 'a')).kind).toBe('rebuild')
    expect(
      planStripUpdate(withAccent, snap([tab('a', { accent: 'var(--fl-project-accent-2)' })], 'a'))
        .kind,
    ).toBe('rebuild')
  })

  it('tooltip change → rebuild; identical accent + tooltip → none', () => {
    const decorated = { accent: '#5778db', tooltip: '/work/core/src/index.ts' }
    const prev = snap([tab('a', decorated)], 'a')
    expect(
      planStripUpdate(prev, snap([tab('a', { ...decorated, tooltip: '/other/path.ts' })], 'a'))
        .kind,
    ).toBe('rebuild')
    expect(planStripUpdate(prev, snap([tab('a', { ...decorated })], 'a'))).toEqual({
      kind: 'none',
    })
  })

  it('label / dirty churn on an accented tab still patches in place', () => {
    const decorated = { accent: '#5778db', tooltip: '/work/core/src/index.ts' }
    const prev = snap([tab('a', decorated), tab('b')], 'a')
    const next = snap([tab('a', { ...decorated, label: 'renamed', dirty: true }), tab('b')], 'a')
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [0],
      redirty: [0],
      activeChanged: false,
      scrollActiveIntoView: false,
    })
  })

  it('combined label + active change in one assignment → single patch, scrolls', () => {
    const prev = snap([tab('a', { label: 'x' }), tab('b')], 'a')
    const next = snap([tab('a', { label: 'y' }), tab('b')], 'b')
    expect(planStripUpdate(prev, next)).toEqual({
      kind: 'patch',
      relabel: [0],
      redirty: [],
      activeChanged: true,
      scrollActiveIntoView: true,
    })
  })
})
