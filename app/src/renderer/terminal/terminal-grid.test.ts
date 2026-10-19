import { computeTerminalGrid, MIN_COLS, MIN_ROWS } from './terminal-grid'

const CELL = { width: 8, height: 16 }

describe('computeTerminalGrid (#99)', () => {
  it('computes cols/rows from the host rect and cell size', () => {
    // (808-8)/8 = 100 cols, (404-4)/16 = 25 rows
    expect(computeTerminalGrid({ width: 808, height: 404 }, CELL, true)).toEqual({
      cols: 100,
      rows: 25,
    })
  })

  it('returns null when the host is disconnected (panel hidden) — no PTY resize', () => {
    expect(computeTerminalGrid({ width: 808, height: 404 }, CELL, false)).toBeNull()
  })

  it('returns null for a 0×0 host instead of clamping to the minimum grid', () => {
    expect(computeTerminalGrid({ width: 0, height: 0 }, CELL, true)).toBeNull()
    expect(computeTerminalGrid({ width: 800, height: 0 }, CELL, true)).toBeNull()
    expect(computeTerminalGrid({ width: 0, height: 400 }, CELL, true)).toBeNull()
  })

  it('returns null when cell metrics are unavailable (0×0 cell)', () => {
    expect(computeTerminalGrid({ width: 800, height: 400 }, { width: 0, height: 0 }, true)).toBeNull()
  })

  it('floors a genuinely tiny (but present) host at the minimum grid', () => {
    const grid = computeTerminalGrid({ width: 10, height: 10 }, CELL, true)
    expect(grid).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
  })
})
