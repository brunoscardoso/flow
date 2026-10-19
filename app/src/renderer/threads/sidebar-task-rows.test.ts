import {
  taskBelongsInSidebar,
  taskThreadSuppressedFromBareList,
  type SidebarTaskFacts,
  type BareThreadTaskFacts,
} from './sidebar-task-rows'

/**
 * The sidebar is the list of conversations, and #1789 is what happened when it
 * forgot that: one "create some tasks" request in a chat mirrored N cards onto
 * the board, and the sidebar grew N task-named rows that opened nothing. The
 * rule under test is the fix — a record earns a row only when nothing marks it
 * as machine-created.
 *
 * The first cut also let any record with a `threadId` through. That made merely
 * OPENING a mirrored card file a permanent conversation, because the board's
 * "Open chat" creates and links the thread on open: four such cards on the
 * reporter's machine held zero messages between them. Owning a chat is no
 * longer enough.
 */

function task(overrides: Partial<SidebarTaskFacts>): SidebarTaskFacts {
  return {
    threadId: null,
    originThreadId: null,
    source: 'manual',
    externalKey: null,
    ...overrides,
  }
}

describe('a chatless agent-mirrored card stays off the sidebar', () => {
  it('hides a card the mirror filed from a conversation (provenance stamped)', () => {
    expect(
      taskBelongsInSidebar(task({ originThreadId: 'thread-1', externalKey: 'thread-1#TASK#3' })),
    ).toBe(false)
  })

  it('hides a todo-list mirror card the same way', () => {
    expect(
      taskBelongsInSidebar(task({ originThreadId: 'thread-1', externalKey: 'thread-1#run tests' })),
    ).toBe(false)
  })

  it('still hides the card after its origin thread was deleted (provenance nulled, key survives)', () => {
    // The FK nulls originThreadId when the producing conversation is deleted;
    // the mirror's key is the mark that outlives it.
    expect(taskBelongsInSidebar(task({ externalKey: 'thread-1#TASK#3' }))).toBe(false)
  })

  it('hides a ledger queue record whose chat is gone — machine bookkeeping, board-owned', () => {
    expect(taskBelongsInSidebar(task({ externalKey: 'flow/loops/queue.jsonl#7' }))).toBe(false)
  })
})

describe('opening the chat does NOT earn the row', () => {
  it('keeps a mirrored card off the sidebar even after ensureThread linked one', () => {
    // The reported defect: opening the card from the board is enough to create
    // its thread, and that used to promote it into the conversation list.
    expect(
      taskBelongsInSidebar(
        task({ threadId: 'own-thread', originThreadId: 'thread-1', externalKey: 'thread-1#TASK#3' }),
      ),
    ).toBe(false)
  })

  it('keeps it off even once the origin thread is gone and only the key remains', () => {
    expect(
      taskBelongsInSidebar(task({ threadId: 'own-thread', externalKey: 'thread-1#run tests' })),
    ).toBe(false)
  })

  it('a ledger queue record with a chat stays board-owned too', () => {
    expect(
      taskBelongsInSidebar(
        task({ threadId: 'own-thread', externalKey: 'flow/loops/queue.jsonl#7' }),
      ),
    ).toBe(false)
  })
})

describe('a person’s own records keep their rows', () => {
  it('shows a manual task (it owns its 1:1 thread by construction)', () => {
    expect(taskBelongsInSidebar(task({ threadId: 'own-thread' }))).toBe(true)
  })

  it('shows a manual task whose thread was deleted — the row is the #1061 recovery affordance', () => {
    expect(taskBelongsInSidebar(task({}))).toBe(true)
  })

  it('shows a tracker import even when chatless, for the same recovery reason', () => {
    expect(
      taskBelongsInSidebar(task({ source: 'github', externalKey: 'owner/repo#42' })),
    ).toBe(true)
  })
})

/**
 * #1880: the board's loop takes a card, gives it a live 1:1 conversation and
 * marks it a run — and that conversation vanished from the thread list. A
 * machine-filed card earns no task row, so its thread was owned (not "bare")
 * yet spoken for nowhere. The rule below lets a RUNNING machine card's thread
 * fall through to the bare list, without reviving #1789's empty-open threads or
 * #1467's archived-as-live rows.
 */
function bareTask(overrides: Partial<BareThreadTaskFacts>): BareThreadTaskFacts {
  return {
    threadId: null,
    originThreadId: null,
    source: 'manual',
    externalKey: null,
    archivedAt: null,
    threadIsLoopRun: false,
    ...overrides,
  }
}

describe('a running machine-filed card reaches the bare thread list (#1880)', () => {
  it('lets a ledger card the board is working through once it is a loop run', () => {
    expect(
      taskThreadSuppressedFromBareList(
        bareTask({ threadId: 'own', externalKey: 'flow/loops/queue.jsonl#7', threadIsLoopRun: true }),
      ),
    ).toBe(false)
  })

  it('lets an agent-mirrored card through once the board is working it', () => {
    expect(
      taskThreadSuppressedFromBareList(
        bareTask({
          threadId: 'own',
          originThreadId: 'thread-1',
          externalKey: 'thread-1#TASK#3',
          threadIsLoopRun: true,
        }),
      ),
    ).toBe(false)
  })

  it('still hides a machine card whose thread was only OPENED, never run (#1789)', () => {
    expect(
      taskThreadSuppressedFromBareList(
        bareTask({ threadId: 'own', externalKey: 'flow/loops/queue.jsonl#7', threadIsLoopRun: false }),
      ),
    ).toBe(true)
  })

  it('keeps an archived machine card off the live bare list even mid-run (#1467)', () => {
    expect(
      taskThreadSuppressedFromBareList(
        bareTask({
          threadId: 'own',
          externalKey: 'flow/loops/queue.jsonl#7',
          threadIsLoopRun: true,
          archivedAt: '2026-09-01T00:00:00.000Z',
        }),
      ),
    ).toBe(true)
  })
})

describe('a sidebar-owned task’s thread stays out of the bare list (spoken for by its row)', () => {
  it('suppresses a manual task’s thread — the task row renders it', () => {
    expect(
      taskThreadSuppressedFromBareList(bareTask({ threadId: 'own', threadIsLoopRun: true })),
    ).toBe(true)
  })

  it('suppresses a tracker import’s thread the same way', () => {
    expect(
      taskThreadSuppressedFromBareList(
        bareTask({
          threadId: 'own',
          source: 'github',
          externalKey: 'owner/repo#42',
          threadIsLoopRun: true,
        }),
      ),
    ).toBe(true)
  })
})
