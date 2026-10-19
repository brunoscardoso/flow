// brief-on-activation tests — the "card entered Todo/Doing without a brief →
// generate one" reaction, exercised with fake deps. No database, no Electron, no
// model call.
//
// Like close-remote-on-done.test.ts, this reaction's whole job is to sometimes
// NOT act, so the load-bearing assertions are the ones proving generate() was
// never called: a re-save, a card that already has a brief, a bare card, an
// inactive lane. Each asserts the generator stayed untouched.

import { briefOnActivation, type BriefOnActivationDeps } from './brief-on-activation'
import { taskHasBriefContent } from './task-service'
import type { TaskRecord } from '../store/task-store'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Add an LRU cache',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'doing',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: 'We need an LRU cache on the API layer.',
    images: null,
    autoFix: false,
    agentBlockedFrom: null,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
    ...overrides,
  }
}

interface Harness {
  deps: BriefOnActivationDeps
  generated: string[]
}

function harness(): Harness {
  const generated: string[] = []
  const deps: BriefOnActivationDeps = {
    // The real predicate — a bare, description-less, keyless card returns false.
    hasContent: taskHasBriefContent,
    generate: async (taskId) => {
      generated.push(taskId)
    },
  }
  return { deps, generated }
}

describe('briefOnActivation', () => {
  it('generates a brief when a card moves from Blocked into Doing with content', async () => {
    const h = harness()
    const p = briefOnActivation(task({ lane: 'blocked' }), task({ lane: 'doing' }), h.deps)
    expect(p).not.toBeNull()
    await p
    expect(h.generated).toEqual(['t1'])
  })

  it('generates a brief when a card moves into Todo', async () => {
    const h = harness()
    await briefOnActivation(task({ lane: 'blocked' }), task({ lane: 'todo' }), h.deps)
    expect(h.generated).toEqual(['t1'])
  })

  it('generates on the Todo → Doing hop (the agent-start / board-loop path)', async () => {
    const h = harness()
    await briefOnActivation(task({ lane: 'todo' }), task({ lane: 'doing' }), h.deps)
    expect(h.generated).toEqual(['t1'])
  })

  it('generates when there is no prior record (a card first seen in an active lane)', async () => {
    const h = harness()
    await briefOnActivation(null, task({ lane: 'doing' }), h.deps)
    expect(h.generated).toEqual(['t1'])
  })

  it('does NOT generate when the lane did not change (a rename / autoFix re-save)', async () => {
    const h = harness()
    const p = briefOnActivation(task({ lane: 'doing' }), task({ lane: 'doing' }), h.deps)
    expect(p).toBeNull()
    expect(h.generated).toEqual([])
  })

  it('does NOT generate when the card landed in Done or Blocked', async () => {
    const h = harness()
    expect(briefOnActivation(task({ lane: 'doing' }), task({ lane: 'done' }), h.deps)).toBeNull()
    expect(briefOnActivation(task({ lane: 'todo' }), task({ lane: 'blocked' }), h.deps)).toBeNull()
    expect(h.generated).toEqual([])
  })

  it('does NOT regenerate when a brief is already ready, pending, or errored', async () => {
    const h = harness()
    for (const briefStatus of ['ready', 'pending', 'error'] as const) {
      expect(
        briefOnActivation(task({ lane: 'todo' }), task({ lane: 'doing', briefStatus }), h.deps),
      ).toBeNull()
    }
    expect(h.generated).toEqual([])
  })

  it('does NOT generate for a bare, title-only card with nothing to summarize', async () => {
    const h = harness()
    const bare = task({ lane: 'doing', description: null, externalKey: null })
    expect(briefOnActivation(task({ lane: 'todo' }), bare, h.deps)).toBeNull()
    expect(h.generated).toEqual([])
  })

  it('generates for a keyed card even without a description', async () => {
    const h = harness()
    const keyed = task({ lane: 'doing', description: null, externalKey: 'acme/api#42' })
    await briefOnActivation(task({ lane: 'todo' }), keyed, h.deps)
    expect(h.generated).toEqual(['t1'])
  })
})
