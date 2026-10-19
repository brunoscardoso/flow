/**
 * What the Files-tree delete confirm should say (#1187).
 *
 * Deleting a FOLDER `rm -rf`s it — `fsPromises.rm(target, {recursive:true,
 * force:true})` — behind a confirm indistinguishable from deleting one file
 * ("Delete service?"). It never said the target was a folder, never said what
 * was inside, and never said the action was irreversible. There is no OS trash
 * and no undo, and the tree keeps folders COLLAPSED by default, so in the normal
 * case the user has never seen what they are destroying.
 *
 * What survives is only what git happens to track: ignored files inside the
 * folder (`.env`, `*.local`, `node_modules/`) are gone with no recovery path at
 * all, and `git status` afterwards doesn't even mention them — so nothing on
 * screen ever hints that they existed. That is the sentence this copy has to
 * carry.
 *
 * Pure so the wording is unit-testable; file-tree.ts renders it.
 */

export interface DeleteTarget {
  name: string
  kind: 'file' | 'directory'
  /** Immediate children, when a listing was available — null when unknown. */
  childCount: number | null
}

export function deleteConfirmMessage(target: DeleteTarget): string {
  if (target.kind === 'file') {
    // Unchanged for files: a single tracked file is recoverable from git, and
    // this confirm has never been the problem.
    return `Delete ${target.name}?`
  }
  const contents =
    target.childCount === null
      ? 'and everything inside it'
      : target.childCount === 0
        ? '(empty)'
        : `and all ${target.childCount} item${target.childCount === 1 ? '' : 's'} inside it`
  return `Delete the folder ${target.name} ${contents}?`
}

/** The second line — what actually happens to the bytes. */
export function deleteConfirmWarning(target: DeleteTarget): string | null {
  if (target.kind === 'file') return null
  // Deleting now moves to the OS trash (#1187), which is the recovery path
  // gitignored contents never had. Say so: it is both the reassurance and the
  // instruction for getting it back.
  return 'Moves to the Trash, including files git ignores (.env, node_modules…).'
}
