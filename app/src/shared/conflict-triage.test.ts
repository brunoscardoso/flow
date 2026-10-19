// Merge-conflict risk triage tests (#66; Phase 10). Structural classification is
// exercised against REAL ConflictBlocks built by `parseConflicts` from marker
// text, and the downgrade-only invariant of `refineRisk`/`forceRisky` is pinned
// exhaustively — a structurally-risky verdict can never be talked back to 'safe'.

import {
  classifyConflictStructural,
  refineRisk,
  forceRisky,
  type FinalVerdict,
  type LlmRisk,
  type StructuralVerdict,
} from './conflict-triage'
import { parseConflicts, type ConflictBlock } from '../renderer/editor/conflict-parser'

/**
 * Build a single conflict block's marker text and parse it back into the
 * `(text, block)` pair `classifyConflictStructural` consumes — exactly how the
 * real pipeline derives blocks, so the section re-slicing is covered end-to-end.
 */
function conflict(ours: string[], theirs: string[], base?: string[]): { text: string; block: ConflictBlock } {
  const lines = ['<<<<<<< HEAD', ...ours]
  if (base) lines.push('||||||| base', ...base)
  lines.push('=======', ...theirs, '>>>>>>> branch')
  const text = lines.join('\n')
  const blocks = parseConflicts(text)
  expect(blocks).toHaveLength(1)
  return { text, block: blocks[0] }
}

describe('classifyConflictStructural', () => {
  it('classifies a whitespace-only conflict as safe (sides equal once trimmed)', () => {
    const { text, block } = conflict(['  foo()', ''], ['foo()'])
    expect(classifyConflictStructural(text, block)).toEqual({ candidate: 'safe', reason: 'whitespace-only' })
  })

  it('classifies an import-only conflict (both sides all imports) as safe', () => {
    const { text, block } = conflict(["import a from 'a'"], ["import b from 'b'"])
    expect(classifyConflictStructural(text, block)).toEqual({ candidate: 'safe', reason: 'import-only' })
  })

  it('recognises Python and require-style import lines as import-only', () => {
    const { text, block } = conflict(['from x import y'], ['const z = require("z")'])
    expect(classifyConflictStructural(text, block).candidate).toBe('safe')
    expect(classifyConflictStructural(text, block).reason).toBe('import-only')
  })

  it('classifies a non-overlapping conflict (theirs side empty) as safe', () => {
    const { text, block } = conflict(['const added = 1'], [])
    expect(classifyConflictStructural(text, block)).toEqual({ candidate: 'safe', reason: 'non-overlapping' })
  })

  it('classifies a non-overlapping conflict (ours side empty) as safe', () => {
    const { text, block } = conflict([], ['const incoming = 2'])
    expect(classifyConflictStructural(text, block)).toEqual({ candidate: 'safe', reason: 'non-overlapping' })
  })

  it('classifies overlapping differing logic as risky', () => {
    const { text, block } = conflict(['const x = 1'], ['const x = 2'])
    expect(classifyConflictStructural(text, block)).toEqual({ candidate: 'risky', reason: 'overlapping-logic' })
  })

  it('is risky when one side mixes an import with real logic (not import-only)', () => {
    const { text, block } = conflict(["import a from 'a'", 'doThing()'], ["import b from 'b'"])
    expect(classifyConflictStructural(text, block).candidate).toBe('risky')
  })

  it('ignores diff3 base-section lines, comparing only ours vs theirs', () => {
    // Base differs from both, but ours/theirs are whitespace-equal → still safe.
    const { text, block } = conflict(['value()'], ['  value()  '], ['original()'])
    expect(classifyConflictStructural(text, block).reason).toBe('whitespace-only')
  })
})

describe('refineRisk (downgrade-only invariant)', () => {
  const safe: StructuralVerdict = { candidate: 'safe', reason: 'import-only' }
  const risky: StructuralVerdict = { candidate: 'risky', reason: 'overlapping-logic' }

  it('keeps a structurally-risky verdict risky when the LLM says safe (never upgraded)', () => {
    const llmSafe: LlmRisk = { risk: 'safe', confidence: 0.99 }
    expect(refineRisk(risky, llmSafe).risk).toBe('risky')
  })

  it('keeps a structurally-risky verdict risky when there is no LLM opinion', () => {
    expect(refineRisk(risky, null).risk).toBe('risky')
  })

  it('keeps a structurally-risky verdict risky when the LLM also says risky', () => {
    expect(refineRisk(risky, { risk: 'risky', confidence: 0.5 }).risk).toBe('risky')
  })

  it('confirms a structurally-safe verdict as safe with no LLM opinion', () => {
    const verdict = refineRisk(safe, null)
    expect(verdict.risk).toBe('safe')
    expect(verdict.confidence).toBe(1)
  })

  it('downgrades a structurally-safe verdict to risky when the LLM says risky', () => {
    const verdict = refineRisk(safe, { risk: 'risky', confidence: 0.8 })
    expect(verdict.risk).toBe('risky')
    expect(verdict.confidence).toBe(0.8)
  })

  it('confirms a structurally-safe verdict when the LLM agrees it is safe', () => {
    const verdict = refineRisk(safe, { risk: 'safe', confidence: 0.7 })
    expect(verdict.risk).toBe('safe')
    expect(verdict.confidence).toBe(0.7)
  })

  it('carries the structural reason into every returned rationale', () => {
    expect(refineRisk(safe, null).reason).toContain('import-only')
    expect(refineRisk(risky, null).reason).toContain('overlapping-logic')
  })
})

describe('forceRisky', () => {
  const base: FinalVerdict = { risk: 'safe', confidence: 0.9, reason: 'was safe' }

  it('forces a safe verdict to risky and never returns safe', () => {
    const forced = forceRisky(base, 'post-merge verification failed')
    expect(forced.risk).toBe('risky')
  })

  it('preserves confidence and appends the escalation reason', () => {
    const forced = forceRisky(base, 'tsc failed')
    expect(forced.confidence).toBe(0.9)
    expect(forced.reason).toContain('was safe')
    expect(forced.reason).toContain('forced risky: tsc failed')
  })

  it('keeps an already-risky verdict risky (one-way escalation)', () => {
    const risky: FinalVerdict = { risk: 'risky', confidence: 0.3, reason: 'r' }
    expect(forceRisky(risky, 'again').risk).toBe('risky')
  })
})
