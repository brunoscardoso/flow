// Conversation-pane scroll reconciliation (#179). Every completed turn rebuilds
// the transcript (#loadHistory empties the feed → scrollTop resets to 0), so a
// reader who scrolled up to re-read earlier messages was yanked to the top the
// instant the turn finished. This pure helper decides where to restore scroll
// after the rebuild: a reader who was following the live output (pinned to the
// bottom) returns to the bottom; a reader who had scrolled up stays where they
// were (clamped to the new content height). DOM-free so it unit-tests directly.

/**
 * The scrollTop to restore after a transcript rebuild.
 *
 * @param wasPinned    Whether the reader was pinned to the bottom before rebuild.
 * @param prevScrollTop The scrollTop captured before the rebuild.
 * @param maxScrollTop  The new max scrollTop (scrollHeight - clientHeight, >= 0).
 */
export function reconcileScrollTop(
  wasPinned: boolean,
  prevScrollTop: number,
  maxScrollTop: number,
): number {
  const max = Math.max(0, maxScrollTop)
  if (wasPinned) return max
  // Keep the reader's position, but never past the (possibly shorter) new bottom.
  return Math.min(Math.max(0, prevScrollTop), max)
}
