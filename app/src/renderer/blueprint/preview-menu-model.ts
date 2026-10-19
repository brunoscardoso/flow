// Pure story↔doc pairing helper for the board.
//
// This file used to hold the view model for the board's Preview-changes
// dropdown; that dropdown, its two IPC channels and the `flow:active-plan`
// broadcast that gated it are gone (header cleanup, 2026-07-27). What survives
// is the one rule the board still needs: never render a compiled story under
// the wrong doc's title.

/**
 * Whether a compiled story belongs to the doc the user asked for (#preview-
 * mismatch, 2026-07-22). story.json holds whatever was narrated LAST — pairing
 * it blindly with a clicked doc rendered feature A's walkthrough under feature
 * B's title. Normalizes leading './' and compares sourcePath to the doc path.
 */
export function storyMatchesDoc(
  story: { sourcePath?: string } | null | undefined,
  docPath: string,
): boolean {
  const src = story?.sourcePath
  if (typeof src !== 'string' || src.length === 0) return false
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')
  return norm(src) === norm(docPath)
}
