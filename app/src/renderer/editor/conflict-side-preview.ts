/**
 * "What does this file become if I take that side?" — answered before the
 * choice is made, not after.
 *
 * Taking one whole side of a conflict drops the other side's changes to that
 * file, and the panel used to do it on a single click of a control that read
 * like a label. The side buttons now arm rather than apply, and arming opens
 * THIS: a read-only two-pane diff of the conflicted file as it stands (left)
 * against the file the button would write (right). The deletions in that diff
 * are exactly what pressing again gives up.
 *
 * One tab per file, whichever side is being weighed — flipping between sides
 * refreshes the same pane rather than stacking two nearly-identical tabs.
 * Renderer-side splice, no resolve: opening a preview writes nothing, and
 * closing it changes nothing.
 */
import { spliceAllConflictHunks } from '../../shared/conflict-hunks'
import { openHunkCompare } from './conflict-compare-view'
import type { EditorApi } from './index'

let editorApiRef: EditorApi | null = null

/** Register the EditorApi so a preview can open an editor tab. */
export function registerConflictSidePreview(api: EditorApi): void {
  editorApiRef = api
}

/** Reads the conflicted working copy — the git bridge, injected for tests. */
export interface ConflictReader {
  read(rootId: string, filePath: string): Promise<string | null>
}

/**
 * Open (or refresh) the preview of `side` for one conflicted file.
 *
 * Returns false when there is nothing to show — no editor registered, an
 * unreadable or oversize file. A false is not an error to shout about: the
 * caller keeps its confirm step, so the worst case is a choice made without a
 * preview, which is where this feature started.
 */
export async function openConflictSidePreview(
  rootId: string,
  filePath: string,
  side: 'ours' | 'theirs',
  reader: ConflictReader,
): Promise<boolean> {
  const api = editorApiRef
  if (api === null) return false
  const markered = await reader.read(rootId, filePath)
  if (markered === null) return false

  const absPath = filePath.startsWith('/') ? filePath : `${rootId.replace(/\/$/, '')}/${filePath}`
  await openHunkCompare(api, {
    absPath,
    // A fixed id, so ours and theirs share ONE tab: the reader is comparing two
    // answers to the same question, not opening two documents.
    hunkId: 'side-preview',
    currentText: markered,
    incomingText: spliceAllConflictHunks(markered, side).text,
    languagePath: filePath,
  })
  return true
}
