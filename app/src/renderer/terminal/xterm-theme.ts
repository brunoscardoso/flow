// xterm ANSI themes (#399). xterm — like Monaco — cannot read CSS custom
// properties, so its colors are literal hex (the established exception) and must be
// switched imperatively off the same <html data-theme> signal the rest of the app
// follows. The dark theme is the original Stark palette (tokens.css dark values);
// the light theme is the warm/soft light counterpart. Pure/DOM-free (ITheme is a
// data type) → unit-testable; terminal-panel.ts reads data-theme and applies these.
import type { EffectiveTheme } from '../theme/theme-model'

type XtermTheme = import('@xterm/xterm').ITheme

/** Stark dark — matches the dark tokens.css palette (magenta/cyan are the one-dark
 *  values the Stark accents derive from). */
export const XTERM_THEME_DARK: XtermTheme = {
  background: '#1f1f1f',
  foreground: '#cccccc',
  cursor: '#3794ff',
  cursorAccent: '#1f1f1f',
  selectionBackground: 'rgba(55, 148, 255, 0.25)',
  black: '#181818',
  red: '#f14c4c',
  green: '#89d185',
  yellow: '#cca700',
  blue: '#3794ff',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#cccccc',
  brightBlack: '#9d9d9d',
  brightRed: '#f14c4c',
  brightGreen: '#89d185',
  brightYellow: '#cca700',
  brightBlue: '#3794ff',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

/** Warm/soft light — warm off-white ground, warm near-black text, and ANSI colors
 *  darkened for legibility on light (mirrors the light tokens.css palette). */
export const XTERM_THEME_LIGHT: XtermTheme = {
  background: '#fdfbf7',
  foreground: '#37352f',
  cursor: '#2f74c0',
  cursorAccent: '#fdfbf7',
  selectionBackground: 'rgba(47, 116, 192, 0.20)',
  black: '#37352f',
  red: '#d13438',
  green: '#2e8b57',
  yellow: '#b58900',
  blue: '#2f74c0',
  magenta: '#a626a4',
  cyan: '#0e7490',
  white: '#37352f',
  brightBlack: '#6b6659',
  brightRed: '#c1272d',
  brightGreen: '#227d47',
  brightYellow: '#9a7400',
  brightBlue: '#265f9c',
  brightMagenta: '#8a1f88',
  brightCyan: '#0b6178',
  brightWhite: '#1a1a1a',
}

/** The xterm theme for an effective app theme. */
export function resolveXtermTheme(theme: EffectiveTheme): XtermTheme {
  return theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK
}
