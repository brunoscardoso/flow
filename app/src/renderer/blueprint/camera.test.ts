import {
  clampScale,
  fitView,
  fitViewInRect,
  freeViewport,
  gridBackgroundSize,
  panBy,
  startsPan,
  zoomAt,
  PAN_START_PX,
  MIN_FREE_BAND,
  MIN_SCALE,
  MAX_SCALE,
  type Bounds,
  type Rect,
} from './camera'

describe('clampScale (#514)', () => {
  it('clamps into [MIN, MAX] and coerces non-finite to 1', () => {
    expect(clampScale(1)).toBe(1)
    expect(clampScale(10)).toBe(MAX_SCALE)
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(Number.NaN)).toBe(1)
  })
})

describe('zoomAt (#514)', () => {
  it('keeps the layout point under the pointer fixed on screen', () => {
    const cam = { x: 0, y: 0, k: 1 }
    const px = 300
    const py = 200
    const layoutBefore = { x: (px - cam.x) / cam.k, y: (py - cam.y) / cam.k }
    const next = zoomAt(cam, 1.5, px, py)
    // The same layout point must still map to (px, py) after the zoom.
    expect(next.x + layoutBefore.x * next.k).toBeCloseTo(px, 6)
    expect(next.y + layoutBefore.y * next.k).toBeCloseTo(py, 6)
    expect(next.k).toBeCloseTo(1.5, 6)
  })

  it('does not drift the pan when the scale is already clamped at the max', () => {
    const cam = { x: 40, y: 20, k: MAX_SCALE }
    const next = zoomAt(cam, 2, 100, 100) // would exceed MAX → ratio 1
    expect(next.k).toBe(MAX_SCALE)
    expect(next.x).toBe(40)
    expect(next.y).toBe(20)
  })
})

describe('panBy (#514)', () => {
  it('translates x/y and leaves scale untouched', () => {
    expect(panBy({ x: 10, y: 5, k: 1.2 }, -4, 8)).toEqual({ x: 6, y: 13, k: 1.2 })
  })
})

describe('fitView (#514)', () => {
  const viewport = { w: 800, h: 600 }
  const pad = 50

  it('centres a small graph without zooming past 1x', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }
    const cam = fitView(bounds, viewport, pad)
    expect(cam.k).toBe(1) // small content stays natural size
    // centred: left offset = (800 - 200)/2 = 300, top = (600 - 100)/2 = 250
    expect(cam.x).toBeCloseTo(300, 6)
    expect(cam.y).toBeCloseTo(250, 6)
  })

  it('scales a large graph down to fit within the padded viewport', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
    const cam = fitView(bounds, viewport, pad)
    // limiting axis: (600 - 100)/1000 = 0.5 (within [MIN, MAX])
    expect(cam.k).toBeCloseTo(0.5, 6)
    // fitted content spans 1000*0.5 = 500 → centred: x = (800-500)/2 = 150, y = (600-500)/2 = 50
    expect(cam.x).toBeCloseTo(150, 6)
    expect(cam.y).toBeCloseTo(50, 6)
  })

  it('respects a non-zero content origin (minX/minY offset)', () => {
    const bounds: Bounds = { minX: 100, minY: 100, maxX: 300, maxY: 200 }
    const cam = fitView(bounds, viewport, pad)
    const cw = 200
    const ch = 100
    expect(cam.x).toBeCloseTo((viewport.w - cw * cam.k) / 2 - 100 * cam.k, 6)
    expect(cam.y).toBeCloseTo((viewport.h - ch * cam.k) / 2 - 100 * cam.k, 6)
  })

  it('never scales below MIN_SCALE even for an enormous graph', () => {
    const cam = fitView({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, viewport, pad)
    expect(cam.k).toBe(MIN_SCALE)
  })
})

