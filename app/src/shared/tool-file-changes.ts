/**
 * What ONE agent tool call did to files, in lines — pure, DOM-free, shared by
 * main (which precomputes it for a list read that withholds the call's bulk)
 * and the renderer (which computes it for a call whose input it holds whole).
 * One code path for "how many lines did this edit change" (allowed-pattern #14).
 *
 * WHAT IS COUNTED, AND HOW
 *
 *   - Claude `Edit`: a line diff of `old_string` → `new_string`. `replace_all`
 *     is counted ONCE — how many places matched is not in the call.
 *   - Claude `MultiEdit`: the sum of its edits' diffs.
 *   - Claude `Write`: every line of `content` is added. Whether the file was
 *     NEW is read from the call's own result ("File created successfully" vs
 *     "has been updated"). A write over an existing file removes lines nobody
 *     recorded, so it counts `removed: 0` and says so with `created: false`;
 *     the request fold diffs it against an earlier write of the same file when
 *     it holds both (see `request-file-changes.ts`).
 *   - Claude `NotebookEdit`: the new cell's lines are added; the old cell is
 *     not in the call, so nothing is removed.
 *   - Copilot `create` (always a new file), `edit` / `str_replace`
 *     (`old_str` → `new_str`), `str_replace_editor` (its `command` decides),
 *     and `apply_patch` (the patch's own `+` / `-` lines per file).
 *   - Codex `file_change` (stored as `Write` with the item as its input): the
 *     paths and whether each was added or deleted — Codex reports no content,
 *     so the lines are UNKNOWN (`counted: false`), never a made-up zero.
 *
 * Failed, denied and interrupted calls changed nothing as far as this module
 * claims: `toolCallFileChanges` answers for any status, and the caller decides
 * which statuses count (`countsAsChange`). Changes made by a shell command are
 * not tool edits and are never counted.
 */
import type { ToolCallRecord, ToolFileChange } from './ipc-contract'

// ── The line diff ───────────────────────────────────────────────────────────

/**
 * A text's lines. A trailing newline ends the last line rather than starting
 * an empty one, so `"a\nb\n"` and `"a\nb"` are both two lines, and `""` is none.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Above this, the full Myers search is not run (see `lineDiffCounts`). */
const DIFF_WORK_BUDGET = 4_000_000

/**
 * Lines added and removed going from `before` to `after` — a real line diff
 * (Myers' O(ND) shortest edit script, counting only), so a moved or
 * interleaved change is not miscounted the way a prefix/suffix trim would.
 *
 * `added + removed` is the shortest edit distance D; with N old and M new
 * lines the common subsequence is (N + M − D) / 2 lines, so
 * `removed = N − common` and `added = M − common`.
 *
 * BOUNDED: the common prefix and suffix are trimmed first, and when the
 * remaining middle would cost more than `DIFF_WORK_BUDGET` steps the search
 * stops and the whole middle counts as removed-then-added — an upper bound,
 * never an invented saving. A diff that large is a rewrite either way.
 */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  return lineArrayDiffCounts(splitLines(before), splitLines(after))
}

export function lineArrayDiffCounts(
  oldLines: readonly string[],
  newLines: readonly string[],
): { added: number; removed: number } {
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1
    endNew -= 1
  }
  const n = endOld - start
  const m = endNew - start
  if (n === 0 || m === 0) return { added: m, removed: n }

  const max = n + m
  const maxD = Math.min(max, Math.max(1, Math.floor(DIFF_WORK_BUDGET / max)))
  const offset = maxD + 1
  const v = new Int32Array(2 * maxD + 3)
  for (let d = 0; d <= maxD; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && oldLines[start + x] === newLines[start + y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2
        return { added: m - common, removed: n - common }
      }
    }
  }
  // Over budget: the honest upper bound.
  return { added: m, removed: n }
}

// ── One tool call ───────────────────────────────────────────────────────────

/** Tool names (lowercased) whose calls can change files. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  // Claude
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  // Copilot
  'create',
  'str_replace',
  'str_replace_editor',
  'apply_patch',
])

/** True for a tool whose calls can change files (any runtime). */
export function isFileChangeTool(toolName: string): boolean {
  return FILE_CHANGE_TOOLS.has(toolName.toLowerCase())
}

/** Only a call that finished cleanly changed anything this module will claim.
 *  `running`/`pending` are in flight; `error`/`denied` changed nothing;
 *  `interrupted` may or may not have landed, so it is not claimed. */
export function countsAsChange(status: ToolCallRecord['status']): boolean {
  return status === 'success'
}

type CallInput = Pick<ToolCallRecord, 'toolName' | 'inputJson' | 'outputJson'> &
  Partial<Pick<ToolCallRecord, 'fileChanges' | 'inputWithheld'>>

