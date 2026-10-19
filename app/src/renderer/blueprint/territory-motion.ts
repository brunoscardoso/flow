/**
 * Territory motion (plan_blueprint_territory_v1, Phase 3) — PURE, no DOM.
 *
 * A level is a zoom of the level above, so the motion between levels has to say
 * so. The ring's answer was a camera: scale the whole sheet about the clicked
 * node's origin (the retired ring's motion module). Territory's answer is smaller and
 * more literal — ONE rectangle flies from the cell you pressed to the whole
 * stage, and the next level is revealed behind it. The cell you chose becomes
 * the sheet: that is the claim, drawn rather than implied.
 *
 * WHAT THIS MODULE OWNS
 * =====================
 *  - `zoomPlan` — two rectangles and a duration. Nothing else.
 *  - `flightFor` — which pair of rectangles a `dive` / `pop` / `jump` means.
 *  - `ZOOM_DURATION_MS` / `LENS_FADE_MS` — the two numbers the CSS must match.
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * No DOM, no element, no CSS, no timers, no camera. It does not create the lens
 * and it does not know that a lens is a `<div>`; it only says which rectangle
 * the lens starts at, which one it ends at, and how long it has. The board
 * (Phase 4) owns the element and the transition. There is deliberately NO free
 * camera on the feature map — `camera.ts` stays, but only the code map drives
 * it — so nothing here composes with pan/zoom state.
 *
 * WHY 240 ms WHEN THE BOARD'S MEDIUM TRANSITION IS 160 ms
 * =======================================================
 * `--fl-transition-medium` (160 ms) is for a control acknowledging a press —
 * fast enough to feel instant. This is not that. A dive REPLACES the sheet, and
 * a replacement the reader does not see happen reads as a new page rather than
 * a zoom into the thing they chose. 240 ms is the number measured on the
 * approved exploration (`flow/brainstorms/blueprint-territory-explored.html`,
 * `.lens { transition: … 240ms ease-out }`) and it is long enough to be read as
 * one continuous rectangle without being long enough to wait for.
 *
 * A CUT IS A LEGAL FLIGHT, NEVER A THROW
 * ======================================
 * Three things all mean "no flight": the reader asked for reduced motion, there
 * is no source cell (a crumb or a search jump lands on a level nobody pressed
 * into), or the caller measured a rectangle that is not a rectangle. Every one
 * of them returns a plan with `durationMs: 0` — the caller has a single code
 * path (allowed-pattern #14): apply the plan, then re-render when it is over.
 * A degraded flight must never be an exception, because the fallback for a
 * failed measurement is the thing working slightly less prettily, not the
 * level failing to open.
 */

import type { Rect } from './camera'

export type { Rect }

/**
 * How long the lens flies, in ms. Must match the CSS transition on the lens
 * element. See the note above on why this is longer than the board's medium
 * transition: a level replacement wants to be seen.
 */
export const ZOOM_DURATION_MS = 240

/**
 * How long the lens takes to fade out once it has landed, in ms. It fades
 * rather than vanishing so the new level is not revealed by a hard edge
 * disappearing; it is separate from the flight because the level is already
 * swapped by the time it runs.
 */
export const LENS_FADE_MS = 200

/**
 * Which way through the levels a flight goes.
 *
 * `dive` and `pop` keep the ring's meaning exactly — into the
 * thing you pressed, and back out of the thing you are leaving. `jump` is new
 * and is the honest name for what a crumb press or a search result is: a level
 * change with no cell behind it. The ring called that a pop and lied about the
 * origin; Territory calls it a jump and cuts.
 */
export type Flight = 'dive' | 'pop' | 'jump'

/** Where the lens starts and where it ends. Both in stage-relative px. */
export interface Lens {
  from: Rect
  to: Rect
}

/** A flight, fully decided: two rectangles and how long to take over them. */
export interface ZoomPlan {
  lens: Lens
  durationMs: typeof ZOOM_DURATION_MS | 0
}

/** True when a plan is a cut — nothing to animate, swap the level now. */
export function isCut(plan: ZoomPlan): boolean {
  return plan.durationMs === 0
}

/**
 * A rectangle the CSS can be handed without checking it first.
 *
 * `getBoundingClientRect` on an unmounted or display-none element is all zeros,
 * a stage mid-resize can hand back a negative size, and a `NaN` anywhere in a
 * `left`/`width` would silently poison the transition. Everything is coerced to
 * a finite, non-negative box here so no consumer has to, and so a degenerate
 * measurement degrades to a zero-size flight instead of throwing.
 */
function box(rect: Rect): Rect {
  return {
    x: Number.isFinite(rect.x) ? rect.x : 0,
    y: Number.isFinite(rect.y) ? rect.y : 0,
    w: Number.isFinite(rect.w) ? Math.max(0, rect.w) : 0,
    h: Number.isFinite(rect.h) ? Math.max(0, rect.h) : 0,
  }
}

/** A flight that isn't one: the lens sits still on `rect` for no time at all. */
function cut(rect: Rect): ZoomPlan {
  // One object for both ends on purpose — a cut has no distance, and sharing it
  // makes `from === to` true for any caller that asks the question that way.
  const still = box(rect)
  return { lens: { from: still, to: still }, durationMs: 0 }
}

/**
 * The plan for flying the lens from one rectangle to another.
 *
 * `fromRect` is nullable because the caller regularly cannot answer it — a
 * crumb jump has no source cell, and a cell scrolled out of the level being
 * left has no rectangle on screen. Null is not an error; it is a cut.
 *
 * Reduced motion keeps BOTH rectangles and drops only the time. The lens still
 * lands exactly where it would have, so a caller that positions anything from
 * `lens.to` gets the same answer either way — the setting removes the motion,
 * not the geometry.
 */
export function zoomPlan(fromRect: Rect | null, toRect: Rect, reducedMotion: boolean): ZoomPlan {
  if (fromRect === null) return cut(toRect)
  return {
    lens: { from: box(fromRect), to: box(toRect) },
    durationMs: reducedMotion ? 0 : ZOOM_DURATION_MS,
  }
}

/**
 * The plan for a level change, by what the reader did.
 *
 *  - `dive` — the pressed cell grows to fill the stage; the level inside it is
 *    revealed behind the lens. Cell → stage.
 *  - `pop` — the exact inverse: the stage shrinks back into the cell the level
 *    being left occupies in its parent, so leaving looks like the reverse of
 *    arriving rather than a second, different animation.
 *  - `jump` — a crumb or a search result. Nobody pressed a cell, so there is no
 *    rectangle to fly from and inventing one would animate a lie. Always a cut,
 *    `cellRect` ignored.
 *
 * A null `cellRect` degrades any kind to a cut on the stage.
 */
export function flightFor(
  kind: Flight,
  cellRect: Rect | null,
  stageRect: Rect,
  reducedMotion: boolean,
): ZoomPlan {
  if (kind === 'jump' || cellRect === null) return cut(stageRect)
  if (kind === 'pop') return zoomPlan(stageRect, cellRect, reducedMotion)
  return zoomPlan(cellRect, stageRect, reducedMotion)
}
