import { isSelectedMode, savedModeForProject, savedModeFromOnboarding } from './mode-selection'

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

describe('savedModeForProject (#1206)', () => {
  it('follows the PROJECT’s autopilot — the store this step writes', () => {
    // The reported case: a fresh second project (autopilot off) while the
    // app-wide default is still Autonomous from the first project.
    expect(savedModeForProject(false, { autonomyBypassDefault: true })).toBe('manual')
    expect(savedModeForProject(true, { autonomyBypassDefault: false })).toBe('autonomous')
  })

  it('falls back to the app-wide default only when there is no project', () => {
    // Which is the only situation that value actually describes.
    expect(savedModeForProject(null, { autonomyBypassDefault: true })).toBe('autonomous')
    expect(savedModeForProject(null, { autonomyBypassDefault: false })).toBe('manual')
  })

  it('agrees with the old behaviour when the two stores agree', () => {
    expect(savedModeForProject(true, { autonomyBypassDefault: true })).toBe('autonomous')
    expect(savedModeForProject(false, { autonomyBypassDefault: false })).toBe('manual')
  })
})
