/**
 * The open file rides along with the chat — the pure half.
 *
 * The file focused in the editor shows as an AUTOMATIC chip above the composer
 * (like VS Code's chat "current file"), and on send it travels as a reference
 * to its PATH only — never its content. The agent can read the file itself if
 * it is relevant; the chip just says what the person is looking at.
 *
 * THE RULES, kept small on purpose:
 *
 *  1. It follows focus. The editor announces its active file on tab changes
 *     only (open, close, switch, project switch) — never per keystroke, never
 *     per streaming batch. No editor file (all tabs closed, or a non-file tab
 *     such as the Board) → no chip.
 *  2. Dismissing it (×) hides it for THAT focus. Any change of the focused file
 *     clears the dismissal — so switching to another file shows that file's
 *     chip, and coming back to the dismissed file later shows it again.
 *     Re-announcing the same file (a no-op tab event) keeps it dismissed.
 *  3. It is offered only for a file inside one of the thread's roots — its
 *     project (or the thread's own checkout) and any attached project. A file
 *     from elsewhere never rides along.
 *  4. It never duplicates a ⌘L selection from the same file: when one is
 *     attached, the selection already carries that file to the agent.
 *  5. It is not sendable content by itself — an empty composer with only the
 *     automatic chip still has nothing to send.
 *
 * Serialization goes through the ONE context-chip path
 * (`serializeContextChips`): the chip becomes a `reference` ContextChipRef.
 */
import type { ContextChipRef } from './context-chips'

/** What the editor announces: the active tab's file, or null. */
export interface ActiveEditorFile {
  /** The root the editor opened it from (absolute). */
  rootPath: string
  /** Path relative to that root. */
  relPath: string
}

export interface ActiveFileState {
  file: ActiveEditorFile | null
  /** The person dismissed the chip for the current focus (rule 2). */
  dismissed: boolean
}

export const NO_ACTIVE_FILE: ActiveFileState = { file: null, dismissed: false }

/** One root a thread can reach, as the scope reports it. */
export interface ChipRoot {
  rootPath: string
  name: string
  primary: boolean
}

/** What the composer draws, and what it sends. */
export interface ActiveFileChip {
  /** Absolute path — the dedup key against ⌘L selections. */
  absolutePath: string
  /** Badge text: the file's name. */
  label: string
  /** Tooltip: the path relative to its root (prefixed by the root's name when
   *  it is an attached project, so two projects' `src/index.ts` differ). */
  title: string
  /** The path the agent is told: relative for the primary root (the session's
   *  working directory), absolute for an attached one. */
  promptPath: string
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function joinPath(root: string, rel: string): string {
  const base = trimSlash(root)
  const tail = rel.startsWith('/') ? rel.slice(1) : rel
  return `${base}/${tail}`
}

function sameFile(a: ActiveEditorFile | null, b: ActiveEditorFile | null): boolean {
  if (a === null || b === null) return a === b
  return joinPath(a.rootPath, a.relPath) === joinPath(b.rootPath, b.relPath)
}

/** The editor focused `file` (or nothing). Same file → the same state object. */
export function focusActiveFile(state: ActiveFileState, file: ActiveEditorFile | null): ActiveFileState {
  if (sameFile(state.file, file)) return state
  return { file, dismissed: false }
}

/** The person pressed × on the chip. */
export function dismissActiveFile(state: ActiveFileState): ActiveFileState {
  if (state.file === null || state.dismissed) return state
  return { file: state.file, dismissed: true }
}

/** Parse the editor's event detail defensively; anything malformed is "no file". */
export function activeEditorFileFrom(detail: unknown): ActiveEditorFile | null {
  if (typeof detail !== 'object' || detail === null) return null
  const { rootPath, relPath } = detail as { rootPath?: unknown; relPath?: unknown }
  if (typeof rootPath !== 'string' || typeof relPath !== 'string') return null
  if (rootPath.length === 0 || relPath.length === 0) return null
  return { rootPath, relPath }
}

/**
 * The chip to show (and send), or null. Combines all five rules: focus,
 * dismissal, the thread's roots, and the ⌘L dedup.
 */
export function activeFileChip(
  state: ActiveFileState,
  roots: readonly ChipRoot[],
  contextChips: readonly ContextChipRef[],
): ActiveFileChip | null {
  const file = state.file
  if (file === null || state.dismissed) return null
  const absolutePath = joinPath(file.rootPath, file.relPath)
  // The deepest root that contains the file — a thread's checkout can live
  // inside a project folder, and the file belongs to the nearer one.
  let owner: ChipRoot | null = null
  for (const root of roots) {
    const base = trimSlash(root.rootPath)
    if (base.length === 0 || !absolutePath.startsWith(`${base}/`)) continue
    if (owner === null || base.length > trimSlash(owner.rootPath).length) owner = root
  }
  if (owner === null) return null
  if (contextChips.some((chip) => chip.source === 'file' && chip.filePath === absolutePath)) return null
  const relPath = absolutePath.slice(trimSlash(owner.rootPath).length + 1)
  const label = relPath.split('/').pop() ?? relPath
  return {
    absolutePath,
    label,
    title: owner.primary || owner.name.length === 0 ? relPath : `${owner.name}/${relPath}`,
    promptPath: owner.primary ? relPath : absolutePath,
  }
}

/** The chip as a context-chip reference, for the one serialization path. */
export function activeFileReference(chip: ActiveFileChip): ContextChipRef {
  return {
    id: `active-file:${chip.absolutePath}`,
    source: 'file',
    label: chip.label,
    text: chip.promptPath,
    filePath: chip.absolutePath,
    reference: true,
  }
}
