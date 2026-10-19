/**
 * Files dragged in from the OS (#1339) — DOM-free routing rules.
 *
 * Dragging a file in from Finder is the first thing anyone tries with a
 * desktop editor, and it did nothing useful anywhere in Flow. The whole
 * renderer registered exactly two drop targets — the composer (attachments)
 * and the tasks board (cards) — so the Files tree, the tab strip and the
 * editor surface each swallowed the drop. Worse, over an open buffer Monaco's
 * own "drop into editor" provider caught it and pasted the file's absolute
 * path plus a literal `$0` (its snippet terminator) INTO the source: a
 * gesture that means "open this" silently edited the file instead.
 *
 * Which project root a dropped path belongs to — and whether it belongs to
 * any — is the decision worth testing, so it lives here.
 */

/** A dropped path resolved against the open project roots. */
export interface DroppedFileTarget {
  rootPath: string
  /** Path relative to `rootPath`, with forward slashes. */
  relPath: string
}

/** Normalise separators so Windows drops compare against POSIX-style roots. */
function normalize(path: string): string {
  return path.split('\\').join('/')
}

/**
 * Resolve a dropped absolute path to (root, relative) — the address the
 * editor's own open path takes.
 *
 * Returns null when the file is outside every open root. That is deliberate:
 * opening a file from nowhere would give the editor a buffer with no project,
 * no LSP and no save target, and silently adopting the whole parent directory
 * as a project root is a much larger decision than a drag should make.
 * The caller says so instead.
 *
 * The LONGEST matching root wins, so a nested root claims its own files rather
 * than the parent that contains it.
 */
export function resolveDroppedFile(
  absPath: string,
  roots: readonly string[],
): DroppedFileTarget | null {
  const target = normalize(absPath)
  let best: DroppedFileTarget | null = null
  for (const root of roots) {
    const normalizedRoot = normalize(root).replace(/\/+$/, '')
    if (normalizedRoot === '') continue
    if (target === normalizedRoot) continue // the root itself is not a file
    if (!target.startsWith(`${normalizedRoot}/`)) continue
    if (best !== null && normalizedRoot.length <= normalize(best.rootPath).length) continue
    best = { rootPath: root, relPath: target.slice(normalizedRoot.length + 1) }
  }
  return best
}

/** Resolve many at once, keeping only what lands inside a root. */
export function resolveDroppedFiles(
  absPaths: readonly string[],
  roots: readonly string[],
): DroppedFileTarget[] {
  const out: DroppedFileTarget[] = []
  for (const path of absPaths) {
    const resolved = resolveDroppedFile(path, roots)
    if (resolved !== null) out.push(resolved)
  }
  return out
}

/** How many files one drop may open, so a dragged folder-full can't spawn
 *  hundreds of tabs. The rest are reported, never silently dropped. */
export const MAX_DROPPED_FILES = 10

export interface DropOutcome {
  /** Files to open, capped. */
  open: DroppedFileTarget[]
  /** A message when something could not be opened — null when all were. */
  notice: string | null
}

/** Decide what a drop does: what opens, and what the user is told (#1339). */
export function planDrop(absPaths: readonly string[], roots: readonly string[]): DropOutcome {
  if (absPaths.length === 0) return { open: [], notice: null }
  const resolved = resolveDroppedFiles(absPaths, roots)
  const outside = absPaths.length - resolved.length
  const open = resolved.slice(0, MAX_DROPPED_FILES)
  const overflow = resolved.length - open.length

  const parts: string[] = []
  if (outside > 0) {
    parts.push(
      `${outside} file${outside === 1 ? '' : 's'} outside the open project${
        roots.length === 1 ? '' : 's'
      }`,
    )
  }
  if (overflow > 0) parts.push(`${overflow} more not opened (limit ${MAX_DROPPED_FILES})`)
  return { open, notice: parts.length > 0 ? parts.join(' · ') : null }
}
