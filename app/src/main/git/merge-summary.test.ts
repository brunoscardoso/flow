// Merge-resolution summary tests (#66; Phase 10). `buildMergeSummary` is PURE
// and DETERMINISTIC — the same input renders byte-identical `doc` + `commitBody`
// (no clock, no randomness), pinned here by an exact-string snapshot plus a
// call-twice equality check. `writeMergeSummaryDoc` is driven through an injected
// fs so no disk is touched, and its path-containment guard is exercised.

import { isAbsolute, join } from 'node:path'

import {
  MERGE_SUMMARY_DIR,
  buildMergeSummary,
  sanitizeBranchForFilename,
  writeMergeSummaryDoc,
  type WriteMergeSummaryDeps,
} from './merge-summary'
import type { MergeSummaryConflict, MergeSummaryInput } from '../../shared/ipc-contract'

const conflict = (overrides: Partial<MergeSummaryConflict> = {}): MergeSummaryConflict => ({
  file: 'src/a.ts',
  oursIntent: 'our thing',
  theirsIntent: 'their thing',
  choice: 'ours',
  finalRisk: 'safe',
  confidence: 0.9,
  why: 'because',
  how: 'took ours',
  ...overrides,
})

const input = (overrides: Partial<MergeSummaryInput> = {}): MergeSummaryInput => ({
  branch: 'feat/x',
  ontoBranch: 'main',
  conflicts: [conflict()],
  verify: { ok: true, ran: ['typecheck'] },
  ...overrides,
})

describe('buildMergeSummary — determinism', () => {
  it('renders byte-identical output for the same input (no clock/randomness)', () => {
    const a = buildMergeSummary(input())
    const b = buildMergeSummary(input())
    expect(a).toEqual(b)
    expect(a.doc).toBe(b.doc)
    expect(a.commitBody).toBe(b.commitBody)
  })

  it('renders the exact expected doc + commit body (snapshot)', () => {
    const { doc, commitBody } = buildMergeSummary(input())
    expect(doc).toBe(
      [
        '# Merge Resolution Summary',
        '',
        '**Branch:** `feat/x`',
        '**Merging from:** `main`',
        '**Conflicts resolved:** 1',
        '**Overall risk:** safe',
        '**Verification:** passed (ran: typecheck)',
        '',
        '## Conflicts',
        '',
        '### 1. `src/a.ts`',
        '',
        '- **Our intent:** our thing',
        '- **Their intent:** their thing',
        '- **Choice:** ours',
        '- **Risk:** safe · **Confidence:** 90%',
        '- **Why:** because',
        '- **How:** took ours',
        '',
      ].join('\n'),
    )
    expect(commitBody).toBe(
      [
        'Merge resolution: 1 conflict(s) resolved, risk: safe.',
        'Verification: passed (ran: typecheck).',
        '- src/a.ts: ours (safe)',
      ].join('\n'),
    )
  })
})

