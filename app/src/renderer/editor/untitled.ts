/**
 * The ⌘N scratch note's identity (#941), in one place.
 *
 * An untitled buffer is keyed by a SYNTHETIC path that is deliberately not a
 * real one, so the save/reload/watcher machinery can tell it apart at a glance.
 * The predicate lives here because more than one surface has to ask: the editor
 * coordinator (persist it as a note, restore it under the same id — #1441) and
 * the tab strip (never offer it file-only actions — #1442). Duplicating the
 * prefix is how those two drifted apart in the first place.
 */

/** Prefix marking a buffer that has no file on disk. */
export const UNTITLED_PREFIX = 'untitled:'

/** Whether a tab/model id addresses an unsaved scratch note rather than a file. */
export function isUntitledPath(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX)
}
