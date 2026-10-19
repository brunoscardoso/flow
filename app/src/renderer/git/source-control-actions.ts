// Per-file + section-level action resolution for the unified Source Control panel
// (#335). Which inline actions a file row offers depends on the section it's shown
// in: a Staged row can be Unstaged; a Changes row can be Staged or Discarded; a
// Merge (conflicted) row is resolved via AI, not staged directly. Section headers
// offer bulk Stage all / Unstage all when they hold ≥1 file. Pure so it's
// unit-testable; the panel renders the buttons these decisions describe.

import type { ConflictHunkChoice } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'
import { sideDisplayLabel } from '../editor/identity-chip-parts'

export type SourceControlSection = 'merge' | 'staged' | 'changes'

/** Inline actions a file row can offer. */
export type FileAction =
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'open-diff'
  | 'resolve'
  | 'use-ours'
  | 'use-theirs'
  | 'open-merge'

/** The inline actions available for a file shown in a given section. */
export function fileActions(section: SourceControlSection): FileAction[] {
  switch (section) {
    case 'staged':
      // Staged rows: unstage, and view the staged diff.
      return ['unstage', 'open-diff']
    case 'changes':
      // Working-tree rows: stage, discard, and view the diff.
      return ['stage', 'discard', 'open-diff']
    case 'merge':
      // Conflicted rows (#335, P6): take a whole side (ours/theirs), open the
      // 3-way merge editor (P5), or view the diff. Whole-window AI resolve is
      // the section-level "Resolve all with AI" control, not a per-row button.
      return ['use-ours', 'use-theirs', 'open-merge', 'open-diff']
  }
}

/**
 * The whole-file / whole-set "keep all" bulk conflict actions (conflict-UX
 * Phase 5, Task 3). The code enum names the git STAGE each maps to (`ours` =
 * stage 2, `theirs` = stage 3) — a code-side term, never a user-facing label.
 * The rendered label is FIXED (see {@link mergeBulkControl}); identity
 * lives in the legend, not in the button.
 */
export type MergeBulkAction = 'keep-all-ours' | 'keep-all-theirs' | 'keep-all-both'

/** A bulk action a section header can offer over all of its files. */
export type BulkAction = 'stage-all' | 'unstage-all' | 'discard-all' | MergeBulkAction

/**
 * The bulk actions a section header offers, in display order. The Changes header
 * gets BOTH "approve all" (stage every change) and "revert all" (discard every
 * change); Staged offers "unstage all"; Merge offers the three whole-file
 * conflict resolutions (use current / use incoming / keep both), each rendered
 * with a fixed, width-bounded label.
 */
export function bulkActions(section: SourceControlSection): BulkAction[] {
  switch (section) {
    case 'changes':
      return ['stage-all', 'discard-all']
    case 'staged':
      return ['unstage-all']
    case 'merge':
      return ['keep-all-ours', 'keep-all-theirs', 'keep-all-both']
  }
}

/**
 * A git action applied to the current multi-selection (#SCMS). Distinct from the
 * per-row {@link FileAction} and the whole-section {@link BulkAction} — it acts on
 * exactly the rows the user picked.
 */
export type SelectionAction = 'stage-selected' | 'unstage-selected' | 'discard-selected'

/** One selection-scoped item for the row context menu (count-aware label). */
export interface SelectionMenuItem {
  action: SelectionAction
  /** User-facing, count-aware label, e.g. "Stage Selected (3)". */
  label: string
}

/**
 * The selection-scoped actions a section offers over the current multi-selection,
 * in display order, prepended above "Reveal" in the row context menu (FR-5).
 * Changes rows get Stage + Discard Selected; Staged rows get Unstage Selected;
 * Merge rows offer none (conflicts resolve per-side, not via `git add`; FR-11).
 * Returns `[]` when nothing is selected, so the menu falls back to Reveal-only.
 */
export function selectionMenuItems(section: SourceControlSection, count: number): SelectionMenuItem[] {
  if (count <= 0) return []
  switch (section) {
    case 'changes':
      return [
        { action: 'stage-selected', label: `Stage Selected (${count})` },
        { action: 'discard-selected', label: `Discard Selected (${count})` },
      ]
    case 'staged':
      return [{ action: 'unstage-selected', label: `Unstage Selected (${count})` }]
    case 'merge':
      return []
  }
}

const MERGE_BULK_ACTIONS: ReadonlySet<BulkAction> = new Set<MergeBulkAction>([
  'keep-all-ours',
  'keep-all-theirs',
  'keep-all-both',
])

