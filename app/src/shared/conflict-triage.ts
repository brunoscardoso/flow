// Merge-conflict risk triage (#66). Pure and DOM-free — importable by both
// main and renderer — so the auto-apply decision is testable without Monaco
// or Electron and agrees everywhere it runs.
//
// DOWNGRADE-ONLY INVARIANT (safety-critical): this module gates which
// conflicts are eligible for auto-apply. Structural analysis is the ONLY
// signal that can call a conflict 'safe' outright; an LLM opinion may
// CONFIRM a structural 'safe' verdict or DOWNGRADE it to 'risky', but it can
// NEVER upgrade a structurally 'risky' verdict back to 'safe'. The asymmetry
// is deliberate: a false 'risky' costs the user one extra manual review: a
// false 'safe' can silently auto-apply a broken merge into their codebase.
// When any signal is uncertain, this module always resolves toward 'risky'.

import type { ConflictBlock } from '../renderer/editor/conflict-parser'

export type ConflictRisk = 'safe' | 'risky'

export interface StructuralVerdict {
  candidate: ConflictRisk
  reason: string
}

/** An LLM's opinion on a conflict's risk. confidence is 0..1. */
export interface LlmRisk {
  risk: ConflictRisk
  confidence: number
}

export interface FinalVerdict {
  risk: ConflictRisk
  confidence: number
  reason: string
}

/** Confidence assigned when a verdict was decided without an LLM opinion. */
const MAX_CONFIDENCE = 1

/** A line containing only whitespace (or nothing). */
const BLANK_LINE_PATTERN = /^\s*$/

/** diff3's optional base-content marker — its lines are excluded from comparison. */
const BASE_MARKER_PATTERN = /^\|\|\|\|\|\|\|(\s|$)/
/** The `ours` / `theirs` divider inside a conflict block. */
const SEPARATOR_MARKER_PATTERN = /^=======(\s|$)/

/** JS/TS `import ...` statements. */
const JS_IMPORT_PATTERN = /^import\s+.+$/
/** JS/TS `export ... from '...'` re-exports. */
const JS_EXPORT_FROM_PATTERN = /^export\s+.+\sfrom\s+.+$/
/** JS/TS `const x = require(...)`, optionally exported. */
const JS_REQUIRE_PATTERN = /^(export\s+)?const\s+.+=\s*require\(.+\)\s*;?$/
/** Python `import x` or `from x import y`. */
const PY_IMPORT_PATTERN = /^(import\s+\S+|from\s+\S+\s+import\s+.+)$/

const IMPORT_LINE_PATTERNS: RegExp[] = [JS_IMPORT_PATTERN, JS_EXPORT_FROM_PATTERN, JS_REQUIRE_PATTERN, PY_IMPORT_PATTERN]

/** The raw `ours`/`theirs` line content of a conflict block, markers excluded. */
interface ConflictSides {
  oursLines: string[]
  theirsLines: string[]
}

/**
 * Split a conflict block's body into its `ours` and `theirs` line sets.
 *
 * `ConflictBlock` (from `conflict-parser.ts`) carries only the 1-based marker
 * line numbers, not the section content, so the source text is re-sliced here
 * using the same marker grammar the parser uses. diff3 base-section lines (if
 * present) are discarded — this classifier only ever compares ours vs theirs.
 */
function extractConflictSides(text: string, block: ConflictBlock): ConflictSides {
  const lines = text.split('\n')
  const oursLines: string[] = []
  const theirsLines: string[] = []
  let section: 'ours' | 'base' | 'theirs' = 'ours'

  for (let lineNumber = block.startLine + 1; lineNumber < block.endLine; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? ''
    if (BASE_MARKER_PATTERN.test(line)) {
      section = 'base'
    } else if (SEPARATOR_MARKER_PATTERN.test(line)) {
      section = 'theirs'
    } else if (section === 'ours') {
      oursLines.push(line)
    } else if (section === 'theirs') {
      theirsLines.push(line)
    }
    // `section === 'base'` lines are intentionally dropped.
  }

  return { oursLines, theirsLines }
}

