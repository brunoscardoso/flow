import {
  CONFLICT_PROPOSALS_FENCE,
  decideApplications,
  decideHunkApplication,
  decideHunkApplications,
  blockKey,
  isConflictProposalReply,
  parseProposals,
  type ConflictProposal,
  type HunkProposalTarget,
} from './conflict-proposal'
import type { ConflictRisk } from '../../shared/conflict-triage'

/** Wrap a JSON array in the fenced conflict-proposals block the agent emits. */
function fenced(json: unknown): string {
  return ['Here you go:', '```' + CONFLICT_PROPOSALS_FENCE, JSON.stringify(json), '```', 'done'].join('\n')
}

const base: ConflictProposal = {
  file: 'src/a.ts',
  blockId: 0,
  choice: 'ours',
  risk: 'safe',
  confidence: 0.9,
  why: 'w',
  how: 'h',
}

describe('parseProposals', () => {
  it('extracts + validates a well-formed fenced array', () => {
    const out = fenced([{ ...base }, { ...base, blockId: 1, choice: 'theirs' }])
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(2)
    expect(proposals[0]).toMatchObject({ file: 'src/a.ts', blockId: 0, choice: 'ours', risk: 'safe' })
    expect(proposals[1].choice).toBe('theirs')
  })

  it('returns [] when there is no fence, bad JSON, or a non-array body', () => {
    expect(parseProposals('no fence here')).toEqual([])
    expect(parseProposals('```' + CONFLICT_PROPOSALS_FENCE + '\n{ not json ```')).toEqual([])
    expect(parseProposals(fenced({ notAn: 'array' }))).toEqual([])
  })

  it('RECOVERS a proposal whose resolvedContent carries its own ``` fence (#1919)', () => {
    // A conflict resolved in a markdown/code file routinely carries a ``` fence
    // inside resolvedContent. The old non-greedy ```…``` capture ended at that
    // inner fence → truncated JSON → [] → no review card, raw JSON shown. The
    // bracket-balanced extractor honors JSON strings, so the array parses whole.
    //
    // This is now SAFE to recover: the parse feeds the HUMAN-IN-THE-LOOP review
    // card (nothing auto-applies; every Accept re-reads the live hunk through the
    // per-hunk splice, which reports a mismatch rather than misapplying). The old
    // auto-apply decision path this test used to protect has no production caller.
    const out = fenced([
      { ...base, choice: 'both', resolvedContent: '# doc\n```js\ncode\n```\ntail' },
    ])
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ choice: 'both' })
    expect(proposals[0].resolvedContent).toContain('```js')
  })

  it('recovers proposals from a ```json fence (agent used the wrong tag)', () => {
    const out = ['Sure:', '```json', JSON.stringify([{ ...base, choice: 'theirs' }]), '```'].join('\n')
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].choice).toBe('theirs')
  })

  it('recovers a bare JSON array with surrounding prose (no fence at all)', () => {
    const out =
      'Here are the resolutions I propose (see [the notes] for context): ' +
      JSON.stringify([{ ...base }, { ...base, blockId: 1, choice: 'theirs' }]) +
      ' — let me know.'
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(2)
    expect(proposals.map((p) => p.blockId)).toEqual([0, 1])
  })

  it('skips a false-start bracket in prose and finds the real proposal array', () => {
    const out = 'Options [A] or [B]? I chose: ' + JSON.stringify([{ ...base }])
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].file).toBe('src/a.ts')
  })

  it('prefers the tagged fence over any other array in the message', () => {
    const out = [
      'ignore this array [1,2,3]',
      '```' + CONFLICT_PROPOSALS_FENCE,
      JSON.stringify([{ ...base, choice: 'theirs' }]),
      '```',
    ].join('\n')
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].choice).toBe('theirs')
  })

  it('never throws on non-string input', () => {
    expect(parseProposals(undefined as unknown as string)).toEqual([])
  })

  it('drops elements missing identity fields (file / blockId / choice)', () => {
    const out = fenced([
      { ...base, file: '' },
      { ...base, blockId: undefined },
      { ...base, choice: 'bogus' },
      { ...base, blockId: 2 },
    ])
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].blockId).toBe(2)
  })

  it('repairs a malformed element toward risky rather than dropping it', () => {
    const out = fenced([
      { ...base, risk: 'safe', confidence: 'high' }, // bad confidence
      { ...base, blockId: 1, risk: 'nonsense' }, // bad risk
      { ...base, blockId: 2, why: 123 }, // bad rationale type
    ])
    const proposals = parseProposals(out)
    expect(proposals).toHaveLength(3)
    for (const p of proposals) expect(p.risk).toBe('risky')
  })

  it('clamps confidence into 0..1', () => {
    const proposals = parseProposals(fenced([{ ...base, confidence: 5 }]))
    expect(proposals[0].confidence).toBe(1)
  })
})

