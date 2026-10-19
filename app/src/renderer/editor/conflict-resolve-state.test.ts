import { resolveAllControl } from './conflict-resolve-state'

// #1134: the button sat unchanged for the whole agent turn — it looked idle
// while a turn was running, and there was no way to stop it from there.

describe('resolveAllControl (#1134)', () => {
  it('offers the plain action when nothing is running', () => {
    const control = resolveAllControl('idle')
    expect(control.label).toBe('Resolve all with AI')
    expect(control.busy).toBe(false)
    expect(control.canStop).toBe(false)
  })

  it('shows progress the moment the click lands, before any turn exists', () => {
    // The gather (reading every conflicted file across roots) is the part that
    // used to look like nothing had happened.
    const control = resolveAllControl('gathering')
    expect(control.busy).toBe(true)
    expect(control.label).toBe('Reading conflicts…')
  })

  it('withholds Stop until there is a turn to interrupt', () => {
    // A Stop during the gather would have nothing to stop; offering a button
    // that does nothing is worse than not offering it.
    expect(resolveAllControl('gathering').canStop).toBe(false)
    expect(resolveAllControl('resolving').canStop).toBe(true)
  })

  it('says what Stop will do while the agent is running', () => {
    const control = resolveAllControl('resolving')
    expect(control.busy).toBe(true)
    expect(control.label).toBe('Resolving…')
    expect(control.title).toContain('Stop')
  })
})
