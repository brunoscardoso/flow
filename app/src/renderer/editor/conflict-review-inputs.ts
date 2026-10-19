/**
 * Proposal -> review-input mapping (conflict-UX v2, Phase 4) — the PURE, DOM- and
 * git-free core that turns the agent's parsed conflict proposals into the
 * ConflictReviewInput rows the in-thread ConflictReviewCard renders, PLUS the
 * concrete per-hunk apply target each accepted row splices. Split out from the
 * DOM-bound resolve-flow orchestration (conflict-resolve-index.ts) so this shaping
 * — side selection, hunk resolution, marker-block capture — unit-tests under the
 * app's node-env jest (no DOM lib), and so the mapping lives in exactly one place.
 *
 * The v2 reversal: resolve-with-AI no longer auto-applies. It builds these items,
 * hands the inputs to the review card, and applies a hunk ONLY when the user
 * accepts its row — via the SAME per-hunk splice path a human click uses
 * (resolveHunkAndRecord), keyed by the row id this module derives. Nothing here
 * touches the git bridge or the DOM; the caller resolves identities + splices.
 */
import { parseConflicts, type ConflictBlock } from './conflict-parser'
import type { ConflictChoice, ConflictProposal } from './conflict-proposal'
import type { ConflictSide } from './identity-chip-parts'
import {
  rowIdForInput,
  type ConflictReviewInput,
} from '../threads/conflict-review-card-model'
import type { SideIdentity } from '../../shared/side-identity'
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'

/**
 * One conflicted file plus everything needed to shape its proposals: the
 * marker-laden working text (parsed here for hunk ids + fallback labels), the
 * proposals the agent produced for THIS file, and the concrete per-side
 * identities resolved from the in-progress operation (absent -> marker-label
 * fallback). The caller resolves identities from the git bridge and passes them
 * in so this module stays DOM- and git-free.
 */
export interface ConflictFileReview {
  /** Absolute repository root the operation runs in. */
  rootPath: string
  /** Root-relative path of the conflicted file. */
  filePath: string
  /** Working-tree text still carrying the conflict markers. */
  markered: string
  /** The agent's proposals for this file (already filtered to `proposal.file`). */
  proposals: readonly ConflictProposal[]
  /** Concrete identity of the ours side (stage 2), when known. */
  oursIdentity?: SideIdentity
  /** Concrete identity of the theirs side (stage 3), when known. */
  theirsIdentity?: SideIdentity
}

/**
 * The concrete, per-hunk splice an accepted row applies — the SAME shape the
 * shared `resolveHunkAndRecord` path consumes. Absent from an item that cannot
 * be hunk-applied (a `synthesized` proposal, or a block the parser can't resolve
 * to a hunk): accepting such a row applies nothing (fail-safe).
 */
export interface ConflictReviewApplyTarget {
  /** Absolute repository root (the `rootId` the git bridge expects). */
  rootId: string
  /** Root-relative path of the conflicted file. */
  filePath: string
  /** The stable hunk id this row splices. */
  hunkId: string
  /** The splice side — never `synthesized` (those items carry no apply target). */
  choice: ConflictHunkChoice
  /** Concatenation order for `choice: 'both'`, when the proposal specifies one. */
  order?: ConflictHunkOrder
  /** The original marker-laden hunk text, captured so an accepted apply is
   *  reversible (undo re-introduces exactly this block). */
  originalBlock?: string
}

/**
 * One review item: the stable row id (the card and the apply path key by it), the
 * card input, and the apply target (absent when the row applies nothing).
 */
export interface ConflictReviewItem {
  /** Stable row id — identical to what the card derives for this input. */
  rowId: string
  /** The card-facing input row. */
  input: ConflictReviewInput
  /** The concrete per-hunk splice this row applies on accept; absent = no-op accept. */
  apply?: ConflictReviewApplyTarget
}

/** The v2 accent side a choice maps to: `ours`/`both`/`synthesized` -> the ours
 *  (Current) accent `a`; `theirs` -> the theirs (Incoming) accent `b`. */