describe('isConflictProposalReply', () => {
  it('is true for a tagged fence, a ```json fence, and a bare array reply', () => {
    expect(isConflictProposalReply(fenced([{ ...base }]))).toBe(true)
    expect(
      isConflictProposalReply(['```json', JSON.stringify([{ ...base }]), '```'].join('\n')),
    ).toBe(true)
    expect(isConflictProposalReply('proposal: ' + JSON.stringify([{ ...base }]))).toBe(true)
  })

  it('is false for ordinary prose, an empty array, and non-string input', () => {
    expect(isConflictProposalReply('Sounds good, resolving now.')).toBe(false)
    expect(isConflictProposalReply(fenced([]))).toBe(false)
    expect(isConflictProposalReply(undefined as unknown as string)).toBe(false)
  })
})

describe('decideApplications', () => {
  const structural = (risk: ConflictRisk): Record<string, { risk: ConflictRisk }> => ({
    'src/a.ts': { risk },
  })

  it('auto-applies a safe ours/theirs proposal as a whole-side resolution', () => {
    const [d] = decideApplications([{ ...base, choice: 'theirs' }], structural('safe'))
    expect(d.action).toBe('auto-apply')
    expect(d.resolution).toEqual({ kind: 'theirs' })
    expect(d.finalRisk).toBe('safe')
  })

  it('auto-applies a safe both proposal as content', () => {
    const [d] = decideApplications(
      [{ ...base, choice: 'both', resolvedContent: 'merged file' }],
      structural('safe'),
    )
    expect(d.action).toBe('auto-apply')
    expect(d.resolution).toEqual({ kind: 'content', text: 'merged file' })
  })

  it('ALWAYS holds synthesized, even when structurally safe (D4)', () => {
    const [d] = decideApplications(
      [{ ...base, choice: 'synthesized', resolvedContent: 'new code' }],
      structural('safe'),
    )
    expect(d.action).toBe('hold')
  })

  it('holds when the structural verdict is risky (downgrade-only)', () => {
    const [d] = decideApplications([{ ...base }], structural('risky'))
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('risky')
  })

  it('honors an LLM downgrade of a structurally-safe file', () => {
    const [d] = decideApplications([{ ...base, risk: 'risky' }], structural('safe'))
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('risky')
  })

  it('holds a file with no structural verdict', () => {
    const [d] = decideApplications([{ ...base }], {})
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('risky')
  })

  it('holds a safe both proposal that lacks resolvedContent', () => {
    const [d] = decideApplications([{ ...base, choice: 'both' }], structural('safe'))
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('safe')
  })

  it('holds synthesized even when structurally risky (D4 + downgrade-only combined)', () => {
    const [d] = decideApplications(
      [{ ...base, choice: 'synthesized', resolvedContent: 'new code', risk: 'risky' }],
      structural('risky'),
    )
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('risky')
    expect(d.why).toContain('synthesized')
  })

  it('never attaches a resolution to a held synthesized proposal', () => {
    const [d] = decideApplications(
      [{ ...base, choice: 'synthesized', resolvedContent: 'new code' }],
      structural('safe'),
    )
    expect(d.resolution).toBeUndefined()
  })

  it('auto-applies a safe ours proposal against a structurally-safe file', () => {
    const [d] = decideApplications([{ ...base, choice: 'ours' }], structural('safe'))
    expect(d.action).toBe('auto-apply')
    expect(d.resolution).toEqual({ kind: 'ours' })
  })

  it('decides each proposal independently across a mixed batch (distinct files)', () => {
    // Distinct files so each is a single-block file — mixing them within ONE file
    // would (correctly) hold them all under the #570 multi-block guard.
    const decisions = decideApplications(
      [
        { ...base, file: 'src/a.ts', choice: 'ours' }, // safe → auto-apply
        { ...base, file: 'src/b.ts', choice: 'synthesized', resolvedContent: 'x' }, // held (D4)
        { ...base, file: 'src/c.ts', choice: 'theirs', risk: 'risky' }, // downgraded → hold
      ],
      { 'src/a.ts': { risk: 'safe' }, 'src/b.ts': { risk: 'safe' }, 'src/c.ts': { risk: 'safe' } },
    )
    expect(decisions.map((d) => d.action)).toEqual(['auto-apply', 'hold', 'hold'])
  })

  it('HOLDS every block of a multi-block file — whole-file apply would drop data (#570)', () => {
    // Two safe blocks of ONE file resolved to different sides: a whole-file
    // ours/theirs checkout can only keep one, so both must hold (no auto-apply).
    const decisions = decideApplications(
      [
        { ...base, file: 'src/x.ts', blockId: 0, choice: 'ours' },
        { ...base, file: 'src/x.ts', blockId: 1, choice: 'theirs' },
      ],
      { 'src/x.ts': { risk: 'safe' } },
    )
    expect(decisions.map((d) => d.action)).toEqual(['hold', 'hold'])
    expect(decisions[0].why).toContain('multi-block')
  })

  it('HOLDS a single whole-file ours/theirs when the file has multiple blocks (#570)', () => {
    // One proposal, but the file itself has 2 conflict blocks — a whole-file
    // side would drop the other block; only a `content` resolution may apply.
    const [d] = decideApplications(
      [{ ...base, file: 'src/y.ts', choice: 'ours' }],
      { 'src/y.ts': { risk: 'safe' } },
      { 'src/y.ts': 2 },
    )
    expect(d.action).toBe('hold')
    expect(d.why).toContain('multi-block')
  })

  it('AUTO-APPLIES a whole-file content resolution even for a multi-block file (#570)', () => {
    // A single `both` proposal whose resolvedContent is the full merged file is
    // safe regardless of block count — it writes the entire file at once.
    const [d] = decideApplications(
      [{ ...base, file: 'src/z.ts', choice: 'both', resolvedContent: 'merged whole file' }],
      { 'src/z.ts': { risk: 'safe' } },
      { 'src/z.ts': 3 },
    )
    expect(d.action).toBe('auto-apply')
    expect(d.resolution).toEqual({ kind: 'content', text: 'merged whole file' })
  })

  it('maps parsed-then-decided proposals end-to-end from agent output', () => {
    const out = [
      'ok',
      '```' + CONFLICT_PROPOSALS_FENCE,
      JSON.stringify([{ ...base, choice: 'theirs' }]),
      '```',
    ].join('\n')
    const proposals = parseProposals(out)
    const [d] = decideApplications(proposals, structural('safe'))
    expect(d.action).toBe('auto-apply')
    expect(d.resolution).toEqual({ kind: 'theirs' })
  })
})

