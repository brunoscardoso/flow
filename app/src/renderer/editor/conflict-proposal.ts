// Structured conflict-resolution proposals (AI merge-conflict-resolution,
// Phase 4). Pure and DOM-free so the parse + apply-decision logic unit-tests
// without Monaco or the git bridge.
//
// The agent replies with a fenced ```conflict-proposals JSON array; each element
// is one ConflictProposal. `parseProposals` extracts + validates it (never
// throws — a missing/garbage block is `[]`, a malformed element is dropped or
// repaired toward 'risky'). `decideApplications` then combines each proposal
// with its file's STRUCTURAL verdict via the Phase-2 downgrade-only rule
// (`refineRisk`) to decide auto-apply vs hold.
//
// SAFETY: this module can only ever make a conflict SAFER, never riskier-to-
// applied. The structural verdict is the sole authority that calls a file
// 'safe'; a proposal's own 'safe' opinion may confirm that, never override a
// structural 'risky'. Synthesized code is ALWAYS held (D4) — never auto-applied.

import { refineRisk, type ConflictRisk, type StructuralVerdict } from '../../shared/conflict-triage'
import type { GitConflictResolution } from '../../shared/ipc-contract'
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'

/** The fenced code-block info string the agent must tag its JSON array with. */
export const CONFLICT_PROPOSALS_FENCE = 'conflict-proposals'

/** How the agent chose to resolve one conflict block. `synthesized` = new code
 *  the agent wrote that is on neither side — always held for human review (D4). */
export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'synthesized'

/** One block's proposed resolution, as parsed from the agent's fenced JSON. */
export interface ConflictProposal {
  /** Root-relative path of the conflicted file (as listed in the prompt). */
  file: string
  /** Identifier of the conflict block within the file (index or label). */
  blockId: string | number
  choice: ConflictChoice
  /** Full resolved file text — required for `both`/`synthesized`, else ignored. */
  resolvedContent?: string
  /** The agent's own risk opinion (can only DOWNGRADE a structural 'safe'). */
  risk: ConflictRisk
  /** The agent's confidence in `risk`, 0..1. */
  confidence: number
  /** Why this conflict happened / what each side intended. */
  why: string
  /** How the proposal resolves it. */
  how: string
}

/** The decision for one proposal after folding in its structural verdict. */
export interface ApplyDecision {
  file: string
  action: 'auto-apply' | 'hold'
  /** The concrete git resolution to apply — present only when `auto-apply`. */
  resolution?: GitConflictResolution
  finalRisk: ConflictRisk
  why: string
}

/** confidence assigned to an element whose own confidence was unusable. */
const NO_CONFIDENCE = 0
/** The set of valid choices, for O(1) membership checks. */
const VALID_CHOICES: ReadonlySet<string> = new Set<ConflictChoice>([
  'ours',
  'theirs',
  'both',
  'synthesized',
])
/** Matches the fenced ```conflict-proposals block and captures its JSON body. */
const FENCE_PATTERN = new RegExp('```' + CONFLICT_PROPOSALS_FENCE + '[^\\n]*\\n([\\s\\S]*?)```')

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function isChoice(value: unknown): value is ConflictChoice {
  return typeof value === 'string' && VALID_CHOICES.has(value)
}

/**
 * Validate + normalize a single raw element into a ConflictProposal.
 *
 * Identity fields (`file`, `blockId`, `choice`) are load-bearing — an element
 * missing any of them is DROPPED (returns null). The risk-bearing fields are
 * repaired defensively: any element whose `risk`/`confidence`/`why`/`how` is
 * missing or the wrong type is REPAIRED TOWARD 'risky' (never toward 'safe'),
 * so a malformed element can never slip through as auto-appliable.
 */
function coerceProposal(raw: unknown): ConflictProposal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const file = typeof record.file === 'string' ? record.file.trim() : ''
  if (file.length === 0) return null

  const blockId =
    typeof record.blockId === 'string' || typeof record.blockId === 'number'
      ? record.blockId
      : null
  if (blockId === null) return null

  if (!isChoice(record.choice)) return null
  const choice = record.choice

  // Repair-toward-risky: 'safe' survives ONLY when every risk-bearing field is
  // well-formed. Any defect (bad risk, garbage confidence, missing rationale)
  // downgrades the element to 'risky' so it holds — never toward 'safe'.
  const confidenceValid =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
  const whyValid = typeof record.why === 'string'
  const howValid = typeof record.how === 'string'
  const wellFormedSafe = record.risk === 'safe' && confidenceValid && whyValid && howValid
  const risk: ConflictRisk = wellFormedSafe ? 'safe' : 'risky'

  const confidence = confidenceValid ? clamp01(record.confidence as number) : NO_CONFIDENCE
  const why = whyValid ? (record.why as string) : ''
  const how = howValid ? (record.how as string) : ''
  const resolvedContent =
    typeof record.resolvedContent === 'string' ? record.resolvedContent : undefined

  return {
    file,
    blockId,
    choice,
    risk,
    confidence,
    why,
    how,
    ...(resolvedContent !== undefined ? { resolvedContent } : {}),
  }
}

