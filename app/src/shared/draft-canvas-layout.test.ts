// The canvas viewer's layout math — and the inlined copy the served page runs.

import { DEFAULT_DRAFT_FRAME } from './ui-drafts'
import { createDraftCanvasMath, draftCanvasMathSource, type DraftCanvasMath } from './draft-canvas-layout'

const defaults = { w: DEFAULT_DRAFT_FRAME.w, h: DEFAULT_DRAFT_FRAME.h, gap: DEFAULT_DRAFT_FRAME.gap }
const direct = createDraftCanvasMath(defaults)
// The page's own copy: the factory's source, evaluated with no outside names.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inlined = new Function(`return ${draftCanvasMathSource(defaults)}`)() as DraftCanvasMath

describe.each([
  ['the module', direct],
  ['the copy inlined in the page', inlined],
])('draft canvas math — %s', (_name, math) => {
  it('places frames from the layout, and falls back to a row for a missing or broken frame', () => {
    expect(
      math.frameRects([
        { id: 'a', frame: { x: 10, y: 20, w: 300, h: 600 } },
        { id: 'b' },
        { id: 'c', frame: { x: 'left', w: -5, h: Number.NaN } },
      ]),
    ).toEqual([
      { id: 'a', x: 10, y: 20, w: 300, h: 600 },
      { id: 'b', x: 470, y: 0, w: 390, h: 844 },
      { id: 'c', x: 940, y: 0, w: 390, h: 844 },
    ])
  })

  it('bounds every frame and the label above it; no frames have no bounds', () => {
    const rects = math.frameRects([
      { id: 'a', frame: { x: 0, y: 0, w: 100, h: 200 } },
      { id: 'b', frame: { x: 150, y: 50, w: 100, h: 200 } },
    ])
    expect(math.bounds(rects)).toEqual({ x: 0, y: -math.LABEL_SPACE, w: 250, h: 250 + math.LABEL_SPACE })
    expect(math.bounds([])).toBeNull()
  })

  it('fits everything in the viewport, centred, and never zooms past 100%', () => {
    const box = { x: 0, y: -28, w: 860, h: 872 }
    const view = math.fitToView(box, { w: 1000, h: 600 }, 48)
    expect(view.zoom).toBeCloseTo((600 - 96) / 872)
    // Centred: the box's middle is the viewport's middle.
    expect(view.x + (box.x + box.w / 2) * view.zoom).toBeCloseTo(500)
    expect(view.y + (box.y + box.h / 2) * view.zoom).toBeCloseTo(300)
    // A small canvas is shown at 100%, not blown up.
    expect(math.fitToView({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 1000 }).zoom).toBe(1)
    // A huge canvas stops at the lower bound.
    expect(math.fitToView({ x: 0, y: 0, w: 1e6, h: 1e6 }, { w: 800, h: 600 }).zoom).toBe(math.MIN_ZOOM)
    expect(math.fitToView(null, { w: 800, h: 600 })).toEqual({ zoom: 1, x: 48, y: 48 })
  })

  it('zooms around a point, keeping the canvas point under it still', () => {
    const view = { zoom: 1, x: 100, y: 50 }
    const point = { x: 400, y: 300 }
    const next = math.zoomAt(view, 2, point)
    expect(next.zoom).toBe(2)
    const before = { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom }
    const after = { x: (point.x - next.x) / next.zoom, y: (point.y - next.y) / next.zoom }
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('keeps zoom between 10% and 400%', () => {
    expect(math.clampZoom(0.01)).toBe(0.1)
    expect(math.clampZoom(9)).toBe(4)
    expect(math.clampZoom(Number.NaN)).toBe(1)
    expect(math.zoomAt({ zoom: 3, x: 0, y: 0 }, 50, { x: 0, y: 0 }).zoom).toBe(4)
    let view = { zoom: 1, x: 0, y: 0 }
    for (let step = 0; step < 50; step += 1) view = math.wheelZoom(view, 100, 0, { x: 10, y: 10 })
    expect(view.zoom).toBe(0.1)
    for (let step = 0; step < 50; step += 1) view = math.wheelZoom(view, -100, 1, { x: 10, y: 10 })
    expect(view.zoom).toBe(4)
  })

  it('wheel up zooms in, wheel down zooms out', () => {
    const view = { zoom: 1, x: 0, y: 0 }
    expect(math.wheelZoom(view, -10, 0, { x: 0, y: 0 }).zoom).toBeGreaterThan(1)
    expect(math.wheelZoom(view, 10, 0, { x: 0, y: 0 }).zoom).toBeLessThan(1)
  })

  it('steps the − / + buttons through named zooms around the centre', () => {
    const viewport = { w: 800, h: 600 }
    expect(math.stepZoom({ zoom: 0.8, x: 0, y: 0 }, 1, viewport).zoom).toBe(1)
    expect(math.stepZoom({ zoom: 0.8, x: 0, y: 0 }, -1, viewport).zoom).toBe(0.67)
    expect(math.stepZoom({ zoom: 0.72, x: 0, y: 0 }, 1, viewport).zoom).toBe(0.8)
    expect(math.stepZoom({ zoom: 4, x: 0, y: 0 }, 1, viewport).zoom).toBe(4)
    expect(math.stepZoom({ zoom: 0.1, x: 0, y: 0 }, -1, viewport).zoom).toBe(0.1)
  })

  it('keeps the view in the page address and reads it back; anything else is no view', () => {
    const hash = math.formatViewHash({ zoom: 0.8, x: -120.456, y: 33 })
    expect(hash).toBe('#view=0.8,-120.46,33')
    expect(math.parseViewHash(hash)).toEqual({ zoom: 0.8, x: -120.46, y: 33 })
    expect(math.parseViewHash('#view=99,0,0')).toEqual({ zoom: 4, x: 0, y: 0 })
    for (const bad of ['', '#', '#view=0,0,0', '#view=a,b,c', '#view=1,2', '#view=1,1e9,0', '#other']) {
      expect([bad, math.parseViewHash(bad)]).toEqual([bad, null])
    }
  })
})
