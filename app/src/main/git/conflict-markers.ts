// Unresolved-conflict detection, pure half (#986). The review (Phases) tab used
// to offer a `UU` file as an ordinary approvable row: ✓ ran `git add` (telling
// git the conflict was RESOLVED) and "Commit phase" landed the merge commit with
// the raw `<<<<<<<` markers in history. These helpers are the content test and
// the refusal wording for the ONE detection code path (allowed-pattern #14) —
// GitManager.unresolvedConflictPaths owns the git-aware half (unmerged set,
// in-progress op, which copy to scan) and both gates (stage/approve and commit)
// reuse it, so the two surfaces can never disagree again.

/**
 * A conflict-marker LINE exactly as git writes it, anchored to line start:
 * `<<<<<<< <label>`, `=======`, `>>>>>>> <label>`, plus diff3's `||||||| <base>`.
 * Content merely QUOTING a marker mid-line (docs, string literals) never
 * matches; the caller additionally scopes scanning to files git itself reports
 * as conflicted/unmerged (or to a repo mid-merge), so even a fixture holding
 * marker lines at column 0 cannot trip the gate outside a real conflict.
 */
const CONFLICT_MARKER_LINE = /^(?:<{7}(?: |\r?$)|={7}\r?$|>{7}(?: |\r?$)|\|{7}(?: |\r?$))/m

/** True when `content` still carries a raw git conflict-marker line. */
export function containsConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_LINE.test(content)
}

/**
 * The SAME line-anchored test as {@link containsConflictMarkers}, phrased as a
 * POSIX ERE for `git grep -E --cached`, so the commit gate can scan every
 * staged blob in ONE subprocess instead of a per-file `git show` fan-out.
 * Keep the two in sync — they express one invariant. Each alternative tolerates
 * a trailing CR like the JS regex does: git grep splits lines on LF, so a CRLF
 * blob's marker line ends in a CR that a bare `$` refuses (#1685). POSIX ERE
 * has no `\r` escape — the JS `'\r'` below embeds the literal CR byte, safe
 * because the pattern is passed as an argv element, never through a shell.
 */
export const CONFLICT_MARKER_GREP =
  '^(<{7}( |\r?$)|={7}\r?$|>{7}( |\r?$)|[|]{7}( |\r?$))'

/** Cap a refused-path list so a toast/error stays readable. */
function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown}, …` : shown
}

const RESOLVE_HINT =
  'Resolve the conflict first — open the file to use the inline conflict resolver, ' +
  'or use Source Control → Changes → Merge Changes.'

/**
 * Refusal for staging/approving a file whose conflict is unresolved (#986).
 * Staging an unmerged path tells git the conflict is resolved, so the ✓ /
 * stage action must refuse while the markers are still in the working copy.
 */
export function stageConflictRefusal(paths: readonly string[]): string {
  const n = paths.length
  return (
    `[Git] Cannot stage ${n} file${n === 1 ? '' : 's'} with unresolved merge ` +
    `conflicts (${pathList(paths)}). ${RESOLVE_HINT}`
  )
}

/**
 * Refusal for committing while unresolved conflict markers remain — either
 * still-unmerged paths or marker-laden content already staged (#986).
 */
export function commitConflictRefusal(paths: readonly string[]): string {
  const n = paths.length
  return (
    `[Git] Cannot commit — ${n} file${n === 1 ? '' : 's'} still ` +
    `${n === 1 ? 'carries' : 'carry'} unresolved conflict markers ` +
    `(${pathList(paths)}). ${RESOLVE_HINT}`
  )
}
