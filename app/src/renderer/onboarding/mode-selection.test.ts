import { isSelectedMode, savedModeFromOnboarding } from './mode-selection'

describe('isSelectedMode (#320)', () => {
  it('highlights the choice that matches the stored selection', () => {
    expect(isSelectedMode('manual', 'manual')).toBe(true)
    expect(isSelectedMode('autonomous', 'autonomous')).toBe(true)
  })

  it('does not highlight the other choice', () => {
    expect(isSelectedMode('autonomous', 'manual')).toBe(false)
    expect(isSelectedMode('manual', 'autonomous')).toBe(false)
  })

  it('highlights nothing before a choice has been made', () => {
    expect(isSelectedMode('manual', null)).toBe(false)
    expect(isSelectedMode('autonomous', null)).toBe(false)
  })
})

describe('savedModeFromOnboarding (#716)', () => {
  it('maps a saved bypass=true to autonomous', () => {
    expect(savedModeFromOnboarding({ autonomyBypassDefault: true })).toBe('autonomous')
  })

  it('maps bypass=false (saved Manual, or the first-run safe default) to manual', () => {
    expect(savedModeFromOnboarding({ autonomyBypassDefault: false })).toBe('manual')
  })
})
