// Peek-drawer model — pure logic, no DOM (node env). Two concerns:
//
//   1. The drawer state machine: closed → open(path) → swap(path') → closed.
//      A reducer so every transition is exhaustively testable and the board
//      holds no ad-hoc `if (open)` scatter.
//   2. Split-size persistence: parse / clamp / serialize the two-pane fraction
//      pair stored under `flow.blueprint.peek.v1`. All parsing is fail-soft —
//      corrupt or degenerate stored state falls back to sane defaults, never a
//      collapsed or NaN pane (the "blank strip" class of layout bug).
//
// The board (blueprint-board.ts) owns the localStorage I/O and the fl-split DOM;
// this module is the DOM-free brain it delegates to.

/** Versioned localStorage key for the peek drawer's split sizes (own key, #568). */
export const PEEK_STORAGE_KEY = 'flow.blueprint.peek.v1'

/** Default split fractions: [main composite, peek drawer]. */
export const PEEK_DEFAULT_SIZES: readonly [number, number] = [0.62, 0.38]

/** Floor/ceiling on the drawer fraction so a restored layout always leaves both
 *  panes usable — a stored 0.99/0.01 pair would otherwise yield a dead sliver. */
export const MIN_PEEK_FRACTION = 0.15

/** The least the stage may be left with when a pane-2 tenant opens, in px. */
export const MIN_STAGE_PX = 180

/**
 * Split fractions that leave the STAGE readable: pane 1 grows until what
 * stands above the stage (`abovePx` — the header, a brief bar) plus
 * `minStagePx` fits, and pane 2 keeps at least `minDrawer` so the tenant is
 * never a dead sliver. When the pane is too short for both, the stage wins —
 * it is the picture the tab exists for and the tenant scrolls.
 *
 * Pure: the board measures, this decides. A split of unknown height (0 —
 * not laid out yet) returns the fractions untouched.
 */
export function sizesKeepingStage(
  sizes: readonly [number, number],
  splitPx: number,
  abovePx: number,
  minStagePx: number = MIN_STAGE_PX,
  minDrawer: number = MIN_PEEK_FRACTION,
): [number, number] {
  const [main, drawer] = sizes
  if (!(splitPx > 0)) return [main, drawer]
  const needed = Math.min(1 - minDrawer, (Math.max(0, abovePx) + minStagePx) / splitPx)
  const first = Math.max(main, needed)
  return [first, 1 - first]
}

/** Which surface the drawer shows: the whole file, or the working-tree diff. */
export type PeekMode = 'full' | 'diff'

/** The reviewer's decision on the peeked file (Review Mode, #609); `null` until
 *  the user approves or refuses. Reset whenever a fresh path opens. */
export type PeekVerdict = 'approved' | 'refused' | null

/** Immutable drawer state. `path` is the repo-relative file the drawer peeks. */
export interface PeekState {
  readonly open: boolean
  readonly path: string | null
  /** `full` (default) shows the whole file; `diff` shows the working-tree diff. */
  readonly mode: PeekMode
  /** The reviewer's approve/refuse decision, or `null` before one is made. */
  readonly verdict: PeekVerdict
}

/** The single closed/empty state — the initial value and the `close` result. */
export const PEEK_CLOSED: PeekState = { open: false, path: null, mode: 'full', verdict: null }

/** Drawer transitions. `open` doubles as the swap action (open while already
 *  open with a different path) — same reducer output, distinguished only by the
 *  prior state, which is all the board needs to decide append vs. in-place.
 *  `open` resets `mode` to `full` and `verdict` to `null` (a fresh file is
 *  reviewed from scratch); `toggle-mode`/`set-mode`/`set-verdict` are in-place. */
export type PeekAction =
  | { type: 'open'; path: string }
  | { type: 'close' }
  | { type: 'toggle-mode' }
  | { type: 'set-mode'; mode: PeekMode }
  | { type: 'set-verdict'; verdict: PeekVerdict }

/**
 * Reduce a drawer action to the next state. Total over the action union:
 *   - open(path):    → { open: true, path, mode: 'full', verdict: null } (open/swap
 *                      both reset mode + verdict — a new path is reviewed fresh)
 *   - close:         → PEEK_CLOSED (mode + verdict reset)
 *   - toggle-mode:   → flip mode full ↔ diff, keep open/path/verdict
 *   - set-mode:      → set mode, keep the rest
 *   - set-verdict:   → set verdict, keep the rest
 */
export function peekReduce(state: PeekState, action: PeekAction): PeekState {
  switch (action.type) {
    case 'open':
      return { open: true, path: action.path, mode: 'full', verdict: null }
    case 'close':
      return PEEK_CLOSED
    case 'toggle-mode':
      return { ...state, mode: state.mode === 'full' ? 'diff' : 'full' }
    case 'set-mode':
      return { ...state, mode: action.mode }
    case 'set-verdict':
      return { ...state, verdict: action.verdict }
  }
}

/** True when the action swaps the peeked file in an already-open drawer (vs. a
 *  fresh open from closed). Lets the board skip re-adding the pane on a swap. */
export function isPeekSwap(state: PeekState, action: PeekAction): boolean {
  return action.type === 'open' && state.open
}

/**
 * Clamp an unknown value into a legal [main, drawer] fraction pair. Rejects
 * anything that is not a length-2 array of finite positive numbers, normalizes
 * the survivors to sum to 1, then floors/ceils the drawer fraction into
 * [MIN_PEEK_FRACTION, 1 - MIN_PEEK_FRACTION]. Always returns a fresh tuple.
 */
export function clampPeekSizes(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    return [...PEEK_DEFAULT_SIZES]
  }
  const [rawMain, rawDrawer] = value as unknown[]
  if (
    typeof rawMain !== 'number' ||
    typeof rawDrawer !== 'number' ||
    !Number.isFinite(rawMain) ||
    !Number.isFinite(rawDrawer) ||
    rawMain <= 0 ||
    rawDrawer <= 0
  ) {
    return [...PEEK_DEFAULT_SIZES]
  }
  const total = rawMain + rawDrawer
  let drawer = rawDrawer / total
  drawer = Math.min(Math.max(drawer, MIN_PEEK_FRACTION), 1 - MIN_PEEK_FRACTION)
  return [1 - drawer, drawer]
}

/**
 * Parse the persisted split sizes from raw localStorage text. Fail-soft on
 * null (nothing stored) and on malformed JSON — both yield the defaults.
 */
export function parsePeekSizes(raw: string | null): [number, number] {
  if (raw === null) {
    return [...PEEK_DEFAULT_SIZES]
  }
  try {
    return clampPeekSizes(JSON.parse(raw) as unknown)
  } catch {
    return [...PEEK_DEFAULT_SIZES]
  }
}

/** Serialize a fraction pair for persistence (clamped first for safety). */
export function serializePeekSizes(sizes: number[]): string {
  return JSON.stringify(clampPeekSizes(sizes))
}