describe('freeViewport (#1064)', () => {
  it('returns the full viewport when there is no obstacle', () => {
    expect(freeViewport({ w: 800, h: 600 }, null)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('returns the full viewport when the obstacle is outside the viewport', () => {
    const obstacle: Rect = { x: 900, y: 0, w: 100, h: 100 }
    expect(freeViewport({ w: 800, h: 600 }, obstacle)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('picks the right band for the issue-#1064 geometry (778×348 stage, bottom-left card)', () => {
    // The measured default layout: card 480×292 anchored left 28 / bottom 28
    // covers 52% of the stage; the only readable band is to its right.
    const obstacle: Rect = { x: 28, y: 348 - 28 - 292, w: 480, h: 292 }
    const free = freeViewport({ w: 778, h: 348 }, obstacle)
    expect(free).toEqual({ x: 508, y: 0, w: 270, h: 348 })
    // Nothing in the free band overlaps the card horizontally.
    expect(free.x).toBeGreaterThanOrEqual(obstacle.x + obstacle.w)
  })

  it('picks the top band when it is larger than the side band', () => {
    // Wide card low on a tall stage → the band above it wins.
    const obstacle: Rect = { x: 28, y: 700, w: 900, h: 280 }
    const free = freeViewport({ w: 1000, h: 1000 }, obstacle)
    expect(free).toEqual({ x: 0, y: 0, w: 1000, h: 700 })
  })

  it('falls back to the full viewport when every band is a sliver', () => {
    // Card nearly fills the stage — no band reaches MIN_FREE_BAND.
    const viewport = { w: 400, h: 300 }
    const obstacle: Rect = { x: 28, y: 28, w: 344, h: 244 }
    expect(freeViewport(viewport, obstacle)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(MIN_FREE_BAND).toBeGreaterThan(28)
  })
})

describe('fitViewInRect (#1064)', () => {
  it('lands the fitted content INSIDE the sub-rect — clear of the obstacle', () => {
    // Issue geometry: fit two node cards into the 270px band right of the card.
    const rect: Rect = { x: 508, y: 0, w: 270, h: 348 }
    const bounds: Bounds = { minX: 40, minY: 60, maxX: 240, maxY: 220 }
    const cam = fitViewInRect(bounds, rect, 120)
    // Every corner of the fitted bounds maps into the band (x >= 508).
    const left = cam.x + bounds.minX * cam.k
    const right = cam.x + bounds.maxX * cam.k
    const top = cam.y + bounds.minY * cam.k
    const bottom = cam.y + bounds.maxY * cam.k
    expect(left).toBeGreaterThanOrEqual(rect.x)
    expect(right).toBeLessThanOrEqual(rect.x + rect.w)
    expect(top).toBeGreaterThanOrEqual(rect.y)
    expect(bottom).toBeLessThanOrEqual(rect.y + rect.h)
    // Centred within the band, not the full viewport.
    expect((left + right) / 2).toBeCloseTo(rect.x + rect.w / 2, 6)
  })

  it('adapts padding down for narrow rects instead of inverting the fit', () => {
    const rect: Rect = { x: 508, y: 0, w: 270, h: 348 }
    const cam = fitViewInRect({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, rect, 120)
    // Effective pad = min(120, 270*0.15=40.5, 348*0.15=52.2) → usable width stays positive.
    expect(cam.k).toBeGreaterThan(0)
    expect(cam.k).toBeLessThanOrEqual(1)
  })

  it('keeps a HUGE union inside the band — containment beats MIN_SCALE (#1064)', () => {
    // A big-picture union wider than the band can hold at MIN_SCALE must scale
    // further down rather than spill under the walkthrough card.
    const rect: Rect = { x: 536, y: 0, w: 680, h: 620 }
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 1900, maxY: 900 }
    const cam = fitViewInRect(bounds, rect, 120)
    expect(cam.k).toBeLessThan(MIN_SCALE)
    const left = cam.x + bounds.minX * cam.k
    const right = cam.x + bounds.maxX * cam.k
    expect(left).toBeGreaterThanOrEqual(rect.x)
    expect(right).toBeLessThanOrEqual(rect.x + rect.w)
  })

  it('degenerates to plain fitView for the full-viewport rect', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }
    const viewport = { w: 800, h: 600 }
    const direct = fitView(bounds, viewport, 50)
    const viaRect = fitViewInRect(bounds, { x: 0, y: 0, w: 800, h: 600 }, 50)
    expect(viaRect).toEqual(direct)
  })
})

describe('gridBackgroundSize (#514)', () => {
  it('scales both coarse (110) and fine (22) grid layers by k', () => {
    expect(gridBackgroundSize(1)).toBe('110px 110px, 110px 110px, 22px 22px, 22px 22px')
    expect(gridBackgroundSize(2)).toBe('220px 220px, 220px 220px, 44px 44px, 44px 44px')
  })
})

describe('startsPan (#514)', () => {
  it('is a click below the threshold and a pan at or above it', () => {
    expect(startsPan(0, 0)).toBe(false)
    expect(startsPan(1, 1)).toBe(false)
    expect(startsPan(PAN_START_PX, 0)).toBe(true)
    expect(startsPan(0, -PAN_START_PX)).toBe(true)
  })

  it('measures total travel, so a diagonal drift counts', () => {
    expect(startsPan(2, 2)).toBe(true)
    expect(startsPan(-2, -1)).toBe(true)
  })
})
