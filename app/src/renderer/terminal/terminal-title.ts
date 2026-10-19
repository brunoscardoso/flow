/**
 * Pure helpers for the live terminal-tab title (the tab tracks the shell's
 * current folder). DOM-free so it unit-tests under the app's node-env jest —
 * terminal-panel.ts (its consumer) pulls in xterm + `document`.
 */

/**
 * Extract the folder name (basename) from an OSC 7 cwd payload. Shells report
 * the working directory as `file://<host><absolute-path>` (path
 * percent-encoded); macOS zsh emits it by default on each prompt. Returns the
 * last path segment, `/` for the filesystem root, or null when the payload
 * isn't a parseable `file://` URI.
 */
export function osc7FolderPath(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data)
  if (!match) return null
  try {
    const path = decodeURIComponent(match[1]!)
    const trimmed = path.replace(/\/+$/, '')
    return trimmed === '' ? '/' : trimmed
  } catch {
    return null // malformed percent-encoding — ignore, keep the prior title
  }
}

export function osc7FolderName(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data)
  if (!match) return null
  let path: string
  try {
    path = decodeURIComponent(match[1]!)
  } catch {
    return null // malformed percent-encoding — ignore, keep the prior title
  }
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base.length > 0 ? base : null
}
