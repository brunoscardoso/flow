// Blueprint → Brain migration (#52). Converts the precious, append-only
// blueprint stores (annotations / investigations / proposals) into a single
// canonical brain markdown document, so the knowledge survives the retirement
// of the .blueprint stores. Pure transforms — the runner supplies the parsed
// JSONL and persists the result.

interface Anchor {
  kind?: string
  ref?: string
  file?: string
}

export interface AnnotationRecord {
  ts?: string
  runId?: string
  type?: string
  text?: string
  anchors?: Anchor[]
  provenance?: string
}

export interface InvestigationRecord {
  kind?: string // 'note' | 'heat'
  ts?: string
  runId?: string
  text?: string
  anchors?: Anchor[]
  anchorRef?: string
  visitor?: string
}

export interface ProposalRecord {
  ts?: string
  plan?: string
  predictedNodeId?: string
  kind?: string
  label?: string
  event?: string
  detail?: string
}

/** JSONL text → parsed records, skipping blank/corrupt lines. */
export function parseJsonl<T>(content: string): T[] {
  const out: T[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // skip corrupt line — migration is best-effort, backed up separately.
    }
  }
  return out
}

function anchorLabel(record: { anchors?: Anchor[]; anchorRef?: string }): string {
  if (record.anchorRef) return record.anchorRef
  const anchor = record.anchors?.[0]
  if (!anchor) return '—'
  return anchor.ref ?? anchor.file ?? anchor.kind ?? '—'
}

function annotationsSection(records: readonly AnnotationRecord[]): string[] {
  if (records.length === 0) return []
  const lines = ['## Annotations', '']
  for (const rec of records) {
    const meta = [rec.type, rec.runId].filter(Boolean).join(' · ')
    lines.push(`- \`${anchorLabel(rec)}\` — ${rec.text ?? ''}${meta ? ` _(${meta})_` : ''}`)
  }
  lines.push('')
  return lines
}

function investigationsSection(records: readonly InvestigationRecord[]): string[] {
  const notes = records.filter((r) => r.kind === 'note')
  const heat = records.filter((r) => r.kind === 'heat')
  if (notes.length === 0 && heat.length === 0) return []
  const lines = ['## Investigations', '']
  for (const note of notes) {
    lines.push(`- \`${anchorLabel(note)}\` — ${note.text ?? ''}`)
  }
  if (heat.length > 0) {
    const byAnchor = new Map<string, number>()
    for (const tick of heat) {
      const key = anchorLabel(tick)
      byAnchor.set(key, (byAnchor.get(key) ?? 0) + 1)
    }
    lines.push('', '### Heat', '')
    for (const [anchor, count] of [...byAnchor.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${anchor}\` — ${count} visit(s)`)
    }
  }
  lines.push('')
  return lines
}

function proposalsSection(records: readonly ProposalRecord[]): string[] {
  if (records.length === 0) return []
  const lines = ['## Proposals', '']
  for (const rec of records) {
    const bits = [rec.label, rec.predictedNodeId].filter(Boolean).join(' — ')
    const suffix = [rec.plan, rec.event].filter(Boolean).join(' · ')
    lines.push(`- ${bits}${rec.detail ? `: ${rec.detail}` : ''}${suffix ? ` _(${suffix})_` : ''}`)
  }
  lines.push('')
  return lines
}

/**
 * Render the three blueprint stores into one canonical brain markdown document.
 * `generatedAt` is injected so the transform stays pure/deterministic.
 */
export function migrateBlueprintToBrain(input: {
  annotations: readonly AnnotationRecord[]
  investigations: readonly InvestigationRecord[]
  proposals: readonly ProposalRecord[]
  generatedAt: string
}): string {
  const lines: string[] = [
    '---',
    'feature: blueprint-migrated',
    'title: "Blueprint annotations, investigations & proposals (migrated)"',
    `migrated_at: ${input.generatedAt}`,
    '---',
    '',
    '# Blueprint knowledge (migrated to brain)',
    '',
    'Preserved from the retired `flow/.blueprint/` stores (#52).',
    '',
    ...annotationsSection(input.annotations),
    ...investigationsSection(input.investigations),
    ...proposalsSection(input.proposals),
  ]
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