/**
 * Scan `text` from `from` for the first BALANCED top-level JSON array
 * (`[ … ]`), honoring JSON string literals + escapes so brackets — or
 * ```-fences — inside a string can never mis-balance or truncate the capture.
 * Returns the array substring (outer brackets included) or null.
 *
 * This replaces the old non-greedy ```…``` fence capture, whose match ended at
 * the FIRST ``` inside `resolvedContent` (a code/markdown file's resolved text
 * routinely carries one), tearing the JSON and yielding `[]` — the everyday
 * cause of "no card, raw JSON shown" (#1919).
 */
function firstBalancedArray(text: string, from: number): string | null {
  const start = text.indexOf('[', from)
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null // a stray close before ours — malformed
    }
  }
  return null // never closed
}

/** Parse + coerce one candidate array substring. Non-JSON / non-array → []. */
function proposalsFromArrayText(arrayText: string): ConflictProposal[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(arrayText)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const proposals: ConflictProposal[] = []
  for (const element of parsed) {
    const proposal = coerceProposal(element)
    if (proposal) proposals.push(proposal)
  }
  return proposals
}

/**
 * Extract + validate the agent's proposals from its message text. Never throws.
 *
 * The parse now feeds the HUMAN-IN-THE-LOOP review card (nothing auto-applies —
 * every Accept goes through the per-hunk splice, which re-reads the live hunk
 * and reports a mismatch rather than misapplying), so it is deliberately
 * FORGIVING of the realistic shapes a real agent turn produces:
 *
 *  1. the tagged ```conflict-proposals fence (highest confidence), then
 *  2. any balanced top-level JSON array anywhere in the text — a ```json fence,
 *     prose around the block, or a bare array — found by bracket-balancing so
 *     backticks inside `resolvedContent` can't truncate it.
 *
 * The first candidate that yields ≥1 coerced proposal wins; a false start (a
 * `[` in prose) coerces to nothing and the scan advances. `coerceProposal`'s
 * safety is unchanged — a malformed element is still dropped or repaired toward
 * 'risky'. No usable array anywhere → `[]`.
 */
export function parseProposals(agentOutput: string): ConflictProposal[] {
  if (typeof agentOutput !== 'string') return []

  // Tier 1 — the tagged fence, extracted by balance (not the old non-greedy
  // regex) so a fence inside the content does not tear it.
  const match = FENCE_PATTERN.exec(agentOutput)
  if (match && typeof match.index === 'number') {
    const fenceOpen = agentOutput.indexOf('\n', match.index)
    if (fenceOpen !== -1) {
      const tagged = firstBalancedArray(agentOutput, fenceOpen)
      if (tagged) {
        const proposals = proposalsFromArrayText(tagged)
        if (proposals.length > 0) return proposals
      }
    }
  }

  // Tier 2 — scan the whole text for the first balanced array that coerces to
  // ≥1 proposal (covers ```json, prose, or a bare array).
  let cursor = 0
  for (;;) {
    const next = agentOutput.indexOf('[', cursor)
    if (next === -1) break
    const arrayText = firstBalancedArray(agentOutput, next)
    if (!arrayText) break
    const proposals = proposalsFromArrayText(arrayText)
    if (proposals.length > 0) return proposals
    cursor = next + 1
  }
  return []
}

/**
 * True when a message's content is essentially a conflict-proposals payload —
 * it yields ≥1 parseable proposal. The single recognizer the transcript uses to
 * suppress the raw JSON dump (#1919) and the resolve flow uses to gate the card,
 * so the two can never disagree (allowed-pattern #14). Pure, no side effects.
 */
export function isConflictProposalReply(content: string): boolean {
  if (typeof content !== 'string') return false
  return parseProposals(content).length > 0
}

