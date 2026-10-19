/**
 * `@`-reference quoting (#1417) — pure, DOM-free.
 *
 * The composer's `@`-file popup offered files and folders whose name contains
 * a SPACE, and then inserted a reference it could not read back. Accepting
 * `design docs/` wrote `@design docs/` and closed the popup: the completion
 * session was over, typing the rest of the name never reopened it, and the
 * reference in the sent message meant `@design` followed by the plain words
 * `docs/tokens.md`. A folder next to it (`src/`) descended and kept completing
 * normally, so the widget looked identical and behaved completely differently
 * depending on a character in someone else's filename.
 *
 * One contract, applied on both sides: quote a path that needs it on insert,
 * and accept a quoted path when parsing the trigger back.
 */

/** Whether this path can be written bare after `@`. */
export function needsQuoting(path: string): boolean {
  return /[\s"]/.test(path)
}

/**
 * The text to insert after `@`. Paths with a space (or a quote) are wrapped in
 * double quotes, with embedded quotes backslash-escaped so the closing quote
 * is unambiguous.
 */
export function quoteMentionPath(path: string): string {
  if (!needsQuoting(path)) return path
  return `"${path.split('\\').join('\\\\').split('"').join('\\"')}"`
}

/**
 * The path a (possibly quoted) `@`-reference names — the inverse of
 * `quoteMentionPath`. An unterminated quote is treated as "everything after
 * it", so a half-typed reference still completes rather than dead-ending.
 */
export function unquoteMentionPath(raw: string): string {
  if (!raw.startsWith('"')) return raw
  const body = raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw.slice(1)
  return body.split('\\"').join('"').split('\\\\').join('\\')
}

/**
 * The `@`-trigger at the end of `text`, or null when there isn't one.
 *
 * Two shapes: a bare run of path characters (as before), or a double-quoted
 * segment which MAY still be open — the open case is what keeps the popup
 * alive while a name with spaces is being typed, which is exactly what the bug
 * report described losing.
 */
export function mentionTrigger(text: string): { start: number; query: string } | null {
  const quoted = /(^|\s)@"((?:[^"\\]|\\.)*)"?$/.exec(text)
  if (quoted !== null) {
    const at = text.length - (quoted[0]?.length ?? 0) + (quoted[1]?.length ?? 0)
    return { start: at, query: unquoteMentionPath(`"${quoted[2] ?? ''}`) }
  }
  const bare = /(^|\s)@([\w./-]*)$/.exec(text)
  if (bare !== null) {
    const at = text.length - (bare[0]?.length ?? 0) + (bare[1]?.length ?? 0)
    return { start: at, query: bare[2] ?? '' }
  }
  return null
}