/** Type guard: is this bulk action one of the merge keep-all conflict actions? */
export function isMergeBulkAction(action: BulkAction): action is MergeBulkAction {
  return MERGE_BULK_ACTIONS.has(action)
}

/**
 * The per-hunk {@link ConflictHunkChoice} a merge bulk action maps to — the
 * single translation from the header control to the splice primitive, so the
 * panel wiring never re-derives it.
 */
export function mergeBulkChoice(action: MergeBulkAction): ConflictHunkChoice {
  switch (action) {
    case 'keep-all-ours':
      return 'ours'
    case 'keep-all-theirs':
      return 'theirs'
    case 'keep-all-both':
      return 'both'
  }
}

/**
 * The glyph each side wears — a SHAPE first, a tint second. The two icons differ
 * before their colours do, so the pair still separates for a reader who can't
 * tell the accents apart, and at the narrow widths where the word is gone and
 * the glyph is the whole control.
 */
export const MERGE_SIDE_ICON = { ours: 'sidebar-left', theirs: 'sidebar-right' } as const

/** "Take both sides" — one pane split down the middle. */
export const MERGE_BOTH_ICON = 'split-horizontal'

/** The glyph an armed control swaps to: a tick, because the next press commits. */
export const MERGE_CONFIRM_ICON = 'check'

/** Which side accent a merge control carries. `a` = ours, `b` = theirs. */
export type MergeAccent = 'a' | 'b' | 'both'

/** What a bulk keep-all control renders. */
export interface MergeBulkControl {
  /** FIXED button text. Bounded width, known at design time, never a branch name. */
  text: string
  /** The whole sentence, naming the real branches — the `title`. */
  title: string
  /** What the destructive confirm says. A dialog has room for the names. */
  confirmLabel: string
  /** Icon name for the leading glyph. */
  icon: string
  accent: MergeAccent
}

/**
 * The three bulk keep-all controls.
 *
 * These used to read "Keep all from <branch>", and a real branch name
 * (`ACME-2446-rework-the-session-cache-for-the-new-router`) is 53 characters. In
 * a 500px sidebar the three buttons overflowed the panel and the third truncated
 * mid-word — and NO width fixed it, because the label's length came from the
 * repository instead of from the design. The role words are fixed here; the
 * branch names are rendered exactly once, in the legend above the buttons (see
 * {@link mergeLegend}). That split is why VS Code's "Accept Current Change"
 * survives a code gutter: identity lives in the headers, never in an action.
 */
export function mergeBulkControl(
  action: MergeBulkAction,
  oursIdentity?: SideIdentity,
  theirsIdentity?: SideIdentity,
): MergeBulkControl {
  const oursLabel = sideDisplayLabel(oursIdentity, { side: 'a' })
  const theirsLabel = sideDisplayLabel(theirsIdentity, { side: 'b' })
  switch (action) {
    case 'keep-all-ours':
      return {
        text: 'Use current',
        title: `Keep ${oursLabel}'s version of every conflicted file`,
        confirmLabel: `Keep ${oursLabel}`,
        icon: MERGE_SIDE_ICON.ours,
        accent: 'a',
      }
    case 'keep-all-theirs':
      return {
        text: 'Use incoming',
        title: `Keep ${theirsLabel}'s version of every conflicted file`,
        confirmLabel: `Keep ${theirsLabel}`,
        icon: MERGE_SIDE_ICON.theirs,
        accent: 'b',
      }
    case 'keep-all-both':
      return {
        text: 'Keep both',
        title: `Keep both versions of every conflicted file — ${oursLabel} first, then ${theirsLabel}`,
        confirmLabel: `Keep both ${oursLabel} and ${theirsLabel}`,
        icon: MERGE_BOTH_ICON,
        accent: 'both',
      }
  }
}

/** One chip of the merge legend: a role word bound to the branch it means. */
export interface MergeLegendChip {
  /** The role word every control in the section uses. */
  role: string
  /** The branch that role IS — the ONLY place a branch name is rendered here. */
  branch: string
  /** The full sentence, with the branch name untruncated. */
  title: string
  icon: string
  accent: 'a' | 'b'
}

/**
 * The legend: identity, once, as a caption rather than as a control.
 *
 * Every button in the merge section says "current" or "incoming"; this is where
 * those two words are cashed out into the two real branches. Two chips, each
 * free to ellipsize, because a legend that gets shorter loses detail while a
 * button that gets shorter loses its verb.
 *
 * The wording is deliberately self-referential ("what Use current keeps") rather
 * than operational ("the branch you are merging into"): the second sentence is
 * false during a rebase, where the stages swap.
 */
