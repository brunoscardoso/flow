/**
 * THE CELL THAT GROWS IN PLACE (plan cell-hover-diagram). PURE — no DOM, no
 * window, no timers.
 *
 * Hovering a Territory or Workspace cell for a moment grows THAT cell where it
 * stands: the level is laid out again with it taking most of the room
 * (`focusLayout` in `territory-layout.ts`), the other cells shrink around it,
 * and the grown cell draws its diagram inside itself (or its description when
 * it has none, or "Drawing…" while the diagram is read). Leaving puts the map
 * back. There is no card and no overlay (user, 2026-10-07: "same component,
 * same place, only changing the size of the items").
 *
 * What lives here, so the board only wires it:
 *   - `hoverReduce`        — when a cell grows, which cell is grown, and when
 *                            it shrinks back (keyboard focus is the same events
 *                            as the pointer: focus = enter, blur = leave);
 *   - `grownContent`       — what the grown cell's body shows;
 *   - `chooseDiagramLayout`— which of a diagram's layouts fits the cell best;
 *   - `isLayoutEcho`       — whether a pointer event is the map moving under a
 *                            still pointer rather than the reader moving it.
 *
 * TIMERS. The model never runs one. After every dispatch the board asks
 * `hoverDeadline(state)`: a number means "(re)arm ONE timeout to fire at that
 * time and dispatch `{ type: 'tick' }`", null means "clear any timeout".
 *
 * THE GROWN CELL OUTLIVES A PASSING POINTER. Moving off a grown cell onto a
 * shrunk neighbour starts the neighbour's pause but keeps the grown one grown
 * (`pending.grown`): re-laying the map back and forth for a pointer that is
 * only passing through is exactly the thrash the pause exists to prevent. When
 * the pause ends the grow moves to the neighbour in one re-layout; when the
 * pointer leaves for the bare sheet, the grown one shrinks after a short grace.
 */

/** The pause before a hovered cell grows. */
export const HOVER_GROW_DELAY_MS = 350
/** How long a grown cell survives the pointer leaving it. */
export const HOVER_CLOSE_GRACE_MS = 120
/** How long the map takes to re-lay itself — the cells' own CSS transition. */
export const GROW_TRANSITION_MS = 220

export interface Size {
  width: number
  height: number
}

/**
 * Below this scale a diagram's words stop being readable; a layout that has to
 * shrink further is chosen only when no layout can stay above it.
 */
export const DIAGRAM_LEGIBLE_SCALE = 0.6

/** One way of laying a diagram out for the cell: its natural size and the scale that fits it. */
export interface DiagramLayoutCandidate {
  content: Size
  scale: number
}

/**
 * WHICH LAYOUT THE GROWN CELL DRAWS. The flow is laid out at several widths: a
 * narrow one stacks its stages into one tall column (wires looping round its
 * side), a wide one sets them side by side and shrinks. Keeping the largest
 * scale always chose the tall column — it never had to shrink — and drew a
 * sliver in the middle of a landscape cell.
 *
 * So the cell keeps the layout that FILLS it best — the most drawn area —
 * among the ones still readable; ties go to the larger scale, then to the
 * earlier (narrower) candidate. Returns the chosen index, or -1 for none.
 */
export function chooseDiagramLayout(candidates: readonly DiagramLayoutCandidate[]): number {
  const drawn = (candidate: DiagramLayoutCandidate): number =>
    candidate.content.width * candidate.content.height * candidate.scale * candidate.scale
  const readable = candidates.some((candidate) => candidate.scale >= DIAGRAM_LEGIBLE_SCALE)
  let best = -1
  candidates.forEach((candidate, index) => {
    if (readable && candidate.scale < DIAGRAM_LEGIBLE_SCALE) return
    if (best === -1) {
      best = index
      return
    }
    const current = candidates[best] as DiagramLayoutCandidate
    const gain = drawn(candidate) - drawn(current)
    if (gain > 1 || (Math.abs(gain) <= 1 && candidate.scale > current.scale)) best = index
  })
  return best
}

/** The scale (0..1] that fits `content` in `room` — never enlarged. */
export function fitScale(content: Size, room: Size): number {
  const byWidth = content.width > 0 ? room.width / content.width : 1
  const byHeight = content.height > 0 ? room.height / content.height : 1
  return Math.max(0, Math.min(1, byWidth, byHeight))
}

export type GrownContent = 'description' | 'drawing' | 'diagram'

/** What the grown cell's body shows: a remote project has no diagram to read. */
export function grownContent(input: { remote: boolean; loading: boolean; hasDiagram: boolean }): GrownContent {
  if (input.remote) return 'description'
  if (input.loading) return 'drawing'
  if (input.hasDiagram) return 'diagram'
  return 'description'
}

