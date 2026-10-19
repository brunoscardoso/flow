import {
  INBOX_STORAGE_KEY,
  readInbox,
  writeInbox,
  type InboxStorage,
  type PersistedInbox,
} from './inbox-store'
import type { FlowNotification } from '../../shared/ipc-contract'

/** In-memory stand-in for localStorage; `fail` makes both halves throw. */
function makeStorage(
  seed: string | null = null,
  fail = false,
): InboxStorage & { value: string | null } {
  return {
    value: seed,
    getItem() {
      if (fail) throw new Error('storage unavailable')
      return this.value
    },
    setItem(_key: string, next: string) {
      if (fail) throw new Error('quota exceeded')
      this.value = next
    },
  }
}

function entry(overrides: Partial<FlowNotification> = {}): FlowNotification {
  return {
    kind: 'state-change',
    rootId: '/tmp/proj',
    title: 'Plan execution failed',
    body: 'Phase 3 failed.\n\nTypeError: cannot read x',
    timestamp: '2026-08-13T10:00:00.000Z',
    level: 'error',
    ...overrides,
  }
}

describe('inbox-store', () => {
  it('round-trips entries and the unread counter', () => {
    const storage = makeStorage()
    const inbox: PersistedInbox = { entries: [entry(), entry({ title: 'Lint finished' })], unread: 2 }
    writeInbox(storage, inbox, 200)

    const read = readInbox(storage, 200)
    expect(read.entries).toHaveLength(2)
    expect(read.unread).toBe(2)
    // The multi-line body #1075 retains is what the reload must not destroy.
    expect(read.entries[0].body).toContain('TypeError: cannot read x')
    expect(read.entries[1].title).toBe('Lint finished')
  })

  it('keeps a blocked prompt id, and drops fields it does not know', () => {
    const storage = makeStorage(
      JSON.stringify({
        entries: [{ ...entry({ kind: 'blocked-prompt', promptId: 'p-1' }), surprise: 'x' }],
        unread: 1,
      }),
    )
    const read = readInbox(storage, 200)
    expect(read.entries[0].promptId).toBe('p-1')
    expect(read.entries[0]).not.toHaveProperty('surprise')
  })

  it('evicts oldest-first on both halves, like the live list', () => {
    const storage = makeStorage()
    const entries = Array.from({ length: 5 }, (_, i) => entry({ title: `n${i}` }))
    writeInbox(storage, { entries, unread: 0 }, 3)
    expect(readInbox(storage, 3).entries.map((e) => e.title)).toEqual(['n2', 'n3', 'n4'])

    // A log written by a build with a larger cap is bounded on the way in too.
    const wide = makeStorage(JSON.stringify({ entries, unread: 0 }))
    expect(readInbox(wide, 2).entries.map((e) => e.title)).toEqual(['n3', 'n4'])
  })

  it('never reports more unread than it can show', () => {
    const storage = makeStorage(JSON.stringify({ entries: [entry()], unread: 99 }))
    expect(readInbox(storage, 200).unread).toBe(1)
  })

  it('drops malformed records rather than the whole log', () => {
    const storage = makeStorage(
      JSON.stringify({
        entries: [
          entry({ title: 'good' }),
          { kind: 'state-change', title: 'no body or level' },
          null,
          'not an object',
          entry({ level: 'catastrophic' as FlowNotification['level'] }),
          entry({ title: 'also good' }),
        ],
        unread: 0,
      }),
    )
    expect(readInbox(storage, 200).entries.map((e) => e.title)).toEqual(['good', 'also good'])
  })

  it('degrades to an empty inbox instead of throwing', () => {
    expect(readInbox(makeStorage(null), 200)).toEqual({ entries: [], unread: 0 })
    expect(readInbox(makeStorage('{not json'), 200)).toEqual({ entries: [], unread: 0 })
    expect(readInbox(makeStorage('[]'), 200)).toEqual({ entries: [], unread: 0 })
    expect(readInbox(makeStorage(JSON.stringify({ unread: 3 })), 200)).toEqual({
      entries: [],
      unread: 0,
    })
    // Storage itself unavailable (private mode, disabled quota).
    expect(readInbox(makeStorage(null, true), 200)).toEqual({ entries: [], unread: 0 })
  })

  it('swallows a failed write so a full quota cannot break the live toast', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeInbox(makeStorage(null, true), { entries: [entry()], unread: 1 }, 200)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('writes under a versioned key', () => {
    const storage = makeStorage()
    writeInbox(storage, { entries: [], unread: 0 }, 200)
    expect(INBOX_STORAGE_KEY).toBe('flow.notification-inbox.v1')
    expect(storage.value).toBe('{"entries":[],"unread":0}')
  })
})
