import {
  migrateBlueprintToBrain,
  parseJsonl,
  type AnnotationRecord,
  type InvestigationRecord,
  type ProposalRecord,
} from './blueprint-migration'

describe('parseJsonl', () => {
  it('parses valid lines and skips blank/corrupt ones', () => {
    const out = parseJsonl<{ a: number }>('{"a":1}\n\n{ bad\n{"a":2}\n')
    expect(out).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('migrateBlueprintToBrain', () => {
  const annotations: AnnotationRecord[] = [
    { type: 'rule', runId: 'r1', text: 'Corrupt anchors crash render', anchors: [{ ref: 'store.ts' }] },
  ]
  const investigations: InvestigationRecord[] = [
    { kind: 'note', text: 'Investigation layer born', anchors: [{ ref: 'src/cli/blueprint' }] },
    { kind: 'heat', anchorRef: 'src/cli/blueprint' },
    { kind: 'heat', anchorRef: 'src/cli/blueprint' },
  ]
  const proposals: ProposalRecord[] = [
    { plan: 'plan_x', predictedNodeId: 'integration:resend', label: 'Resend email', event: 'proposed', detail: 'Email' },
  ]

  it('renders all three stores with frontmatter', () => {
    const md = migrateBlueprintToBrain({
      annotations,
      investigations,
      proposals,
      generatedAt: '2026-07-13T00:00:00Z',
    })
    expect(md).toContain('feature: blueprint-migrated')
    expect(md).toContain('migrated_at: 2026-07-13T00:00:00Z')
    expect(md).toContain('## Annotations')
    expect(md).toContain('`store.ts` — Corrupt anchors crash render')
    expect(md).toContain('## Investigations')
    expect(md).toContain('Investigation layer born')
    expect(md).toContain('### Heat')
    expect(md).toContain('`src/cli/blueprint` — 2 visit(s)')
    expect(md).toContain('## Proposals')
    expect(md).toContain('Resend email — integration:resend: Email')
  })

  it('omits empty sections', () => {
    const md = migrateBlueprintToBrain({
      annotations,
      investigations: [],
      proposals: [],
      generatedAt: '2026-07-13T00:00:00Z',
    })
    expect(md).toContain('## Annotations')
    expect(md).not.toContain('## Investigations')
    expect(md).not.toContain('## Proposals')
  })
})
