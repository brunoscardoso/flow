import { chooseLayer, mapLayersView, readLayerPref } from './map-layers-model'

const base = { connections: null, understood: null, changes: null, chosen: 'map' as const }

describe('readLayerPref', () => {
  it('reads a stored layer', () => {
    expect(readLayerPref('learning', null)).toBe('learning')
    expect(readLayerPref('connections', 'off')).toBe('connections')
  })
  it('migrates the old Connections toggle: a stored "on" is the Connections layer', () => {
    expect(readLayerPref(null, 'on')).toBe('connections')
  })
  it('never stores Changes, and anything unreadable is the plain map', () => {
    expect(readLayerPref('changes', null)).toBe('map')
    expect(readLayerPref('nonsense', 'off')).toBe('map')
    expect(readLayerPref(null, null)).toBe('map')
  })
  it('a new choice wins over the legacy key', () => {
    expect(readLayerPref('map', 'on')).toBe('map')
  })
})

describe('mapLayersView', () => {
  it('offers the map and Learning everywhere, with the understood share', () => {
    const view = mapLayersView({ ...base, understood: 38 })
    expect(view.options.map((o) => o.id)).toEqual(['map', 'learning'])
    expect(view.options[1]).toMatchObject({ label: 'Learning', figure: '38%' })
    expect(view.current).toBe('map')
    expect(view.buttonLabel).toBe('Map')
  })

  it('offers Connections with its count only where they exist', () => {
    const view = mapLayersView({ ...base, connections: { count: 7 }, chosen: 'connections' })
    expect(view.options.map((o) => o.id)).toEqual(['map', 'connections', 'learning'])
    expect(view.options[1]).toMatchObject({ figure: '7', disabled: false })
    expect(view.current).toBe('connections')
    expect(view.buttonLabel).toBe('Connections')
  })

  it('falls back to the map when the stored layer is not offered here', () => {
    expect(mapLayersView({ ...base, chosen: 'connections' }).current).toBe('map')
  })

  it('keeps unreadable connections listed but not choosable', () => {
    const view = mapLayersView({ ...base, connections: { count: null, unreadableReason: 'nope' }, chosen: 'connections' })
    expect(view.options[1]).toMatchObject({ disabled: true, figure: null, title: 'nope' })
    expect(view.current).toBe('map')
  })

  it('shows Changes as the layer while a changeset stands undismissed', () => {
    const view = mapLayersView({ ...base, changes: { files: 12, dismissed: false }, chosen: 'learning' })
    expect(view.options.at(-1)).toMatchObject({ id: 'changes', figure: '12 files' })
    expect(view.current).toBe('changes')
    expect(view.showKey).toBe(false)
  })

  it('returns to the chosen layer once the changeset is dismissed', () => {
    const view = mapLayersView({ ...base, changes: { files: 1, dismissed: true }, chosen: 'learning' })
    expect(view.options.at(-1)).toMatchObject({ figure: '1 file' })
    expect(view.current).toBe('learning')
    expect(view.showKey).toBe(true)
  })

  it('offers no Changes for a clean tree', () => {
    expect(mapLayersView({ ...base, changes: { files: 0, dismissed: false } }).options.map((o) => o.id)).not.toContain('changes')
  })
})

describe('chooseLayer', () => {
  it('choosing another layer over Changes dismisses this changeset and remembers the choice', () => {
    const view = mapLayersView({ ...base, changes: { files: 3, dismissed: false } })
    expect(chooseLayer('learning', view)).toEqual({ store: 'learning', dismissChanges: true, restoreChanges: false })
  })
  it('choosing Changes brings it back and keeps the stored choice', () => {
    const view = mapLayersView({ ...base, changes: { files: 3, dismissed: true }, chosen: 'learning' })
    expect(chooseLayer('changes', view)).toEqual({ store: null, dismissChanges: false, restoreChanges: true })
  })
  it('a plain choice is only remembered', () => {
    const view = mapLayersView(base)
    expect(chooseLayer('map', view)).toEqual({ store: 'map', dismissChanges: false, restoreChanges: false })
  })
})