function parseObject(json: string | null): Record<string, unknown> | null {
  if (json === null || json === '') return null
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function str(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return null
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value
}

/** The text of a stored output — a JSON string, or raw text. */
function outputText(outputJson: string | null): string {
  if (outputJson === null) return ''
  try {
    const parsed = JSON.parse(outputJson) as unknown
    if (typeof parsed === 'string') return parsed
  } catch {
    // raw text
  }
  return outputJson
}

/** Whether a Claude `Write` created its file, from its own result. Null when
 *  the result is not here (withheld, still running) or says neither. */
export function writeCreatedFile(outputJson: string | null): boolean | null {
  const text = outputText(outputJson)
  if (text === '') return null
  if (/file created successfully/i.test(text)) return true
  if (/has been updated/i.test(text)) return false
  return null
}

const counted = (path: string, added: number, removed: number, created: boolean | null, extra: Partial<ToolFileChange> = {}): ToolFileChange => ({
  path,
  added,
  removed,
  counted: true,
  created,
  ...extra,
})

/**
 * The file changes one call describes. `fileChanges` precomputed by main wins
 * (the call's bulk was withheld from this read, so its input cannot be
 * re-counted here). A summarized input with nothing precomputed yields the
 * path with its lines UNKNOWN rather than a count of what survived the trim.
 */
export function toolCallFileChanges(call: CallInput): ToolFileChange[] {
  if (call.fileChanges !== undefined) return call.fileChanges
  const tool = call.toolName.toLowerCase()
  if (!FILE_CHANGE_TOOLS.has(tool)) return []
  const input = parseObject(call.inputJson)

  // Codex: a `file_change` item, whatever name it was stored under.
  if (input !== null && input['type'] === 'file_change') return codexChanges(input)

  if (tool === 'apply_patch') {
    const patch = input === null ? call.inputJson : str(input, 'input', 'patch', 'diff', 'content')
    return patch === null ? [] : patchChanges(patch)
  }
  if (input === null) return []
  const path = nonEmpty(str(input, 'file_path', 'path', 'notebook_path'))
  if (path === null) return []
  if (call.inputWithheld === true) return [{ path, added: 0, removed: 0, counted: false, created: null }]

  switch (tool) {
    case 'edit':
    case 'str_replace': {
      const { added, removed } = lineDiffCounts(str(input, 'old_string', 'old_str') ?? '', str(input, 'new_string', 'new_str') ?? '')
      return [counted(path, added, removed, false)]
    }
    case 'multiedit': {
      const edits = Array.isArray(input['edits']) ? input['edits'] : []
      let added = 0
      let removed = 0
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue
        const e = edit as Record<string, unknown>
        const diff = lineDiffCounts(str(e, 'old_string') ?? '', str(e, 'new_string') ?? '')
        added += diff.added
        removed += diff.removed
      }
      return [counted(path, added, removed, false)]
    }
    case 'write': {
      const content = str(input, 'content') ?? ''
      return [counted(path, splitLines(content).length, 0, writeCreatedFile(call.outputJson), { whole: true })]
    }
    case 'notebookedit': {
      const mode = str(input, 'edit_mode')
      const source = mode === 'delete' ? '' : (str(input, 'new_source') ?? '')
      return [counted(path, splitLines(source).length, 0, false)]
    }
    case 'create':
      return [counted(path, splitLines(str(input, 'file_text', 'content') ?? '').length, 0, true, { whole: true })]
    case 'str_replace_editor': {
      const command = str(input, 'command')
      if (command === 'create') {
        return [counted(path, splitLines(str(input, 'file_text') ?? '').length, 0, true, { whole: true })]
      }
      if (command === 'str_replace') {
        const { added, removed } = lineDiffCounts(str(input, 'old_str') ?? '', str(input, 'new_str') ?? '')
        return [counted(path, added, removed, false)]
      }
      if (command === 'insert') return [counted(path, splitLines(str(input, 'new_str') ?? '').length, 0, false)]
      return [] // view / undo_edit change nothing countable
    }
    default:
      return []
  }
}

function codexChanges(item: Record<string, unknown>): ToolFileChange[] {
  const changes = Array.isArray(item['changes']) ? item['changes'] : []
  const out: ToolFileChange[] = []
  for (const change of changes) {
    if (change === null || typeof change !== 'object') continue
    const c = change as Record<string, unknown>
    const path = nonEmpty(str(c, 'path'))
    if (path === null) continue
    const kind = str(c, 'kind')
    out.push({
      path,
      added: 0,
      removed: 0,
      counted: false,
      created: kind === 'add' ? true : kind === null ? null : false,
      ...(kind === 'delete' ? { deleted: true } : {}),
    })
  }
  return out
}

/**
 * The `*** Begin Patch` format (Copilot's and Codex's `apply_patch`): a file
 * section per `*** Add File:` / `*** Update File:` / `*** Delete File:`, its
 * `+` and `-` lines counted. A deleted file's lines are not in the patch.
 */
export function patchChanges(patch: string): ToolFileChange[] {
  const out: ToolFileChange[] = []
  let current: ToolFileChange | null = null
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header !== null) {
      const kind = header[1]
      const path = header[2].trim()
      current =
        kind === 'Delete'
          ? { path, added: 0, removed: 0, counted: false, created: false, deleted: true }
          : { path, added: 0, removed: 0, counted: true, created: kind === 'Add' }
      out.push(current)
      continue
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line)
    if (moved !== null && current !== null) {
      current.path = moved[1].trim()
      continue
    }
    if (current === null || current.deleted === true || line.startsWith('***')) continue
    if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
  }
  return out
}
