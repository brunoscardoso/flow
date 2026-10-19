import type { ThreadSummary } from '../../shared/ipc-contract'
import {
  comparableAim,
  latestRunFor,
  runChipText,
  runChipTitle,
  runForHunt,
  runsIn,
} from './loop-run-link'

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'TOL-001 · tenant ids',
    sdkSessionId: null,
    model: null,
    effort: null,
    status: 'idle',
    createdAt: '2026-08-17T10:00:00.000Z',
    updatedAt: '2026-08-17T10:00:00.000Z',
    archivedAt: null,
    imported: false,
    pinnedAt: null,
    bypassPermissions: false,
    additionalRoots: [],
    originLoop: 'find',
    originAim: 'tenant ids',
    originKey: 'TOL-001',
    worktreePath: null,
    worktreeBranch: null,
    worktreeBase: null,
    // A run thread publishes nowhere until a person says where — same as a chat.
    remote: null,
    remoteBranch: null,
    prBase: null,
    previouslyPushedAs: null,
    ...overrides,
  }
}

describe('runsIn', () => {
  it('keeps only threads that ARE runs, newest first', () => {
    const runs = runsIn([
      thread({ id: 'chat', originLoop: null, originAim: null, originKey: null }),
      thread({ id: 'old', createdAt: '2026-08-16T09:00:00.000Z', originKey: 'TOL-001' }),
      thread({ id: 'new', createdAt: '2026-08-17T09:00:00.000Z', originKey: 'TOL-002' }),
    ])
    expect(runs.map((run) => run.threadId)).toEqual(['new', 'old'])
  })

  it('does not count a thread that has a loop but no key as a run', () => {
    // Half-written provenance is not evidence: without a key there is nothing
    // to call the run, and every surface here is about naming it.
    expect(runsIn([thread({ originKey: null })])).toEqual([])
  })
})

describe('latestRunFor', () => {
  it('answers with the newest run of THAT loop', () => {
    const threads = [
      thread({ id: 'find-old', createdAt: '2026-08-16T09:00:00.000Z', originKey: 'TOL-001' }),
      thread({ id: 'fix', originLoop: 'fix', originKey: 'TOL-002' }),
      thread({ id: 'find-new', createdAt: '2026-08-17T11:00:00.000Z', originKey: 'TOL-003' }),
    ]
    expect(latestRunFor('find', threads)?.threadId).toBe('find-new')
    expect(latestRunFor('fix', threads)?.threadId).toBe('fix')
    expect(latestRunFor('improve', threads)).toBeNull()
  })
})

describe('runForHunt', () => {
  const threads = [
    thread({ id: 'run', originAim: 'Tenant  IDs   everywhere', originKey: 'TOL-004' }),
  ]

  it('matches the loop AND the sentence, whitespace and case aside', () => {
    expect(runForHunt(['find'], 'tenant ids everywhere', threads)?.threadId).toBe('run')
  })

  it('refuses a run started for another sentence', () => {
    // A link that opens the WRONG conversation is worse than no link, because
    // it gets believed.
    expect(runForHunt(['find'], 'flaky tests', threads)).toBeNull()
  })

  it('refuses a run started by a loop this hunt does not name', () => {
    expect(runForHunt(['fix'], 'tenant ids everywhere', threads)).toBeNull()
  })

  it('is null when nothing has ever been run', () => {
    expect(runForHunt(['find'], 'anything', [])).toBeNull()
  })
})

describe('the chip', () => {
  it('says running only while the agent actually is', () => {
    expect(runChipText({ ...runsIn([thread({ status: 'working' })])[0] })).toBe('TOL-001 · running')
    expect(runChipText({ ...runsIn([thread({ status: 'done' })])[0] })).toBe('TOL-001 · last run')
  })

  it('says what pressing it does, not where it is stored', () => {
    const title = runChipTitle(runsIn([thread()])[0])
    expect(title).toContain('Open TOL-001')
    expect(title).not.toMatch(/planflow-ai|flow\/|\.jsonl/)
  })
})

describe('comparableAim', () => {
  it('collapses whitespace and case, and nothing else', () => {
    expect(comparableAim('  Tenant   IDs ')).toBe('tenant ids')
    expect(comparableAim('tenant-ids')).not.toBe(comparableAim('tenant ids'))
  })
})
