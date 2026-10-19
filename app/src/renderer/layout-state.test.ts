import {
  migrateLegacyLayout,
  normalizeLayoutState,
  normalizeLayoutStore,
  type ShellLayoutState,
} from './layout-state'
import { DEFAULT_PANEL_LAYOUT, type PanelLayout } from './panel-layout'

describe('normalizeLayoutState (#454, #580)', () => {
  it('preserves sideTab / terminalVisible / sidebarVisible across a save→load round-trip', () => {
    const saved = {
      splits: { root: [0.3, 0.7] },
      collapsed: { left: true },
      sideTab: 'git',
      terminalVisible: true,
      sidebarVisible: false,
    }
    const result = normalizeLayoutState(saved)
    expect(result.splits).toEqual(saved.splits)
    expect(result.collapsed).toEqual(saved.collapsed)
    expect(result.sideTab).toBe('git')
    expect(result.terminalVisible).toBe(true)
    expect(result.sidebarVisible).toBe(false)
  })

  it('defaults an absent panelLayout to DEFAULT_PANEL_LAYOUT (#580)', () => {
    const result = normalizeLayoutState({ splits: {}, collapsed: {} })
    expect(result.panelLayout).toEqual(DEFAULT_PANEL_LAYOUT)
  })

  it('preserves a valid panelLayout and defaults a corrupt one', () => {
    const valid: PanelLayout = {
      panels: [
        { id: 'conversation', side: 'right', order: 0, visible: true },
      ],
      editorVisible: true,
      focusMode: false,
    }
    expect(normalizeLayoutState({ splits: {}, collapsed: {}, panelLayout: valid }).panelLayout).toEqual(
      valid,
    )
    // Corrupt (missing conversation panel) → default arrangement.
    expect(
      normalizeLayoutState({ splits: {}, collapsed: {}, panelLayout: { panels: [] } }).panelLayout,
    ).toEqual(DEFAULT_PANEL_LAYOUT)
  })

  it('drops corrupt optional prefs to undefined so shell defaults apply', () => {
    const result = normalizeLayoutState({
      splits: {},
      collapsed: {},
      sideTab: 'bogus',
      terminalVisible: 'yes',
      sidebarVisible: 1,
    })
    expect(result.sideTab).toBeUndefined()
    expect(result.terminalVisible).toBeUndefined()
    expect(result.sidebarVisible).toBeUndefined()
  })

  it('preserves a false terminalVisible and a true sidebarVisible (booleans, not truthiness)', () => {
    const result = normalizeLayoutState({ terminalVisible: false, sidebarVisible: true })
    expect(result.terminalVisible).toBe(false)
    expect(result.sidebarVisible).toBe(true)
  })

  it('rejects a non-object / null candidate with empty defaults (+ default panelLayout)', () => {
    for (const bad of [null, 'nope', 42]) {
      const result = normalizeLayoutState(bad)
      expect(result.splits).toEqual({})
      expect(result.collapsed).toEqual({})
      expect(result.panelLayout).toEqual(DEFAULT_PANEL_LAYOUT)
    }
  })

  it('guards splits/collapsed shapes (corrupt → empty record)', () => {
    const result = normalizeLayoutState({ splits: { a: ['x'] }, collapsed: { b: 'no' } })
    expect(result.splits).toEqual({})
    expect(result.collapsed).toEqual({})
    expect(result.sideTab).toBeUndefined()
  })

  it('defaults activeRailItem from legacy sideTab on first load', () => {
    expect(normalizeLayoutState({ sideTab: 'git' }).activeRailItem).toBe('source-control')
    expect(normalizeLayoutState({ sideTab: 'files' }).activeRailItem).toBe('files')
    expect(normalizeLayoutState({ sideTab: 'threads' }).activeRailItem).toBe('threads')
  })

  it('migrates legacy editor-tab sideTab values to threads', () => {
    expect(normalizeLayoutState({ sideTab: 'tasks' }).activeRailItem).toBe('threads')
    expect(normalizeLayoutState({ sideTab: 'blueprint' }).activeRailItem).toBe('threads')
    expect(normalizeLayoutState({ sideTab: 'terminal' }).activeRailItem).toBe('threads')
  })

  it('defaults activeRailItem to threads when sideTab is absent', () => {
    const result = normalizeLayoutState({})
    expect(result.activeRailItem).toBe('threads')
  })

  it('defaults sidebarOpen to true', () => {
    const result = normalizeLayoutState({})
    expect(result.sidebarOpen).toBe(true)
  })

  it('preserves a persisted sidebarOpen: false', () => {
    const result = normalizeLayoutState({ sidebarOpen: false })
    expect(result.sidebarOpen).toBe(false)
  })
})

