import type { AskSavedThread } from '../../shared/ask-contract'
import {
  classifyCode,
  featureIdLabel,
  inlineList,
  isFileLike,
  parseAnswer,
  parseInline,
  questionCountLabel,
  questionCounts,
  recentRows,
  suggestedQuestions,
  type AnswerContext,
} from './ask-answer-model'

const CONTEXT: AnswerContext = {
  sources: [
    { n: 1, label: 'Tenant', featureId: 'feature:tenant' },
    { n: 2, label: 'Schema', file: 'prisma/schema.prisma' },
    { n: 3, label: 'Create', file: 'src/commands/createTenant.ts' },
  ],
  featureName: (id) => (id === 'feature:tenant' ? 'Tenant' : null),
}

const STRUCTURED = [
  'A tenant has two copies, one here and one in `feature:tenant`. [1]',
  '',
  '### What a tenant stores',
  '- `externalTenantId` and `alias`, both unique',
  '- `celesteAccessTier`: Light, Full or Foundations [2]',
  '',
  '### How a tenant is created',
  'A provisioning call runs `createTenant.ts`, then syncs products. [3]',
  '',
  'Not covered: how jupiter-core stores tenants.',
].join('\n')

describe('parseAnswer — the structured grammar', () => {
  it('reads a lead, headed sections, real lists, paragraphs and the not-covered line', () => {
    const doc = parseAnswer(STRUCTURED, CONTEXT)
    expect(doc.structured).toBe(true)
    expect(doc.lead).toEqual([
      { kind: 'text', text: 'A tenant has two copies, one here and one in ' },
      { kind: 'feature', id: 'feature:tenant', label: 'Tenant' },
      { kind: 'text', text: '. ' },
      { kind: 'cite', n: 1 },
    ])
    expect(doc.blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'heading', 'paragraph'])
    const list = doc.blocks[1]
    expect(list.kind === 'list' && list.items).toHaveLength(2)
    expect(list.kind === 'list' && list.items[0][0]).toEqual({ kind: 'code', text: 'externalTenantId' })
    const para = doc.blocks[3]
    expect(para.kind === 'paragraph' && para.inline).toContainEqual({ kind: 'file', text: 'createTenant.ts', path: 'src/commands/createTenant.ts' })
    expect(doc.notCovered).toBe('how jupiter-core stores tenants.')
  })

  it('a "### Not covered" section is the callout, not a section; bold labels are read too', () => {
    const doc = parseAnswer('Short answer.\n\n### Not covered\n- the mobile app\n- billing', CONTEXT)
    expect(doc.blocks).toEqual([])
    expect(doc.notCovered).toBe('the mobile app billing')
    expect(parseAnswer('Lead.\n- a\n**Not covered:** the CLI', CONTEXT).notCovered).toBe('the CLI')
  })

  it('numbered lists and indented continuations are list items', () => {
    const doc = parseAnswer('Lead.\n\n1. first\n   still first\n2. second', CONTEXT)
    expect(doc.blocks).toEqual([
      {
        kind: 'list',
        items: [[{ kind: 'text', text: 'first still first' }], [{ kind: 'text', text: 'second' }]],
      },
    ])
  })

  it('a structured answer that opens with a heading has no lead', () => {
    expect(parseAnswer('### Heading\n- a', CONTEXT).lead).toBeNull()
  })
})

describe('parseAnswer — old saved prose still reads', () => {
  it('paragraphs stay paragraphs, with no lead', () => {
    const doc = parseAnswer('One paragraph here.\n\nAnother one - with a dash.', CONTEXT)
    expect(doc.structured).toBe(false)
    expect(doc.lead).toBeNull()
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'One paragraph here.' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Another one - with a dash.' }] },
    ])
  })

  it('an inline " - a - b - c" run becomes a list, keeping its citations', () => {
    const doc = parseAnswer('A tenant stores: - its alias [2] - its name - its logo', CONTEXT)
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'A tenant stores:' }] },
      {
        kind: 'list',
        items: [
          [{ kind: 'text', text: 'its alias ' }, { kind: 'cite', n: 2 }],
          [{ kind: 'text', text: 'its name' }],
          [{ kind: 'text', text: 'its logo' }],
        ],
      },
    ])
  })
})

describe('inlineList — only when it clearly is one', () => {
  it('needs three items, or two after a colon', () => {
    expect(inlineList('Roles - admin - member - guest')).toEqual({ intro: 'Roles', items: ['admin', 'member', 'guest'] })
    expect(inlineList('Two kinds: - admin - member')).toEqual({ intro: 'Two kinds:', items: ['admin', 'member'] })
    expect(inlineList('A word - which is a dash - and another')).toBeNull()
    expect(inlineList('Just one - dash')).toBeNull()
    expect(inlineList('- a - b')).toEqual({ intro: '', items: ['a', 'b'] })
  })

  it('refuses an "item" that is a whole page', () => {
    expect(inlineList(`Intro: - ${'x'.repeat(300)} - b - c`)).toBeNull()
  })
})

