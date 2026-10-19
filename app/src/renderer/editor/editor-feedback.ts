// User-facing feedback for editor actions (#195). A cmd/ctrl+S save that fails
// (permission denied, read-only mount, ENOSPC, path became a directory) used to
// be swallowed to the console: the tab kept its dirty dot, which reads as
// "unsaved edits" rather than "your save failed" — a silent data-loss trap
// (forbidden pattern #2). This pure builder turns the failure into a toast; the
// editor dispatches it via the `flow:notify` event → NotificationCenter.

export interface EditorToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** Readable text from an unknown thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '[object Object]' ? 'Unknown error' : text
}

/**
 * A failed save → toast naming the file + the underlying error, and stating
 * plainly that the change is NOT on disk (the buffer stays dirty by design).
 */
export function saveFailedToast(fileName: string, error: unknown): EditorToast {
  return {
    title: 'Save failed',
    body: `${fileName} — ${errorText(error)}. Your change is not on disk.`,
    level: 'error',
  }
}

/**
 * An open file was deleted/renamed on disk while a DIRTY tab held it (#294).
 * The tab is kept (unsaved edits aren't discarded) but flagged, and the save
 * path now prompts before recreating — this tells the user why.
 */
export function fileDeletedOnDiskToast(fileName: string): EditorToast {
  return {
    title: 'File deleted on disk',
    body: `${fileName} was removed or renamed. Saving will recreate it — close the tab to discard.`,
    level: 'error',
  }
}

/**
 * An open file changed on disk (agent/external edit) while a DIRTY tab held it
 * (#353). A clean tab silently reloads; a dirty one is kept + flagged, and the save
 * path prompts before overwriting — this tells the user why.
 */
export function fileChangedOnDiskToast(fileName: string): EditorToast {
  return {
    title: 'File changed on disk',
    body: `${fileName} was modified elsewhere. Saving will overwrite that change — close and reopen to load it.`,
    level: 'error',
  }
}

/** File-tree operations that can fail with a silent no-op (#196). */
export type FileOp = 'create' | 'rename' | 'delete'

const FILE_OP_TITLE: Record<FileOp, string> = {
  create: "Couldn't create",
  rename: "Couldn't rename",
  delete: "Couldn't delete",
}

/** Basename of a project-relative (forward-slash) path, for readable messages. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * A failed file-tree create/rename/delete → toast naming the item (basename
 * only) + the underlying error (#196). Without this the context-menu action was
 * a silent no-op on a name collision / permission error — the menu just closed.
 */
export function fileOpFailedToast(op: FileOp, path: string, error: unknown): EditorToast {
  return {
    title: `${FILE_OP_TITLE[op]} ${baseName(path)}`,
    body: errorText(error),
    level: 'error',
  }
}

/** True when a failure reads as "that path isn't there" — ENOENT from fs, or the
 *  project list refusing a root it no longer tracks (a root whose folder vanished
 *  is dropped from the available list, so listDir/readFile answer with
 *  `[Project] Unknown root`). */
function looksMissing(error: unknown): boolean {
  return /ENOENT|Unknown root|no such file or directory/i.test(errorText(error))
}

/** True when a failure reads as "that path is there, but you may not read it" —
 *  a chmod'd or root-owned folder, a network mount whose credentials lapsed, or
 *  (macOS) a TCC-protected folder an un-entitled app gets EPERM on (#1464). */
function looksUnreadable(error: unknown): boolean {
  return /EACCES|EPERM|permission denied|operation not permitted/i.test(errorText(error))
}

/**
 * One line for the file tree's own empty state (#1464) — null when the failure
 * is neither missing nor unreadable, so an unrecognised error keeps today's
 * console-only behaviour rather than putting a mystery in the pane.
 *
 * The tree rendered an unreadable folder as an ordinary EMPTY project: zero
 * children, no error, byte-identical to opening a genuinely empty folder — while
 * Source Control and Review both toasted about the same folder in the same
 * second. The pane the user is actually looking at was the only one that stayed
 * mute, and its silence reads as "this project is empty".
 */
