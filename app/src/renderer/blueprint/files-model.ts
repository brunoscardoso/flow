/**
 * Files-list model for the node-popover's Files section (Phase 5, #568) — pure
 * list assembly, no DOM/IO. A module node's popover shows its immediate
 * directory listing (fetched async by the board via `project:listDir`) so a
 * click peeks the file without leaving the board. Source files sort first (the
 * interesting files aren't buried under READMEs/configs), the combined list is
 * capped at MAX_POPOVER_FILES with an explicit overflow count — same idiom as
 * the popover's Annotations section (`moreAnnotations`).
 *
 * SOURCE-FILE PREDICATE: `isSourceFileName` below is a renderer-safe COPY of
 * `isSourceFileName` in `app/src/main/blueprint/basic-derive.ts` — that module
 * is main-process-only (Node `fs`), so it cannot be imported into the renderer
 * bundle/jest boundary. Keep the extension set in sync with the main copy if
 * it changes (same duplication idiom basic-derive.ts itself uses for
 * `MODULE_TREE_DEPTH_CAP`).
 */
import type { DirectoryEntry, GitFileChange, GitFileState } from '../../shared/ipc-contract'

/** Max files rendered before the rest fold into an overflow count. */
export const MAX_POPOVER_FILES = 8

/** Renderer-safe copy of basic-derive's SOURCE_EXTENSIONS — keep in sync. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.swift',
  '.kt',
  '.cs',
])

/** True when a filename has a recognized source-file extension (see file header). */
export function isSourceFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot))
}

export interface PopoverFileEntry {
  name: string
  /** Repo-relative path (the module's directory joined with `name`) — the
   *  argument `BlueprintBoard#openPeek` expects. */
  relPath: string
  /** Git working-tree state for this file, when the popover was joined against a
   *  git-status snapshot (Review Mode, #609). Absent for clean/un-joined files. */
  gitState?: GitFileState
}

export interface FileListResult {
  /** Source files first (alpha), then everything else (alpha), capped. */
  files: PopoverFileEntry[]
  /** Count of entries beyond the cap ('…and K more'); 0 when none. */
  overflow: number
}

function joinRelPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/** Basename of a repo-relative path — the trailing segment after the last `/`. */
function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}

/** Parent directory of a repo-relative path (`''` for a top-level file) — the
 *  directory a file "belongs to" for popover scoping. `'a/b/c.ts'` → `'a/b'`. */
function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? '' : relPath.slice(0, slash)
}

/** Source-first, then alpha — the popover's file ordering convention. */
function bySourceThenName(a: PopoverFileEntry, b: PopoverFileEntry): number {
  const aSource = isSourceFileName(a.name)
  const bSource = isSourceFileName(b.name)
  if (aSource !== bSource) return aSource ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * Assemble a module directory's Files section content from a `listDir`
 * response, annotated with git working-tree state (Review Mode, #609).
 * `entries` is `null` on a listDir failure — propagated straight through to
 * `null` so the caller can fail-soft (omit the section) without its own
 * try/catch. Directories are excluded — the popover only peeks files.
 *
 * Each on-disk file gets its `gitState` from the change whose `filePath`
 * matches its `relPath`. A `deleted` file is gone from disk (so it never
 * appears in `entries`), but it is re-surfaced ONLY when its parent directory
 * is exactly `dir` — i.e. it belonged to THIS module — so a deletion stays
 * visible in its own module's list without leaking every repo-wide deletion
 * into every popover (#629). Source files sort first; the combined on-disk +
 * deleted list is capped at MAX_POPOVER_FILES with an explicit overflow count
 * (deletions are inside the cap, never appended past it). Pure and
 * deterministic for a given (dir, entries, changes).
 */
export function buildFileList(
  dir: string,
  entries: readonly DirectoryEntry[] | null,
  changes: readonly GitFileChange[] = [],
): FileListResult | null {
  if (entries === null) return null
  const changeByPath = new Map(changes.map((change) => [change.filePath, change]))
  const onDisk: PopoverFileEntry[] = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => {
      const relPath = joinRelPath(dir, entry.name)
      const change = changeByPath.get(relPath)
      return change ? { name: entry.name, relPath, gitState: change.state } : { name: entry.name, relPath }
    })
  const present = new Set(onDisk.map((file) => file.relPath))
  const deletedHere = changes
    .filter(
      (change) =>
        change.state === 'deleted' &&
        parentDir(change.filePath) === dir &&
        !present.has(change.filePath),
    )
    .map((change) => ({
      name: baseName(change.filePath),
      relPath: change.filePath,
      gitState: change.state,
    }))
  const ordered = [...onDisk, ...deletedHere].sort(bySourceThenName)
  const shown = ordered.slice(0, MAX_POPOVER_FILES)
  const overflow = Math.max(0, ordered.length - shown.length)
  return { files: shown, overflow }
}
