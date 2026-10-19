/**
 * Stage-and-confirm completion review (conflict-UX Phase 5, Task 5) — the PURE,
 * DOM-free builder for the final "here's what will be committed" review shown
 * BEFORE a merge/rebase is completed. It lists every resolved hunk in IDENTITY
 * terms (what was kept per hunk), reusing the identity-chip label logic
 * (`sideDisplayLabel`) so the review speaks branches/authors, never the stage
 * words "ours"/"theirs". The completion gate requires an explicit confirm — this
 * module supplies the content; the panel renders it and awaits the click.
 *
 * DOM-free so it unit-tests under the node jest env; the DOM confirm surface
 * (git-panel) is verified by tsconfig.web.json only.
 */
import { WHOLE_FILE_HUNK_ID, type HunkResolution } from './merge-resolution-record'
import { sideDisplayLabel } from './identity-chip-parts'

/** One resolved hunk, described for the confirmation review. */
export interface ResolvedHunkReviewRow {
  /** Repo-relative path of the file. */
  filePath: string
  /** Stable hunk id within the file. */
  hunkId: string
  /** What was kept, in IDENTITY terms (branch label / "both (A + B)") — never a
   *  stage word. */
  kept: string
  /** True when an AI auto-applied this hunk (surfaced distinctly in the review). */
  auto: boolean
  /** True when the resolution covered the WHOLE FILE (the Source Control
   *  panel's side buttons) rather than one hunk (#1288). */
  wholeFile: boolean
}

/** The assembled completion review: per-hunk rows plus auto/manual counts. */
export interface MergeCompletionReview {
  rows: ResolvedHunkReviewRow[]
  /** Count of AI auto-applied hunks in the set. */
  autoCount: number
  /** Count of human-resolved hunks in the set. */
  manualCount: number
  /** Whether there is anything to confirm (an empty set skips the review). */
  hasResolutions: boolean
  /** One-line headline, e.g. "5 hunks resolved (2 auto-applied) — confirm to commit". */
  headline: string
}

/**
 * The IDENTITY label for what a hunk kept. `ours`/`theirs` resolve to that side's
 * display label; `both` names both sides in concatenation order. Falls back to
 * the neutral Side A/B labels when identity was not recorded.
 */
export function keptLabel(resolution: HunkResolution): string {
  const oursLabel = sideDisplayLabel(resolution.oursIdentity, { side: 'a' })
  const theirsLabel = sideDisplayLabel(resolution.theirsIdentity, { side: 'b' })
  switch (resolution.choice) {
    case 'ours':
      return oursLabel
    case 'theirs':
      return theirsLabel
    case 'both': {
      // Respect the concatenation order the hunk was resolved with.
      const [first, second] =
        resolution.order === 'theirs-first' ? [theirsLabel, oursLabel] : [oursLabel, theirsLabel]
      return `both (${first} + ${second})`
    }
  }
}

/**
 * Build the completion review from the session's per-hunk resolutions. Rows are
 * ordered by file then hunk id for a stable render. Deterministic + pure.
 */
export function buildMergeCompletionReview(
  resolutions: readonly HunkResolution[],
): MergeCompletionReview {
  const rows: ResolvedHunkReviewRow[] = resolutions
    .map((resolution) => ({
      filePath: resolution.filePath,
      hunkId: resolution.hunkId,
      kept: keptLabel(resolution),
      auto: resolution.auto,
      // #1288: a panel-button resolution covers the whole file, not one hunk —
      // the review must not call it a hunk.
      wholeFile: resolution.hunkId === WHOLE_FILE_HUNK_ID,
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.hunkId.localeCompare(b.hunkId))

  const autoCount = rows.filter((row) => row.auto).length
  const manualCount = rows.length - autoCount
  const hasResolutions = rows.length > 0
  const autoNote = autoCount > 0 ? ` (${autoCount} auto-applied)` : ''
  // #1288: "hunk" stays the noun when every row IS a hunk (the editor path,
  // unchanged); a set containing whole-file resolutions is counted in
  // conflicts, because calling a whole-file resolution a hunk is the same
  // category error that made the panel's own resolutions unreportable.
  const anyWholeFile = rows.some((row) => row.wholeFile)
  const noun = anyWholeFile
    ? rows.length === 1
      ? 'conflict'
      : 'conflicts'
    : rows.length === 1
      ? 'hunk'
      : 'hunks'
  const headline = hasResolutions
    ? `${rows.length} ${noun} resolved${autoNote} — confirm to commit`
    : 'No recorded hunk resolutions — confirm to complete'

  return { rows, autoCount, manualCount, hasResolutions, headline }
}
