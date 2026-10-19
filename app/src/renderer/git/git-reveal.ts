/**
 * The project-relative path to reveal for a git change row (#1063).
 *
 * A rolled-up untracked *directory* row's `filePath` carries a trailing slash
 * (`app/`) — strip it so the OS file manager reveals the folder itself rather
 * than resolving to an empty relPath (FR-2). Leaf file rows pass through
 * unchanged. Pure so it unit-tests without the panel.
 */
export function revealRelForRow(kind: string, filePath: string): string {
  return kind === 'dir' ? filePath.replace(/\/+$/, '') : filePath
}