describe('parseInline and classifyCode', () => {
  it('splits code, strong and grouped citations; text is never interpreted as markup otherwise', () => {
    expect(parseInline('See **this** [1, 3] and <b>raw</b>', CONTEXT)).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'strong', text: 'this' },
      { kind: 'text', text: ' ' },
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 3 },
      { kind: 'text', text: ' and <b>raw</b>' },
    ])
  })

  it('a repo path or a known-extension file is a file chip; a dotted name or a route is code', () => {
    expect(isFileLike('src/app/route.ts')).toBe(true)
    expect(isFileLike('schema.prisma')).toBe(true)
    expect(isFileLike('tenant.alias')).toBe(false)
    expect(isFileLike('POST /api/tenants')).toBe(false)
    expect(isFileLike('foo.ts()')).toBe(false)
    expect(classifyCode('schema.prisma', CONTEXT)).toEqual({ kind: 'file', text: 'schema.prisma', path: 'prisma/schema.prisma' })
    expect(classifyCode('lib/other.ts', CONTEXT)).toEqual({ kind: 'file', text: 'lib/other.ts', path: 'lib/other.ts' })
    // A bare name nothing locates is drawn, not pressable.
    expect(classifyCode('unknown.ts', CONTEXT)).toEqual({ kind: 'file', text: 'unknown.ts', path: null })
    expect(classifyCode('MANAGE_SETTINGS', CONTEXT)).toEqual({ kind: 'code', text: 'MANAGE_SETTINGS' })
  })

  it('a feature id is a feature chip, named by the board, else its source, else the id', () => {
    expect(classifyCode('feature:tenant', CONTEXT)).toEqual({ kind: 'feature', id: 'feature:tenant', label: 'Tenant' })
    expect(classifyCode('feature:core::access-tier/roles', CONTEXT)).toEqual({ kind: 'feature', id: 'feature:core::access-tier/roles', label: 'Roles' })
    expect(featureIdLabel('feature:sign-in')).toBe('Sign in')
  })
})

describe('suggestedQuestions — deterministic, no model', () => {
  it('a feature in scope asks about it, its first part and its first connection', () => {
    const input = { focus: { name: 'Tenant', parts: ['Roles'], related: ['Auth'] }, projects: [], scopeName: 'app', features: [] }
    expect(suggestedQuestions(input)).toEqual([
      'How does Tenant work, from start to finish?',
      'What does Roles do in Tenant?',
      'How does Tenant connect to Auth?',
    ])
    expect(suggestedQuestions(input)).toEqual(suggestedQuestions(input))
  })

  it('a feature with nothing around it still gets three', () => {
    expect(suggestedQuestions({ focus: { name: 'X', parts: [], related: [] }, projects: [], scopeName: null, features: [] })).toHaveLength(3)
  })

  it('the Workspace asks across projects; a project asks about its biggest features', () => {
    expect(suggestedQuestions({ focus: null, projects: ['core', 'app'], scopeName: 'Team', features: ['Auth'] })[0]).toBe(
      'How do core and app talk to each other?',
    )
    expect(suggestedQuestions({ focus: null, projects: [], scopeName: 'app', features: ['Auth', 'Chats'] })).toEqual([
      'What are the main parts of app, and how do they fit together?',
      'How does Auth work?',
      'How do Auth and Chats connect?',
    ])
  })
})

function thread(id: string, ts: string, tags: string[], extra: Partial<AskSavedThread> = {}): AskSavedThread {
  return {
    id,
    ts,
    author: 'You',
    question: `Q ${id}`,
    tags,
    conversationCount: 0,
    usedConversation: false,
    answer: 'A',
    sources: [],
    factsLearned: 0,
    partial: false,
    followUps: [],
    ...extra,
  }
}

describe('recentRows', () => {
  it('newest first, at most four, the meta naming when and the first tag', () => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    const rows = recentRows(
      [
        thread('a', '2026-11-16T08:00:00Z', ['feature:tenant']),
        thread('b', '2026-11-15T10:00:00Z', []),
        thread('c', '2026-11-16T11:59:30Z', ['project:core']),
        thread('d', '2026-11-01T00:00:00Z', []),
        thread('e', '2026-10-01T00:00:00Z', []),
      ],
      now,
      (id) => (id === 'feature:tenant' ? 'Tenant' : null),
    )
    expect(rows.map((row) => row.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(rows[0].meta).toBe('just now · Core')
    expect(rows[1].meta).toBe('4 h ago · Tenant')
    expect(rows[2].meta).toBe('yesterday')
  })
})

describe('questionCounts', () => {
  it('counts each question once per feature it tags or cites; a part counts on its feature too', () => {
    const counts = questionCounts([
      thread('a', '2026-11-16T08:00:00Z', ['feature:tenant', 'feature:tenant'], {
        sources: [{ label: 'x', featureId: 'feature:auth/session' }],
      }),
      thread('b', '2026-11-16T09:00:00Z', ['feature:tenant/roles', 'project:core']),
    ])
    expect(Object.fromEntries(counts)).toEqual({
      'feature:tenant': 2,
      'feature:auth/session': 1,
      'feature:auth': 1,
      'feature:tenant/roles': 1,
    })
  })

  it('follow-ups count toward their thread, not as new questions', () => {
    const counts = questionCounts([
      thread('a', '2026-11-16T08:00:00Z', [], { followUps: [{ ...thread('f', '2026-11-16T09:00:00Z', ['feature:chats']) }] }),
    ])
    expect(counts.get('feature:chats')).toBe(1)
    expect(questionCountLabel(1, 'Chats')).toBe('1 question you asked about Chats')
    expect(questionCountLabel(3, 'Chats')).toBe('3 questions you asked about Chats')
  })
})
