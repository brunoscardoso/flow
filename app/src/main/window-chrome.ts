/**
 * Window chrome per platform (Windows support, Phase 7).
 *
 * macOS uses `hiddenInset`: the traffic lights sit INSIDE the app's own
 * titlebar row, which is why the renderer reserves 78px on its left edge.
 *
 * Windows was getting the same option, and `hiddenInset` is macOS-only. On
 * Windows any non-`default` titleBarStyle removes the standard frame, and
 * without `titleBarOverlay` no window controls are drawn in its place — so the
 * window shipped with no minimize / maximize / close buttons at all. `hidden` +
 * `titleBarOverlay` restores them as the Window Controls Overlay: OS-drawn
 * caption buttons painted over the top-right of the app's own titlebar. The
 * renderer keeps `WINDOWS_CONTROL_BOX_WIDTH` clear on the right for them
 * (see `renderer/platform-affordances.ts`).
 *
 * Pure and platform-parameterized so both branches are testable off-platform —
 * the shape `attachments/capture-support.ts` established.
 */
import type { BrowserWindowConstructorOptions } from 'electron'

/** Height of the app's own titlebar row (`.fl-titlebar`), in CSS px. */
export const TITLEBAR_HEIGHT = 34

/**
 * Width of the Windows caption-button box: three Chromium caption buttons at
 * 46 CSS px each. The renderer reserves exactly this much on the right so the
 * titlebar's own controls never sit under the OS ones.
 */
export const WINDOWS_CONTROL_BOX_WIDTH = 138

/**
 * Overlay colors. These must track the DARK values of `--fl-color-bg` and
 * `--fl-color-text-secondary` in `renderer/theme/tokens.css`; main already
 * hardcodes a dark `backgroundColor` for the same reason. The overlay is set at
 * window creation and is NOT re-themed when the user picks the light theme —
 * a known cosmetic gap that needs a theme→main channel to close.
 */
const OVERLAY_COLOR = '#181818'
const OVERLAY_SYMBOL_COLOR = '#9d9d9d'

export type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay'
>

/** The titlebar options for a platform. Spread into `new BrowserWindow({…})`. */
export function windowChromeOptions(platform: NodeJS.Platform | string): WindowChromeOptions {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' }
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: OVERLAY_COLOR,
        symbolColor: OVERLAY_SYMBOL_COLOR,
        height: TITLEBAR_HEIGHT,
      },
    }
  }
  // Linux and anything else: the standard OS frame. Never a frameless window
  // the user has no way to close.
  return { titleBarStyle: 'default' }
}
