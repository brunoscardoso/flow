/**
 * Theme controller (#399) — the thin runtime around the pure theme-model. It is
 * the SINGLE writer of `<html data-theme>`, the one signal every surface follows:
 *   - CSS light palette applies via `:root[data-theme='light']` (tokens.css)
 *   - Monaco follows via its data-theme MutationObserver (monaco-host.ts, #126)
 *   - xterm follows via its own data-theme observer (terminal-panel.ts, this feature)
 *
 * `initTheme()` runs at the very top of main.ts, BEFORE the shell mounts, so the
 * effective theme is stamped before first paint (no flash). The persisted mode is
 * read synchronously from localStorage; 'system' resolves against the OS and is
 * re-resolved live on OS change — but ONLY while the user is on System mode.
 */
import {
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  parseThemeMode,
  resolveEffectiveTheme,
  type EffectiveTheme,
  type ThemeMode,
} from './theme-model'

type ThemeListener = (effective: EffectiveTheme, mode: ThemeMode) => void

const listeners = new Set<ThemeListener>()
let currentMode: ThemeMode = DEFAULT_THEME_MODE
let mediaQuery: MediaQueryList | null = null

function osPrefersDark(): boolean {
  return mediaQuery?.matches ?? true // default dark if matchMedia is unavailable
}

function readPersistedMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    // Private-mode / disabled storage — fall back to the default, never throw.
    return DEFAULT_THEME_MODE
  }
}

/** Stamp the resolved theme on <html> and notify listeners. */
function apply(): void {
  const effective = resolveEffectiveTheme(currentMode, osPrefersDark())
  document.documentElement.dataset['theme'] = effective
  for (const listener of listeners) {
    listener(effective, currentMode)
  }
}

/**
 * Initialize theming before first paint. Idempotent — safe to call once from
 * main.ts. Reads the persisted mode, stamps <html data-theme>, and wires the OS
 * media listener (which only changes the app while mode === 'system').
 */
export function initTheme(): void {
  currentMode = readPersistedMode()
  if (mediaQuery === null && typeof matchMedia === 'function') {
    mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
      if (currentMode === 'system') apply()
    })
  }
  apply()
}

/** The user's current mode (light | dark | system). */
export function getThemeMode(): ThemeMode {
  return currentMode
}

/** The effective theme rendering right now (system already resolved). */
export function getEffectiveTheme(): EffectiveTheme {
  return resolveEffectiveTheme(currentMode, osPrefersDark())
}

/** Change the mode: persist, re-apply <html data-theme>, notify listeners. */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Non-persistent storage — the in-memory mode still drives this session.
  }
  apply()
}

/** Subscribe to theme changes (e.g. the Settings selector reflecting a live
 *  System→OS flip). Returns an unsubscribe. */
export function onThemeChanged(listener: ThemeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