/**
 * Build the concrete git resolution for an auto-appliable proposal, or null
 * when it cannot be applied (a `both` with no `resolvedContent`). `synthesized`
 * is never passed here — it is held upstream (D4).
 */
function resolutionFor(proposal: ConflictProposal): GitConflictResolution | null {
  switch (proposal.choice) {
    case 'ours':
      return { kind: 'ours' }
    case 'theirs':
      return { kind: 'theirs' }
    case 'both':
    case 'synthesized': {
      const text = proposal.resolvedContent
      if (typeof text !== 'string' || text.length === 0) return null
      return { kind: 'content', text }
    }
  }
}

/**
 * Fold each proposal together with its file's structural verdict into an
 * ApplyDecision. The structural verdict is the sole 'safe' authority; the
 * proposal's opinion enters only through `refineRisk` (downgrade-only), so a
 * structurally-risky file can never be auto-applied.
 *
 * Rules:
 *  - `synthesized` → ALWAYS hold (D4), regardless of risk.
 *  - a file with no structural verdict → treated as 'risky' (hold).
 *  - `finalRisk === 'safe'` AND not synthesized AND a concrete resolution can
 *    be built → 'auto-apply'; everything else holds.
 */
export function decideApplications(
  proposals: readonly ConflictProposal[],
  structuralByFile: Record<string, { risk: ConflictRisk }>,
  blockCountByFile: Record<string, number> = {},
): ApplyDecision[] {
  // Count proposals per file. A file with MORE THAN ONE proposal (i.e. multiple
  // conflict blocks resolved independently) cannot be auto-applied: every git
  // resolution acts on the WHOLE file (`checkout --ours/--theirs` or a single
  // `content` write), so applying one block's side silently drops the others
  // (#570, data-loss). Such files are held for manual review.
  const proposalsPerFile = new Map<string, number>()
  for (const proposal of proposals) {
    proposalsPerFile.set(proposal.file, (proposalsPerFile.get(proposal.file) ?? 0) + 1)
  }
  return proposals.map((proposal) =>
    decideOne(
      proposal,
      structuralByFile,
      proposalsPerFile.get(proposal.file) ?? 1,
      blockCountByFile[proposal.file] ?? 1,
    ),
  )
}

// ── Per-hunk auto-apply (conflict-UX Phase 5, Task 4) ────────────────────────
//
// The whole-file decision above HOLDS any multi-block file (a whole-file
// checkout would drop the other blocks — #570). With the per-hunk splice
// primitive (git:resolveConflictHunk / spliceConflictHunk), a provably-safe hunk
// can now be auto-applied INDIVIDUALLY without touching its siblings — so a
// multi-block file no longer forces the whole file to hold. This decision layer
// is per-hunk and drives the inspectable/reversible auto-resolve: every
// auto-applied hunk is recorded with `auto:true` (see merge-resolution-record).

/** The hunk id a proposal's block maps to — the caller resolves blockId→hunkId
 *  against the file's parsed hunks and supplies it here so the decision can name
 *  the concrete splice target. */
export interface HunkProposalTarget {
  /** The hunk's stable id (conflict-hunks.ts). */
  hunkId: string
  /** This specific hunk's structural verdict (safe iff provably safe). */
  structuralRisk: ConflictRisk
}

/** A per-hunk auto-apply decision. Only `auto-apply` decisions are spliced +
 *  recorded; `hold` hunks await human review. `synthesized` always holds (D4). */
export interface HunkApplyDecision {
  file: string
  hunkId: string
  /** The splice choice — never `synthesized` (that path always holds). */
  choice: ConflictHunkChoice
  /** Concatenation order for `choice: 'both'`. */
  order?: ConflictHunkOrder
  action: 'auto-apply' | 'hold'
  finalRisk: ConflictRisk
  why: string
}

/** The hunk-level splice choice for a proposal, or null when it can't splice
 *  per-hunk (`synthesized` writes new code — never a pure side selection). */