export function listDirFailureHint(error: unknown): string | null {
  if (looksUnreadable(error)) return "Couldn't read this folder — permission denied"
  if (looksMissing(error)) return "This folder isn't on disk any more"
  return null
}

/**
 * A file open that failed → toast (#1118). Opening a file from a project whose
 * folder disappeared mid-session was console-only: the click did nothing, no
 * toast, no state change, so the user reads it as "Flow is broken" rather than
 * "that folder isn't where it used to be". The missing-path case gets the
 * explanation; anything else still names the file and the error.
 */
export function openFileFailedToast(path: string, error: unknown): EditorToast {
  return {
    title: `Couldn't open ${baseName(path)}`,
    body: looksMissing(error)
      ? "This file is no longer on disk — its project folder may have been moved, renamed, or its drive isn't mounted."
      : errorText(error),
    level: 'error',
  }
}

/**
 * A directory listing that failed → toast (#1118). `FileTree.#loadChildren`
 * swallowed the error and rendered `children = []`, which is why a project whose
 * folder was deleted looked like an ordinary EMPTY project instead of a missing
 * one. Returns null for a non-missing error, which stays console-only: a
 * transient read failure deep in a tree must not spam toasts.
 */
export function listDirFailedToast(rootName: string, error: unknown): EditorToast | null {
  // #1464: EACCES missed the missing-path regex by one error code, so a folder
  // the app is not permitted to read fell into the "console-only" carve-out —
  // the very silence #1118 removed for the vanished-folder case.
  if (looksUnreadable(error)) {
    return {
      title: "Couldn't read that project folder",
      body: `${rootName} exists but Flow isn't allowed to read it — check its permissions, or reopen it from a location you own.`,
      level: 'error',
    }
  }
  if (!looksMissing(error)) return null
  return {
    title: 'Project folder not found',
    body: `${rootName} isn't where it used to be — it may have been moved, renamed, or its drive isn't mounted.`,
    level: 'error',
  }
}

/**
 * An agent-edit review action failed (#1291). The ✓/✗ on a hunk widget became
 * a SILENT dead click once the file changed: hunk ids embed position and
 * content hash, so any edit invalidates them, the IPC rejected, and the
 * renderer logged to console and stopped there — the widget stayed, the count
 * stayed, and the app never said why.
 */
export function hunkResolveFailedToast(fileName: string, error: unknown): EditorToast {
  return {
    title: "Couldn't apply that review action",
    body: `${fileName} — ${errorText(error)}. Nothing was changed.`,
    level: 'error',
  }
}

/** The hunk id no longer matches anything because the file moved on (#1291).
 *  Distinct from a hard failure: nothing is wrong, the view was just stale. */
export function hunkStaleToast(fileName: string): EditorToast {
  return {
    title: 'That change moved',
    body: `${fileName} was edited since this review was shown, so the hunk no longer matches. The list has been refreshed — try again.`,
    level: 'info',
  }
}

/**
 * A whole-file review action would cover MORE than the review showed (#1290).
 * Rejecting reverts the file to its pre-agent baseline, so edits the user made
 * and saved afterwards are destroyed — uncommitted, unrecoverable, under a
 * count that named only the agent's change. This names the real blast radius
 * for the confirm.
 */
export function hunkScopeConfirmText(
  fileName: string,
  action: 'accept' | 'reject',
  hunks: number,
  expected: number,
): string {
  const extra = hunks - expected
  const verb = action === 'reject' ? 'Reject' : 'Accept'
  const consequence =
    action === 'reject'
      ? `Rejecting reverts ALL of them, including your own edit${extra === 1 ? '' : 's'} — that work is not committed, so it cannot be recovered.`
      : 'Accepting adopts all of them as reviewed.'
  return (
    `${fileName} has changed since this review was shown.\n\n` +
    `It now has ${hunks} pending change${hunks === 1 ? '' : 's'}, not ${expected}: ` +
    `${extra} ${extra === 1 ? 'was' : 'were'} made outside this review.\n\n` +
    `${consequence}\n\n${verb} all ${hunks}?`
  )
}
