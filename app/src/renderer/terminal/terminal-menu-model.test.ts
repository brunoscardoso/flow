import { terminalMenuItems } from './terminal-menu-model'

// #1149: the menu's SHAPE is fixed — an action that can't do anything renders
// disabled, never missing, so the items don't move under the cursor between
// two right-clicks in the same terminal.

describe('terminalMenuItems (#1149)', () => {
  it('always offers the same actions, in the same order', () => {
    const ids = terminalMenuItems({ hasSelection: false, writable: false, splittable: true }).map((i) => i.id)
    expect(ids).toEqual(['copy', 'paste', 'select-all', 'clear', 'split'])
  })

  it('enables Copy only with a selection', () => {
    const withSelection = terminalMenuItems({ hasSelection: true, writable: true, splittable: true })
    const without = terminalMenuItems({ hasSelection: false, writable: true, splittable: true })
    expect(withSelection.find((i) => i.id === 'copy')?.disabled).toBe(false)
    expect(without.find((i) => i.id === 'copy')?.disabled).toBe(true)
  })

  it('disables the input actions on a read-only agent tab', () => {
    // A read-only agent tab takes no input, so Paste/Clear must not pretend.
    const readOnly = terminalMenuItems({ hasSelection: true, writable: false, splittable: true })
    expect(readOnly.find((i) => i.id === 'paste')?.disabled).toBe(true)
    expect(readOnly.find((i) => i.id === 'clear')?.disabled).toBe(true)
    // …but Copy still works — reading the agent's output is the point.
    expect(readOnly.find((i) => i.id === 'copy')?.disabled).toBe(false)
  })

  it('keeps Select All available even with nothing selected', () => {
    const items = terminalMenuItems({ hasSelection: false, writable: false, splittable: true })
    expect(items.find((i) => i.id === 'select-all')?.disabled).toBe(false)
  })

  it('offers Split, disabled at the pane cap rather than missing (#1133)', () => {
    // Same rule as the rest of the menu: the shape must not change under the
    // cursor between two right-clicks in the same terminal.
    const roomy = terminalMenuItems({ hasSelection: false, writable: true, splittable: true })
    const full = terminalMenuItems({ hasSelection: false, writable: true, splittable: false })
    expect(roomy.find((i) => i.id === 'split')?.disabled).toBe(false)
    expect(full.find((i) => i.id === 'split')?.disabled).toBe(true)
    expect(full.map((i) => i.id)).toEqual(roomy.map((i) => i.id))
  })
})