/** Trim each line and drop blank ones, so whitespace-only edits compare equal. */
function significantLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => !BLANK_LINE_PATTERN.test(line))
}

function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

function isImportLine(line: string): boolean {
  return IMPORT_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function allLinesAreImports(lines: string[]): boolean {
  return lines.length > 0 && lines.every(isImportLine)
}

/**
 * Deterministic, non-LLM classification of a conflict block's risk, purely
 * from its `ours`/`theirs` line content:
 *
 * 1. `whitespace-only` — both sides are identical once trimmed and blank
 *    lines are dropped.
 * 2. `import-only` — every non-blank line on both sides is an import/require
 *    statement (JS/TS or Python).
 * 3. `non-overlapping` — one side has no content at all (a pure add/remove
 *    with nothing to reconcile).
 * 4. `overlapping-logic` — anything else; both sides made real, differing edits.
 *
 * `text` must be the same file text `block` was parsed from (e.g. via
 * `parseConflicts` in `conflict-parser.ts`) — `ConflictBlock` only carries
 * marker line numbers, so the section content is re-derived from it here.
 */
export function classifyConflictStructural(text: string, block: ConflictBlock): StructuralVerdict {
  const { oursLines, theirsLines } = extractConflictSides(text, block)
  const oursSignificant = significantLines(oursLines)
  const theirsSignificant = significantLines(theirsLines)

  if (linesEqual(oursSignificant, theirsSignificant)) {
    return { candidate: 'safe', reason: 'whitespace-only' }
  }

  const bothSidesHaveContent = oursSignificant.length > 0 && theirsSignificant.length > 0
  if (bothSidesHaveContent && allLinesAreImports(oursSignificant) && allLinesAreImports(theirsSignificant)) {
    return { candidate: 'safe', reason: 'import-only' }
  }

  if (oursSignificant.length === 0 || theirsSignificant.length === 0) {
    return { candidate: 'safe', reason: 'non-overlapping' }
  }

  return { candidate: 'risky', reason: 'overlapping-logic' }
}

/**
 * Combine the structural verdict with an optional LLM opinion into the final
 * risk used to gate auto-apply. See the module-level DOWNGRADE-ONLY comment —
 * this function is the single enforcement point for that invariant:
 *
 * - structural 'risky' → always 'risky', regardless of `llm` (never upgraded).
 * - structural 'safe' + `llm` null → stays 'safe' (no opinion to downgrade it).
 * - structural 'safe' + `llm.risk === 'risky'` → downgraded to 'risky'.
 * - structural 'safe' + `llm.risk === 'safe'` → confirmed 'safe'.
 */
export function refineRisk(structural: StructuralVerdict, llm: LlmRisk | null): FinalVerdict {
  if (structural.candidate === 'risky') {
    return {
      risk: 'risky',
      confidence: llm?.confidence ?? MAX_CONFIDENCE,
      reason: `structural verdict is risky (${structural.reason}); llm cannot upgrade`,
    }
  }

  if (llm === null) {
    return {
      risk: 'safe',
      confidence: MAX_CONFIDENCE,
      reason: `structural verdict is safe (${structural.reason}); no llm opinion`,
    }
  }

  if (llm.risk === 'risky') {
    return {
      risk: 'risky',
      confidence: llm.confidence,
      reason: `llm downgraded structural safe verdict (${structural.reason}) to risky`,
    }
  }

  return {
    risk: 'safe',
    confidence: llm.confidence,
    reason: `structural verdict is safe (${structural.reason}); llm confirmed safe`,
  }
}

/**
 * Force a verdict to 'risky' (e.g. post-merge verification failed) and record
 * why. Never returns 'safe' — this is a one-way escalation, mirroring the
 * downgrade-only invariant `refineRisk` enforces.
 */
export function forceRisky(verdict: FinalVerdict, reason: string): FinalVerdict {
  return {
    risk: 'risky',
    confidence: verdict.confidence,
    reason: `${verdict.reason}; forced risky: ${reason}`,
  }
}
