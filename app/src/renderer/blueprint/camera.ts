// Board camera (#514) — pure pan/zoom/fit math over layoutStage output. The
// board renders the map into one transformed inner surface; this module owns the
// transform arithmetic so it's deterministic and unit-testable with no DOM.
//
// A layout point (lx, ly) maps to a viewport point (sx, sy) via the surface's
// CSS `translate(x,y) scale(k)` (transform-origin 0 0):
//     sx = x + lx * k,  sy = y + ly * k
// so the inverse (viewport → layout) is  lx = (sx - x) / k.

/** Pan offset (x, y) in viewport px + zoom scale k. */
export interface Camera {
  x: number
  y: number
  k: number
}

/** A layout-space bounding box (card extents). */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Size {
  w: number
  h: number
}

/** A viewport-space rectangle (x/y = top-left, in viewport px). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const MIN_SCALE = 0.4
export const MAX_SCALE = 2
export const IDENTITY: Camera = { x: 0, y: 0, k: 1 }

/** Clamp a zoom into [MIN_SCALE, MAX_SCALE]; non-finite → 1. */
export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))
}

/**
 * Zoom by `factor` about the viewport point (px, py), keeping whatever is under
 * that point fixed on screen. The scale is clamped, so at a limit the pan is left
 * unchanged (ratio = 1) — no drift when you keep scrolling past min/max.
 */
export function zoomAt(cam: Camera, factor: number, px: number, py: number): Camera {
  const k = clampScale(cam.k * factor)
  const ratio = k / cam.k
  return {
    k,
    x: px - (px - cam.x) * ratio,
    y: py - (py - cam.y) * ratio,
  }
}

/** Translate the camera by a viewport-space delta (drag-to-pan). */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy }
}

/**
 * Camera that centres `bounds` within `viewport` with `padding` on all sides.
 * Never zooms IN past 1× (a small graph stays its natural size, centred rather
 * than blown up); scales down (to MIN_SCALE) to bring a large graph fully in view.
 */
export function fitView(bounds: Bounds, viewport: Size, padding: number): Camera {
  const cw = Math.max(1, bounds.maxX - bounds.minX)
  const ch = Math.max(1, bounds.maxY - bounds.minY)
  const kx = (viewport.w - padding * 2) / cw
  const ky = (viewport.h - padding * 2) / ch
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(kx, ky, 1)))
  return {
    k,
    x: (viewport.w - cw * k) / 2 - bounds.minX * k,
    y: (viewport.h - ch * k) / 2 - bounds.minY * k,
  }
}

/** A free band narrower/shorter than this is useless for reading nodes — fall
 *  back to the full viewport instead of cramming the fit into a sliver (#1064). */
export const MIN_FREE_BAND = 120

/**
 * The largest band of `viewport` NOT covered by `obstacle` — the region a
 * camera fit should target when floating chrome (the preview walkthrough card,
 * #1064) occludes part of the stage. Considers the four bands beside the
 * obstacle (above / below / left / right) and returns the one with the largest
 * area. Falls back to the full viewport when there is no obstacle, when the
 * obstacle doesn't overlap the viewport, or when the best band is too small to
 * be useful (narrow stage — better centred-behind than unreadable-sliver).
 */
export function freeViewport(viewport: Size, obstacle: Rect | null): Rect {
  const full: Rect = { x: 0, y: 0, w: viewport.w, h: viewport.h }
  if (obstacle === null) return full
  const x1 = Math.max(0, obstacle.x)
  const y1 = Math.max(0, obstacle.y)
  const x2 = Math.min(viewport.w, obstacle.x + obstacle.w)
  const y2 = Math.min(viewport.h, obstacle.y + obstacle.h)
  if (x2 <= x1 || y2 <= y1) return full // obstacle fully outside the viewport
  const bands: Rect[] = [
    { x: 0, y: 0, w: viewport.w, h: y1 }, // above
    { x: 0, y: y2, w: viewport.w, h: viewport.h - y2 }, // below
    { x: 0, y: 0, w: x1, h: viewport.h }, // left
    { x: x2, y: 0, w: viewport.w - x2, h: viewport.h }, // right
  ]
  let best = bands[0]
  for (const band of bands) {
    if (band.w * band.h > best.w * best.h) best = band
  }
  if (best.w < MIN_FREE_BAND || best.h < MIN_FREE_BAND) return full
  return best
}

/** Absolute scale floor for obstacle-aware fits — guards degenerate rects
 *  without re-introducing the MIN_SCALE spill (see fitViewInRect). */
export const MIN_FIT_SCALE = 0.1

/**
 * Fit `bounds` centred within a SUB-RECT of the viewport (obstacle-aware fit,
 * #1064): same math as `fitView` over the rect's size, then offset by the
 * rect's origin so the content lands inside the rect, not the full viewport.
 * Padding adapts down for narrow rects so a thin band keeps usable interior.
 *
 * Unlike `fitView`, this does NOT clamp to the interactive MIN_SCALE floor:
 * the whole point of this fit is keeping nodes OUT of an occluded region —
 * a large union spilling under the obstacle is worse than a small render
 * (the next wheel/keys interaction re-clamps via zoomAt as usual). A tiny
 * absolute floor still guards degenerate inputs.
 */
export function fitViewInRect(bounds: Bounds, rect: Rect, padding: number): Camera {
  const pad = Math.max(0, Math.min(padding, rect.w * 0.15, rect.h * 0.15))
  const cw = Math.max(1, bounds.maxX - bounds.minX)
  const ch = Math.max(1, bounds.maxY - bounds.minY)
  const kx = (rect.w - pad * 2) / cw
  const ky = (rect.h - pad * 2) / ch
  const k = Math.max(MIN_FIT_SCALE, Math.min(MAX_SCALE, Math.min(kx, ky, 1)))
  return {
    k,
    x: rect.x + (rect.w - cw * k) / 2 - bounds.minX * k,
    y: rect.y + (rect.h - ch * k) / 2 - bounds.minY * k,
  }
}

/** The grid `background-size` string for a camera (coarse 110px + fine 22px layers). */
export function gridBackgroundSize(k: number): string {
  const coarse = 110 * k
  const fine = 22 * k
  return `${coarse}px ${coarse}px, ${coarse}px ${coarse}px, ${fine}px ${fine}px, ${fine}px ${fine}px`
}

/**
 * How far a press must travel before it is a pan rather than a click.
 *
 * Below this a press on a card still activates the card — the threshold is what
 * keeps "click a module" and "drag the map" from being the same gesture. It
 * lived beside the retired ring's motion module and moved here with the code
 * map's camera, so the map's one drag threshold has one home.
 */
export const PAN_START_PX = 3

/** True once a press has travelled far enough to be a pan. */
export function startsPan(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) >= PAN_START_PX
}
