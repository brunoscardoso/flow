import { buildConflictResolutionPrompt, type ConflictFile } from './conflict-prompt'
import { CONFLICT_PROPOSALS_FENCE } from './conflict-proposal'

const f = (rootPath: string, filePath: string, extra: Partial<ConflictFile> = {}): ConflictFile => ({
  rootPath,
  filePath,
  ...extra,
})
const single = { multiRoot: false }
const multi = { multiRoot: true }

describe('buildConflictResolutionPrompt', () => {
  it('lists the files and instructs a fenced conflict-proposals reply (single-root: plain list)', () => {
    const prompt = buildConflictResolutionPrompt([f('/r', 'src/a.ts'), f('/r', 'src/b.ts')], single)
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('- src/b.ts')
    expect(prompt).toContain(CONFLICT_PROPOSALS_FENCE)
    expect(prompt).toMatch(/conflict markers/i)
    // Instructs the choice semantics (keep/combine existing sides).
    expect(prompt).toMatch(/combin/i)
    expect(prompt).toMatch(/synthesized/i)
    // A single-project window needs no group header.
    expect(prompt).not.toMatch(/^In /m)
  })

  it('renders each block id + line range when blocks are known', () => {
    const prompt = buildConflictResolutionPrompt(
      [f('/r', 'src/a.ts', { blocks: [{ blockId: 0, startLine: 3, endLine: 9 }] })],
      single,
    )
    expect(prompt).toContain('block 0: lines 3–9')
  })

  it('renders reachable intent context when present', () => {
    const prompt = buildConflictResolutionPrompt(
      [f('/r', 'src/a.ts', { context: 'ours: phase-2 auth; theirs: phase-3 logging' })],
      single,
    )
    expect(prompt).toContain('context: ours: phase-2 auth; theirs: phase-3 logging')
  })

  it('de-dupes on (root, file) and ignores blank entries', () => {
    const prompt = buildConflictResolutionPrompt(
      [f('/r', 'a.ts'), f('/r', 'a.ts'), f('/r', '  '), f('/r', 'b.ts')],
      single,
    )
    expect((prompt?.match(/- a\.ts/g) ?? []).length).toBe(1)
    expect(prompt).toContain('- b.ts')
  })

  it('returns null when there is nothing to resolve', () => {
    expect(buildConflictResolutionPrompt([], multi)).toBeNull()
    expect(buildConflictResolutionPrompt([f('/r', ''), f('/r', '   ')], single)).toBeNull()
  })

  it('keeps same-relative-path conflicts in different roots distinct, grouped by root (#295)', () => {
    const prompt = buildConflictResolutionPrompt(
      [f('/abs/repoA', 'src/index.ts'), f('/abs/repoB', 'src/index.ts')],
      multi,
    )
    expect(prompt).toContain('In repoA (/abs/repoA):')
    expect(prompt).toContain('In repoB (/abs/repoB):')
    expect((prompt?.match(/- src\/index\.ts/g) ?? []).length).toBe(2)
  })

  it('groups multiple files under their respective roots', () => {
    const prompt = buildConflictResolutionPrompt(
      [f('/abs/repoA', 'a.ts'), f('/abs/repoB', 'b.ts'), f('/abs/repoA', 'c.ts')],
      multi,
    )
    const repoA = prompt?.slice(prompt.indexOf('In repoA'), prompt.indexOf('In repoB')) ?? ''
    expect(repoA).toContain('- a.ts')
    expect(repoA).toContain('- c.ts')
    expect(repoA).not.toContain('- b.ts')
  })

  it('qualifies by root in a MULTI-project window even when only ONE root has conflicts (#337)', () => {
    const prompt = buildConflictResolutionPrompt([f('/abs/repoB', 'src/index.ts')], multi)
    expect(prompt).toContain('In repoB (/abs/repoB):')
    expect(prompt).toContain('- src/index.ts')
    expect(prompt).toMatch(/^In /m)
  })

  it('is deterministic — identical inputs produce identical prompts', () => {
    const input: ConflictFile[] = [f('/r', 'a.ts', { blocks: [{ blockId: 0, startLine: 1, endLine: 4 }] })]
    expect(buildConflictResolutionPrompt(input, single)).toBe(
      buildConflictResolutionPrompt(input, single),
    )
  })
})
