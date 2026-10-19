/**
 * Chat-learn trigger decisions. The whole point of this module is that it stays
 * QUIET: it must ask about the area a conversation is actually working in, and
 * about nothing else. Every "returns null" case below is a prompt the user does
 * not see.
 */

import {
  MIN_TOUCHED_FILES,
  owningCore,
  resolveChatLearnAsk,
  tallyModules,
  type ChatLearnInput,
  type CoreFeatureLike,
} from './chat-learn-trigger'
import type { BlueprintLearningStatus } from '../../shared/ipc-contract'
import type { WorkingSetFile } from '../brain/types'

const MODULES = ['src/app/api/billing', 'src/app/api/reports', 'src/lib']

const CORES: CoreFeatureLike[] = [
  { slug: 'billing', name: 'Billing', anchors: ['module:src/app/api/billing'] },
  { slug: 'platform', name: 'Platform', anchors: ['module:src/app'] },
]

const read = (path: string): WorkingSetFile => ({ path, role: 'read' })
const edited = (path: string): WorkingSetFile => ({ path, role: 'edited' })

function input(overrides: Partial<ChatLearnInput> = {}): ChatLearnInput {
  return {
    files: [edited('src/app/api/billing/charge.ts'), read('src/app/api/billing/plan.ts')],
    modulePaths: MODULES,
    statusByModule: new Map<string, BlueprintLearningStatus>(),
    cores: CORES,
    askedThreads: new Set<string>(),
    threadId: 'thread-1',
    ...overrides,
  }
}

describe('tallyModules', () => {
  it('weights an edit above a read and counts files per module', () => {
    const tally = tallyModules(
      [
        edited('src/app/api/billing/charge.ts'),
        read('src/app/api/billing/plan.ts'),
        read('src/lib/util.ts'),
      ],
      MODULES,
    )

    expect(tally.get('src/app/api/billing')).toEqual({ files: 2, weight: 3 })
    expect(tally.get('src/lib')).toEqual({ files: 1, weight: 1 })
  })

  it('drops files that belong to no module rather than inventing one', () => {
    // Repo-root configs and anything outside the spine have no owning module.
    // Pooling them would manufacture an area the user was never working in.
    const tally = tallyModules([edited('package.json'), read('README.md')], MODULES)

    expect(tally.size).toBe(0)
  })
})

describe('owningCore', () => {
  it('picks the MOST SPECIFIC anchor when several features claim the module', () => {
    // Both Billing (src/app/api/billing) and Platform (src/app) claim it. The
    // specific owner is the useful parent — "this belongs to Billing" says
    // something; "this belongs to Platform" says almost nothing.
    expect(owningCore('src/app/api/billing', CORES)?.slug).toBe('billing')
  })

  it('claims a module nested under an anchor, not just an exact match', () => {
    expect(owningCore('src/app/api/reports', CORES)?.slug).toBe('platform')
  })

  it('does not let a prefix that stops mid-segment claim a module', () => {
    // `src/app` must not claim `src/apparatus` — path claims are per segment.
    const cores = [{ slug: 'app', name: 'App', anchors: ['module:src/app'] }]
    expect(owningCore('src/apparatus', cores)).toBeNull()
  })

  it('returns null when nothing anchors the module', () => {
    expect(owningCore('src/lib', CORES)).toBeNull()
  })
})

describe('resolveChatLearnAsk', () => {
  it('asks about the area the turn concentrated on, naming its parent', () => {
    expect(resolveChatLearnAsk(input())).toEqual({
      modulePath: 'src/app/api/billing',
      fileCount: 2,
      parentSlug: 'billing',
      parentName: 'Billing',
    })
  })

  it('asks only ONCE per thread', () => {
    expect(resolveChatLearnAsk(input({ askedThreads: new Set(['thread-1']) }))).toBeNull()
  })

  it('stays quiet when the turn touched too little to be evidence', () => {
    // One incidental file read is not "working on an area".
    expect(resolveChatLearnAsk(input({ files: [read('src/app/api/billing/charge.ts')] }))).toBeNull()
    expect(MIN_TOUCHED_FILES).toBe(2)
  })

  it('stays quiet about an area that is already understood or underway', () => {
    for (const status of ['learned', 'learning', 'queued'] as const) {
      const statusByModule = new Map<string, BlueprintLearningStatus>([
        ['src/app/api/billing', status],
      ])
      expect(resolveChatLearnAsk(input({ statusByModule }))).toBeNull()
    }
  })

  it('falls through to the next-heaviest area when the top one is settled', () => {
    // The user touched billing (settled) and reports (never learned) — the
    // prompt should be about the part we do NOT understand.
    const files = [
      edited('src/app/api/billing/charge.ts'),
      edited('src/app/api/billing/plan.ts'),
      edited('src/app/api/reports/list.ts'),
      read('src/app/api/reports/pdf.ts'),
    ]
    const statusByModule = new Map<string, BlueprintLearningStatus>([
      ['src/app/api/billing', 'learned'],
    ])

    expect(resolveChatLearnAsk(input({ files, statusByModule }))?.modulePath).toBe(
      'src/app/api/reports',
    )
  })

  it('still asks when no feature claims the area — with no parent', () => {
    const files = [edited('src/lib/util.ts'), edited('src/lib/fmt.ts')]

    expect(resolveChatLearnAsk(input({ files }))).toEqual({
      modulePath: 'src/lib',
      fileCount: 2,
      parentSlug: null,
      parentName: null,
    })
  })

  it('treats a stale area as worth asking about (drift is not understanding)', () => {
    const statusByModule = new Map<string, BlueprintLearningStatus>([
      ['src/app/api/billing', 'stale'],
    ])

    expect(resolveChatLearnAsk(input({ statusByModule }))?.modulePath).toBe('src/app/api/billing')
  })

  it('says nothing for a turn that touched no files, or a project with no modules', () => {
    expect(resolveChatLearnAsk(input({ files: [] }))).toBeNull()
    expect(resolveChatLearnAsk(input({ modulePaths: [] }))).toBeNull()
  })

  it('is deterministic when two areas are equally weighted', () => {
    const files = [
      edited('src/app/api/reports/a.ts'),
      edited('src/app/api/reports/b.ts'),
      edited('src/lib/a.ts'),
      edited('src/lib/b.ts'),
    ]

    const first = resolveChatLearnAsk(input({ files }))
    const again = resolveChatLearnAsk(input({ files: [...files].reverse() }))
    expect(first?.modulePath).toBe(again?.modulePath)
  })
})
