// Pure wrap arithmetic for the overlay focus trap (#1006).
//
// Split out of overlay-focus-trap.ts so it is unit-testable: that module touches
// `document`/`HTMLElement`, and ts-jest compiles a whole imported module under
// the app's node-env config — importing the trap from a test made the suite fail
// to RUN (silently zero coverage), the same reason other renderer logic lives in
// DOM-free siblings (project memory: extract DOM-free logic).

/**
 * Where the next Tab lands inside a trap of `count` focusable controls.
 * `currentIndex` < 0 (or out of range) means focus is not on a trapped control —
 * a Tab then ENTERS the trap at its first (forward) or last (backward) control.
 * Empty traps return -1: nothing to focus, the caller leaves focus alone.
 */
export function nextFocusIndex(currentIndex: number, count: number, backward: boolean): number {
  if (count <= 0) return -1
  if (currentIndex < 0 || currentIndex >= count) return backward ? count - 1 : 0
  if (backward) return currentIndex === 0 ? count - 1 : currentIndex - 1
  return currentIndex === count - 1 ? 0 : currentIndex + 1
}
