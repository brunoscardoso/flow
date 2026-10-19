/**
 * ONE ANSWER LEFT: this shell's directory is gone.
 *
 * This module used to tag every terminal tab with the tree it sat in, because
 * a thread's checkout and the project's own files could be open side by side in
 * the same strip — same prompt, different files under the same relative paths.
 * That tagging belonged to the era when a conversation's checkout was an object
 * a person managed, and it went with the surfaces that managed it
 * (worktree-ui-removal Phase 5, task 5.5).
 *
 * WHAT DID NOT GO IS C3: a shell whose directory has been removed is still a
 * real question, and it is the only tag that ever had a consequence. A running
 * shell cannot move — its cwd was fixed when it spawned — so when the directory
 * underneath it is freed, the tab keeps its scrollback and loses its ground.
 * Nothing else on screen says so. The whole of what this decides is that one
 * sentence, and it says it in the tag's OWN tooltip rather than leaning on a
 * neighbouring tag to explain it.
 *
 * A tag never names the directory it is about — a conversation's checkout sits
 * in a folder whose name is an internal slug, which is exactly what
 * forbidden-pattern #12 keeps off the screen.
 *
 * Pure and DOM-free: terminal-panel.ts renders whatever this returns.
 */

export interface TerminalRootTag {
  /** The short marker rendered beside the tab's own title. */
  label: string
  /** Hover text — the whole answer, since the label cannot carry it. */
  tooltip: string
}

/** What a tab whose directory has been removed says, in two words. */
const GONE_LABEL = 'folder gone'

/**
 * The tag for a terminal sitting in `projectRoot`, or null when there is
 * nothing worth saying — which is every ordinary tab.
 *
 * `missingRoots` holds the roots whose directory could not be read. It is the
 * only evidence this accepts: a root simply not being known is not the same
 * claim as a root having been removed, and guessing the second from the first
 * would put a warning on a perfectly healthy shell.
 */
export function terminalRootTag(
  projectRoot: string | undefined,
  missingRoots: ReadonlySet<string> | undefined,
): TerminalRootTag | null {
  if (projectRoot === undefined) return null
  if (missingRoots?.has(projectRoot) !== true) return null
  return {
    label: GONE_LABEL,
    tooltip:
      'The folder this shell was opened in has been removed. It keeps running where it is, and everything it printed is still here, but new commands have nowhere to look.',
  }
}
