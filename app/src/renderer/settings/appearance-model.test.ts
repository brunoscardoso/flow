import {
  FEED_DENSITY_OPTIONS,
  THEME_MODE_OPTIONS,
  feedDensityLabel,
  themeModeLabel,
} from './appearance-model'

describe('appearance-model (#399)', () => {
  it('offers all three modes in presentation order', () => {
    expect(THEME_MODE_OPTIONS.map((o) => o.mode)).toEqual(['light', 'dark', 'system'])
  })

  it('every option has a non-empty label and hint', () => {
    for (const option of THEME_MODE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.hint.length).toBeGreaterThan(0)
    }
  })

  it('maps each mode to its human label', () => {
    expect(themeModeLabel('light')).toBe('Light')
    expect(themeModeLabel('dark')).toBe('Dark')
    expect(themeModeLabel('system')).toBe('System')
  })
})

describe('appearance-model — conversation density (chat-feed-signal Q-1)', () => {
  it('offers all three densities in presentation order', () => {
    expect(FEED_DENSITY_OPTIONS.map((o) => o.density)).toEqual([
      'compact',
      'balanced',
      'detailed',
    ])
  })

  it('every option has a non-empty label and hint', () => {
    for (const option of FEED_DENSITY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.hint.length).toBeGreaterThan(0)
    }
  })

  it('maps each density to its human label', () => {
    expect(feedDensityLabel('compact')).toBe('Compact')
    expect(feedDensityLabel('balanced')).toBe('Balanced')
    expect(feedDensityLabel('detailed')).toBe('Detailed')
  })

  it("promises Detailed hides nothing — the setting's whole point (C-2)", () => {
    const detailed = FEED_DENSITY_OPTIONS.find((o) => o.density === 'detailed')
    expect(detailed?.hint).toContain('Nothing is folded away')
  })
})
