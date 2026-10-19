// Pure GFM table-delimiter detection — split out of markdown-renderer.ts (which
// is DOM-coupled) so it unit-tests under the node test env. A GFM delimiter row
// is a run of cells, each `:?-+:?` — ONE or more dashes, optional leading/trailing
// pipes and alignment colons. The renderer's block scanner treats a `|`-bearing
// line followed by such a row as a table header (#704).

/** Each delimiter cell is `:?-+:?` (one-or-more dashes) — NOT two+. Requiring
 *  `-{2,}` dropped single-dash tables (`|-|-|`) and any divider with even one
 *  single-dash cell (`|:--|--:|:-:|`), which then rendered as raw pipe text. */
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** True when `line` is a GFM table delimiter row (single- or multi-dash cells,
 *  optional alignment colons). Pure — no DOM. */
export function isTableDivider(line: string): boolean {
  return TABLE_DIVIDER_RE.test(line)
}

/** True when `line` opens a table: a `|`-bearing header row whose successor is
 *  a delimiter row. This is the block scanner's table test AND the paragraph
 *  break test (#1015 — in GFM a table interrupts an open paragraph; without
 *  this the header/divider/data rows are swallowed as literal prose). The
 *  `includes('-')` guard keeps a bare `|` line from starting a table. */
export function isTableStart(line: string, next: string | undefined): boolean {
  if (next === undefined) return false
  return line.includes('|') && isTableDivider(next) && next.includes('-')
}
