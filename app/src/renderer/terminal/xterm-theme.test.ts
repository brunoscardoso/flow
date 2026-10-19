import { XTERM_THEME_DARK, XTERM_THEME_LIGHT, resolveXtermTheme } from './xterm-theme'

describe('resolveXtermTheme (#399)', () => {
  it('maps the effective app theme to the matching xterm theme', () => {
    expect(resolveXtermTheme('light')).toBe(XTERM_THEME_LIGHT)
    expect(resolveXtermTheme('dark')).toBe(XTERM_THEME_DARK)
  })

  it('light and dark are visually distinct — warm off-white vs near-black ground', () => {
    expect(XTERM_THEME_LIGHT.background).toBe('#fdfbf7')
    expect(XTERM_THEME_DARK.background).toBe('#1f1f1f')
    expect(XTERM_THEME_LIGHT.foreground).not.toBe(XTERM_THEME_DARK.foreground)
    // On light, the "white" ANSI slot must render as dark text, not white.
    expect(XTERM_THEME_LIGHT.white).toBe('#37352f')
  })
})
