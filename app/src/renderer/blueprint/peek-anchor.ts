/**
 * Anchor → peek-file resolution (Phase 5, #568) — pure, no DOM. An
 * annotation's anchor may name a concrete file: a `file`-kind anchor's `ref`
 * IS the repo-relative path, and a `symbol`-kind anchor's optional `file`
 * scopes the symbol to a file the same way. Other anchor kinds
 * (table/endpoint/module) don't name a single file, so they never produce a
 * peek target.
 *
 * Used by the node-popover's Annotations section (any annotation anchor with
 * a file ref gets a peek affordance). The StoryCard (threads/story-card.ts)
 * needs the identical decision but is deliberately import-free from the
 * blueprint board (see its header comment) — it carries its own tiny copy in
 * threads/story-card-model.ts (`anchorPeekPath`); keep the two in sync.
 */
import type { BlueprintAnchor } from '../../shared/ipc-contract'

/** The repo-relative path a single anchor names for peeking, or null when the
 *  anchor kind doesn't identify one concrete file. */
export function anchorPeekPath(anchor: BlueprintAnchor): string | null {
  if (anchor.kind === 'file') return anchor.ref
  if (anchor.kind === 'symbol' && anchor.file !== undefined) return anchor.file
  return null
}

/** The first anchor in `anchors` that names a peekable file, or null when none
 *  do. Order-preserving — first match wins. */
export function firstAnchorPeekPath(anchors: readonly BlueprintAnchor[]): string | null {
  for (const anchor of anchors) {
    const path = anchorPeekPath(anchor)
    if (path !== null) return path
  }
  return null
}
