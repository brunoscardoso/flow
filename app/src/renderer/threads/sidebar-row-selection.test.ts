// sidebar-row-selection — WHICH persistent "am I on this one" decoration a
// sidebar row asks <fl-list> to paint, so it survives the list being unfocused
// (#1881) without drawing a second box inside the row's own (2026-09-08).

import { sidebarRowMark } from './sidebar-row-selection'

describe('sidebarRowMark', () => {
  it('marks the OPEN thread as the row the surface is currently on', () => {
    expect(sidebarRowMark({ active: true, multiSelected: false })).toBe('fl-row-current')
  })

  it('marks a ⌘-click multi-selected row distinctly from the open one', () => {
    expect(sidebarRowMark({ active: false, multiSelected: true })).toBe('fl-row-marked')
  })

  it('lets the open state win over multi-select so the open thread stays loudest', () => {
    expect(sidebarRowMark({ active: true, multiSelected: true })).toBe('fl-row-current')
  })

  it('adds nothing to a plain, unselected row', () => {
    expect(sidebarRowMark({ active: false, multiSelected: false })).toBeNull()
  })

  it('never returns a paint of its own — the class names are fl-list’s', () => {
    // The bug this replaced: the row painted `background:` / `box-shadow:` from
    // its own inline style, onto an element inset 8px inside a row 8px taller
    // than it — one selection, two boxes. Nothing here may be a style fragment.
    for (const state of [
      { active: true, multiSelected: false },
      { active: false, multiSelected: true },
    ]) {
      const mark = sidebarRowMark(state)
      expect(mark).not.toBeNull()
      expect(mark).not.toContain(':')
    }
  })
})
