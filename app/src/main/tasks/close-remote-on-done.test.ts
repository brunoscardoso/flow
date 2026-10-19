// close-remote-on-done tests — the promoted-task → Done → close-the-remote
// reaction, exercised with fake deps. No database, no Electron, no network.
//
// The suite's spine is allowed-pattern #24: for a reaction whose whole job is to
// sometimes NOT act, the important assertions are the ones proving no side effect
// happened — a manual card, a non-transition, the feature off. Each of those
// asserts closeIssue was never called.

import { closeRemoteOnDone, type CloseRemoteOnDoneDeps } from './close-remote-on-done'
import type { CloseIssueResult } from '../integrations/integrations-manager'
import type { IssueRef } from '../issue-ref'
import type { TaskRecord } from '../store/task-store'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Fix the thing',
    source: 'github',
    externalKey: 'acme/api#42',
    externalUrl: 'https://github.com/acme/api/issues/42',
    lane: 'done',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
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
  deps: CloseRemoteOnDoneDeps
  closed: { ref: IssueRef; opts: { comment?: string } }[]
  notes: { title: string; body: string; level: 'info' | 'warn' }[]
}

function harness(
  opts: { enabled?: boolean; result?: CloseIssueResult; throws?: boolean } = {},
): Harness {
  const closed: Harness['closed'] = []
  const notes: Harness['notes'] = []
  const deps: CloseRemoteOnDoneDeps = {
    isEnabled: () => opts.enabled ?? true,
    closeIssue: async (ref, o) => {
      closed.push({ ref, opts: o })
      if (opts.throws) throw new Error('boom')
      return opts.result ?? { ok: true, provider: 'github', key: ref.key }
    },
    notify: ({ title, body, level }) => notes.push({ title, body, level }),
  }
  return { deps, closed, notes }
}

describe('closeRemoteOnDone (#1885)', () => {
  it('closes the remote when a GitHub card transitions INTO done', async () => {
    const h = harness()
    const p = closeRemoteOnDone(task({ lane: 'doing' }), task({ lane: 'done' }), h.deps)
    expect(p).not.toBeNull()
    await p
    expect(h.closed).toHaveLength(1)
    expect(h.closed[0]?.ref).toMatchObject({ provider: 'github', owner: 'acme', repo: 'api', number: 42 })
    expect(h.closed[0]?.opts.comment).toMatch(/moved to Done/i)
    expect(h.notes[0]).toMatchObject({ title: 'Remote ticket closed', level: 'info' })
  })

  it('does NOTHING when the card was already in done (no re-close on a re-save)', () => {
    const h = harness()
    const result = closeRemoteOnDone(task({ lane: 'done' }), task({ lane: 'done' }), h.deps)
    expect(result).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('does NOTHING when the move is not into done', () => {
    const h = harness()
    expect(closeRemoteOnDone(task({ lane: 'todo' }), task({ lane: 'doing' }), h.deps)).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('does NOTHING for a manual card (a hand-created task)', () => {
    const h = harness()
    const prev = task({ lane: 'doing', source: 'manual', externalKey: null, externalUrl: null })
    const next = task({ lane: 'done', source: 'manual', externalKey: null, externalUrl: null })
    expect(closeRemoteOnDone(prev, next, h.deps)).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('does NOTHING for an agent-todo mirror (source manual with a synthetic key)', () => {
    const h = harness()
    const prev = task({ lane: 'doing', source: 'manual', externalKey: 'th1#some-todo', externalUrl: null })
    const next = task({ lane: 'done', source: 'manual', externalKey: 'th1#some-todo', externalUrl: null })
    expect(closeRemoteOnDone(prev, next, h.deps)).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('does NOTHING when the setting is off', () => {
    const h = harness({ enabled: false })
    expect(closeRemoteOnDone(task({ lane: 'doing' }), task({ lane: 'done' }), h.deps)).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('does NOTHING when nothing on the record parses as a tracker ref', () => {
    const h = harness()
    const prev = task({ lane: 'doing', externalKey: 'not-a-ref', externalUrl: null })
    const next = task({ lane: 'done', externalKey: 'not-a-ref', externalUrl: null })
    expect(closeRemoteOnDone(prev, next, h.deps)).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('is fail-soft: a failed close still notifies, with the reason', async () => {
    const h = harness({ result: { ok: false, reason: 'token is read-only' } })
    await closeRemoteOnDone(task({ lane: 'doing' }), task({ lane: 'done' }), h.deps)
    expect(h.notes[0]).toMatchObject({ title: "Couldn't close the remote ticket", body: 'token is read-only', level: 'warn' })
  })

  it('is fail-soft: a thrown closeIssue is caught and notified, never propagated', async () => {
    const h = harness({ throws: true })
    // Must resolve, not reject — the lane move must never see an error.
    await expect(
      closeRemoteOnDone(task({ lane: 'doing' }), task({ lane: 'done' }), h.deps),
    ).resolves.toBeUndefined()
    expect(h.notes[0]).toMatchObject({ title: "Couldn't close the remote ticket", level: 'warn' })
  })

  it('falls back to the externalKey when there is no URL', async () => {
    const h = harness()
    const prev = task({ lane: 'doing', externalUrl: null })
    const next = task({ lane: 'done', externalUrl: null }) // key acme/api#42 still parses
    await closeRemoteOnDone(prev, next, h.deps)
    expect(h.closed[0]?.ref).toMatchObject({ provider: 'github', number: 42 })
  })
})
