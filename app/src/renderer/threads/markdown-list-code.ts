// Pure list-item block helpers — split out of markdown-renderer.ts (which is
// DOM-coupled) so they unit-test under the node test env, the same pattern as
// markdown-table-detect.ts (#704). These back the #1016 fixes: an indented
// fenced code block INSIDE a list item, loose-list continuation across blank
// lines, and ordered lists whose first marker is not 1.

/** A list-item marker line: (indent)(`-`/`*`/`+` or `1.`/`1)`) (content). */
export const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

export interface FenceLine {
  /** Leading-whitespace width of the fence line. */
  indent: number
  /** The fence marker run (``` or ~~~, possibly longer). */
  marker: string
  /** Language — the first word of the info string ('' when absent). */
  lang: string
}

/** Parse a fence-opening line at ANY indent: marker + language + indent, or
 *  null when the line isn't a fence. A backtick fence whose info string
 *  contains a backtick is inline code (e.g. a line starting ```` ```code``` ````),
 *  not a fence — same rule the top-level scanner applies. The renderer treats
 *  indent 0 as a top-level fence and indent > 0 (under a list item) as a code
 *  block belonging to that item (#1016). */
export function fenceLineInfo(lineText: string): FenceLine | null {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lineText)
  if (!match) return null
  const info = (match[3] ?? '').trim()
  if (match[2]!.startsWith('`') && info.includes('`')) return null
  return { indent: match[1]!.length, marker: match[2]!, lang: info.split(/\s+/)[0] ?? '' }
}

/** Strip up to `indent` leading SPACES from a fence-body line, so code inside
 *  an item-indented fence keeps its own relative indentation but loses the
 *  list indent. Never eats non-space characters. */
export function stripFenceIndent(text: string, indent: number): string {
  let width = 0
  while (width < indent && width < text.length && text[width] === ' ') {
    width += 1
  }
  return text.slice(width)
}

export type AfterBlankClass = 'item' | 'continuation' | 'end'

/** Classify the first non-blank line after blank line(s) inside a list
 *  (loose-list handling, #1016 — a blank line must NOT split one procedure
 *  into two lists that renumber from 1):
 *   - 'item'         — another item of this list (same-or-deeper indent; at the
 *                      same indent the marker kind must match `ordered`)
 *   - 'continuation' — indented non-item content that belongs to the last item
 *                      (e.g. an indented fence or paragraph)
 *   - 'end'          — the list is over; the caller resumes top-level parsing */
export function classifyAfterBlank(
  text: string,
  baseIndent: number,
  ordered: boolean,
): AfterBlankClass {
  const item = LIST_ITEM_RE.exec(text)
  if (item) {
    const indent = item[1]!.length
    if (indent < baseIndent) return 'end'
    if (indent === baseIndent && /\d/.test(item[2]!) !== ordered) return 'end'
    return 'item'
  }
  const indent = /^\s*/.exec(text)![0].length
  return indent > baseIndent ? 'continuation' : 'end'
}

/** Ordered-list start number from an item marker ('3.' → 3, '2)' → 2); null
 *  for bullet markers. The first item's number becomes the <ol> `start`, so a
 *  list resuming after an interruption never silently renumbers from 1. */
export function listStartNumber(marker: string): number | null {
  const match = /^(\d{1,9})[.)]$/.exec(marker)
  return match ? Number.parseInt(match[1]!, 10) : null
}