describe('normalizeLayoutStore (v5 per-root, #580)', () => {
  it('normalizes a valid multi-root store, validating each root', () => {
    const store = {
      version: 5,
      roots: {
        '/a': { splits: { root: [0.5, 0.5] }, collapsed: {} },
        '/b': { splits: {}, collapsed: {}, terminalVisible: false },
      },
    }
    const result = normalizeLayoutStore(store)
    expect(result.version).toBe(5)
    expect(Object.keys(result.roots)).toEqual(['/a', '/b'])
    expect(result.roots['/a'].splits).toEqual({ root: [0.5, 0.5] })
    expect(result.roots['/a'].panelLayout).toEqual(DEFAULT_PANEL_LAYOUT)
    expect(result.roots['/b'].terminalVisible).toBe(false)
  })

  it('returns an empty v5 store for a non-object / null candidate', () => {
    for (const bad of [null, 'nope', 42, undefined]) {
      expect(normalizeLayoutStore(bad)).toEqual({ version: 5, roots: {} })
    }
  })

  it('returns an empty store when the version is not 5 (legacy shape)', () => {
    expect(normalizeLayoutStore({ splits: {}, collapsed: {} })).toEqual({ version: 5, roots: {} })
    expect(normalizeLayoutStore({ version: 4, roots: { '/a': {} } })).toEqual({
      version: 5,
      roots: {},
    })
  })

  it('returns an empty store when roots is missing or not an object', () => {
    expect(normalizeLayoutStore({ version: 5 })).toEqual({ version: 5, roots: {} })
    expect(normalizeLayoutStore({ version: 5, roots: null })).toEqual({ version: 5, roots: {} })
  })

  it('drops empty-string root keys but keeps valid ones', () => {
    const result = normalizeLayoutStore({
      version: 5,
      roots: { '': { splits: {}, collapsed: {} }, '/keep': { splits: {}, collapsed: {} } },
    })
    expect(Object.keys(result.roots)).toEqual(['/keep'])
  })
})

describe('migrateLegacyLayout (v3 global → v5 per-root, #580)', () => {
  it("wraps a legacy v3 global object into the active root slot with today's layout", () => {
    const v3: ShellLayoutState = {
      splits: { root: [0.4, 0.6] },
      collapsed: { left: true },
      sideTab: 'git',
      terminalVisible: false,
    }
    const result = migrateLegacyLayout(v3, '/proj/root')
    expect(result.version).toBe(5)
    expect(Object.keys(result.roots)).toEqual(['/proj/root'])
    const slot = result.roots['/proj/root']
    expect(slot.splits).toEqual({ root: [0.4, 0.6] })
    expect(slot.sideTab).toBe('git')
    expect(slot.terminalVisible).toBe(false)
    // Legacy predates panelLayout — the active root anchors to today's default.
    expect(slot.panelLayout).toEqual(DEFAULT_PANEL_LAYOUT)
    // Legacy predates activity bar — defaults to threads.
    expect(slot.activeRailItem).toBe('threads')
    expect(slot.sidebarOpen).toBe(true)
  })

  it('is fail-soft: garbage legacy input still yields a valid store with a default slot', () => {
    const result = migrateLegacyLayout('not-an-object', '/proj')
    expect(result.version).toBe(5)
    expect(result.roots['/proj'].splits).toEqual({})
    expect(result.roots['/proj'].panelLayout).toEqual(DEFAULT_PANEL_LAYOUT)
    expect(result.roots['/proj'].activeRailItem).toBe('threads')
  })

  it('does not share the default panels array between migrations (deep clone)', () => {
    const a = migrateLegacyLayout({}, '/a')
    const b = migrateLegacyLayout({}, '/b')
    expect(a.roots['/a'].panelLayout).not.toBe(b.roots['/b'].panelLayout)
    expect(a.roots['/a'].panelLayout?.panels).not.toBe(b.roots['/b'].panelLayout?.panels)
  })
})
