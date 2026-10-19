// WindowState pure logic — parsing, the off-screen guard, and the constructor
// overrides. No electron needed (the electron-facing wrappers are thin).

import {
  computeOverrides,
  computeSecondaryDisplayOverrides,
  isVisibleOnSomeDisplay,
  parseState,
} from './window-state'

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }

describe('parseState', () => {
  it('returns null for non-JSON', () => {
    expect(parseState('not json')).toBeNull()
  })

  it('parses a valid saved state (mode flags default to false)', () => {
    expect(parseState(JSON.stringify({ x: 100, y: 80, width: 1200, height: 800, isMaximized: true }))).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 800,
      isMaximized: true,
      isFullScreen: false,
    })
  })

  it('rejects a non-numeric size', () => {
    expect(parseState(JSON.stringify({ width: 'wide', height: 800 }))).toBeNull()
  })

  it('clamps sizes below the minimum and drops a partial position', () => {
    const state = parseState(JSON.stringify({ width: 100, height: 100, x: 5 })) // no y
    expect(state?.width).toBe(480)
    expect(state?.height).toBe(360)
    expect(state?.x).toBeUndefined()
  })
})

describe('isVisibleOnSomeDisplay', () => {
  it('is true for a rect on the primary display', () => {
    expect(isVisibleOnSomeDisplay({ x: 100, y: 100, width: 800, height: 600 }, [PRIMARY])).toBe(true)
  })

  it('is false for a rect entirely off every display', () => {
    expect(isVisibleOnSomeDisplay({ x: 5000, y: 5000, width: 800, height: 600 }, [PRIMARY])).toBe(
      false,
    )
  })

  it('is true when a second display covers the rect', () => {
    const displays = [PRIMARY, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }]
    expect(isVisibleOnSomeDisplay({ x: 2200, y: 100, width: 800, height: 600 }, displays)).toBe(true)
  })
})

describe('computeOverrides', () => {
  it('falls back to defaults when nothing is saved', () => {
    expect(computeOverrides(null, [PRIMARY], 1440, 900)).toEqual({ width: 1440, height: 900 })
  })

  it('restores saved size AND position when still on-screen', () => {
    const state = parseState(JSON.stringify({ x: 200, y: 120, width: 1000, height: 700 }))
    expect(computeOverrides(state, [PRIMARY], 1440, 900)).toEqual({
      width: 1000,
      height: 700,
      x: 200,
      y: 120,
    })
  })

  it('keeps the saved size but DROPS an off-screen position', () => {
    const state = parseState(JSON.stringify({ x: 6000, y: 6000, width: 1000, height: 700 }))
    const overrides = computeOverrides(state, [PRIMARY], 1440, 900)
    expect(overrides).toEqual({ width: 1000, height: 700 })
    expect('x' in overrides).toBe(false)
  })
})

describe('computeSecondaryDisplayOverrides', () => {
  const PRIMARY_ID = 1
  const primary = { id: PRIMARY_ID, workArea: PRIMARY.workArea }
  const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }

  it('returns null with only the primary display connected', () => {
    expect(computeSecondaryDisplayOverrides(PRIMARY_ID, [primary], 1440, 900)).toBeNull()
  })

  it('centers the window in the secondary work area', () => {
    expect(computeSecondaryDisplayOverrides(PRIMARY_ID, [primary, secondary], 1440, 900)).toEqual({
      x: 1920 + (2560 - 1440) / 2,
      y: (1440 - 900) / 2,
      width: 1440,
      height: 900,
    })
  })

  it('clamps a window larger than the secondary work area', () => {
    const small = { id: 2, workArea: { x: -1280, y: 200, width: 1280, height: 720 } }
    expect(computeSecondaryDisplayOverrides(PRIMARY_ID, [primary, small], 1440, 900)).toEqual({
      x: -1280,
      y: 200,
      width: 1280,
      height: 720,
    })
  })

  it('never picks the primary display regardless of ordering', () => {
    const overrides = computeSecondaryDisplayOverrides(PRIMARY_ID, [secondary, primary], 800, 600)
    expect(overrides?.x).toBeGreaterThanOrEqual(1920)
  })
})
