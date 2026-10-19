import {
  EDITOR_THEME_DARK,
  EDITOR_THEME_LIGHT,
  colorModeFromDataTheme,
  diffEditorThemeName,
  resolveEditorThemeName,
} from './monaco-themes'

describe('resolveEditorThemeName (#126)', () => {
  it('maps light → the Light+ theme and dark → the Dark+ theme', () => {
    expect(resolveEditorThemeName('light')).toBe(EDITOR_THEME_LIGHT)
    expect(resolveEditorThemeName('dark')).toBe(EDITOR_THEME_DARK)
  })
})

describe('diffEditorThemeName (#453)', () => {
  it('resolves to a DEFINED editor theme from <html data-theme> — never the removed flow-stark', () => {
    expect(diffEditorThemeName('light')).toBe(EDITOR_THEME_LIGHT)
    expect(diffEditorThemeName('dark')).toBe(EDITOR_THEME_DARK)
    // Dark-only shell today: no attribute → dark (not the light `vs` fallback).
    expect(diffEditorThemeName(null)).toBe(EDITOR_THEME_DARK)
    expect(diffEditorThemeName(undefined)).toBe(EDITOR_THEME_DARK)
  })

  it('only ever returns one of the two known theme names', () => {
    const known = [EDITOR_THEME_DARK, EDITOR_THEME_LIGHT]
    for (const input of ['light', 'dark', '', 'flow-stark', null, undefined]) {
      expect(known).toContain(diffEditorThemeName(input))
    }
  })
})

describe('colorModeFromDataTheme (#126)', () => {
  it('reads data-theme="light" as light', () => {
    expect(colorModeFromDataTheme('light')).toBe('light')
  })

  it('defaults to dark — the app is dark-only, so absent/dark/unknown is dark', () => {
    expect(colorModeFromDataTheme(undefined)).toBe('dark')
    expect(colorModeFromDataTheme(null)).toBe('dark')
    expect(colorModeFromDataTheme('dark')).toBe('dark')
    expect(colorModeFromDataTheme('')).toBe('dark')
  })
})
