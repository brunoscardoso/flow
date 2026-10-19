import { AUTO_MODEL, effortControlState } from './effort-control'

describe('effortControlState (#332)', () => {
  it('locks effort in Auto mode — routing owns the tier, not the user', () => {
    const state = effortControlState(AUTO_MODEL, true)
    expect(state.disabled).toBe(true)
    expect(state.title).toMatch(/model routing/i)
  })

  it('enables effort when a concrete model is pinned', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const state = effortControlState(model, true)
      expect(state.disabled).toBe(false)
      expect(state.title).toBe('Effort')
    }
  })

  it('locks effort when no thread is open, regardless of model', () => {
    expect(effortControlState('opus', false).disabled).toBe(true)
    expect(effortControlState(AUTO_MODEL, false).disabled).toBe(true)
    expect(effortControlState('opus', false).title).toMatch(/open a thread/i)
  })
})

describe('Auto means something else outside Claude', () => {
  it('leaves effort editable when the runtime picks its own model', () => {
    // Under Codex or Copilot, "Auto" is the RUNTIME choosing a model — Flow's
    // effort→model routing has nothing to do with it, and effort is a dial the
    // runtime actually has. Locking it left those runtimes with no knob at all.
    expect(effortControlState('auto', true, false)).toEqual({ disabled: false, title: 'Effort' })
  })

  it('still defers to routing under Claude', () => {
    expect(effortControlState('auto', true, true).disabled).toBe(true)
    expect(effortControlState('auto', true).disabled).toBe(true)
  })
})
