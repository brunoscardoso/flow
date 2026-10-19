/**
 * Per-hunk resolve action (conflict-UX Phase 4) — the ONE renderer code path that
 * resolves a single conflict hunk and records it. Both inline surfaces (the merge
 * editor's view-zone controls and the CodeLens lenses) call THIS so the IPC call +
 * session record never drift (allowed-pattern #14).
 *
 * It invokes `git:resolveConflictHunk` for exactly the named hunk, and on a match
 * records the choice in the session-scoped per-hunk record (for undo + the merge
 * summary). Identities are optional — they only enrich the record's undo history;
 * a match is still recorded without them.
 */
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'
import { recordHunkResolution } from './merge-resolution-record'

/** Everything needed to resolve + record one hunk. */
export interface ResolveHunkParams {
  rootId: string
  filePath: string
  hunkId: string
  choice: ConflictHunkChoice
  /** Concatenation order for `choice: 'both'`. */
  order?: ConflictHunkOrder
  /** Concrete identity of side A (ours stage), when known — enriches the record. */
  oursIdentity?: SideIdentity
  /** Concrete identity of side B (theirs stage), when known. */
  theirsIdentity?: SideIdentity
  /** True when an AI auto-applied this; false (default) for a human click. */
  auto?: boolean
  /** The original marker-laden hunk text, captured so an auto-apply is reversible
   *  (conflict-UX Phase 5, Task 4). Optional — only auto-applies need it. */
  originalBlock?: string
}

/** Mirror of the `git:resolveConflictHunk` response. */
export interface ResolveHunkOutcome {
  matched: boolean
  remainingConflicts: number
  staged: boolean
}

/**
 * Resolve one hunk via the git bridge, then record it. Throws on an IPC failure
 * (the caller surfaces a toast + leaves the file untouched); the record is only
 * written when a hunk actually matched, so a no-match never fabricates history.
 */
export async function resolveHunkAndRecord(params: ResolveHunkParams): Promise<ResolveHunkOutcome> {
  const { rootId, filePath, hunkId, choice, order, oursIdentity, theirsIdentity, auto, originalBlock } =
    params

  const outcome = await window.flow.git.resolveConflictHunk({
    rootId,
    filePath,
    hunkId,
    choice,
    ...(order ? { order } : {}),
  })

  if (outcome.matched) {
    recordHunkResolution(rootId, {
      filePath,
      hunkId,
      choice,
      ...(order ? { order } : {}),
      ...(oursIdentity ? { oursIdentity } : {}),
      ...(theirsIdentity ? { theirsIdentity } : {}),
      auto: auto ?? false,
      ...(originalBlock !== undefined ? { originalBlock } : {}),
    })
  }

  return outcome
}
