import { EventEmitter } from 'node:events'

import { THREAD_STORE_CHANGE_EVENT, type ThreadChangeEvent } from '../store/thread-store'
import { stopDockerOnThreadArchived } from './docker-on-thread-archived'

function harness(options: { compose?: string[]; roots?: string[]; stopThrows?: boolean } = {}) {
  const store = new EventEmitter()
  const stops: string[] = []
  const reads: string[] = []
  const outcomes: Array<boolean | null> = []
  const unsubscribe = stopDockerOnThreadArchived(store, {
    rootsOf: () => options.roots ?? ['/p'],
    hasCompose: async (root: string) => {
      reads.push(root)
      return (options.compose ?? ['/p']).includes(root)
    },
    stopThreadDocker: async (threadId) => {
      stops.push(threadId)
      if (options.stopThrows) throw new Error('docker gone')
      return true
    },
    onOutcome: (outcome) => outcomes.push(outcome.stopped),
  })
  const emit = async (event: ThreadChangeEvent): Promise<void> => {
    store.emit(THREAD_STORE_CHANGE_EVENT, event)
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  }
  return { store, stops, reads, outcomes, unsubscribe, emit }
}

const event = (action: ThreadChangeEvent['action'], entity: ThreadChangeEvent['entity'] = 'thread'): ThreadChangeEvent => ({
  entity,
  action,
  threadId: 't1',
})

describe('stopDockerOnThreadArchived', () => {
  it('stops the thread’s Docker services on archive when the project has a Compose file', async () => {
    const h = harness()
    await h.emit(event('archived'))
    expect(h.stops).toEqual(['t1'])
    expect(h.outcomes).toEqual([true])
  })

  it('does no Docker work for a project without a Compose file (positive control: one with a Compose file does)', async () => {
    const on = harness()
    await on.emit(event('archived'))
    expect(on.stops).toEqual(['t1'])
    const off = harness({ compose: [] })
    await off.emit(event('archived'))
    expect(off.reads).toEqual(['/p']) // the file WAS looked for…
    expect(off.stops).toEqual([]) // …and Docker was not
    expect(off.outcomes).toEqual([null])
  })

  it('any one of the thread’s projects with a Compose file is enough', async () => {
    const h = harness({ roots: ['/a', '/b'], compose: ['/b'] })
    await h.emit(event('archived'))
    expect(h.stops).toEqual(['t1'])
  })

  it('ignores restore, updates, deletes, other entities', async () => {
    // Positive first: the same harness stops on a real archive.
    const control = harness()
    await control.emit(event('archived'))
    expect(control.stops).toEqual(['t1'])
    const h = harness()
    await h.emit(event('restored'))
    await h.emit(event('updated'))
    await h.emit(event('deleted'))
    await h.emit(event('archived', 'message'))
    expect(h.reads).toEqual([])
    expect(h.stops).toEqual([])
  })

  it('a failing stop never throws out of the subscriber', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness({ stopThrows: true })
    await h.emit(event('archived'))
    expect(h.outcomes).toEqual([false])
    spy.mockRestore()
  })

  it('stops listening once unsubscribed', async () => {
    const h = harness()
    h.unsubscribe()
    await h.emit(event('archived'))
    expect(h.stops).toEqual([])
  })
})