function hunkChoiceFor(proposal: ConflictProposal): ConflictHunkChoice | null {
  switch (proposal.choice) {
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
 * Decide ONE hunk's fate. Unlike the whole-file rule, there is no multi-block
 * data-loss guard here — a per-hunk splice leaves siblings untouched — so a
 * provably-safe, non-synthesized hunk auto-applies. Synthesized code always
 * holds (D4); a missing/risky structural verdict holds.
 */
export function decideHunkApplication(
  proposal: ConflictProposal,
  target: HunkProposalTarget,
): HunkApplyDecision {
  const structural: StructuralVerdict = {
    candidate: target.structuralRisk,
    reason: 'per-hunk structural',
  }
  const final = refineRisk(structural, { risk: proposal.risk, confidence: proposal.confidence })

  if (proposal.choice === 'synthesized') {
    return {
      file: proposal.file,
      hunkId: target.hunkId,
      choice: 'both', // nominal; never applied — synthesized always holds
      action: 'hold',
      finalRisk: final.risk,
      why: `synthesized code held for review; ${final.reason}`,
    }
  }

  const choice = hunkChoiceFor(proposal)
  if (choice === null || final.risk !== 'safe') {
    return {
      file: proposal.file,
      hunkId: target.hunkId,
      choice: choice ?? 'both',
      action: 'hold',
      finalRisk: final.risk,
      why: final.reason,
    }
  }
  return {
    file: proposal.file,
    hunkId: target.hunkId,
    choice,
    action: 'auto-apply',
    finalRisk: 'safe',
    why: final.reason,
  }
}

/**
 * Decide a batch of per-hunk proposals. `targetByBlock` maps a proposal's
 * `${file} ${blockId}` composite key to its resolved hunk id + structural
 * verdict. A proposal with no resolvable target is held (fail toward review).
 */
export function decideHunkApplications(
  proposals: readonly ConflictProposal[],
  targetByBlock: Record<string, HunkProposalTarget>,
): HunkApplyDecision[] {
  return proposals.map((proposal) => {
    const target = targetByBlock[blockKey(proposal.file, proposal.blockId)]
    if (!target) {
      return {
        file: proposal.file,
        hunkId: String(proposal.blockId),
        choice: hunkChoiceFor(proposal) ?? 'both',
        action: 'hold',
        finalRisk: 'risky',
        why: 'no hunk target resolved for this block; held for review',
      }
    }
    return decideHunkApplication(proposal, target)
  })
}

/** The composite key for a (file, blockId) pair in `targetByBlock`. */
export function blockKey(file: string, blockId: string | number): string {
  return `${file} ${blockId}`
}

function decideOne(
  proposal: ConflictProposal,
  structuralByFile: Record<string, { risk: ConflictRisk }>,
  fileProposalCount: number,
  fileBlockCount: number,
): ApplyDecision {
  // Absent structural verdict ⇒ risky (fail toward hold).
  const structuralRisk: ConflictRisk = structuralByFile[proposal.file]?.risk ?? 'risky'
  const structural: StructuralVerdict = {
    candidate: structuralRisk,
    reason: structuralByFile[proposal.file] ? 'aggregate structural' : 'no structural verdict',
  }
  const final = refineRisk(structural, { risk: proposal.risk, confidence: proposal.confidence })

  // D4: synthesized code is never auto-applied — a human always reviews new code.
  if (proposal.choice === 'synthesized') {
    return {
      file: proposal.file,
      action: 'hold',
      finalRisk: final.risk,
      why: `synthesized code held for review; ${final.reason}`,
    }
  }

  if (final.risk === 'safe') {
    const resolution = resolutionFor(proposal)
    if (resolution) {
      // #570 data-loss guard: git resolutions act on the WHOLE file. If the file
      // has multiple blocks/proposals, a whole-file `ours`/`theirs` would discard
      // the other blocks — only a single whole-file `content` resolution (one that
      // already merges every block) may auto-apply; otherwise hold for review.
      if (fileProposalCount > 1) {
        return {
          file: proposal.file,
          action: 'hold',
          finalRisk: 'safe',
          why: `multi-block file (${fileProposalCount} proposals) — whole-file apply would drop blocks; held for review`,
        }
      }
      if (fileBlockCount > 1 && resolution.kind !== 'content') {
        return {
          file: proposal.file,
          action: 'hold',
          finalRisk: 'safe',
          why: `multi-block file — whole-file "${resolution.kind}" would drop other blocks; held for review`,
        }
      }
      return { file: proposal.file, action: 'auto-apply', resolution, finalRisk: 'safe', why: final.reason }
    }
    // Safe but not applyable (a `both` with no resolvedContent) → hold.
    return {
      file: proposal.file,
      action: 'hold',
      finalRisk: 'safe',
      why: `safe but no resolvable content; ${final.reason}`,
    }
  }

  return { file: proposal.file, action: 'hold', finalRisk: final.risk, why: final.reason }
}
