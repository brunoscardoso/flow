// Pure terminal grid sizing (#99). DOM-free so the "don't resize a hidden
// panel" rule is unit-testable without xterm / a real layout.

export interface TerminalGrid {
  cols: number
  rows: number
}

/** Smallest grid xterm/PTY is ever sized to. */
export const MIN_COLS = 2
export const MIN_ROWS = 2

/** Starting grid for a terminal created before the panel has layout. */
export const DEFAULT_GRID: TerminalGrid = { cols: 80, rows: 24 }

/**
 * Grid (cols×rows) for a terminal host of the given pixel `rect` and character
 * `cell` size. Returns null when there is NO layout area — the host is
 * disconnected (panel hidden → removed from the DOM) or measures 0×0 — so the
 * caller skips resizing. Without this bail, a 0×0 host clamps to MIN_COLS/
 * MIN_ROWS and SIGWINCHes the live PTY down to the minimum grid, reflowing any
 * running full-screen program (htop/vim/less) on every panel toggle.
 */
export function computeTerminalGrid(
  rect: { width: number; height: number },
  cell: { width: number; height: number },
  connected: boolean,
): TerminalGrid | null {
  if (!connected) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  if (cell.width <= 0 || cell.height <= 0) return null
  return {
    cols: Math.max(MIN_COLS, Math.floor((rect.width - 8) / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor((rect.height - 4) / cell.height)),
  }
}
