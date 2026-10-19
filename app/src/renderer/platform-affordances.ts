/**
 * Renderer-side platform affordances (Windows support, Phase 7).
 *
 * Two decisions the shell chrome makes per platform, each a pure function of a
 * platform string so both branches are testable off-platform:
 *
 *   1. `titlebarInsets` — which edge of `.fl-titlebar` the OS window controls
 *      occupy. macOS puts the traffic lights top-LEFT (78px, `hiddenInset`);
 *      Windows puts the Window Controls Overlay top-RIGHT (138px, see
 *      `main/window-chrome.ts`). Both are OS chrome at a fixed DEVICE size, so
 *      both are divided by the zoom (#1352) — a CSS length is not.
 *   2. `isCaptureAffordanceVisible` — native region capture is `screencapture
 *      -i`, macOS-only (#456). The button is HIDDEN elsewhere rather than shown
 *      and failing on click; main refuses the same call independently.
 *
 * The platform comes from the preload bridge (`window.flowPlatform` === main's
 * `process.platform`), falling back to the legacy `navigator.platform` sniff
 * only when the bridge is absent (e.g. under unit test) — the same authority
 * order `reveal-label.ts` uses.
 */

/** Padding reserved on each edge of the titlebar for OS window controls. */
export interface TitlebarInsets {
  left: string
  right: string
}

const EDGE_PADDING = 'var(--fl-space-sm)'

/** macOS traffic lights (`hiddenInset`), in CSS px at zoom 1. */
export const MAC_TRAFFIC_LIGHT_WIDTH = 78

/** Windows caption-button box (Window Controls Overlay), in CSS px at zoom 1. */
export const WINDOWS_CONTROL_BOX_WIDTH = 138

/** Normalize a Node `process.platform` value OR a legacy `navigator.platform`
 *  string ('MacIntel', 'Win32', …) to 'darwin' | 'win32' | ''. */
function normalizePlatform(platform: string): 'darwin' | 'win32' | '' {
  const p = platform.toLowerCase()
  if (p === 'darwin' || p.startsWith('mac')) return 'darwin'
  if (p === 'win32' || p.startsWith('win')) return 'win32'
  return ''
}

/** The authoritative platform surfaced by preload, or the navigator fallback. */
export function currentPlatform(): string {
  const fromBridge = (globalThis as { flowPlatform?: string }).flowPlatform
  if (fromBridge) return fromBridge
  return (globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? ''
}

/**
 * The left/right padding `.fl-titlebar` needs so the OS window controls never
 * overlap the app's own. Values are CSS length expressions, divided by the zoom
 * because the controls are OS chrome at a fixed device size (#1352).
 */
export function titlebarInsets(platform: string): TitlebarInsets {
  switch (normalizePlatform(platform)) {
    case 'darwin':
      return { left: `calc(${MAC_TRAFFIC_LIGHT_WIDTH}px / var(--fl-zoom, 1))`, right: EDGE_PADDING }
    case 'win32':
      return { left: EDGE_PADDING, right: `calc(${WINDOWS_CONTROL_BOX_WIDTH}px / var(--fl-zoom, 1))` }
    default:
      // Standard OS frame (see `windowChromeOptions`) — no controls overlap the
      // app's titlebar row, so neither edge is reserved.
      return { left: EDGE_PADDING, right: EDGE_PADDING }
  }
}

/** Whether to show the screenshot-capture button. macOS only (#456). */
export function isCaptureAffordanceVisible(platform: string): boolean {
  return normalizePlatform(platform) === 'darwin'
}
