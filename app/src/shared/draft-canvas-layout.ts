/**
 * THE CANVAS VIEWER'S LAYOUT MATH — frame positions (with the row fallback),
 * bounds, fit-to-view, zoom around a point, zoom bounds and the view kept in
 * the page address. DOM-free and pure.
 *
 * ONE FACTORY, NO OUTSIDE NAMES. The served canvas page cannot load a script
 * (its policy allows only inline code), so main inlines this logic into the
 * page as `(${createDraftCanvasMath.toString()})(defaults)`. Everything the
 * functions use is therefore defined inside the factory or passed in: a
 * reference to a module-level name would survive the tests and break in the
 * page. The tests run the inlined copy too, so the page runs the code that was
 * tested.
 */

/** Where a screen's frame sits, in canvas pixels. */
export interface CanvasRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** A screen as the layout gives it; a missing or broken frame falls back to the row. */
export interface CanvasScreenInput {
  id: string
  frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null
}

/** The visible part of the canvas: screen = canvas * zoom + (x, y). */
export interface CanvasView {
  zoom: number
  x: number
  y: number
}

export interface CanvasBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasSize {
  w: number
  h: number
}

export interface CanvasDefaults {
  w: number
  h: number
  gap: number
}

export interface DraftCanvasMath {
  MIN_ZOOM: number
  MAX_ZOOM: number
  /** Room above each frame for its label, in canvas pixels. */
  LABEL_SPACE: number
  clampZoom(zoom: number): number
  frameRects(screens: CanvasScreenInput[]): CanvasRect[]
  bounds(rects: CanvasRect[]): CanvasBounds | null
  fitToView(bounds: CanvasBounds | null, viewport: CanvasSize, padding?: number): CanvasView
  zoomAt(view: CanvasView, zoom: number, point: { x: number; y: number }): CanvasView
  wheelZoom(view: CanvasView, deltaY: number, deltaMode: number, point: { x: number; y: number }): CanvasView
  stepZoom(view: CanvasView, direction: 1 | -1, viewport: CanvasSize): CanvasView
  formatViewHash(view: CanvasView): string
  parseViewHash(hash: string): CanvasView | null
}

export function createDraftCanvasMath(defaults: CanvasDefaults): DraftCanvasMath {
  const MIN_ZOOM = 0.1
  const MAX_ZOOM = 4
  const LABEL_SPACE = 28
  const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4]

  function finite(value: unknown): value is number {
    return typeof value === 'number' && isFinite(value)
  }

  function clampZoom(zoom: number): number {
    if (!finite(zoom) || zoom <= 0) return 1
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  }

  function frameRects(screens: CanvasScreenInput[]): CanvasRect[] {
    return screens.map((screen, index) => {
      const frame = screen.frame || {}
      const w = finite(frame.w) && frame.w > 0 ? frame.w : defaults.w
      const h = finite(frame.h) && frame.h > 0 ? frame.h : defaults.h
      return {
        id: screen.id,
        x: finite(frame.x) ? frame.x : index * (defaults.w + defaults.gap),
        y: finite(frame.y) ? frame.y : 0,
        w,
        h,
      }
    })
  }

  /** Every frame and the label above it. */
  function bounds(rects: CanvasRect[]): CanvasBounds | null {
    if (rects.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
      left = Math.min(left, rect.x)
      top = Math.min(top, rect.y - LABEL_SPACE)
      right = Math.max(right, rect.x + rect.w)
      bottom = Math.max(bottom, rect.y + rect.h)
    }
    return { x: left, y: top, w: right - left, h: bottom - top }
  }

  /** Fit the bounds in the viewport, centred, never zoomed past 100%. */
  function fitToView(box: CanvasBounds | null, viewport: CanvasSize, padding?: number): CanvasView {
    const pad = finite(padding) ? padding : 48
    if (box === null || box.w <= 0 || box.h <= 0) return { zoom: 1, x: pad, y: pad }
    const room = { w: Math.max(1, viewport.w - pad * 2), h: Math.max(1, viewport.h - pad * 2) }
    const zoom = clampZoom(Math.min(1, room.w / box.w, room.h / box.h))
    return {
      zoom,
      x: (viewport.w - box.w * zoom) / 2 - box.x * zoom,
      y: (viewport.h - box.h * zoom) / 2 - box.y * zoom,
    }
  }

  /** Zoom to `zoom` keeping the canvas point under `point` (screen pixels) still. */
  function zoomAt(view: CanvasView, zoom: number, point: { x: number; y: number }): CanvasView {
    const next = clampZoom(zoom)
    const canvasX = (point.x - view.x) / view.zoom
    const canvasY = (point.y - view.y) / view.zoom
    return { zoom: next, x: point.x - canvasX * next, y: point.y - canvasY * next }
  }

  /** A wheel or pinch step: lines and pages count as many pixels. */
  function wheelZoom(view: CanvasView, deltaY: number, deltaMode: number, point: { x: number; y: number }): CanvasView {
    const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
    const bounded = Math.max(-200, Math.min(200, pixels))
    return zoomAt(view, view.zoom * Math.exp(-bounded * 0.01), point)
  }

  /** The − / + buttons: the next named step, around the viewport's centre. */
  function stepZoom(view: CanvasView, direction: 1 | -1, viewport: CanvasSize): CanvasView {
    const current = view.zoom
    let target = direction > 0 ? MAX_ZOOM : MIN_ZOOM
    if (direction > 0) {
      for (const step of STEPS) {
        if (step > current + 0.001) {
          target = step
          break
        }
      }
    } else {
      for (let index = STEPS.length - 1; index >= 0; index -= 1) {
        if (STEPS[index] < current - 0.001) {
          target = STEPS[index]
          break
        }
      }
    }
    return zoomAt(view, target, { x: viewport.w / 2, y: viewport.h / 2 })
  }

  function formatViewHash(view: CanvasView): string {
    const round = (value: number): string => String(Math.round(value * 100) / 100)
    return `#view=${round(view.zoom)},${round(view.x)},${round(view.y)}`
  }

  /** The view a page address keeps, or null when it keeps none (or a broken one). */
  function parseViewHash(hash: string): CanvasView | null {
    const match = /^#view=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(typeof hash === 'string' ? hash : '')
    if (match === null) return null
    const [zoom, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (!finite(zoom) || !finite(x) || !finite(y) || zoom <= 0) return null
    if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return null
    return { zoom: clampZoom(zoom), x, y }
  }

  return {
    MIN_ZOOM,
    MAX_ZOOM,
    LABEL_SPACE,
    clampZoom,
    frameRects,
    bounds,
    fitToView,
    zoomAt,
    wheelZoom,
    stepZoom,
    formatViewHash,
    parseViewHash,
  }
}

/** The page's inline copy: the factory's own source, called with the defaults. */
export function draftCanvasMathSource(defaults: CanvasDefaults): string {
  return `(${createDraftCanvasMath.toString()})(${JSON.stringify(defaults)})`
}
