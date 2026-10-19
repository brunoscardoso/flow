/**
 * Shared conflict side-A/side-B decoration recipe (conflict-UX v2, Phase 1).
 *
 * The dedicated read-only merge tab and the REAL editor's inline conflict surface
 * must tint the two sides of a hunk identically — one two-side accent scheme, two
 * consumers (allowed-pattern #14). This module is that single definition: the four
 * decoration class names, the CSS that binds them to the `--fl-color-conflict-side-*`
 * theme tokens, and a PURE, DOM-free derivation of which line ranges each side
 * occupies within a {@link ConflictBlock}.
 *
 * It is intentionally DOM-free and Monaco-free so the range derivation is unit
 * testable and so both the merge editor and the codelens surface can import it
 * without duplicating the class names or the CSS string. Callers translate the
 * returned line ranges into Monaco decorations themselves.
 */
import type { ConflictBlock } from './conflict-parser'

/** Whole-line tint over the ours region (side A). */
export const SIDE_A_LINE_CLASS = 'fl-conflict-side-a-line'
/** Gutter accent bar over the ours region (side A). */
export const SIDE_A_GUTTER_CLASS = 'fl-conflict-side-a-gutter'
/** Whole-line tint over the theirs region (side B). */
export const SIDE_B_LINE_CLASS = 'fl-conflict-side-b-line'
/** Gutter accent bar over the theirs region (side B). */
export const SIDE_B_GUTTER_CLASS = 'fl-conflict-side-b-gutter'

/**
 * A DOM-free description of one side's decorated line span. `startLine`/`endLine`
 * are 1-based and inclusive; the class names are applied as a whole-line + gutter
 * Monaco decoration by the caller.
 */
export interface SideLineRange {
  /** 1-based first line of the tinted region (inclusive). */
  startLine: number
  /** 1-based last line of the tinted region (inclusive). */
  endLine: number
  /** Whole-line class for this side. */
  lineClassName: string
  /** Gutter class for this side. */
  gutterClassName: string
}

/** Line count of a joined side body — an empty body is zero lines (no phantom). */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

/**
 * Derive the tinted line ranges for one conflict block: the ours region (side A)
 * counted forward from the opening marker, and the theirs region (side B) counted
 * back from the closing marker. Diff3-base-aware by construction — the optional
 * `|||||||`..`=======` base region sits between the two counted spans and is left
 * neutral (never tinted). Empty sides yield no range.
 */
export function sideDecorationRanges(block: ConflictBlock): SideLineRange[] {
  const ranges: SideLineRange[] = []

  const oursCount = countLines(block.oursText)
  if (oursCount > 0) {
    ranges.push({
      startLine: block.startLine + 1,
      endLine: block.startLine + oursCount,
      lineClassName: SIDE_A_LINE_CLASS,
      gutterClassName: SIDE_A_GUTTER_CLASS,
    })
  }

  const theirsCount = countLines(block.theirsText)
  if (theirsCount > 0) {
    const from = block.endLine - theirsCount
    const to = block.endLine - 1
    if (from >= 1 && to >= from) {
      ranges.push({
        startLine: from,
        endLine: to,
        lineClassName: SIDE_B_LINE_CLASS,
        gutterClassName: SIDE_B_GUTTER_CLASS,
      })
    }
  }

  return ranges
}

/**
 * The two-side accent CSS, keyed to the shared class names and the theme tokens.
 * Injected verbatim by every consumer so the merge tab and the real editor render
 * the exact same tint. Note: never contains a block-comment terminator.
 */
export const CONFLICT_SIDE_DECORATION_CSS = `
    .${SIDE_A_LINE_CLASS} { background: var(--fl-color-conflict-side-a-bg); }
    .${SIDE_A_GUTTER_CLASS} {
      background: var(--fl-color-conflict-side-a);
      width: 3px !important;
      margin-left: 3px;
    }
    .${SIDE_B_LINE_CLASS} { background: var(--fl-color-conflict-side-b-bg); }
    .${SIDE_B_GUTTER_CLASS} {
      background: var(--fl-color-conflict-side-b);
      width: 3px !important;
      margin-left: 3px;
    }
`
