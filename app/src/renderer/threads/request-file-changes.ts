/**
 * The files ONE request changed — pure and DOM-free, the model behind the
 * chat's changed-files list, the live file cards and the per-step chips.
 *
 * What one call did to a file is `toolCallFileChanges` (shared with main,
 * which precomputes it when a list read withholds the call's bulk). This
 * module only folds those facts across a request:
 *
 *   - ONE card per file, in first-touch order, its lines summed over every
 *     call that changed it.
 *   - Only calls that finished cleanly count (`countsAsChange`): a failed,
 *     denied or interrupted edit is not a change. A call still running counts
 *     its predicted lines while it is the request's NEWEST call — that is the
 *     card marked "writing…" — and nothing otherwise.
 *   - A file is NEW when the first call that touched it created it. A new
 *     file's diff against nothing is all additions, so its later edits fold
 *     into one net count: `added − removed` lines added, none removed.
 *   - A whole-file write over a file this request already wrote is diffed
 *     against that earlier content when both are here whole; otherwise it
 *     adds its lines and removes none (the old content is in no call), and
 *     the file is not called new.
 *   - A file the runtime reported without lines (Codex) is listed with no
 *     numbers; the totals count only the files that have them.
 *
 * Known blind spots, stated rather than hidden: an edit's `replace_all` counts
 * once; edits that rewrite each other within one request are summed, not
 * netted (only git knows the net); changes made by shell commands are not tool
 * edits and are never here.
 */
import type { ToolCallRecord, ToolFileChange } from '../../shared/ipc-contract'
import { countsAsChange, lineDiffCounts, toolCallFileChanges } from '../../shared/tool-file-changes'

/** One changed file, as a card or a chip shows it. */
export interface FileChangeView {
  /** The path as the agent named it (the key). */
  path: string
  added: number
  removed: number
  /** False when no call reported lines for it — no numbers are drawn. */
  counted: boolean
  isNew: boolean
  deleted: boolean
  /** The request's newest call is still writing this file. */
  writing: boolean
}

/** Everything a request's file lists draw. */
export interface RequestFileChanges {
  files: FileChangeView[]
  /** Per step (same index as the steps given), that step's own files. */
  steps: FileChangeView[][]
  /** Summed over the files that have numbers. */
  added: number
  removed: number
}

interface Acc {
  view: FileChangeView
  /** The first call that touched the file decided `isNew`. */
  decided: boolean
  /** The last whole content written, when it was here whole. */
  lastContent: string | null
}

/**
 * Each record's changes, counted once per record OBJECT. A live request is
 * re-folded on every stream batch and every second's tick, and a record is
 * replaced (a new object) whenever it changes — so identity is exactly the
 * invalidation this needs, and the line diff never re-runs for a record that
 * did not change.
 */
const changesByRecord = new WeakMap<ToolCallRecord, ToolFileChange[]>()

function changesOf(record: ToolCallRecord): ToolFileChange[] {
  let changes = changesByRecord.get(record)
  if (changes === undefined) {
    changes = toolCallFileChanges(record)
    changesByRecord.set(record, changes)
  }
  return changes
}

/** The `content` of a whole-file write, when the input is here whole. */
function wholeContent(record: ToolCallRecord): string | null {
  if (record.inputWithheld === true || record.fileChanges !== undefined || record.inputJson === null) return null
  try {
    const input = JSON.parse(record.inputJson) as Record<string, unknown>
    const content = input['content'] ?? input['file_text']
    return typeof content === 'string' ? content : null
  } catch {
    return null
  }
}

function fold(map: Map<string, Acc>, change: ToolFileChange, record: ToolCallRecord, writing: boolean): void {
  let acc = map.get(change.path)
  if (acc === undefined) {
    acc = {
      view: { path: change.path, added: 0, removed: 0, counted: false, isNew: false, deleted: false, writing: false },
      decided: false,
      lastContent: null,
    }
    map.set(change.path, acc)
  }
  const view = acc.view
  if (!acc.decided && change.created !== null) {
    view.isNew = change.created
    acc.decided = true
  } else if (!acc.decided) {
    // The first touch cannot say (a write whose result is not here) — the
    // file is not called new on a guess, and a later call does not decide it.
    acc.decided = true
  }
  if (change.deleted === true) view.deleted = true
  if (writing) view.writing = true
  if (!change.counted) return
  view.counted = true
  let { added, removed } = change
  const content = change.whole === true ? wholeContent(record) : null
  if (change.whole === true && content !== null && acc.lastContent !== null) {
    // The earlier write's content is the honest "before" of this one.
    const diff = lineDiffCounts(acc.lastContent, content)
    added = diff.added
    removed = diff.removed
  }
  if (change.whole === true) acc.lastContent = content
  view.added += added
  view.removed += removed
  if (view.isNew) {
    view.added = Math.max(0, view.added - view.removed)
    view.removed = 0
  }
}