export function mergeLegend(
  oursIdentity?: SideIdentity,
  theirsIdentity?: SideIdentity,
): [MergeLegendChip, MergeLegendChip] {
  const oursLabel = sideDisplayLabel(oursIdentity, { side: 'a' })
  const theirsLabel = sideDisplayLabel(theirsIdentity, { side: 'b' })
  return [
    {
      role: 'current',
      branch: oursLabel,
      title: `current is ${oursLabel} — the version "Use current" keeps`,
      icon: MERGE_SIDE_ICON.ours,
      accent: 'a',
    },
    {
      role: 'incoming',
      branch: theirsLabel,
      title: `incoming is ${theirsLabel} — the version "Use incoming" keeps`,
      icon: MERGE_SIDE_ICON.theirs,
      accent: 'b',
    },
  ]
}

/** What one per-file side control renders. */
export interface MergeSideControl {
  icon: string
  /** The short role word beside the glyph. Hidden when narrow — never clipped. */
  text: string
  /** The full sentence: the tooltip, and the accessible name when icon-only. */
  title: string
  accent: 'a' | 'b'
  /** True on the second press: previewed, and one press from being applied. */
  armed: boolean
}

/**
 * The per-file side controls — a glyph and a fixed role word, never a branch name.
 *
 * The branch name was put here to solve something real: two bare stage words
 * ("ours" / "theirs") sitting beside a filename read as part of the path, and a
 * click meant to open the file resolved it instead. But a 53-character branch
 * name inside a 28px row is worse, not better — it rendered as
 * "Jse ACME-2446-rework-the-session-cache-for-the-new-router-off-the-legacy-engin", which is not a
 * word, let alone an action.
 *
 * The original concern is still solved, by the two things the name was standing
 * in for: a role word that reads as a CHOICE rather than a folder ("Current",
 * not "ours"), and the legend above the rows, which says once which branch each
 * role is. The real name stays in `title`, where length costs nothing.
 */
export function mergeSideControl(
  side: 'ours' | 'theirs',
  armed: boolean,
  identity?: SideIdentity,
): MergeSideControl {
  const accent = side === 'ours' ? 'a' : 'b'
  const branch = identity?.branch?.trim()
  const fallback = side === 'ours' ? 'the current side' : 'the incoming side'
  const name = branch === undefined || branch.length === 0 ? fallback : branch
  if (armed) {
    return {
      icon: MERGE_CONFIRM_ICON,
      text: 'Confirm',
      title: `Resolve this file with ${name}'s version — the other side's changes to it are dropped`,
      accent,
      armed: true,
    }
  }
  return {
    icon: MERGE_SIDE_ICON[side],
    text: side === 'ours' ? 'Current' : 'Incoming',
    title: `Preview ${name}'s version of this file`,
    accent,
    armed: false,
  }
}

/**
 * What a risk badge MEANS, in words.
 *
 * The row showed a colour and the word RISKY, which says a file is dangerous
 * without saying what to do about it. These say what was actually observed —
 * whether the two sides touched the same lines — because that is the fact a
 * person weighs when deciding whether to take a whole side.
 *
 * ONE word, not two: "Separate edits" arrived on the choice line beside two
 * branch-name buttons and rendered as "Separate ed". The noun was the half a
 * reader could infer, so the adjective is what stayed; `detail` carries the
 * whole sentence, and at narrow widths the badge drops to its dot and keeps it.
 */
export function conflictRiskLabel(badge: 'safe' | 'risky' | 'pending'): {
  text: string
  detail: string
} {
  if (badge === 'pending') return { text: 'Checking…', detail: 'Reading the conflict' }
  if (badge === 'safe') {
    return {
      text: 'Separate',
      detail: 'The two sides changed different parts of this file',
    }
  }
  return {
    text: 'Overlapping',
    detail: 'The two sides changed the same lines — read the preview before choosing',
  }
}

/**
 * The two-step pick, as a rule rather than as an event handler.
 *
 * Taking a whole side of a conflict is destructive to the other side's changes
 * in that file, and it used to happen on one click of a control that looked
 * like a branch label. A press now either ARMS a side (and previews it) or, if
 * that same side is already armed, applies it. Arming the other side moves the
 * arming — there is never more than one loaded button.
 */
export type ArmedSide = 'ours' | 'theirs' | undefined

export function nextSidePress(
  armed: ArmedSide,
  pressed: 'ours' | 'theirs',
): { action: 'preview' | 'apply'; armed: ArmedSide } {
  if (armed === pressed) return { action: 'apply', armed: undefined }
  return { action: 'preview', armed: pressed }
}
