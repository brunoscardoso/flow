import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  isThemeMode,
  parseThemeMode,
  resolveEffectiveTheme,
} from './theme-model'

describe('resolveEffectiveTheme (#399)', () => {
  it('returns explicit light/dark verbatim, ignoring the OS', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })

  it('follows the OS only in system mode', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })
})

describe('parseThemeMode', () => {
  it('accepts the three valid modes', () => {
    expect(parseThemeMode('light')).toBe('light')
    expect(parseThemeMode('dark')).toBe('dark')
    expect(parseThemeMode('system')).toBe('system')
  })

  it('defaults to Dark for null / empty / garbage (never themeless)', () => {
    expect(parseThemeMode(null)).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode(undefined)).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('')).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('LIGHT')).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('solarized')).toBe(DEFAULT_THEME_MODE)
    expect(DEFAULT_THEME_MODE).toBe('dark')
  })
})

describe('isThemeMode', () => {
  it('guards the union', () => {
    expect(isThemeMode('system')).toBe(true)
    expect(isThemeMode('sepia')).toBe(false)
    expect(isThemeMode(null)).toBe(false)
    expect(isThemeMode(42)).toBe(false)
  })
})

describe('THEME_MODES', () => {
  it('lists all three modes in selector order', () => {
    expect(THEME_MODES).toEqual(['light', 'dark', 'system'])
  })
})
