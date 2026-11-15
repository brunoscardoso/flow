// Suggested tags from pasted text, and the @ picker — local matching only.

import {
  activeMention,
  graphCandidates,
  MAX_SUGGESTIONS,
  pickerMatches,
  suggestLabel,
  suggestTags,
  type PickerCandidate,
  type SuggestNode,
} from './ask-tag-suggest'

const NODES: SuggestNode[] = [
  { id: 'feature:connectors', name: 'Connectors', kind: 'core', summary: 'Third-party integrations with OAuth tokens.' },
  { id: 'feature:connectors/credentials', name: 'Credentials', kind: 'part', partOf: 'connectors', summary: 'Encrypted secrets vault.' },
  { id: 'feature:coworkers', name: 'Coworkers', kind: 'core', summary: 'Inviting teammates into a workspace.' },
  { id: 'plan:vault', name: 'Connectors refactor', kind: 'child' },
]

describe('suggestTags', () => {
  it('suggests what a pasted message names, a part said with its feature first', () => {
    const text = 'Customers keep asking: can Connectors share credentials with coworkers?'
    const ids = suggestTags(text, NODES).map((s) => s.id)
    expect(ids[0]).toBe('feature:connectors/credentials')
    expect(ids).toEqual(expect.arrayContaining(['feature:connectors', 'feature:coworkers']))
    expect(ids).not.toContain('plan:vault')
  })

  it('labels a part "Feature · Part"', () => {
    const [first] = suggestTags('the credentials of connectors', NODES)
    expect(first).toEqual({ id: 'feature:connectors/credentials', kind: 'part', label: 'Connectors · Credentials' })
  })

  it('needs two shared summary words for a summary-only match', () => {
    expect(suggestTags('does the vault use OAuth tokens?', NODES).map((s) => s.id)).toEqual(['feature:connectors'])
    expect(suggestTags('anything about tokens?', NODES)).toEqual([])
  })

  it('leaves out excluded ids, empty text, and caps the list', () => {
    expect(suggestTags('connectors', NODES, { exclude: new Set(['feature:connectors']) })).toEqual([])
    expect(suggestTags('   ', NODES)).toEqual([])
    const many: SuggestNode[] = Array.from({ length: 10 }, (_, i) => ({ id: `feature:f${i}`, name: `Widget${i}`, kind: 'core' }))
    const text = many.map((n) => n.name).join(' ')
    expect(suggestTags(text, many)).toHaveLength(MAX_SUGGESTIONS)
  })

  it('matches a plural and a whole word only', () => {
    expect(suggestTags('two connector', [{ id: 'feature:c', name: 'Connector', kind: 'core' }])).toHaveLength(1)
    expect(suggestTags('many connectors', [{ id: 'feature:c', name: 'Connector', kind: 'core' }])).toHaveLength(1)
    expect(suggestTags('reconnectors', [{ id: 'feature:c', name: 'Connector', kind: 'core' }])).toEqual([])
  })
})

describe('suggestLabel / graphCandidates', () => {
  it('builds picker rows for features and parts, never changes', () => {
    const rows = graphCandidates(NODES)
    expect(rows.map((r) => r.id)).toEqual(['feature:connectors', 'feature:connectors/credentials', 'feature:coworkers'])
    expect(rows[1]).toMatchObject({ kind: 'part', label: 'Connectors · Credentials', hint: 'Encrypted secrets vault.' })
    expect(suggestLabel({ id: 'feature:x/y', name: 'Y', kind: 'part' }, new Map())).toBe('Y')
  })
})

describe('pickerMatches', () => {
  const rows: PickerCandidate[] = [
    ...graphCandidates(NODES),
    { id: 't1', kind: 'conversation', label: 'Connector bug chat' },
  ]

  it('ranks a label prefix over a word prefix over a substring', () => {
    expect(pickerMatches('cre', rows).map((r) => r.id)).toEqual(['feature:connectors/credentials'])
    expect(pickerMatches('conn', rows).map((r) => r.id)).toEqual(['feature:connectors', 't1', 'feature:connectors/credentials'])
    expect(pickerMatches('workers', rows).map((r) => r.id)).toEqual(['feature:coworkers'])
  })

  it('an empty query lists features, then conversations, then parts; excluded ids are left out', () => {
    expect(pickerMatches('', rows).map((r) => r.kind)).toEqual(['feature', 'feature', 'conversation', 'part'])
    expect(pickerMatches('', rows, { exclude: new Set(['t1']), limit: 2 }).map((r) => r.id)).toEqual(['feature:connectors', 'feature:coworkers'])
  })
})

describe('activeMention', () => {
  it('finds the @ being typed at the caret', () => {
    expect(activeMention('ask @conn', 9)).toEqual({ query: 'conn', start: 4 })
    expect(activeMention('@', 1)).toEqual({ query: '', start: 0 })
    expect(activeMention('mail a@b', 8)).toBeNull()
    expect(activeMention('ask @conn more', 14)).toBeNull()
  })
})