/**
 * Fold a request's steps (each its tool records, in order) into its files.
 * `live` says the request is running — only then can a file be "writing…".
 */
export function requestFileChanges(
  steps: ReadonlyArray<readonly ToolCallRecord[]>,
  options: { live?: boolean } = {},
): RequestFileChanges {
  // The request's newest call, if it is still in flight.
  let newest: ToolCallRecord | null = null
  for (const step of steps) for (const record of step) newest = record
  const inFlight =
    options.live === true && newest !== null && (newest.status === 'running' || newest.status === 'pending')
      ? newest
      : null

  const whole = new Map<string, Acc>()
  const perStep: FileChangeView[][] = []
  for (const step of steps) {
    const local = new Map<string, Acc>()
    for (const record of step) {
      const writing = record === inFlight
      if (!writing && !countsAsChange(record.status)) continue
      for (const change of changesOf(record)) {
        fold(whole, change, record, writing)
        fold(local, change, record, writing)
      }
    }
    perStep.push([...local.values()].map((acc) => acc.view))
  }

  const files = [...whole.values()].map((acc) => acc.view)
  let added = 0
  let removed = 0
  for (const file of files) {
    if (!file.counted) continue
    added += file.added
    removed += file.removed
  }
  return { files, steps: perStep, added, removed }
}

// ── Words ───────────────────────────────────────────────────────────────────

const MINUS = String.fromCharCode(8722)

const plural = (count: number, noun: string): string => count + ' ' + noun + (count === 1 ? '' : 's')

/** `+156`, or empty for none. */
export function addedText(count: number): string {
  return count > 0 ? '+' + count : ''
}

/** `−34` (a real minus sign), or empty for none. */
export function removedText(count: number): string {
  return count > 0 ? MINUS + count : ''
}

/** `3 files changed` — the list's header and the work row's fact. */
export function filesChangedText(count: number): string {
  return plural(count, 'file') + ' changed'
}

/** The live work row's running total: `+180 −40 in 2 files`. Empty when
 *  nothing has changed yet; just `in 1 file` when no lines are known. */
export function liveTotalsText(changes: Pick<RequestFileChanges, 'files' | 'added' | 'removed'>): string {
  if (changes.files.length === 0) return ''
  const numbers = [addedText(changes.added), removedText(changes.removed)].filter((part) => part !== '')
  const where = 'in ' + plural(changes.files.length, 'file')
  return numbers.length === 0 ? where : numbers.join(' ') + ' ' + where
}

/** One card's accessible name: `train_model.py in src/training, 156 lines added, 34 removed, new`. */
export function fileChangeLabel(file: FileChangeView, display: FileDisplay): string {
  const parts = [display.folder === '' ? display.name : `${display.name} in ${display.folder}`]
  if (file.counted) {
    parts.push(plural(file.added, 'line') + ' added')
    parts.push(file.removed + ' removed')
  }
  if (file.isNew) parts.push('new')
  if (file.deleted) parts.push('deleted')
  if (file.writing) parts.push('being written')
  return parts.join(', ')
}

// ── Where a file is ─────────────────────────────────────────────────────────

/** A file as the card names it, and where its diff opens. */
export interface FileDisplay {
  name: string
  /** The folder relative to the root it is under ('' at the root); the full
   *  folder when it is under none of them. */
  folder: string
  /** The root the file is under, or null. */
  root: string | null
  /** The path relative to `root` (the whole path when `root` is null). */
  relative: string
}

const trimSlash = (path: string): string => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path)

/**
 * Name, folder and root of `path`, against the conversation's roots (its own
 * checkout first). The longest root containing the path wins. A relative path
 * is taken as relative to the first root.
 */
export function fileDisplay(path: string, roots: readonly string[]): FileDisplay {
  const normalized = path.replace(/\\/g, '/')
  let root: string | null = null
  let relative = normalized
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) {
    root = roots.length > 0 ? trimSlash(roots[0]) : null
    relative = normalized.replace(/^\.\//, '')
  } else {
    for (const candidate of roots) {
      const base = trimSlash(candidate.replace(/\\/g, '/'))
      if ((normalized.startsWith(base + '/')) && (root === null || base.length > root.length)) {
        root = base
        relative = normalized.slice(base.length + 1)
      }
    }
  }
  const cut = relative.lastIndexOf('/')
  return {
    name: cut === -1 ? relative : relative.slice(cut + 1),
    folder: cut === -1 ? '' : relative.slice(0, cut),
    root,
    relative,
  }
}
