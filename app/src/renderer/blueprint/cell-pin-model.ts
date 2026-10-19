/**
 * PIN & EXPLORE — the grown cell's diagram, kept and read up close. PURE — no
 * DOM, no window, no timers.
 *
 * Hovering a cell grows it and draws its diagram as a PREVIEW, fitted to the
 * room (`cell-hover-model.ts`). A click inside that diagram PINS the cell: it
 * stays grown when the pointer leaves, the rest of the map dims, and the
 * diagram becomes a viewport with a camera — drag pans, the wheel zooms, `0`
 * fits, and hovering a component lights it and its neighbours. The user asked
 * for it because the preview was too small to read (2026-10-07).
 *
 * What lives here, so the board only wires it:
 *   - the cameras: the preview's (centred, fitted), the pinned opening one
 *     (readable — ~0.85 of natural, entry/top-left in view) and Fit;
 *   - `wheelZoomFactor` — how far a wheel or a pinch zooms;
 *   - `diagramClick`, `spaceAction`, `outsideClick`, `hoverWhilePinned` — the
 *     decisions every gesture asks while a cell may be pinned;
 *   - `focusOf` — what a hovered component lights.
 *
 * The camera itself is `camera.ts`'s — the same one the storyline uses.
 */
import { clampScale, fitViewInRect, startsPan, type Camera } from './camera'

/** The pinned diagram opens at this share of its natural size — readable, not fitted. */
export const PIN_OPEN_SCALE = 0.85
/** Room left around the diagram when it is fitted (Fit, `0`). */
export const PIN_FIT_PADDING_PX = 14
/** Room left before the diagram's top-left corner when it opens pinned. */
export const PIN_OPEN_INSET_PX = 12
/** One press of the toolbar's − / + (and the keyboard's), as a zoom factor. */
export const PIN_ZOOM_STEP = 1.2
/** Wheel / pinch zoom sensitivity, per pixel of wheel delta. */
export const PIN_WHEEL_SENSITIVITY = 0.0022
/** A pinch arrives as a ctrl-wheel with small deltas: it is made this much keener. */
export const PIN_PINCH_GAIN = 4
/** A wheel in LINES (deltaMode 1) is this many pixels a line. */
export const WHEEL_LINE_PX = 16
/** A wheel in PAGES (deltaMode 2) is this many pixels a page. */
export const WHEEL_PAGE_PX = 400
/** The wheel's `deltaMode` values. */
const DELTA_LINE = 1
const DELTA_PAGE = 2

export interface Extent {
  width: number
  height: number
}

/** The camera of the PREVIEW: the diagram at `scale`, centred in the room. */
export function previewCamera(content: Extent, room: Extent, scale: number): Camera {
  return {
    k: scale,
    x: Math.max(0, (room.width - content.width * scale) / 2),
    y: Math.max(0, (room.height - content.height * scale) / 2),
  }
}

/** Fit shows ALL of the diagram, centred, never enlarged past natural size. */
export function pinFitCamera(content: Extent, room: Extent): Camera {
  return fitViewInRect(
    { minX: 0, minY: 0, maxX: content.width, maxY: content.height },
    { x: 0, y: 0, w: room.width, h: room.height },
    PIN_FIT_PADDING_PX,
  )
}

/**
 * THE PINNED DIAGRAM OPENS READABLE. Fit-to-cell is what made the preview too
 * small; pinned, the diagram opens at `PIN_OPEN_SCALE` of its natural size (or
 * the preview's own scale when that is already larger), and on each axis it
 * is centred when it fits and starts at its top-left — where the flow begins —
 * when it does not. Fit still shows all of it.
 */
export function pinOpeningCamera(content: Extent, room: Extent, previewScale: number): Camera {
  const k = clampScale(Math.min(1, Math.max(PIN_OPEN_SCALE, previewScale)))
  const axis = (size: number, space: number): number => {
    const drawn = size * k
    if (drawn + PIN_OPEN_INSET_PX * 2 <= space) return (space - drawn) / 2
    return PIN_OPEN_INSET_PX
  }
  return { k, x: axis(content.width, room.width), y: axis(content.height, room.height) }
}

/** The camera's scale as the toolbar prints it. */
export function zoomPercent(k: number): string {
  return `${String(Math.round(k * 100))}%`
}

