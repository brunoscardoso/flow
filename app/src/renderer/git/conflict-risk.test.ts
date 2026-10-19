// Per-file structural risk badge tests (#335; Phase 10). `fileConflictRisk`
// collapses a marker-laden file's per-block verdicts into one badge, mirroring
// conflict-triage's downgrade-only stance: a file is 'safe' only when it has at
// least one parseable block AND every block is structurally safe.

import { fileConflictRisk } from './conflict-risk'

/** Assemble one conflict block's marker text. */
function block(ours: string[], theirs: string[]): string {
  return ['<<<<<<< HEAD', ...ours, '=======', ...theirs, '>>>>>>> branch'].join('\n')
}

describe('fileConflictRisk', () => {
  it('is risky when the file has no parseable conflict blocks', () => {
    expect(fileConflictRisk('just some normal file content\nno markers')).toBe('risky')
    expect(fileConflictRisk('')).toBe('risky')
  })

  it('is safe when the single block is structurally safe (import-only)', () => {
    expect(fileConflictRisk(block(["import a from 'a'"], ["import b from 'b'"]))).toBe('safe')
  })

  it('is safe when every one of several blocks is structurally safe', () => {
    const text = [
      block(["import a from 'a'"], ["import b from 'b'"]),
      block(['  foo()'], ['foo()']), // whitespace-only
    ].join('\n')
    expect(fileConflictRisk(text)).toBe('safe')
  })

  it('is risky when any block is structurally risky', () => {
    const text = [
      block(["import a from 'a'"], ["import b from 'b'"]), // safe
      block(['const x = 1'], ['const x = 2']), // risky logic
    ].join('\n')
    expect(fileConflictRisk(text)).toBe('risky')
  })

  it('is risky for a single overlapping-logic block', () => {
    expect(fileConflictRisk(block(['return doA()'], ['return doB()']))).toBe('risky')
  })

  it('is safe for a non-overlapping block (one side empty)', () => {
    expect(fileConflictRisk(block(['const added = 1'], []))).toBe('safe')
  })
})
