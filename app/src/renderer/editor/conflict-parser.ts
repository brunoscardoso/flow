// Merge-conflict marker parser (#66). Pure and DOM-free so it unit-tests without
// Monaco. Finds well-formed conflict blocks (git's `<<<<<<< / ======= / >>>>>>>`,
// diff3's optional `|||||||` base section included) and now captures each side's
// content + labels + a stable `hunkId` per block (conflict-UX Phase 3).
//
// The marker grammar, per-side content capture, hunkId derivation, and the splice
// primitive all live in ONE place — `shared/conflict-hunks.ts` — shared with the
// main-process resolver so the renderer and main never diverge on how a conflict
// is parsed or resolved (allowed-pattern #14). This module is the renderer-facing
// re-export; the returned shape is a superset of the old `{ startLine, endLine }`,
// so existing consumers (codelens, triage, risk, resolve-index) keep compiling.

import { parseConflictHunks, hasConflictHunks } from '../../shared/conflict-hunks'

/**
 * One conflict block. Backward-compatible superset of the historical
 * `{ startLine, endLine }` shape: the two line numbers are unchanged, and every
 * other field is additive.
 */
export interface ConflictBlock {
  /** 1-based line of the opening `<<<<<<<` marker. */
  startLine: number
  /** 1-based line of the closing `>>>>>>>` marker. */
  endLine: number
  /** Our side's body (between `<<<<<<<` and `=======`/base), lines joined by `\n`. */
  oursText: string
  /** Their side's body (between `=======` and `>>>>>>>`), lines joined by `\n`. */
  theirsText: string
  /** The diff3 base body (between `|||||||` and `=======`), when present. */
  baseText?: string
  /** Label text after `<<<<<<<` (e.g. `HEAD`), trimmed; absent when blank. */
  oursLabel?: string
  /** Label text after `>>>>>>>` (e.g. the incoming branch), trimmed. */
  theirsLabel?: string
  /** Stable, content-derived id for per-hunk resolution (see conflict-hunks.ts). */
  hunkId: string
}

/**
 * Parse conflict blocks from file text. A valid block opens on `<<<<<<<`, has a
 * `=======` separator, and closes on `>>>>>>>` — in that order. A second
 * `<<<<<<<` before a close abandons the prior (unterminated) block. An open
 * block at end-of-file is dropped. diff3 `|||||||` base sections are captured.
 */
export function parseConflicts(text: string): ConflictBlock[] {
  return parseConflictHunks(text)
}

/** True when the text contains at least one well-formed conflict block. */
export function hasConflicts(text: string): boolean {
  return hasConflictHunks(text)
}

/** The one Monaco text-model capability the marker probe needs. Structural (not
 *  `ITextModel`) so this stays DOM-free and unit-testable with a stub. */
export interface ConflictMarkerSearchable {
  findMatches(
    searchString: string,
    searchOnlyEditableRange: boolean,
    isRegex: boolean,
    matchCase: boolean,
    wordSeparators: string | null,
    captureMatches: boolean,
    limitResultCount?: number,
  ): unknown[]
}

/**
 * Cheap no-conflict probe (#1784): ask the model's own search for one `<<<<<<<`
 * occurrence instead of materializing the whole document with `getValue()`.
 * `findMatches` walks the piece tree and stops at the first hit (limit 1), so a
 * marker-free buffer — the overwhelmingly common case — is rejected at a cost
 * proportional to the search, never an O(document) string copy per keystroke.
 * Conservative superset of the block grammar: a hit only admits the caller to
 * the real parse, exactly like the `indexOf` gate it replaces.
 */
export function modelHasConflictMarker(model: ConflictMarkerSearchable): boolean {
  return model.findMatches('<<<<<<<', false, false, false, null, false, 1).length > 0
}
