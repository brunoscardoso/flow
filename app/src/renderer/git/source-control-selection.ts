// Pure multi-select logic for the Source Control panel's Changes/Staged lists.
//
// DOM-free so it unit-tests under node-env jest (mirrors source-control-actions.ts):
// the panel owns the per-(root, section) selection state and the section scoping,
// and this module only computes the next selection for a single section given a
// click gesture, plus reconciles a selection against the live file set after a
// git refresh (FR-10). Everything is PATH-keyed — never index-keyed — because the
// panel re-renders wholesale and indices are not stable across a rebuild.

/** A multi-selection scoped to ONE section (merge / staged / changes). */
export interface Selection {
  /** The selected file paths within the section. */
  readonly selected: ReadonlySet<string>
  /** The path a Shift-range extends FROM — the last plain/toggle click. Null
   *  when the selection is empty. */
  readonly anchor: string | null
}

/** The empty selection — shared, immutable. */
export const EMPTY_SELECTION: Selection = { selected: new Set<string>(), anchor: null }

/** Which gesture a click's modifiers map to. */
export type SelectionGesture = 'plain' | 'toggle' | 'range'

/**
 * Resolve a click's modifier flags (as carried on `fl-list-activate`) to a
 * gesture. Shift (range) wins over meta/ctrl (toggle) — range is the more
 * specific intent, matching VS Code / Finder list behavior.
 */
export function gestureFor(modifiers: { multiSelect?: boolean; range?: boolean }): SelectionGesture {
  if (modifiers.range === true) return 'range'
  if (modifiers.multiSelect === true) return 'toggle'
  return 'plain'
}

export interface NextSelectionInput {
  /** The section's selectable file paths in DISPLAY order (the caller has already
   *  excluded merge and rolled-up untracked-dir rows; FR-11). This is the universe
   *  a range spans. */
  readonly items: readonly string[]
  /** The clicked path. */
  readonly path: string
  readonly gesture: SelectionGesture
}

/**
 * Compute the next selection for a click within one section.
 *
 * - **plain** — the clicked row becomes the sole selection and the new anchor
 *   (collapsing any prior multi-selection; the panel still opens its diff, FR-1).
 * - **toggle** (Cmd/Ctrl) — flip the clicked row's membership; the anchor moves
 *   to it, or clears when the selection empties.
 * - **range** (Shift) — select the contiguous span from the anchor to the clicked
 *   row; the anchor is preserved so a second Shift-click re-extends from the same
 *   origin. With no prior anchor the clicked row is the origin.
 *
 * A path not in `items` (not selectable / not present) leaves the selection
 * unchanged.
 */
export function nextSelection(current: Selection, input: NextSelectionInput): Selection {
  const { items, path, gesture } = input
  const index = items.indexOf(path)
  if (index < 0) return current

  if (gesture === 'toggle') {
    const selected = new Set(current.selected)
    if (selected.has(path)) selected.delete(path)
    else selected.add(path)
    return { selected, anchor: selected.size === 0 ? null : path }
  }

  if (gesture === 'range') {
    const anchorPath = current.anchor ?? path
    const anchorIndex = items.indexOf(anchorPath)
    const from = anchorIndex < 0 ? index : anchorIndex
    const lo = Math.min(from, index)
    const hi = Math.max(from, index)
    const selected = new Set<string>()
    for (let i = lo; i <= hi; i += 1) {
      const p = items[i]
      if (p !== undefined) selected.add(p)
    }
    return { selected, anchor: anchorPath }
  }

  // plain
  return { selected: new Set<string>([path]), anchor: path }
}

/**
 * Drop any selected or anchor path no longer present after a git refresh (FR-10).
 * A vanished anchor is cleared (the next range just starts from the clicked row);
 * an emptied selection collapses to {@link EMPTY_SELECTION}.
 */
export function reconcileSelection(current: Selection, livePaths: Iterable<string>): Selection {
  const live = livePaths instanceof Set ? (livePaths as Set<string>) : new Set(livePaths)
  const selected = new Set<string>()
  for (const p of current.selected) if (live.has(p)) selected.add(p)
  if (selected.size === 0) return EMPTY_SELECTION
  const anchor = current.anchor !== null && live.has(current.anchor) ? current.anchor : null
  return { selected, anchor }
}
