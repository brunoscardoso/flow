/**
 * The pure half of the editor's range highlight (range-highlight.ts): which
 * lines a requested range really covers, and when a cursor has left it. No DOM,
 * no Monaco — unit tested under node.
 */

export interface HighlightRange {
  /** 1-based first line, inclusive. */
  start: number
  /** 1-based last line, inclusive. */
  end: number
}

/**
 * Clamp a requested range to the model: both ends inside 1..lineCount, a
 * reversed range swapped, an absent/invalid end collapsing to the start line.
 * Returns null when the start itself is not a usable line number.
 */
export function normalizeHighlightRange(
  line: number,
  endLine: number | undefined,
  lineCount: number,
): HighlightRange | null {
  if (!Number.isFinite(line) || line < 1 || lineCount < 1) return null
  const clamp = (value: number): number => Math.min(Math.max(1, Math.floor(value)), lineCount)
  const first = clamp(line)
  const last = typeof endLine === 'number' && Number.isFinite(endLine) ? clamp(endLine) : first
  return { start: Math.min(first, last), end: Math.max(first, last) }
}

/** True when a cursor on `line` has left the highlighted range. */
export function cursorLeavesRange(line: number, range: HighlightRange): boolean {
  return line < range.start || line > range.end
}
