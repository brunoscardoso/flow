/**
 * Folder-behind marker rows — the durable trace of a conversation that began
 * while the project folder was behind its remote branch (user, 2026-10-12:
 * "every new thread branch created, we need to pull recent changes from main
 * automatically").
 *
 * A thread that gets a branch of its own already starts from the latest: the
 * cut fetches the base and the new checkout is put on `<remote>/<base>` before
 * anything runs. A thread that works in the PROJECT FOLDER has no such step —
 * it works on whatever the folder is sitting on, however stale, and nothing
 * said so. This marker is what says so.
 *
 * THE MARKER CARRIES NO COUNT, AND THAT IS THE POINT. A stored "7 commits
 * behind" is a claim with a shelf life: the moment somebody pulls — through the
 * card's own action, the git panel, or a terminal — the row is a lie that
 * survives every reload. So the row records only WHICH comparison was behind
 * when the conversation began, and the card reads the live numbers from
 * `git:status`, the same read the git panel uses (allowed-pattern #14). The
 * past tense is the only thing a stored row is allowed to assert.
 *
 * Writer (main, thread-worktree.ts) and reader (renderer, conversation-pane.ts)
 * share this ONE classification so the two can never drift — the same
 * shared-classifier shape as artifact-marker.ts (#1056) and turn-failure.ts
 * (#1048).
 */

/** Machine-parseable prefix of a persisted folder-behind system row. */
export const FOLDER_BEHIND_MARKER_PREFIX = '[folder-behind]'

/** A parsed marker: which comparison was behind when the thread began. */
export interface FolderBehindMarker {
  /** The branch the project folder was on, e.g. `main`. */
  branch: string
  /** What it was behind, as git names it, e.g. `origin/main`. */
  upstream: string
}

/**
 * A branch name as this marker may carry it.
 *
 * Git's ref grammar forbids whitespace, so a single space is a safe separator
 * and a name that somehow holds one is not a name this marker can round-trip —
 * `parseFolderBehindMarker` answers null and the row renders as the plain
 * system line it already is, rather than becoming a card with a truncated
 * branch in it.
 */
function isMarkerSafeRef(value: string): boolean {
  return value.length > 0 && !/\s/.test(value)
}

/**
 * Serialize a marker row's content: `[folder-behind] <branch> <upstream>`.
 *
 * Returns null for anything that cannot be round-tripped, so a caller that
 * cannot say what was behind writes no row at all — never a half-marker that
 * the reader would have to guess at.
 */
export function formatFolderBehindMarker(branch: string, upstream: string): string | null {
  if (!isMarkerSafeRef(branch) || !isMarkerSafeRef(upstream)) return null
  return `${FOLDER_BEHIND_MARKER_PREFIX} ${branch} ${upstream}`
}

/**
 * Parse a persisted system row back into a marker, or null when the row is not
 * a marker (any other system note) or is malformed — such rows fall back to
 * rendering as plain system lines, never crash.
 */
export function parseFolderBehindMarker(content: string): FolderBehindMarker | null {
  if (!content.startsWith(`${FOLDER_BEHIND_MARKER_PREFIX} `)) return null
  const rest = content.slice(FOLDER_BEHIND_MARKER_PREFIX.length + 1).trim()
  const parts = rest.split(/\s+/)
  if (parts.length !== 2) return null
  const [branch, upstream] = parts
  if (branch === undefined || upstream === undefined) return null
  if (!isMarkerSafeRef(branch) || !isMarkerSafeRef(upstream)) return null
  return { branch, upstream }
}
