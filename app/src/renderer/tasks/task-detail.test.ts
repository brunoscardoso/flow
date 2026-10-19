import { taskDetailSignature } from './task-detail'
import type { TaskSummary } from '../../shared/ipc-contract'

function task(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Fix the bug',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: null,
    originThreadId: null,
    description: 'a long description',
    images: null,
    autoFix: false,
    prUrl: null,
    brief: 'the brief',
    briefStatus: 'ready',
    archivedAt: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...over,
  }
}

describe('taskDetailSignature (#204)', () => {
  it('is stable for the same rendered content', () => {
    expect(taskDetailSignature(task())).toBe(taskDetailSignature(task()))
  })

  it('does NOT change when only non-rendered fields change (no scroll-resetting rebuild)', () => {
    // suggestDone and a bumped updatedAt are still invisible in the modal.
    // (`lane` moved OUT of this list in #1299 — see below.)
    const base = taskDetailSignature(task())
    expect(taskDetailSignature(task({ suggestDone: true }))).toBe(base)
    expect(taskDetailSignature(task({ updatedAt: '2026-07-14T09:99:99.000Z' }))).toBe(base)
  })

  it('changes on a LANE move, because the modal renders the lane (#1299)', () => {
    // Excluding lane was right until #1153 added the Status row. After it, the
    // row froze at whatever lane the modal opened with: it reported the wrong
    // lane, the button just clicked never became `current`, and the lane the
    // task had LEFT stayed disabled — so a task moved to Done could not be
    // moved back to Todo from the modal at all.
    const base = taskDetailSignature(task())
    expect(taskDetailSignature(task({ lane: 'doing' }))).not.toBe(base)
    expect(taskDetailSignature(task({ lane: 'done' }))).not.toBe(base)
  })

  it('reflects a BACKGROUND lane change too (#1299)', () => {
    // makeOnTurnStart moves a task to `doing` on every agent turn; with the
    // modal open, the card and counts moved and the Status row did not.
    expect(taskDetailSignature(task({ lane: 'done' }))).not.toBe(
      taskDetailSignature(task({ lane: 'doing' })),
    )
  })

  it('changes when a rendered field changes', () => {
    const base = taskDetailSignature(task())
    expect(taskDetailSignature(task({ title: 'New title' }))).not.toBe(base)
    expect(taskDetailSignature(task({ brief: 'regenerated brief' }))).not.toBe(base)
    expect(taskDetailSignature(task({ briefStatus: 'pending', brief: null }))).not.toBe(base)
    expect(taskDetailSignature(task({ description: 'edited body' }))).not.toBe(base)
  })
})