describe('decideApplications on an empty proposal set', () => {
  it('returns [] when there are no proposals to decide', () => {
    expect(decideApplications([], { 'src/a.ts': { risk: 'safe' } })).toEqual([])
  })
})

describe('decideHunkApplication (Phase 5 Task 4) — per-hunk auto-resolve', () => {
  const target = (structuralRisk: ConflictRisk, hunkId = 'hunk-1'): HunkProposalTarget => ({
    hunkId,
    structuralRisk,
  })

  it('auto-applies a provably-safe, non-synthesized hunk', () => {
    const d = decideHunkApplication({ ...base, choice: 'ours' }, target('safe'))
    expect(d.action).toBe('auto-apply')
    expect(d.choice).toBe('ours')
    expect(d.hunkId).toBe('hunk-1')
    expect(d.finalRisk).toBe('safe')
  })

  it('maps both → both (per-hunk splice handles concatenation, no resolvedContent needed)', () => {
    const d = decideHunkApplication({ ...base, choice: 'both' }, target('safe'))
    expect(d.action).toBe('auto-apply')
    expect(d.choice).toBe('both')
  })

  it('holds a structurally-risky hunk (downgrade-only: agent cannot make it safe)', () => {
    const d = decideHunkApplication({ ...base, choice: 'ours', risk: 'safe' }, target('risky'))
    expect(d.action).toBe('hold')
    expect(d.finalRisk).toBe('risky')
  })

  it('ALWAYS holds synthesized code (D4), even when structurally safe', () => {
    const d = decideHunkApplication({ ...base, choice: 'synthesized' }, target('safe'))
    expect(d.action).toBe('hold')
    expect(d.why).toContain('synthesized')
  })

  it('does NOT force a multi-block file to hold — each safe hunk auto-applies independently', () => {
    // Two blocks in one file: the whole-file rule would hold both (#570); the
    // per-hunk rule auto-applies each safe one because siblings are untouched.
    const proposals: ConflictProposal[] = [
      { ...base, blockId: 0, choice: 'ours' },
      { ...base, blockId: 1, choice: 'theirs' },
    ]
    const targetByBlock = {
      [blockKey('src/a.ts', 0)]: target('safe', 'hunk-a'),
      [blockKey('src/a.ts', 1)]: target('safe', 'hunk-b'),
    }
    const decisions = decideHunkApplications(proposals, targetByBlock)
    expect(decisions.map((d) => d.action)).toEqual(['auto-apply', 'auto-apply'])
    expect(decisions.map((d) => d.hunkId)).toEqual(['hunk-a', 'hunk-b'])
  })

  it('holds a proposal whose block has no resolved hunk target (fail toward review)', () => {
    const decisions = decideHunkApplications([{ ...base, blockId: 7 }], {})
    expect(decisions[0].action).toBe('hold')
    expect(decisions[0].finalRisk).toBe('risky')
  })
})
