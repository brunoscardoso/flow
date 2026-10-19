// User-facing feedback for Git panel actions (#192). Changed-file and commit
// rows render with `cursor: pointer` and open a diff, but when git:diff rejected
// the coordinator only console.error'd — a dead click with no visible feedback
// (forbidden pattern #2). These pure builders turn a failure into a toast; the
// coordinator dispatches it via the `flow:notify` event → NotificationCenter.

import { ipcErrorMessage } from '../ipc-error'

export interface GitToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** execFile's `Command failed: <argv>` lead line — internal plumbing, like the
 *  IPC wrapper: it names the git command line, not what went wrong. The real
 *  message (git's stderr / a hook's own output) follows on the next line. */
const COMMAND_FAILED_LINE = /^Command failed:[^\n]*\n?/

/**
 * The human-meaningful text of a failed git action (#988). Routes through the
 * ONE IPC unwrap path (`ipcErrorMessage`, #731) — never the raw
 * `error.message` — then drops execFile's `Command failed: git …` lead line so
 * the toast opens with the message the user actually needs (e.g. a pre-commit
 * hook's reason). Falls back to the unwrapped text when nothing else remains.
 */
export function gitErrorMessage(error: unknown): string {
  const unwrapped = ipcErrorMessage(error)
  const message = unwrapped.replace(COMMAND_FAILED_LINE, '').trim()
  return message.length > 0 ? message : unwrapped
}

/** A failed file diff → toast naming the file + the underlying git error. */
export function fileDiffFailedToast(filePath: string, error: unknown): GitToast {
  return {
    title: 'Could not open diff',
    body: `${filePath} — ${gitErrorMessage(error)}`,
    level: 'error',
  }
}

/** A failed commit diff → toast naming the commit + the underlying git error. */
export function commitDiffFailedToast(commitHash: string, error: unknown): GitToast {
  return {
    title: 'Could not open diff',
    body: `commit ${commitHash.slice(0, 7)} — ${gitErrorMessage(error)}`,
    level: 'error',
  }
}

/** A failed git status/log refresh → toast, so the failure isn't console-only (#289). */
export function gitStatusFailedToast(error: unknown): GitToast {
  return {
    title: "Couldn't load git status",
    body: gitErrorMessage(error),
    level: 'error',
  }
}
