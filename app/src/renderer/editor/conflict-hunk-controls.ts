/**
 * Per-hunk control specs (conflict-UX Phase 4; reworded conflict-UX v2 Phase 2) —
 * the PURE, DOM-free description of the inline actions a single conflict hunk
 * offers: Accept Current, Accept Incoming, Accept Both. Split from the DOM/Monaco
 * surfaces (conflict-merge-editor.ts, conflict-codelens.ts) so the label + choice
 * mapping unit-tests under plain Node and both surfaces derive their controls from
 * ONE place (allowed-pattern #14).
 *
 * v2 decision: the action labels use the familiar "Current / Incoming / Both"
 * words (Current → the ours stage, Incoming → the theirs stage, Both → both),
 * made unambiguous by the per-side identity ANNOTATION Phase 1 renders on each
 * marker line — so the labels are identity-independent and no longer interpolate a
 * side name. `keepBothOrderOptions` still takes the two side labels because its
 * reorder menu names each side ("<A> first" / "<B> first").
 */
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'

/** One primary control on a hunk. `order` is the default for the both-control. */
export interface HunkControlSpec {
  key: 'keep-a' | 'keep-b' | 'keep-both'
  /** User-facing action label: "Accept Current" / "Accept Incoming" / "Accept Both". */
  label: string
  choice: ConflictHunkChoice
  /** Present only on `keep-both`: the immediate default concatenation order. */
  order?: ConflictHunkOrder
}

/** One entry in the Keep-both order menu (the "▾" affordance). */
export interface KeepBothOption {
  /** e.g. "main first" / "feature first". Never contains a stage word. */
  label: string
  order: ConflictHunkOrder
}

/**
 * The three primary actions for a hunk, in display order. Labels are the fixed v2
 * wording (identity-independent — the per-side annotation disambiguates). `keep-both`
 * defaults to `ours-first` (Current first) — the sensible default the caret menu can
 * then flip to `theirs-first`.
 */
export function hunkControlSpecs(): HunkControlSpec[] {
  return [
    { key: 'keep-a', label: 'Accept Current', choice: 'ours' },
    { key: 'keep-b', label: 'Accept Incoming', choice: 'theirs' },
    { key: 'keep-both', label: 'Accept Both', choice: 'both', order: 'ours-first' },
  ]
}

/**
 * The Keep-both order options — side A first (default) then side B first. Both
 * apply `choice: 'both'`; only the concatenation order differs, which is how a
 * user "reorders" both before committing the splice removes the markers.
 */
export function keepBothOrderOptions(sideALabel: string, sideBLabel: string): KeepBothOption[] {
  return [
    { label: `${sideALabel} first`, order: 'ours-first' },
    { label: `${sideBLabel} first`, order: 'theirs-first' },
  ]
}