export type HoverState =
  | { kind: 'idle' }
  /**
   * Hovered; it grows once `since + HOVER_GROW_DELAY_MS` passes. `grown` is the
   * cell still grown from before (the pointer came off it), or null.
   */
  | { kind: 'pending'; cellId: string; since: number; grown: string | null }
  /** Grown, with the pointer (or focus) on it. */
  | { kind: 'open'; cellId: string }
  /** Grown but left; it shrinks back at `since + HOVER_CLOSE_GRACE_MS`. */
  | { kind: 'closing'; cellId: string; since: number }

export type HoverEvent =
  | { type: 'enter'; cellId: string }
  | { type: 'leave'; cellId: string }
  | { type: 'tick' }
  | { type: 'escape' }
  | { type: 'reset' }

export const HOVER_IDLE: HoverState = { kind: 'idle' }

/** The cell drawn grown right now, or null for the plain map. */
export function grownCellId(state: HoverState): string | null {
  if (state.kind === 'open' || state.kind === 'closing') return state.cellId
  if (state.kind === 'pending') return state.grown
  return null
}

/** When the board's single timeout must fire, or null for none. */
export function hoverDeadline(state: HoverState): number | null {
  if (state.kind === 'pending') return state.since + HOVER_GROW_DELAY_MS
  if (state.kind === 'closing') return state.since + HOVER_CLOSE_GRACE_MS
  return null
}

function onEnter(state: HoverState, cellId: string, now: number): HoverState {
  if (state.kind === 'pending' && state.cellId === cellId) return state
  if (state.kind === 'open' && state.cellId === cellId) return state
  // BACK ONTO THE GROWN CELL: it is already grown, so no pause.
  if (grownCellId(state) === cellId) return { kind: 'open', cellId }
  return { kind: 'pending', cellId, since: now, grown: grownCellId(state) }
}

function onLeave(state: HoverState, cellId: string, now: number): HoverState {
  if (state.kind === 'pending' && state.cellId === cellId) {
    return state.grown === null ? HOVER_IDLE : { kind: 'closing', cellId: state.grown, since: now }
  }
  if (state.kind === 'open' && state.cellId === cellId) return { kind: 'closing', cellId, since: now }
  return state
}

function onTick(state: HoverState, now: number): HoverState {
  if (state.kind === 'pending' && now >= state.since + HOVER_GROW_DELAY_MS) {
    return { kind: 'open', cellId: state.cellId }
  }
  if (state.kind === 'closing' && now >= state.since + HOVER_CLOSE_GRACE_MS) return HOVER_IDLE
  return state
}

/** The hover state after `event` at time `now`. Never mutates `state`. */
export function hoverReduce(state: HoverState, event: HoverEvent, now: number): HoverState {
  switch (event.type) {
    case 'enter':
      return onEnter(state, event.cellId, now)
    case 'leave':
      return onLeave(state, event.cellId, now)
    case 'tick':
      return onTick(state, now)
    case 'escape':
    case 'reset':
      return HOVER_IDLE
  }
}

/** Where the pointer was last seen by a real boundary event. */
export interface PointerMark {
  x: number
  y: number
}

/** How far (CSS px) a pointer must move to count as moved. */
export const POINTER_STILL_PX = 1

/**
 * IS THIS THE MAP MOVING, NOT THE READER? When the level re-lays itself, the
 * browser re-tests what is under a pointer that has not moved and sends
 * boundary events for whatever slid under it. Answering those would grow the
 * cell that happened to arrive there — and its growth would move the map
 * again. So while a re-layout is in flight (`now < shiftUntil`), an event at
 * the very spot the pointer was last seen is an echo, and the board ignores it.
 */
export function isLayoutEcho(last: PointerMark | null, event: PointerMark, now: number, shiftUntil: number): boolean {
  if (last === null || now >= shiftUntil) return false
  return Math.abs(event.x - last.x) < POINTER_STILL_PX && Math.abs(event.y - last.y) < POINTER_STILL_PX
}

/**
 * WHERE A WORKSPACE PROJECT'S CELL READS ITS DIAGRAM FROM — its checkout, but
 * only when Flow has that checkout open (the current project always is). Main
 * refuses a root it does not know, so any other checkout — and a project not
 * on this computer — has no diagram: its grown cell is its words.
 */
export function siblingDiagramRoot(
  project: { local: string | null; current: boolean },
  openRoots: ReadonlySet<string>,
): string | null {
  if (project.local === null) return null
  if (project.current || openRoots.has(project.local)) return project.local
  return null
}
