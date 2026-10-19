// WindowState — persist and restore the main window's size / position /
// maximized state across launches, so reopening Flow puts the window back
// exactly where the user left it.
//
// Stored as JSON in Electron's per-user data dir (window-state.json), separate
// from the app database (this is a chrome concern, not app data). Fail-soft:
// any read/parse/write error falls back to defaults and never blocks launch.
//
// Off-screen guard: a window saved on a monitor that is later disconnected
// would otherwise open invisibly. Before restoring a position we confirm the
// saved rectangle still overlaps a connected display's work area; if not, we
// drop the position (keep the size) and let the OS center it.
//
// Electron is accessed via a LAZY require (never a top-level import): under the
// test runtime (ELECTRON_RUN_AS_NODE) `import 'electron'` resolves to the
// binary PATH, not the API. Keeping electron lazy lets the pure logic
// (parseState / isVisibleOnSomeDisplay / computeOverrides) be unit-tested
// without any electron mock.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'

/** A screen rectangle (mirrors electron's Rectangle — kept local to avoid a
 *  runtime electron import). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
  isFullScreen?: boolean
}

const FILE_NAME = 'window-state.json'
/** Debounce window resize/move bursts before persisting. */
const SAVE_DEBOUNCE_MS = 400
/** Floor for a restored size — never smaller than the window's own minimums. */
const MIN_WIDTH = 480
const MIN_HEIGHT = 360

// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = (): typeof import('electron') => require('electron')

function statePath(): string {
  return join(electron().app.getPath('userData'), FILE_NAME)
}

// ── Pure logic (exported for tests — no electron needed) ───────────────────

/** Parse + shape-validate saved state. Returns null on any problem. */
export function parseState(raw: string): WindowState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WindowState>
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height)
    ) {
      return null
    }
    const state: WindowState = {
      width: Math.max(MIN_WIDTH, Math.round(parsed.width)),
      height: Math.max(MIN_HEIGHT, Math.round(parsed.height)),
      isMaximized: parsed.isMaximized === true,
      isFullScreen: parsed.isFullScreen === true,
    }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      state.x = Math.round(parsed.x)
      state.y = Math.round(parsed.y)
    }
    return state
  } catch {
    return null
  }
}

/**
 * True when at least 40px of the rectangle is visible on some display's work
 * area — so a window saved on a now-unplugged monitor is re-centered rather
 * than opening off-screen.
 */
export function isVisibleOnSomeDisplay(bounds: Rect, displays: Array<{ workArea: Rect }>): boolean {
  const MARGIN = 40
  return displays.some(({ workArea: area }) => {
    return (
      bounds.x + bounds.width - MARGIN > area.x &&
      bounds.y + bounds.height - MARGIN > area.y &&
      bounds.x + MARGIN < area.x + area.width &&
      bounds.y + MARGIN < area.y + area.height
    )
  })
}

/**
 * BrowserWindow constructor overrides from a saved state + the current
 * displays: always the saved size, and the saved position only when it is
 * still on-screen. Falls back to the given defaults when there is no state.
 */
export function computeOverrides(
  state: WindowState | null,
  displays: Array<{ workArea: Rect }>,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number; x?: number; y?: number } {
  if (!state) {
    return { width: fallbackWidth, height: fallbackHeight }
  }
  const overrides: { width: number; height: number; x?: number; y?: number } = {
    width: state.width,
    height: state.height,
  }
  if (
    state.x !== undefined &&
    state.y !== undefined &&
    isVisibleOnSomeDisplay(
      { x: state.x, y: state.y, width: state.width, height: state.height },
      displays,
    )
  ) {
    overrides.x = state.x
    overrides.y = state.y
  }
  return overrides
}

/**
 * Overrides that pin the window to a NON-primary display, centered in its work
 * area with the size clamped to fit. Used for e2e runs (FLOW_E2E) so Playwright
 * windows never open over the user's working screen. Returns null when no
 * secondary display is connected (single-display machines, CI) — callers fall
 * back to normal placement.
 */
export function computeSecondaryDisplayOverrides(
  primaryId: number,
  displays: Array<{ id: number; workArea: Rect }>,
  width: number,
  height: number,
): Rect | null {
  const secondary = displays.find((display) => display.id !== primaryId)
  if (!secondary) return null
  const area = secondary.workArea
  const clampedWidth = Math.min(width, area.width)
  const clampedHeight = Math.min(height, area.height)
  return {
    x: area.x + Math.round((area.width - clampedWidth) / 2),
    y: area.y + Math.round((area.height - clampedHeight) / 2),
    width: clampedWidth,
    height: clampedHeight,
  }
}

// ── Electron-facing wrappers (thin; used by createWindow) ──────────────────

/** The saved window state, or null when absent/corrupt. Never throws. */
export function readWindowState(): WindowState | null {
  try {
    return parseState(readFileSync(statePath(), 'utf-8'))
  } catch {
    return null
  }
}

/** Constructor overrides derived from the saved state + connected displays. */
export function windowStateOverrides(
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number; x?: number; y?: number } {
  return computeOverrides(
    readWindowState(),
    electron().screen.getAllDisplays(),
    fallbackWidth,
    fallbackHeight,
  )
}

/** Secondary-display overrides for the given size, or null (see compute…). */
export function secondaryDisplayOverrides(width: number, height: number): Rect | null {
  const { screen } = electron()
  return computeSecondaryDisplayOverrides(
    screen.getPrimaryDisplay().id,
    screen.getAllDisplays(),
    width,
    height,
  )
}

/** Re-apply the saved maximize / fullscreen mode after the window is built. */
export function restoreWindowMode(window: BrowserWindow): void {
  const state = readWindowState()
  if (state?.isFullScreen) {
    window.setFullScreen(true)
  } else if (state?.isMaximized) {
    window.maximize()
  }
}

/**
 * Persist the window's size/position/mode on every settled resize/move and on
 * close. Uses getNormalBounds() so a maximized/fullscreen window still records
 * the size to RESTORE to, not the maximized size.
 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null

  const persist = (): void => {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    }
    try {
      writeFileSync(statePath(), JSON.stringify(state), 'utf-8')
    } catch (error) {
      console.warn('[WindowState] Failed to persist window state:', error)
    }
  }

  const queue = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, SAVE_DEBOUNCE_MS)
  }

  window.on('resize', queue)
  window.on('move', queue)
  window.on('maximize', queue)
  window.on('unmaximize', queue)
  window.on('enter-full-screen', queue)
  window.on('leave-full-screen', queue)
  // Final synchronous flush before the window goes away.
  window.on('close', () => {
    if (timer) clearTimeout(timer)
    persist()
  })
}
