// Per-file structural risk for the Merge Changes section (#335, Phase 6). Pure
// and DOM-free so the badge decision is unit-testable without Monaco or the panel.
//
// The badge collapses a file's per-block structural verdicts (conflict-triage) into
// one risk. It mirrors conflict-triage's downgrade-only invariant: a file is only
// 'safe' when it has ≥1 well-formed conflict block AND every block classifies
// structurally 'safe'. Everything else — mixed blocks, overlapping logic, or a file
// with no parseable blocks at all — is 'risky'. A file is never optimistically safe.
import { parseConflicts } from '../editor/conflict-parser'
import { classifyConflictStructural } from '../../shared/conflict-triage'

/** The risk shown on a conflicted row: resolved risk, or 'pending' while loading. */
export type ConflictBadge = 'safe' | 'risky' | 'pending'

/**
 * Structural risk of a whole conflicted file from its marker-laden content.
 * `markered` is the working-tree copy still carrying `<<<<<<<`/`=======`/`>>>>>>>`
 * (i.e. `GitConflictedFile.markered` from `readConflicted`).
 */
export function fileConflictRisk(markered: string): 'safe' | 'risky' {
  const blocks = parseConflicts(markered)
  if (blocks.length === 0) return 'risky'
  const allSafe = blocks.every(
    (block) => classifyConflictStructural(markered, block).candidate === 'safe',
  )
  return allSafe ? 'safe' : 'risky'
}
