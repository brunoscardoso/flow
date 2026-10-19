import {
  EMPTY_SELECTION,
  gestureFor,
  nextSelection,
  reconcileSelection,
  type Selection,
} from './source-control-selection'

const ITEMS = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']

/** Build a Selection from a path list + anchor, for terse test setup. */
function sel(paths: string[], anchor: string | null): Selection {
  return { selected: new Set(paths), anchor }
}

describe('gestureFor (#SCMS)', () => {
  it('maps no modifiers to a plain click', () => {
    expect(gestureFor({})).toBe('plain')
    expect(gestureFor({ multiSelect: false, range: false })).toBe('plain')
  })
  it('maps the meta/ctrl modifier to toggle', () => {
    expect(gestureFor({ multiSelect: true })).toBe('toggle')
  })
  it('maps shift to range', () => {
    expect(gestureFor({ range: true })).toBe('range')
  })
  it('lets range (shift) win over toggle (meta/ctrl) when both are held', () => {
    expect(gestureFor({ multiSelect: true, range: true })).toBe('range')
  })
})

describe('nextSelection — plain (#SCMS FR-1)', () => {
  it('selects the sole clicked row and makes it the anchor', () => {
    const next = nextSelection(EMPTY_SELECTION, { items: ITEMS, path: 'b.ts', gesture: 'plain' })
    expect([...next.selected]).toEqual(['b.ts'])
    expect(next.anchor).toBe('b.ts')
  })
  it('collapses a prior multi-selection to just the clicked row', () => {
    const next = nextSelection(sel(['a.ts', 'b.ts', 'c.ts'], 'a.ts'), {
      items: ITEMS,
      path: 'd.ts',
      gesture: 'plain',
    })
    expect([...next.selected]).toEqual(['d.ts'])
    expect(next.anchor).toBe('d.ts')
  })
})

describe('nextSelection — toggle (#SCMS FR-2)', () => {
  it('adds an unselected row and moves the anchor to it', () => {
    const next = nextSelection(sel(['a.ts'], 'a.ts'), { items: ITEMS, path: 'c.ts', gesture: 'toggle' })
    expect([...next.selected].sort()).toEqual(['a.ts', 'c.ts'])
    expect(next.anchor).toBe('c.ts')
  })
  it('removes an already-selected row', () => {
    const next = nextSelection(sel(['a.ts', 'c.ts'], 'c.ts'), { items: ITEMS, path: 'c.ts', gesture: 'toggle' })
    expect([...next.selected]).toEqual(['a.ts'])
  })
  it('clears the anchor when the last row is toggled off', () => {
    const next = nextSelection(sel(['a.ts'], 'a.ts'), { items: ITEMS, path: 'a.ts', gesture: 'toggle' })
    expect(next).toEqual(EMPTY_SELECTION)
  })
})

describe('nextSelection — range (#SCMS FR-3)', () => {
  it('selects the contiguous span from the anchor to the clicked row', () => {
    const next = nextSelection(sel(['b.ts'], 'b.ts'), { items: ITEMS, path: 'd.ts', gesture: 'range' })
    expect([...next.selected]).toEqual(['b.ts', 'c.ts', 'd.ts'])
    expect(next.anchor).toBe('b.ts')
  })
  it('spans upward too (clicked row above the anchor)', () => {
    const next = nextSelection(sel(['d.ts'], 'd.ts'), { items: ITEMS, path: 'b.ts', gesture: 'range' })
    expect([...next.selected]).toEqual(['b.ts', 'c.ts', 'd.ts'])
  })
  it('re-extends from the SAME anchor on a second shift-click (anchor preserved)', () => {
    const first = nextSelection(sel(['b.ts'], 'b.ts'), { items: ITEMS, path: 'd.ts', gesture: 'range' })
    const second = nextSelection(first, { items: ITEMS, path: 'e.ts', gesture: 'range' })
    expect([...second.selected]).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts'])
    expect(second.anchor).toBe('b.ts')
    // A range click does not accumulate — re-extending shorter drops the tail.
    const shorter = nextSelection(second, { items: ITEMS, path: 'c.ts', gesture: 'range' })
    expect([...shorter.selected]).toEqual(['b.ts', 'c.ts'])
  })
  it('uses the clicked row as origin when there is no prior anchor', () => {
    const next = nextSelection(EMPTY_SELECTION, { items: ITEMS, path: 'c.ts', gesture: 'range' })
    expect([...next.selected]).toEqual(['c.ts'])
    expect(next.anchor).toBe('c.ts')
  })
})

describe('nextSelection — guards', () => {
  it('leaves the selection unchanged when the path is not selectable (not in items)', () => {
    const current = sel(['a.ts'], 'a.ts')
    const next = nextSelection(current, { items: ITEMS, path: 'merge-or-dir.ts', gesture: 'plain' })
    expect(next).toBe(current)
  })
})

describe('reconcileSelection (#SCMS FR-10)', () => {
  it('drops selected paths no longer present', () => {
    const next = reconcileSelection(sel(['a.ts', 'c.ts', 'z.ts'], 'a.ts'), ['a.ts', 'b.ts', 'c.ts'])
    expect([...next.selected].sort()).toEqual(['a.ts', 'c.ts'])
  })
  it('keeps a surviving anchor', () => {
    const next = reconcileSelection(sel(['a.ts', 'c.ts'], 'a.ts'), ['a.ts', 'c.ts'])
    expect(next.anchor).toBe('a.ts')
  })
  it('clears a vanished anchor while keeping the surviving selection', () => {
    const next = reconcileSelection(sel(['a.ts', 'c.ts'], 'z.ts'), ['a.ts', 'c.ts'])
    expect([...next.selected].sort()).toEqual(['a.ts', 'c.ts'])
    expect(next.anchor).toBeNull()
  })
  it('collapses to EMPTY_SELECTION when nothing survives', () => {
    expect(reconcileSelection(sel(['x.ts', 'y.ts'], 'x.ts'), ['a.ts'])).toEqual(EMPTY_SELECTION)
  })
  it('accepts a Set as the live paths', () => {
    const next = reconcileSelection(sel(['a.ts', 'z.ts'], 'a.ts'), new Set(['a.ts']))
    expect([...next.selected]).toEqual(['a.ts'])
  })
})

describe('section scoping is caller-owned — the reducer never crosses item sets', () => {
  it('a range within one section only ever selects paths from that section’s items', () => {
    // The panel passes ONE section's items; a range can never reach another
    // section's files because they are not in `items`.
    const stagedItems = ['s1.ts', 's2.ts']
    const next = nextSelection(sel(['s1.ts'], 's1.ts'), { items: stagedItems, path: 's2.ts', gesture: 'range' })
    expect([...next.selected]).toEqual(['s1.ts', 's2.ts'])
    expect(next.selected.has('a.ts')).toBe(false)
  })
})