function sideForChoice(choice: ConflictChoice): ConflictSide {
  return choice === 'theirs' ? 'b' : 'a'
}

/** The hunk-level splice side for a choice, or null when it can't splice per-hunk
 *  (`synthesized` writes new code — never a pure side selection). */
function hunkChoiceForChoice(choice: ConflictChoice): ConflictHunkChoice | null {
  switch (choice) {
    case 'ours':
      return 'ours'
    case 'theirs':
      return 'theirs'
    case 'both':
      return 'both'
    case 'synthesized':
      return null
  }
}

/**
 * The conflict block a proposal targets. `proposal.blockId` is the block's index
 * within the file (the id the prompt assigned); a string index is coerced. An
 * out-of-range / non-integer id resolves to undefined (the row then carries no
 * hunk id + no apply target — held, never mis-applied).
 */
function blockForProposal(
  blocks: readonly ConflictBlock[],
  blockId: string | number,
): ConflictBlock | undefined {
  const index = typeof blockId === 'number' ? blockId : Number(blockId)
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return undefined
  return blocks[index]
}

/**
 * The raw marker-laden text of one hunk (its `<<<<<<< ... >>>>>>>` region) sliced
 * from the file's markered text by the block's 1-based start/end lines. Captured
 * so an accepted apply is reversible — undo re-introduces exactly this block.
 */
export function markerBlockText(markered: string, startLine: number, endLine: number): string {
  return markered
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n')
}

/** Shape one proposal into its review item (input + optional apply target). */
function shapeItem(file: ConflictFileReview, proposal: ConflictProposal): ConflictReviewItem {
  const blocks = parseConflicts(file.markered)
  const block = blockForProposal(blocks, proposal.blockId)
  const side = sideForChoice(proposal.choice)

  // Synthesized code belongs to neither side — present it NEUTRALLY (no identity,
  // no side-label fallback) so the card reads "Review synthesized" without a
  // misleading branch/author. Every other choice carries its side's identity.
  let identity: SideIdentity | undefined
  let fallbackLabel: string | undefined
  if (proposal.choice === 'synthesized') {
    identity = undefined
    fallbackLabel = undefined
  } else {
    identity = side === 'b' ? file.theirsIdentity : file.oursIdentity
    fallbackLabel = side === 'b' ? block?.theirsLabel : block?.oursLabel
  }

  const input: ConflictReviewInput = {
    proposal,
    side,
    rootPath: file.rootPath,
    filePath: file.filePath,
    ...(identity !== undefined ? { identity } : {}),
    ...(block?.hunkId !== undefined ? { hunkId: block.hunkId } : {}),
    ...(fallbackLabel !== undefined ? { fallbackLabel } : {}),
  }

  const apply = buildApplyTarget(file, proposal, block)
  return {
    rowId: rowIdForInput(input),
    input,
    ...(apply !== undefined ? { apply } : {}),
  }
}

/** The per-hunk splice for a proposal, or undefined when it can't be hunk-applied
 *  (`synthesized`, or an unresolvable block). */
function buildApplyTarget(
  file: ConflictFileReview,
  proposal: ConflictProposal,
  block: ConflictBlock | undefined,
): ConflictReviewApplyTarget | undefined {
  if (!block) return undefined
  const choice = hunkChoiceForChoice(proposal.choice)
  if (choice === null) return undefined
  return {
    rootId: file.rootPath,
    filePath: file.filePath,
    hunkId: block.hunkId,
    choice,
    originalBlock: markerBlockText(file.markered, block.startLine, block.endLine),
  }
}

/**
 * Shape every file's proposals into review items, preserving input order (files
 * then proposal order). Pure — the inputs are never mutated. The caller passes the
 * resulting `input`s to the card and keeps the `apply` targets to splice on accept.
 */
export function buildConflictReviewItems(
  files: readonly ConflictFileReview[],
): ConflictReviewItem[] {
  const items: ConflictReviewItem[] = []
  for (const file of files) {
    for (const proposal of file.proposals) {
      items.push(shapeItem(file, proposal))
    }
  }
  return items
}
