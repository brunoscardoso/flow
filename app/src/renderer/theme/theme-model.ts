// Theme resolution model (#399). The DOM-free decision layer behind the whole
// light/dark feature: it maps the user's chosen MODE (light | dark | system) plus
// the OS preference to the EFFECTIVE theme the app renders, and parses/defaults the
// persisted mode. Kept pure so every branch is unit-testable without a DOM — the
// controller (theme-controller.ts) is a thin wrapper that feeds this real inputs
// (localStorage, matchMedia, <html data-theme>).

/** What the user picked. 'system' follows the OS and switches live with it. */
export type ThemeMode = 'light' | 'dark' | 'system'

/** What actually renders — 'system' has already been resolved against the OS. */
export type EffectiveTheme = 'light' | 'dark'

/** localStorage key for the persisted mode. */
export const THEME_STORAGE_KEY = 'flow:theme-mode'

/** Default for existing installs and new users — Dark, so nothing changes on
 *  upgrade until a user opts in (#399 decision D-2). */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

/** Every mode, in the order the Settings selector presents them. */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * The persisted mode, defaulting to Dark for anything unrecognized or absent — a
 * corrupt/empty localStorage value must never leave the app themeless.
 */
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE
}

/**
 * Resolve the effective theme. Explicit light/dark is returned verbatim (the OS is
 * ignored); only 'system' consults `osPrefersDark`, so a live OS flip changes the
 * app ONLY while the user is on System mode.
 */
export function resolveEffectiveTheme(mode: ThemeMode, osPrefersDark: boolean): EffectiveTheme {
  if (mode === 'system') {
    return osPrefersDark ? 'dark' : 'light'
  }
  return mode
}
