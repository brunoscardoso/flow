/**
 * A DELETED CONVERSATION'S UNSAVED WORK GOES TO ITS PROJECT, NOT AWAY.
 *
 * A thread's tab set carries the unsaved buffers typed while it was selected.
 * Deleting the thread used to drop the set whole — and a late save of it (the
 * switch away from the thread just deleted) was refused — so text nobody had
 * saved disappeared without a word. This moves those buffers into the
 * project-level set (`thread_id ''`), where the project view restores them
 * dirty like any other.
 *
 * NOTHING ALREADY THERE IS OVERWRITTEN. A file the project set already holds
 * unsaved text for, or a scratch note, arrives as a NEW scratch note carrying
 * the text, so two conflicting buffers both survive and a person decides. A
 * buffer whose exact text the project set already holds is not duplicated —
 * which is also what keeps a rescue that runs twice (the delete, then the
 * refused late save) from adding the same note twice.
 *
 * PURE: `TabSetStore` reads and writes the rows.
 */
import type { OpenFileRef, TabSet } from '../../shared/ipc-contract'

/**
 * A scratch note's buffer key and display name. They mirror
 * `renderer/editor/untitled.ts` and the editor's `Untitled-<n>` naming, which
 * main cannot import; the restore side parses exactly this shape.
 */
const UNTITLED_PREFIX = 'untitled:'
const UNTITLED_NAME = /^Untitled-(\d+)$/

function joinPath(rootPath: string, relPath: string): string {
  const base = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return `${base}/${relPath}`
}

/** The buffer key a ref's unsaved text is stored under. */
function bufferKey(ref: OpenFileRef): string | null {
  if (ref.untitled !== true) return joinPath(ref.rootPath, ref.relPath)
  const seq = UNTITLED_NAME.exec(ref.relPath)?.[1]
  return seq === undefined ? null : `${UNTITLED_PREFIX}${seq}`
}

/**
 * `target` (the project-level set) with `orphan`'s unsaved buffers added, or
 * null when there is nothing to move. `rootPath` is the project — the home of
 * any buffer that arrives as a scratch note.
 */
export function rescueOrphanedBuffers(rootPath: string, target: TabSet, orphan: TabSet): TabSet | null {
  const buffers = Object.entries(orphan.dirtyBuffers)
  if (buffers.length === 0) return null

  const orphanRefs = new Map<string, OpenFileRef>()
  for (const ref of orphan.openFiles) {
    const key = bufferKey(ref)
    if (key !== null) orphanRefs.set(key, ref)
  }

  const openFiles = [...target.openFiles]
  const dirtyBuffers = { ...target.dirtyBuffers }
  const openKeys = new Set(openFiles.map(bufferKey).filter((key): key is string => key !== null))
  const heldTexts = new Set(Object.values(dirtyBuffers))
  let nextNote = 0
  for (const key of [...openKeys, ...Object.keys(dirtyBuffers)]) {
    if (!key.startsWith(UNTITLED_PREFIX)) continue
    const seq = Number.parseInt(key.slice(UNTITLED_PREFIX.length), 10)
    if (Number.isInteger(seq)) nextNote = Math.max(nextNote, seq)
  }

  let moved = false
  for (const [key, content] of buffers) {
    if (heldTexts.has(content)) continue // already there, word for word
    const ref = orphanRefs.get(key)
    const isFile = ref !== undefined && ref.untitled !== true
    if (isFile && dirtyBuffers[key] === undefined) {
      if (!openKeys.has(key)) {
        openFiles.push({
          rootPath: ref.rootPath,
          relPath: ref.relPath,
          ...(ref.dirtyBaseline !== undefined ? { dirtyBaseline: ref.dirtyBaseline } : {}),
          ...(ref.dirtyModel !== undefined ? { dirtyModel: ref.dirtyModel } : {}),
        })
        openKeys.add(key)
      }
      dirtyBuffers[key] = content
    } else {
      // A note, a ref-less buffer, or a file the project set has its own
      // unsaved text for: kept whole as a new note rather than overwriting.
      nextNote += 1
      openFiles.push({ rootPath: ref?.rootPath ?? rootPath, relPath: `Untitled-${nextNote}`, untitled: true })
      dirtyBuffers[`${UNTITLED_PREFIX}${nextNote}`] = content
    }
    heldTexts.add(content)
    moved = true
  }
  return moved ? { ...target, openFiles, dirtyBuffers } : null
}
