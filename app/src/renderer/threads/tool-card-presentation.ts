/**
 * Pure, DOM-free presentation logic for a tool-call change card (the code-quote
 * half of #17). Grouping (which calls fold under one header) lives in
 * tool-group-model.ts; this module only decides what ONE change card shows.
 *
 * Owns no DOM so it runs under the node-env jest; the view (tool-card.ts)
 * consumes it.
 */

import type { ToolCallRecord } from '../../shared/ipc-contract'

/** Whether a tool call is an edit, a write, or neither. */
export type ToolKind = 'edit' | 'write' | 'other'

const EDIT_TOOLS = new Set(['edit', 'notebookedit'])
const WRITE_TOOLS = new Set(['write'])

/** The minimal shape the presentation helpers need. */
export type PresentableCall = Pick<ToolCallRecord, 'toolName' | 'inputJson'>

/** Bounded line-level diff for the code quote. */
export interface LineDiff {
  removed: string[]
  added: string[]
  /** True when the change was larger than the bound and clipped. */
  truncated: boolean
}

const MAX_SUMMARY_LEN = 80
const MAX_DIFF_LINES = 200
const MAX_DIFF_LINE_WIDTH = 500
const MINUS_SIGN = String.fromCharCode(8722)

export function classifyTool(toolName: string): ToolKind {
  const t = toolName.toLowerCase()
  if (EDIT_TOOLS.has(t)) return 'edit'
  if (WRITE_TOOLS.has(t)) return 'write'
  return 'other'
}

/**
 * A bounded line-level diff: trim the common prefix and suffix, then the
 * middle is what was removed vs added. Bounded by line count and line width
 * so a huge edit never ships a wall of text to draw a quote.
 */
export function computeLineDiff(
  oldStr: string,
  newStr: string,
  opts?: { maxLines?: number; maxWidth?: number },
): LineDiff {
  const maxLines = opts?.maxLines ?? MAX_DIFF_LINES
  const maxWidth = opts?.maxWidth ?? MAX_DIFF_LINE_WIDTH
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1
    endNew -= 1
  }

  const removedAll = oldLines.slice(start, endOld)
  const addedAll = newLines.slice(start, endNew)
  const truncated = removedAll.length > maxLines || addedAll.length > maxLines
  const clipWidth = (line: string): string =>
    line.length > maxWidth ? line.slice(0, maxWidth) + String.fromCharCode(8230) : line
  return {
    removed: removedAll.slice(0, maxLines).map(clipWidth),
    added: addedAll.slice(0, maxLines).map(clipWidth),
    truncated,
  }
}

function parseInput(inputJson: string | null): Record<string, unknown> | null {
  if (!inputJson) return null
  try {
    const parsed = JSON.parse(inputJson) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + String.fromCharCode(8230) : text
}

/** The file path an edit/write targets, or null. */
export function filePathOf(record: PresentableCall): string | null {
  return stringField(parseInput(record.inputJson), 'file_path')
}

/** Last path segment (handles both / and backslash), or the whole string. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf(String.fromCharCode(92)))
  return cut === -1 ? path : path.slice(cut + 1)
}

function lineDelta(diff: LineDiff): string {
  const added = diff.added.length
  const removed = diff.removed.length
  if (added === 0 && removed === 0) return ''
  return '+' + added + ' ' + MINUS_SIGN + removed
}

/**
 * A real signal for a change card's collapsed line -- the first non-blank
 * added line, else a delta count. Empty when the input is withheld or
 * unparseable (the card then falls back to today's path summary).
 */
export function changeSummary(record: PresentableCall): string {
  const kind = classifyTool(record.toolName)
  const input = parseInput(record.inputJson)
  if (input === null) return ''
  if (kind === 'edit') {
    const oldStr = stringField(input, 'old_string') ?? ''
    const newStr = stringField(input, 'new_string') ?? ''
    if (oldStr === '' && newStr === '') return ''
    const diff = computeLineDiff(oldStr, newStr)
    const firstAdded = diff.added.find((line) => line.trim() !== '')
    if (firstAdded !== undefined) return clip(singleLine(firstAdded), MAX_SUMMARY_LEN)
    return lineDelta(diff)
  }
  if (kind === 'write') {
    const content = stringField(input, 'content')
    if (content === null) return ''
    const lines = content === '' ? 0 : content.split(String.fromCharCode(10)).length
    return '+' + lines + ' line' + (lines === 1 ? '' : 's')
  }
  return ''
}
