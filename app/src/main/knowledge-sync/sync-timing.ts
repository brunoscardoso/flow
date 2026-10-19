/**
 * The timings and the commit wording the Workspace sync engine runs on. They
 * once belonged to the per-project knowledge sync engine, which was removed
 * with the hard migration (2026-10-06): every project's knowledge now syncs
 * through its Workspace.
 */

/** A commit is followed by a push this long after the LAST commit in a burst. */
export const PUSH_DEBOUNCE_MS = 30_000
/** The first retry after the host could not be reached. */
export const RETRY_BASE_MS = 30_000
/** The longest a retry waits. */
export const RETRY_MAX_MS = 15 * 60_000
/** Quit waits at most this long for the last commits, whatever they are doing. */
export const QUIT_PUSH_TIMEOUT_MS = 3_000
/**
 * Opening a project again this soon after a complete sync skips the network:
 * switching between two projects should not fetch both every time. "Sync now"
 * and the sync after a turn are not affected.
 */
export const OPEN_SYNC_COOLDOWN_MS = 60_000

/** Commit subjects stay one readable line. */
const MAX_LABEL_LENGTH = 72

/** `Flow: <label>` — one line, bounded, never empty. */
export function commitMessage(label: string): string {
  // eslint-disable-next-line no-control-regex -- control characters never reach a commit subject
  const oneLine = label.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const bounded = oneLine.length > MAX_LABEL_LENGTH ? `${oneLine.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…` : oneLine
  return `Flow: ${bounded === '' ? 'changes' : bounded}`
}

/** Injected so tests drive time by hand. */
export interface EngineTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