describe('buildMergeSummary — content rules', () => {
  it('marks overall risk risky when ANY conflict is risky', () => {
    const { doc } = buildMergeSummary(
      input({ conflicts: [conflict({ finalRisk: 'safe' }), conflict({ file: 'b.ts', finalRisk: 'risky' })] }),
    )
    expect(doc).toContain('**Overall risk:** risky')
  })

  it('reports UNASSESSED when the conflict list is empty (#1287)', () => {
    // It used to say `safe` here — a risk assessment over nothing at all,
    // written into the summary doc AND the commit trailer that lands in
    // history forever. `safe` is a claim; an empty set earns no claim.
    const { doc, commitBody } = buildMergeSummary(input({ conflicts: [] }))
    expect(doc).toContain('**Overall risk:** unassessed')
    expect(doc).toContain('_No recorded conflict resolutions._')
    expect(commitBody).toContain('0 conflict(s) resolved, risk: unassessed')
  })

  it('reports UNASSESSED when any resolution went unexamined (#1287)', () => {
    // A human picking a side is a resolution nothing judged. Mixing one into
    // an otherwise-safe set must not inherit the set's `safe`.
    const { doc } = buildMergeSummary(
      input({
        conflicts: [conflict({ finalRisk: 'safe' }), conflict({ finalRisk: 'unassessed' })],
      }),
    )
    expect(doc).toContain('**Overall risk:** unassessed')
  })

  it('still reports risky when anything is risky — worst wins (#1287)', () => {
    const { doc } = buildMergeSummary(
      input({
        conflicts: [conflict({ finalRisk: 'unassessed' }), conflict({ finalRisk: 'risky' })],
      }),
    )
    expect(doc).toContain('**Overall risk:** risky')
  })

  it('still reports safe when everything WAS assessed safe', () => {
    const { doc } = buildMergeSummary(
      input({ conflicts: [conflict({ finalRisk: 'safe' }), conflict({ finalRisk: 'safe' })] }),
    )
    expect(doc).toContain('**Overall risk:** safe')
  })

  it('renders the placeholder for empty text fields', () => {
    const { doc } = buildMergeSummary(
      input({ conflicts: [conflict({ oursIntent: '', why: '  ', how: '' })] }),
    )
    expect(doc).toContain('- **Our intent:** —')
    expect(doc).toContain('- **Why:** —')
    expect(doc).toContain('- **How:** —')
  })

  it('renders a section per conflict with a 1-based index', () => {
    const { doc } = buildMergeSummary(
      input({ conflicts: [conflict({ file: 'a.ts' }), conflict({ file: 'b.ts' })] }),
    )
    expect(doc).toContain('### 1. `a.ts`')
    expect(doc).toContain('### 2. `b.ts`')
  })

  it('describes a missing verify block as not run', () => {
    const { doc } = buildMergeSummary(input({ verify: undefined }))
    expect(doc).toContain('**Verification:** not run')
  })

  it('describes a failed verification with its first failing step', () => {
    const { doc } = buildMergeSummary(
      input({ verify: { ok: false, ran: ['typecheck', 'test'], firstFailure: 'test' } }),
    )
    expect(doc).toContain('**Verification:** failed at test (ran: typecheck, test)')
  })
})

describe('sanitizeBranchForFilename', () => {
  it('replaces path separators and unsafe chars with dashes', () => {
    expect(sanitizeBranchForFilename('feat/x')).toBe('feat-x')
    expect(sanitizeBranchForFilename('feat/foo bar')).toBe('feat-foo-bar')
  })

  it('trims leading/trailing dashes', () => {
    expect(sanitizeBranchForFilename('/weird/')).toBe('weird')
  })

  it('falls back to a default token when a branch sanitizes to nothing', () => {
    expect(sanitizeBranchForFilename('///')).toBe('merge')
    expect(sanitizeBranchForFilename('')).toBe('merge')
  })
})

describe('writeMergeSummaryDoc', () => {
  function fakeDeps(): { deps: WriteMergeSummaryDeps; mkdirs: string[]; writes: Array<{ path: string; data: string }> } {
    const mkdirs: string[] = []
    const writes: Array<{ path: string; data: string }> = []
    return {
      mkdirs,
      writes,
      deps: {
        mkdir: async (dirPath) => {
          mkdirs.push(dirPath)
        },
        writeFile: async (filePath, data) => {
          writes.push({ path: filePath, data })
        },
      },
    }
  }

  it('writes to flow/merges/merge_<sanitized>_<stamp>.md and returns the path', async () => {
    const { deps, mkdirs, writes } = fakeDeps()
    const path = await writeMergeSummaryDoc('/root', 'feat/x', '20260716-000000', 'DOC', deps)

    const expected = join('/root', MERGE_SUMMARY_DIR, 'merge_feat-x_20260716-000000.md')
    expect(path).toBe(expected)
    expect(mkdirs).toEqual([join('/root', MERGE_SUMMARY_DIR)])
    expect(writes).toEqual([{ path: expected, data: 'DOC' }])
  })

  it('neutralises a path-traversal branch name (sanitised, path stays inside root)', async () => {
    const { deps, writes } = fakeDeps()
    const path = await writeMergeSummaryDoc('/root', '../../../../etc/passwd', 'stamp', 'DOC', deps)
    expect(path.startsWith(join('/root', MERGE_SUMMARY_DIR))).toBe(true)
    expect(path).not.toContain('/etc/passwd')
    expect(writes).toHaveLength(1)
  })

  it('rejects a stamp that would escape the root (containment guard)', async () => {
    const { deps, writes } = fakeDeps()
    await expect(
      writeMergeSummaryDoc('/root', 'feat', '../../../../../../../../tmp/pwned', 'DOC', deps),
    ).rejects.toThrow(/escapes root/)
    expect(writes).toHaveLength(0)
  })

  it('produces an absolute path under the resolved root', async () => {
    const { deps } = fakeDeps()
    const path = await writeMergeSummaryDoc('/root', 'main', 'stamp', 'DOC', deps)
    expect(isAbsolute(path)).toBe(true)
  })
})