export interface WheelInput {
  deltaY: number
  deltaMode: number
  /** A trackpad pinch arrives as a ctrl-wheel. */
  ctrlKey: boolean
}

/**
 * HOW FAR ONE WHEEL EVENT ZOOMS while pinned — no modifier needed. Down zooms
 * out, up zooms in; a pinch (ctrl-wheel, small deltas) is made keener so a
 * pinch and a wheel feel alike.
 */
export function wheelZoomFactor(input: WheelInput): number {
  let px = input.deltaY
  if (input.deltaMode === DELTA_LINE) px *= WHEEL_LINE_PX
  if (input.deltaMode === DELTA_PAGE) px *= WHEEL_PAGE_PX
  const gain = input.ctrlKey ? PIN_PINCH_GAIN : 1
  return Math.exp(-px * PIN_WHEEL_SENSITIVITY * gain)
}

/** A press inside the diagram, at release: was it a click or a drag? `camera.startsPan`'s threshold. */
export function pressWasDrag(dx: number, dy: number): boolean {
  return startsPan(dx, dy)
}

export type DiagramClick = 'pin' | 'none'

/**
 * A CLICK INSIDE A GROWN CELL'S DIAGRAM never navigates: it pins the cell when
 * the cell is not pinned yet, and does nothing more when it is. A drag is a
 * pan, never a click. Only a drawn diagram can be pinned.
 */
export function diagramClick(input: { pinned: string | null; cellKey: string; drawn: boolean; dragged: boolean }): DiagramClick {
  if (input.dragged || !input.drawn) return 'none'
  if (input.pinned === input.cellKey) return 'none'
  return 'pin'
}

export type SpaceAction = 'unpin' | 'pin' | 'grow-then-pin' | 'press'

/**
 * SPACE ON A CELL (hovered, or keyboard-focused). It toggles the pin of a cell
 * that has a diagram to explore: unpin the pinned one, pin a grown one whose
 * diagram is drawn, grow one whose diagram may still be drawn and pin it once
 * it is. A cell with nothing to explore keeps Space's old meaning — its press.
 */
export function spaceAction(input: { pinned: string | null; cellKey: string; drawn: boolean; canDraw: boolean }): SpaceAction {
  if (input.pinned === input.cellKey) return 'unpin'
  if (input.drawn) return 'pin'
  if (input.canDraw) return 'grow-then-pin'
  return 'press'
}

/**
 * A CLICK SOMEWHERE ELSE while a cell is pinned. Inside the pinned cell it is
 * the cell's business. Anywhere else it unpins — and on the map itself it is
 * SWALLOWED, so the same click never also presses the cell under it.
 */
export function outsideClick(input: { pinned: string | null; insidePinned: boolean; onSheet: boolean }): {
  unpin: boolean
  swallow: boolean
} {
  if (input.pinned === null || input.insidePinned) return { unpin: false, swallow: false }
  return { unpin: true, swallow: input.onSheet }
}

export type PinnedHover = 'pass' | 'ignore' | 'unpin'

/**
 * WHAT THE HOVER MODEL HEARS while a cell is pinned: nothing about pointers
 * (another cell's hover does nothing, leaving does not shrink it, no pause
 * ends); an Escape or a reset — a press, a re-render — ends the pin.
 */
export function hoverWhilePinned(pinned: string | null, event: 'enter' | 'leave' | 'tick' | 'escape' | 'reset'): PinnedHover {
  if (pinned === null) return 'pass'
  if (event === 'escape' || event === 'reset') return 'unpin'
  return 'ignore'
}

export interface FocusWire {
  from: string
  to: string
}

/**
 * WHAT A HOVERED COMPONENT LIGHTS — itself, every wire it is on, and the
 * component at each wire's far end. The storyline's hover focus, as data.
 */
export function focusOf(id: string, wires: readonly FocusWire[]): { on: string; near: Set<string>; wires: Set<number> } {
  const near = new Set<string>()
  const lit = new Set<number>()
  wires.forEach((wire, index) => {
    if (wire.from !== id && wire.to !== id) return
    lit.add(index)
    const other = wire.from === id ? wire.to : wire.from
    if (other !== id) near.add(other)
  })
  return { on: id, near, wires: lit }
}
