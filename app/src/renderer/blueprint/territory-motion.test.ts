import type { Rect } from './camera'
import {
  flightFor,
  isCut,
  LENS_FADE_MS,
  zoomPlan,
  ZOOM_DURATION_MS,
  type Flight,
} from './territory-motion'

const CELL: Rect = { x: 120, y: 60, w: 220, h: 96 }
const STAGE: Rect = { x: 0, y: 0, w: 900, h: 520 }

describe('zoomPlan (Phase 3.1)', () => {
  it('flies from the source rect to the destination rect over ZOOM_DURATION_MS', () => {
    const plan = zoomPlan(CELL, STAGE, false)
    expect(plan.lens.from).toEqual(CELL)
    expect(plan.lens.to).toEqual(STAGE)
    expect(plan.durationMs).toBe(ZOOM_DURATION_MS)
    expect(isCut(plan)).toBe(false)
  })

  it('is longer than the board’s medium transition — a level swap wants to be seen', () => {
    expect(ZOOM_DURATION_MS).toBe(240)
    expect(ZOOM_DURATION_MS).toBeGreaterThan(160)
    expect(LENS_FADE_MS).toBe(200)
  })

  it('does not alias its inputs — mutating the plan cannot move a cell', () => {
    const cell = { ...CELL }
    const plan = zoomPlan(cell, STAGE, false)
    plan.lens.from.x = -999
    expect(cell.x).toBe(CELL.x)
  })

  it('is deterministic — same arguments, same plan, every time', () => {
    expect(zoomPlan(CELL, STAGE, false)).toEqual(zoomPlan(CELL, STAGE, false))
    expect(flightFor('dive', CELL, STAGE, false)).toEqual(flightFor('dive', CELL, STAGE, false))
  })
})

describe('reduced motion', () => {
  it('drops the time and keeps the geometry — the lens still lands where it would have', () => {
    const moving = zoomPlan(CELL, STAGE, false)
    const still = zoomPlan(CELL, STAGE, true)
    expect(still.lens).toEqual(moving.lens)
    expect(still.durationMs).toBe(0)
    expect(isCut(still)).toBe(true)
  })

  it('applies to every flight kind that has a source rect', () => {
    for (const kind of ['dive', 'pop'] as Flight[]) {
      const still = flightFor(kind, CELL, STAGE, true)
      expect(still.durationMs).toBe(0)
      expect(still.lens).toEqual(flightFor(kind, CELL, STAGE, false).lens)
    }
  })
})

describe('flightFor — dive and pop are inverses', () => {
  it('a pop retraces the dive it undoes', () => {
    const dive = flightFor('dive', CELL, STAGE, false)
    const pop = flightFor('pop', CELL, STAGE, false)
    expect(dive.lens.from).toEqual(pop.lens.to)
    expect(dive.lens.to).toEqual(pop.lens.from)
    expect(pop.durationMs).toBe(dive.durationMs)
  })

  it('a dive grows the pressed cell into the stage', () => {
    const { lens } = flightFor('dive', CELL, STAGE, false)
    expect(lens.from).toEqual(CELL)
    expect(lens.to).toEqual(STAGE)
  })

  it('a pop shrinks the stage back into the cell it came from', () => {
    const { lens } = flightFor('pop', CELL, STAGE, false)
    expect(lens.from).toEqual(STAGE)
    expect(lens.to).toEqual(CELL)
  })
})

describe('flights that degrade to a cut', () => {
  it('a jump has no source cell — it cuts, and ignores any rect handed to it', () => {
    const jump = flightFor('jump', CELL, STAGE, false)
    expect(jump.durationMs).toBe(0)
    expect(jump.lens.from).toEqual(STAGE)
    expect(jump.lens.to).toEqual(STAGE)
    expect(jump.lens.from).toBe(jump.lens.to)
  })

  it('a missing source rect cuts rather than inventing an origin', () => {
    for (const kind of ['dive', 'pop', 'jump'] as Flight[]) {
      const plan = flightFor(kind, null, STAGE, false)
      expect(plan.durationMs).toBe(0)
      expect(plan.lens.from).toBe(plan.lens.to)
      expect(plan.lens.to).toEqual(STAGE)
    }
  })

  it('zoomPlan with a null source cuts on the destination', () => {
    const plan = zoomPlan(null, STAGE, false)
    expect(plan.durationMs).toBe(0)
    expect(plan.lens.from).toBe(plan.lens.to)
    expect(plan.lens.to).toEqual(STAGE)
  })
})

describe('degenerate rects never throw', () => {
  const degenerate: Rect[] = [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: -40, y: -12, w: 0, h: 200 },
    { x: 10, y: 10, w: -50, h: -50 },
    { x: Number.NaN, y: 0, w: 100, h: 100 },
    { x: 0, y: 0, w: Number.NaN, h: Number.POSITIVE_INFINITY },
  ]

  it('coerces every measurement to a finite, non-negative box', () => {
    for (const rect of degenerate) {
      for (const kind of ['dive', 'pop', 'jump'] as Flight[]) {
        const plan = flightFor(kind, rect, rect, false)
        for (const end of [plan.lens.from, plan.lens.to]) {
          expect(Number.isFinite(end.x)).toBe(true)
          expect(Number.isFinite(end.y)).toBe(true)
          expect(end.w).toBeGreaterThanOrEqual(0)
          expect(end.h).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('a zero-size cell still dives — an unmeasurable cell is not a broken level', () => {
    const plan = flightFor('dive', { x: 0, y: 0, w: 0, h: 0 }, STAGE, false)
    expect(plan.durationMs).toBe(ZOOM_DURATION_MS)
    expect(plan.lens.to).toEqual(STAGE)
  })

  it('keeps the sign of a legitimate off-stage origin, and clamps only the size', () => {
    const plan = zoomPlan({ x: -40, y: -12, w: -50, h: 200 }, STAGE, false)
    expect(plan.lens.from).toEqual({ x: -40, y: -12, w: 0, h: 200 })
  })
})
