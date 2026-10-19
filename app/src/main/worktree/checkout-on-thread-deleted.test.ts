import { EventEmitter } from 'node:events'
import { THREAD_STORE_CHANGE_EVENT, type ThreadChangeEvent } from '../store/thread-store'
import {
  orphanedByDeletion,
  releaseCheckoutOnThreadDeleted,
  type CheckoutReleaseResult,
} from './checkout-on-thread-deleted'

const ABANDONED = { projectRoot: '/p', worktreePath: '/p/.flow/t1', branch: 'flow/work' }

function deletion(over: Partial<ThreadChangeEvent> = {}): ThreadChangeEvent {
  return { entity: 'thread', action: 'deleted', threadId: 't1', abandoned: ABANDONED, ...over }
}

/** Records every call so a test can assert the QUESTION asked, not just the answer. */
function harness(result: CheckoutReleaseResult = { status: 'pruned' }) {
  const store = new EventEmitter()
  const calls: Array<{ threadId: string; options: Record<string, unknown> }> = []
  const outcomes: Array<{ threadId: string; status: string }> = []
  const stop = releaseCheckoutOnThreadDeleted(store, {
    release: async (threadId, options) => {
      calls.push({ threadId, options: options as unknown as Record<string, unknown> })
      return result
    },
    onOutcome: (o) => outcomes.push({ threadId: o.threadId, status: o.status }),
  })
  const emit = async (event: ThreadChangeEvent): Promise<void> => {
    store.emit(THREAD_STORE_CHANGE_EVENT, event)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { store, calls, outcomes, stop, emit }
}

describe('which events orphan a checkout', () => {
  it('reads a deletion that had one', () => {
    expect(orphanedByDeletion(deletion())).toEqual(ABANDONED)
  })

  it('ignores a deletion that had none', () => {
    expect(orphanedByDeletion(deletion({ abandoned: undefined }))).toBeNull()
  })

  it.each([
    ['a thread update', { entity: 'thread', action: 'updated' } as const],
    ['a thread creation', { entity: 'thread', action: 'created' } as const],
    ['a message', { entity: 'message', action: 'created' } as const],
    ['a tool call', { entity: 'tool_call', action: 'created' } as const],
  ])('ignores %s even when it carries a checkout', (_label, over) => {
    // Releasing on an UPDATE would pull the floor out from under a live
    // conversation — the narrowing is the safety, not a tidiness.
    expect(orphanedByDeletion(deletion(over))).toBeNull()
  })
})

describe('releasing on deletion', () => {
  it('asks to release the checkout the deletion orphaned', async () => {
    const h = harness()
    await h.emit(deletion())
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toEqual({
      threadId: 't1',
      options: { confirmed: true, abandoned: ABANDONED },
    })
  })

  // THE ONE THAT MATTERS (forbidden-pattern #15). A backstop that runs while
  // nobody is watching must not be able to discard work, and the only thing
  // that could is a flag this module must never pass.
  it('never asks for permission to discard unlanded work', async () => {
    const h = harness()
    await h.emit(deletion())
    expect(h.calls[0].options).not.toHaveProperty('allowUnlanded')
    expect(Object.keys(h.calls[0].options).sort()).toEqual(['abandoned', 'confirmed'])
  })

  it('leaves the files alone when prune refuses, and says so', async () => {
    const h = harness({ status: 'refused', detail: 'still holds work' })
    await h.emit(deletion())
    // The positive first (allowed-pattern #28): it DID ask…
    expect(h.calls).toHaveLength(1)
    // …and reported the refusal rather than reporting success.
    expect(h.outcomes).toEqual([{ threadId: 't1', status: 'refused' }])
  })

  it('does nothing at all for a conversation that had no checkout', async () => {
    const h = harness()
    await h.emit(deletion({ abandoned: undefined }))
    expect(h.calls).toEqual([])
  })

  it('survives a release that throws, because the orphan is where we already were', async () => {
    const store = new EventEmitter()
    const outcomes: string[] = []
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    releaseCheckoutOnThreadDeleted(store, {
      release: () => Promise.reject(new Error('disk on fire')),
      onOutcome: (o) => outcomes.push(o.status),
    })
    expect(() => store.emit(THREAD_STORE_CHANGE_EVENT, deletion())).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(outcomes).toEqual(['failed'])
    spy.mockRestore()
  })

  it('stops listening when told to', async () => {
    const h = harness()
    h.stop()
    await h.emit(deletion())
    expect(h.calls).toEqual([])
  })
})
