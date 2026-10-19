import {
  buildBoardModel,
  huntFilterFor,
  originForItem,
  originForTask,
  queueItemExternalKey,
} from './board-model'
import type { BoardCard, BoardModelInput } from './board-model'
import type {
  LoopInstruction,
  LoopQueueGroup,
  LoopQueueItem,
  LoopQueueSnapshot,
  LoopStatusRow,
  LoopsSnapshot,
  TaskSummary,
} from '../../shared/ipc-contract'

const NOW = Date.parse('2026-08-14T16:00:00.000Z')
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

// Shapes copied from what the real CLI emits in this repo (verified against
// `loop list` / `loop status` on 2026-08-14): person-filed items carry
// `fingerprint: ""` and no `assignees` key at all, and both loops name the SAME
// github queue.
function item(overrides: Partial<LoopQueueItem> = {}): LoopQueueItem {
  return {
    id: '1533',
    loop: 'fix',
    title: 'code map refactor',
    body: '<!-- loop: fix -->\n',
    fingerprint: '',
    state: 'open',
    labels: ['loop-fix'],
    approved: true,
    createdAt: iso(2 * 86_400_000),
    url: 'https://github.com/dev/plan-flow/issues/1533',
    ...overrides,
  }
}

function group(overrides: Partial<LoopQueueGroup> = {}): LoopQueueGroup {
  return {
    loop: 'fix',
    queueKind: 'github',
    queueLocation: 'dev/plan-flow',
    items: [],
    ...overrides,
  }
}

function queue(overrides: Partial<LoopQueueSnapshot> = {}): LoopQueueSnapshot {
  return {
    available: true,
    reason: null,
    state: 'open',
    loops: [],
    generatedAt: iso(0),
    ...overrides,
  }
}

function statusRow(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'fix',
    pause: null,
    locks: [],
    queue: {
      open: 3,
      closed: 97,
      claimed: 1,
      awaitingApproval: 0,
      parked: 0,
      claimable: 2,
      maxOpenIssues: 20,
      capReached: false,
    },
    queueKind: 'github',
    queueLocation: 'dev/plan-flow',
    awaitingApprovalIds: [],
    ...overrides,
  }
}

function loops(rows: LoopStatusRow[] = [], overrides: Partial<LoopsSnapshot> = {}): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows,
    globalPause: null,
    digest: null,
    generatedAt: iso(0),
    ...overrides,
  }
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'A local task',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: false,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: iso(3 * 3_600_000),
    updatedAt: iso(3_600_000),
    ...overrides,
  }
}

function input(overrides: Partial<BoardModelInput> = {}): BoardModelInput {
  return { queue: queue(), loops: loops(), tasks: [], now: NOW, ...overrides }
}

// ── Task 5.1: the pure module ───────────────────────────────────────────

describe('buildBoardModel — the pure module', () => {
  it('is pure: same inputs and same clock produce an identical model', () => {
    const args = input({
      queue: queue({ loops: [group({ items: [item()] })] }),
      loops: loops([statusRow()]),
      tasks: [task()],
    })
    expect(buildBoardModel(args)).toEqual(buildBoardModel(args))
  })

  it('returns all five lanes, always', () => {
    const model = buildBoardModel(input())
    expect(Object.keys(model.lanes).sort()).toEqual([
      'blocked',
      'doing',
      'done',
      'review',
      'todo',
    ])
  })

  it('touches no DOM — the module never mentions one', () => {
    // The board's model runs under the app's CJS ts-jest runner, whose
    // testEnvironment is `node`: there is no `document` here at all, so a
    // model that reached for one would throw rather than quietly work.
    expect(typeof globalThis).toBe('object')
    expect((globalThis as Record<string, unknown>)['document']).toBeUndefined()
    expect(() => buildBoardModel(input({ tasks: [task()] }))).not.toThrow()
  })

  it('places local records in the lane their record names', () => {
    const model = buildBoardModel(
      input({
        tasks: [
          task({ id: 'a', lane: 'todo' }),
          task({ id: 'b', lane: 'doing' }),
          task({ id: 'c', lane: 'blocked' }),
          task({ id: 'd', lane: 'done' }),
        ],
      }),
    )
    expect(model.lanes.todo.map((card) => card.taskId)).toEqual(['a'])
    expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['b'])
    expect(model.lanes.blocked.map((card) => card.taskId)).toEqual(['c'])
    expect(model.lanes.done.map((card) => card.taskId)).toEqual(['d'])
  })

  it('keeps archived records off the board', () => {
    const model = buildBoardModel(
      input({ tasks: [task({ id: 'gone', archivedAt: iso(86_400_000) })] }),
    )
    expect(model.lanes.todo).toEqual([])
  })

  it('reads the clock it is given, never a real one', () => {
    const model = buildBoardModel(
      input({ tasks: [task({ updatedAt: iso(4 * 60_000) })], now: NOW }),
    )
    expect(model.lanes.todo[0]?.ageLabel).toBe('4m ago')
  })
})

// ── Task 5.2: origin chips ──────────────────────────────────────────────

describe('origin chips', () => {
  it('names the store a local record came from', () => {
    // Phase 5 widened this from `TaskSource` to the whole record, because the
    // mirror's chip cannot be read off `source` alone (see `isMirroredTask`).
    // The assertions are the original ones; only what is handed in changed.
    expect(originForTask(task({ source: 'manual' }))).toBe('you')
    expect(originForTask(task({ source: 'jira' }))).toBe('jira')
    expect(originForTask(task({ source: 'github' }))).toBe('github')
    // `azure` is a real TaskSource and gets its own chip rather than being
    // mislabelled `you` (which would credit a person for an import).
    expect(originForTask(task({ source: 'azure' }))).toBe('azure')
  })

  it('reads `loop` off the fingerprint a producer filed with', () => {
    expect(originForItem('github', item({ fingerprint: 'a1b2c3' }))).toBe('loop')
    expect(originForItem('ledger', item({ fingerprint: 'a1b2c3' }))).toBe('loop')
  })

  it('reads a person-filed item as its store — the live queue shape', () => {
    // Every open item in this repo's own queue today: `fingerprint: ""`.
    expect(originForItem('github', item({ fingerprint: '' }))).toBe('github')
    expect(originForItem('ledger', item({ fingerprint: '' }))).toBe('you')
  })

  it('gives no chip when nothing reported the store — never a default', () => {
    expect(originForItem(undefined, item({ fingerprint: '' }))).toBeNull()
    expect(originForItem(null, item({ fingerprint: '' }))).toBeNull()
  })

  it('puts one chip on every card it draws', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item()] })] }),
        tasks: [task({ id: 'local' })],
      }),
    )
    for (const card of model.lanes.todo) expect(card.origin).not.toBeUndefined()
  })
})

describe('Todo — a window over the live list, plus the local cards', () => {
  it('holds the queue items AND the local records, each with its own chip', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        tasks: [task({ id: 'local', source: 'manual', lane: 'todo' })],
      }),
    )
    expect(model.lanes.todo.map((card) => [card.itemId, card.taskId, card.origin])).toEqual([
      ['1533', null, 'github'],
      [null, 'local', 'you'],
    ])
  })

  it('draws a loop-filed item and a person-filed one differently', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({
              items: [
                item({ id: '10', fingerprint: 'deadbeef' }),
                item({ id: '11', fingerprint: '' }),
              ],
            }),
          ],
        }),
      }),
    )
    expect(model.lanes.todo.map((card) => card.origin)).toEqual(['loop', 'github'])
  })

  it('keeps the CLI order and stores nothing between calls', () => {
    const args = input({
      queue: queue({ loops: [group({ items: [item({ id: 'a' }), item({ id: 'b' })] })] }),
    })
    expect(buildBoardModel(args).lanes.todo.map((card) => card.itemId)).toEqual(['a', 'b'])
    // The window shows only what the read carried — the previous read's items
    // are not remembered.
    const narrowed = input({ queue: queue({ loops: [group({ items: [item({ id: 'b' })] })] }) })
    expect(buildBoardModel(narrowed).lanes.todo.map((card) => card.itemId)).toEqual(['b'])
  })

  it('reports another run holding an item without going amber', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({
              items: [item({ claimedBy: 'run-20260814T130131791Z-73725', claimedAt: iso(60_000) })],
            }),
          ],
        }),
      }),
    )
    const card = model.lanes.todo[0]
    expect(card?.heldBy).toBe('run-20260814T130131791Z-73725')
    expect(card?.attention).toBe(false)
  })
})

// ── Task 5.3: Doing / Blocked / Done are records ────────────────────────

/** A local record joined to the live item `1533` by the importer's own key. */
function joinedRecord(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return task({
    id: 'run-1',
    source: 'github',
    externalKey: 'dev/plan-flow#1533',
    externalUrl: 'https://github.com/dev/plan-flow/issues/1533',
    lane: 'doing',
    ...overrides,
  })
}

describe('Doing / Blocked / Done — records joined to items', () => {
  it('an item with no run record is never in Doing, Blocked or Done', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({
              items: [
                item({ id: '1', claimedBy: 'someone-elses-run' }),
                item({ id: '2', approved: true }),
              ],
            }),
          ],
        }),
      }),
    )
    expect(model.lanes.todo).toHaveLength(2)
    expect(model.lanes.doing).toEqual([])
    expect(model.lanes.blocked).toEqual([])
    expect(model.lanes.done).toEqual([])
  })

  it('joins by the external key the importer stores', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        tasks: [joinedRecord()],
      }),
    )
    expect(model.lanes.todo).toEqual([])
    expect(model.lanes.doing).toHaveLength(1)
    const card = model.lanes.doing[0]
    expect(card?.itemId).toBe('1533')
    expect(card?.taskId).toBe('run-1')
  })

  it('joins by url when the record carries no external key', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        tasks: [
          joinedRecord({
            externalKey: null,
            externalUrl: 'https://github.com/dev/plan-flow/issues/1533/',
          }),
        ],
      }),
    )
    expect(model.lanes.doing[0]?.taskId).toBe('run-1')
  })

  it('draws a joined pair once, not twice', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        tasks: [joinedRecord()],
      }),
    )
    const cards = [...model.lanes.todo, ...model.lanes.doing, ...model.lanes.done]
    expect(cards).toHaveLength(1)
    expect(model.localTodo).toEqual([])
  })

  it('surfaces a record whose item vanished — never silently drops it', () => {
    const model = buildBoardModel(
      input({
        // The queue ANSWERED (items: []) and did not name 1533.
        queue: queue({ state: 'open', loops: [group({ items: [] })] }),
        tasks: [joinedRecord({ lane: 'doing' })],
      }),
    )
    expect(model.lanes.doing).toHaveLength(1)
    expect(model.lanes.doing[0]?.missingReason).toBe(
      'no longer open in dev/plan-flow',
    )
  })

  it('names the slice that was read rather than claiming removal', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ state: 'all', loops: [group({ items: [] })] }),
        tasks: [joinedRecord()],
      }),
    )
    expect(model.lanes.doing[0]?.missingReason).toBe('no longer in dev/plan-flow')
  })

  it('claims nothing about a record whose queue could not be read', () => {
    // Absence proves nothing about a list nobody reached — the empty-Todo lie
    // in a different hat.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: null, queueError: 'gh: HTTP 502' })] }),
        tasks: [joinedRecord()],
      }),
    )
    expect(model.lanes.doing[0]?.missingReason).toBeNull()
  })

  it('says nothing about a local record that belongs to no queue', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [] })] }),
        tasks: [task({ id: 'mine', source: 'manual', lane: 'doing' })],
      }),
    )
    expect(model.lanes.doing[0]?.missingReason).toBeNull()
  })
})

// ── Task 5.4: Blocked admits exactly two states ─────────────────────────

describe('Blocked — the two states that want a human', () => {
  it('blocks an item the approval gate is holding, and goes amber', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '77', approved: false })] })] }),
        loops: loops([statusRow()]),
      }),
    )
    expect(model.lanes.todo).toEqual([])
    expect(model.lanes.blocked).toHaveLength(1)
    expect(model.lanes.blocked[0]?.blockedReason).toBe('waiting for approval')
    expect(model.lanes.blocked[0]?.attention).toBe(true)
  })

  it('blocks an item the status snapshot names, even when the item looks approved', () => {
    // Two answers to one read: whichever arrived, the gate is shown.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '77', approved: true })] })] }),
        loops: loops([statusRow({ awaitingApprovalIds: ['77'] })]),
      }),
    )
    expect(model.lanes.blocked.map((card) => card.itemId)).toEqual(['77'])
  })

  it('leaves work in flight where it is — the approval gate is the ONLY route to Blocked', () => {
    // THE SECOND ROUTE IS GONE. A tripped consecutive-failure breaker used to
    // pull a loop's in-flight work into Blocked with `breaker tripped 3/3` on
    // it; the breaker went with the supervision layer (loops-native-runtime,
    // Phase 6), so no status row can carry that state and no card can reach
    // that lane through it. A card in Doing stays in Doing.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        loops: loops([statusRow({})]),
        tasks: [joinedRecord({ lane: 'doing' })],
      }),
    )
    expect(model.lanes.doing).toHaveLength(1)
    expect(model.lanes.blocked).toEqual([])
  })

  it('does NOT block a spent budget — a cap is the machinery working', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        loops: loops([
          statusRow({
            queue: {
              open: 20,
              closed: 97,
              claimed: 1,
              awaitingApproval: 0,
              parked: 0,
              claimable: 0,
              maxOpenIssues: 20,
              capReached: true,
            },
          }),
        ]),
        tasks: [joinedRecord({ lane: 'doing' })],
      }),
    )
    expect(model.lanes.blocked).toEqual([])
    expect(model.lanes.doing).toHaveLength(1)
  })

  it('does NOT block a gate that refused — nobody can act on it', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        loops: loops([statusRow({ lastOutcome: 'refused', lastRunAt: iso(60_000) })]),
        tasks: [joinedRecord({ lane: 'doing' })],
      }),
    )
    expect(model.lanes.blocked).toEqual([])
    expect(model.lanes.doing).toHaveLength(1)
  })

  it('keeps a human-placed card in Blocked without painting it amber', () => {
    const model = buildBoardModel(input({ tasks: [task({ id: 'mine', lane: 'blocked' })] }))
    expect(model.lanes.blocked.map((card) => card.taskId)).toEqual(['mine'])
    expect(model.lanes.blocked[0]?.attention).toBe(false)
  })

  it('paints nothing else amber', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({
              items: [item({ id: '1' }), item({ id: '2', claimedBy: 'other-run' })],
            }),
          ],
        }),
        loops: loops([statusRow()]),
        tasks: [task({ id: 'a', lane: 'doing' }), task({ id: 'b', lane: 'done' })],
      }),
    )
    const all = [
      ...model.lanes.todo,
      ...model.lanes.doing,
      ...model.lanes.blocked,
      ...model.lanes.done,
    ]
    expect(all.filter((card) => card.attention)).toEqual([])
  })

  it('reports no blocking at all when the status snapshot is missing', () => {
    // Not measured is not "nothing is waiting" — but neither is it a block the
    // model may invent, so the item stays where the queue put it.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ id: '1533' })] })] }),
        loops: null,
        tasks: [joinedRecord({ lane: 'doing' })],
      }),
    )
    expect(model.lanes.doing).toHaveLength(1)
    expect(model.lanes.blocked).toEqual([])
  })
})

// ── Task 5.5: THE UNREADABLE RULE (NFR-1 / NFR-2) ───────────────────────
//
// The user's own stated failure mode: "the board silently shows a stale list".
// A read that failed and a list that is genuinely clear are DIFFERENT ANSWERS,
// and this block is the one that must fail loudly if they ever merge.

describe('the unreadable rule', () => {
  it('a failed read is `unreadable` with the CLI reason — never an empty Todo', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ available: false, reason: 'planflow-ai not found on PATH', state: null }),
      }),
    )
    expect(model.state).toBe('unreadable')
    expect(model.reason).toBe('planflow-ai not found on PATH')
    expect(model.state).not.toBe('ready')
    expect(model.state).not.toBe('no-list-configured')
  })

  it('one loop\'s unreachable backend is unreadable, reason verbatim', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [group({ items: null, queueError: 'gh api failed: HTTP 502 (bad gateway)' })],
        }),
      }),
    )
    expect(model.state).toBe('unreadable')
    expect(model.groups[0]?.readable).toBe(false)
    expect(model.groups[0]?.reason).toBe('gh api failed: HTTP 502 (bad gateway)')
    expect(model.groups[0]?.todo).toEqual([])
  })

  it('an unparseable directive is unreadable and says so', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            {
              loop: 'find',
              items: null,
              directiveError: 'loops/find.md: queue: is missing',
            },
          ],
        }),
      }),
    )
    expect(model.state).toBe('unreadable')
    expect(model.groups[0]?.reason).toBe('loops/find.md: queue: is missing')
  })

  it('null and [] are DIFFERENT ANSWERS and never collapse', () => {
    const failed = buildBoardModel(
      input({ queue: queue({ loops: [group({ items: null, queueError: 'boom' })] }) }),
    )
    const clear = buildBoardModel(input({ queue: queue({ loops: [group({ items: [] })] }) }))

    expect(failed.state).toBe('unreadable')
    expect(clear.state).toBe('ready')
    expect(failed.groups[0]?.readable).toBe(false)
    expect(clear.groups[0]?.readable).toBe(true)
    // Both draw zero Todo cards — which is exactly why the STATE has to differ.
    expect(failed.lanes.todo).toEqual([])
    expect(clear.lanes.todo).toEqual([])
    expect(failed.state).not.toBe(clear.state)
  })

  it('stays unreadable even with no reason to show — silence is not success', () => {
    const model = buildBoardModel(input({ queue: queue({ loops: [group({ items: null })] }) }))
    expect(model.state).toBe('unreadable')
    expect(model.groups[0]?.readable).toBe(false)
    expect(model.groups[0]?.reason).toBeNull()
  })

  it('keeps the local records on the board while the window is broken', () => {
    // The window failed; the records are still ours and still true.
    const model = buildBoardModel(
      input({
        queue: queue({ available: false, reason: 'loop list timed out after 20s', state: null }),
        tasks: [task({ id: 'mine', lane: 'todo' }), task({ id: 'run', lane: 'doing' })],
      }),
    )
    expect(model.state).toBe('unreadable')
    expect(model.localTodo.map((card) => card.taskId)).toEqual(['mine'])
    expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['run'])
  })

  it('reports `partial` when one queue answered and another did not', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'fix', items: [item()] }),
            group({
              loop: 'audit',
              queueKind: 'ledger',
              queueLocation: 'flow/loops/audit.jsonl',
              items: null,
              queueError: 'flow/loops/audit.jsonl: ENOENT',
            }),
          ],
        }),
      }),
    )
    expect(model.state).toBe('partial')
    expect(model.groups.map((entry) => entry.readable)).toEqual([true, false])
    expect(model.groups[1]?.reason).toBe('flow/loops/audit.jsonl: ENOENT')
  })

  it('never reports `unreadable` as `no-list-configured`', () => {
    // A read that failed says nothing about whether a list exists, and telling
    // the user to set one up would be advice to duplicate the list they have.
    const model = buildBoardModel(
      input({ queue: queue({ available: false, reason: 'CLI unavailable', state: null }) }),
    )
    expect(model.state).toBe('unreadable')
  })
})

// ── Task 5.6: Done holds records, not closures ──────────────────────────

describe('Done — only work Flow has a record of', () => {
  it('drops an item closed elsewhere rather than drawing it', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          state: 'all',
          loops: [
            group({
              items: [
                item({ id: '900', state: 'closed', closedAt: iso(86_400_000), closeReason: 'done' }),
                item({ id: '901', state: 'open' }),
              ],
            }),
          ],
        }),
      }),
    )
    expect(model.lanes.done).toEqual([])
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['901'])
    expect(model.groups[0]?.todo.map((card) => card.itemId)).toEqual(['901'])
  })

  it('keeps a closed item whose work Flow actually did', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          state: 'all',
          loops: [group({ items: [item({ id: '1533', state: 'closed', closeReason: 'done' })] })],
        }),
        tasks: [joinedRecord({ lane: 'done' })],
      }),
    )
    expect(model.lanes.done.map((card) => [card.itemId, card.taskId])).toEqual([
      ['1533', 'run-1'],
    ])
  })

  it('never puts a bare queue item in Done', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          state: 'all',
          loops: [
            group({
              items: [
                item({ id: '1', state: 'closed' }),
                item({ id: '2', state: 'closed', closeReason: 'wontfix' }),
                item({ id: '3', state: 'open' }),
              ],
            }),
          ],
        }),
      }),
    )
    expect(model.lanes.done.every((card) => card.taskId !== null)).toBe(true)
    expect(model.lanes.done).toEqual([])
  })
})

// ── Task 5.7: one group per QUEUE, and the no-list state ────────────────

describe('queue groups', () => {
  it('two loops on the SAME queue are ONE group — this repo, today', () => {
    // Verified against `planflow-ai loop list` on 2026-08-14: `find` and `fix`
    // both report queueKind `github`, queueLocation `dev/plan-flow`.
    // Grouping per loop would draw one backlog twice under two headings.
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'find', items: [] }),
            group({ loop: 'fix', items: [item({ id: '1533' })] }),
          ],
        }),
      }),
    )
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0]?.loops).toEqual(['find', 'fix'])
    // Phase 5 stopped printing the raw location as a heading (forbidden pattern
    // #12) — the LOCATION is unchanged and still asserted below; only what a
    // person is shown moved to the panel's own vocabulary.
    expect(model.groups[0]?.location).toBe('dev/plan-flow')
    expect(model.groups[0]?.label).toBe('GitHub · dev/plan-flow')
    expect(model.groups[0]?.todo.map((card) => card.itemId)).toEqual(['1533'])
  })

  it('draws an item ONCE when both loops on a queue report it', () => {
    // WHAT THE USER SAW: a `find` run filed three findings and the board drew
    // six cards, in identical pairs, with the count agreeing. `loop list`
    // reports per LOOP and both loops read the same list, so every item came
    // back twice — the fold that makes them one group already knew that, and
    // the drawing walked the rows again anyway.
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'find', items: [item({ id: '1' }), item({ id: '2' })] }),
            group({ loop: 'fix', items: [item({ id: '1' }), item({ id: '2' })] }),
          ],
        }),
      }),
    )
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['1', '2'])
    expect(model.groups[0]?.todo.map((card) => card.itemId)).toEqual(['1', '2'])
  })

  it('keeps an id that two DIFFERENT queues both use', () => {
    // A ledger's `3` is not GitHub's `3`. Deduping on the item id alone would
    // be the same lie in the other direction: one list's work vanishing because
    // another list numbered something the same.
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'fix', items: [item({ id: '3' })] }),
            group({
              loop: 'audit',
              queueKind: 'ledger',
              queueLocation: 'flow/loops/queue.jsonl',
              items: [item({ id: '3', url: undefined })],
            }),
          ],
        }),
      }),
    )
    expect(model.lanes.todo).toHaveLength(2)
  })

  it('two loops naming DIFFERENT queues produce two labelled groups', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'fix', items: [item({ id: '1' })] }),
            group({
              loop: 'audit',
              queueKind: 'ledger',
              queueLocation: 'flow/loops/audit.jsonl',
              items: [item({ id: '2', loop: 'audit' })],
            }),
          ],
        }),
      }),
    )
    // The two KINDS and the two LOCATIONS are what make these separate groups
    // and are asserted unchanged; the labels are Phase 5's reader-facing names
    // (a ledger's own name, never the path to the file it lives in).
    expect(model.groups.map((entry) => [entry.kind, entry.location, entry.label])).toEqual([
      ['github', 'dev/plan-flow', 'GitHub · dev/plan-flow'],
      ['ledger', 'flow/loops/audit.jsonl', 'This project · audit'],
    ])
    expect(model.groups.map((entry) => entry.todo.map((card) => card.itemId))).toEqual([
      ['1'],
      ['2'],
    ])
  })

  it('never merges two loops that named no queue at all', () => {
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            { loop: 'a', items: null, directiveError: 'no queue:' },
            { loop: 'b', items: null, directiveError: 'no queue:' },
          ],
        }),
      }),
    )
    expect(model.groups.map((entry) => entry.key)).toEqual(['loop:a', 'loop:b'])
    expect(model.groups.map((entry) => entry.label)).toEqual(['a', 'b'])
  })

  it('a queue one loop could read is readable, whichever loop failed', () => {
    // Both rows are reads of ONE list; one success means the list was read.
    const model = buildBoardModel(
      input({
        queue: queue({
          loops: [
            group({ loop: 'find', items: null, queueError: 'gh: rate limited' }),
            group({ loop: 'fix', items: [item({ id: '1533' })] }),
          ],
        }),
      }),
    )
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0]?.readable).toBe(true)
    expect(model.groups[0]?.reason).toBe('gh: rate limited')
    expect(model.state).toBe('ready')
  })

  it('no directives is `no-list-configured` — explicit, not empty', () => {
    const model = buildBoardModel(input({ queue: queue({ loops: [] }) }))
    expect(model.state).toBe('no-list-configured')
    expect(model.groups).toEqual([])
  })

  it('still shows the local board when no list is configured', () => {
    const model = buildBoardModel(
      input({ queue: queue({ loops: [] }), tasks: [task({ id: 'mine', lane: 'todo' })] }),
    )
    expect(model.state).toBe('no-list-configured')
    expect(model.localTodo.map((card) => card.taskId)).toEqual(['mine'])
  })

  it('creates nothing and mutates nothing — reading writes nothing', () => {
    const snapshot = queue({ loops: [group({ items: [item()] })] })
    const before = JSON.parse(JSON.stringify(snapshot)) as unknown
    const records = [task({ id: 'mine' })]
    const recordsBefore = JSON.parse(JSON.stringify(records)) as unknown
    buildBoardModel(input({ queue: snapshot, tasks: records }))
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(before)
    expect(JSON.parse(JSON.stringify(records))).toEqual(recordsBefore)
  })
})

describe('queueItemExternalKey', () => {
  it('builds the same key the issue importer stores', () => {
    // `parseIssueRef` writes `owner/repo#123`; the join meets it there.
    expect(queueItemExternalKey('dev/plan-flow', '1533')).toBe(
      'dev/plan-flow#1533',
    )
  })

  it('is null when the queue never named a location', () => {
    expect(queueItemExternalKey(undefined, '1')).toBeNull()
    expect(queueItemExternalKey('   ', '1')).toBeNull()
  })
})

// ── Task 7.1: the hunt gets a face ──────────────────────────────────────

function instruction(overrides: Partial<LoopInstruction> = {}): LoopInstruction {
  return {
    text: 'find UI gaps in the blueprint board',
    filed: 7,
    cap: 20,
    quietRuns: 0,
    status: 'active',
    since: iso(3 * 86_400_000),
    ...overrides,
  }
}

describe('buildBoardModel — hunts (Task 7.1)', () => {
  it('reports a producer hunt with the store\'s own two numbers', () => {
    const model = buildBoardModel(
      input({ loops: loops([statusRow({ loop: 'find', instructions: [instruction()] })]) }),
    )
    expect(model.hunts.cards).toHaveLength(1)
    const hunt = model.hunts.cards[0]!
    expect(hunt.text).toBe('find UI gaps in the blueprint board')
    expect(hunt.filed).toBe(7)
    expect(hunt.cap).toBe(20)
    expect(hunt.status).toBe('active')
    expect(hunt.loops).toEqual(['find'])
    expect(model.hunts.reason).toBeNull()
  })

  it('reports NO budget — `loop status` does not carry one', () => {
    // The premise check that mattered: a run's budget is arithmetic over the
    // directive's `max_run_minutes` and the lock's `acquiredAt`, and the status
    // report carries the lock but never the minutes. There is nothing on this
    // wire to render, so the card renders nothing rather than the lock's TTL
    // (the budget PLUS a wrap-up margin) under the budget's name.
    const model = buildBoardModel(
      input({
        loops: loops([
          statusRow({
            loop: 'find',
            instructions: [instruction()],
            locks: [
              {
                owner: 'run-1',
                slot: 1,
                acquiredAt: iso(10 * 60_000),
                expiresAt: new Date(NOW + 20 * 60_000).toISOString(),
              },
            ],
          }),
        ]),
      }),
    )
    const hunt = model.hunts.cards[0]! as unknown as Record<string, unknown>
    expect(hunt['budget']).toBeUndefined()
    expect(hunt['remainingMs']).toBeUndefined()
  })

  it('folds one hunt reported by two producers into ONE card naming both', () => {
    // The store is one project-wide file with no loop field, so `loop status`
    // reports the same hunts on every producer row. Two cards would be a
    // project with twice the hunts.
    const model = buildBoardModel(
      input({
        loops: loops([
          statusRow({ loop: 'find', topic: 'codemap', instructions: [instruction()] }),
          statusRow({
            loop: 'hunt',
            topic: 'ui',
            // Same sentence, different spacing and case — the CLI's identity
            // rule collapses them, and so must this.
            instructions: [instruction({ text: 'Find UI  gaps in the Blueprint board' })],
          }),
        ]),
      }),
    )
    expect(model.hunts.cards).toHaveLength(1)
    expect(model.hunts.cards[0]?.loops).toEqual(['find', 'hunt'])
    expect(model.hunts.cards[0]?.topics).toEqual(['codemap', 'ui'])
  })

  it('carries no amber and no breaker label on a hunt — neither state exists to report', () => {
    // A CAPPED HUNT IS NOT AMBER. It wants a human eventually; it is not a
    // state nothing can proceed without a person clearing. The one state that
    // WAS — a tripped breaker — no longer exists at all, so `BoardHunt` carries
    // neither the flag nor the label: a field nothing can ever set is a promise
    // the card cannot keep.
    const capped = buildBoardModel(
      input({
        loops: loops([
          statusRow({ loop: 'find', instructions: [instruction({ filed: 20, status: 'capped' })] }),
        ]),
      }),
    )
    expect(capped.hunts.cards[0]?.status).toBe('capped')
    expect(Object.keys(capped.hunts.cards[0] ?? {})).not.toContain('attention')
    expect(Object.keys(capped.hunts.cards[0] ?? {})).not.toContain('breakerLabel')
  })

  it('says WHY nobody could read the hunts, rather than reporting none', () => {
    // The mutation this test exists for: `[]` says nothing is being hunted, and
    // an unreadable store has said nothing at all.
    const model = buildBoardModel(
      input({
        loops: loops([
          statusRow({ loop: 'find', instructionsError: 'malformed instructions.json' }),
        ]),
      }),
    )
    expect(model.hunts.cards).toEqual([])
    expect(model.hunts.reason).toBe('malformed instructions.json')
  })

  it('reports no hunts at all when the status snapshot never happened', () => {
    expect(buildBoardModel(input({ loops: null })).hunts).toEqual({ cards: [], reason: null })
    expect(
      buildBoardModel(input({ loops: { ...loops(), available: false, reason: 'no CLI' } })).hunts,
    ).toEqual({ cards: [], reason: null })
  })

  it('keeps hunts out of the lanes — a hunt is not a piece of work', () => {
    const model = buildBoardModel(
      input({ loops: loops([statusRow({ loop: 'find', instructions: [instruction()] })]) }),
    )
    expect(model.lanes.doing).toEqual([])
  })
})

// ── Task 7.2: the filed count filters, approximately ────────────────────

describe('huntFilterFor + the hunt filter (Task 7.2)', () => {
  const filed = (overrides: Partial<LoopQueueItem> = {}): LoopQueueItem =>
    item({
      id: '2001',
      loop: 'find',
      // A fingerprint is the tell that a LOOP filed it — a person's issue has
      // none, which is what every open item in this repo's own queue looks like.
      fingerprint: 'abc123',
      labels: ['codemap'],
      ...overrides,
    })

  const withFind = (items: LoopQueueItem[]): LoopQueueSnapshot =>
    queue({ loops: [group({ loop: 'find', items })] })

  const huntModel = (): ReturnType<typeof buildBoardModel> =>
    buildBoardModel(
      input({ loops: loops([statusRow({ loop: 'find', topic: 'codemap', instructions: [instruction()] })]) }),
    )

  it('is always approximate — no filed item points back at an instruction', () => {
    const filter = huntFilterFor(huntModel().hunts.cards[0]!)
    const model = buildBoardModel(input({ queue: withFind([filed()]), filter }))
    expect(model.filter?.approximate).toBe(true)
    expect(model.filter?.label).toBe('find UI gaps in the blueprint board')
  })

  it('keeps this loop\'s filings under its topic and drops everything else', () => {
    const filter = huntFilterFor(huntModel().hunts.cards[0]!)
    const model = buildBoardModel(
      input({
        queue: withFind([
          filed({ id: 'keep' }),
          // A person's issue: no fingerprint.
          filed({ id: 'by-hand', fingerprint: '' }),
          // Another loop's filing.
          filed({ id: 'other-loop', loop: 'fix' }),
          // This loop, but filed under a different topic.
          filed({ id: 'other-topic', labels: ['docs'] }),
        ]),
        filter,
      }),
    )
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['keep'])
    expect(model.filter?.matched).toBe(1)
    // The three it dropped are counted, not silently gone.
    expect(model.filter?.hidden).toBe(3)
  })

  it('falls back to the loop alone when no loop on the hunt has a topic', () => {
    const noTopic = buildBoardModel(
      input({ loops: loops([statusRow({ loop: 'find', instructions: [instruction()] })]) }),
    )
    const filter = huntFilterFor(noTopic.hunts.cards[0]!)
    expect(filter.topics).toEqual([])
    const model = buildBoardModel(
      input({ queue: withFind([filed({ id: 'a', labels: [] }), filed({ id: 'b', loop: 'fix' })]), filter }),
    )
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['a'])
  })

  it('keeps local records — they are the reader\'s own work, not unmatched backlog', () => {
    const filter = huntFilterFor(huntModel().hunts.cards[0]!)
    const model = buildBoardModel(
      input({ queue: withFind([filed()]), tasks: [task({ id: 'mine' })], filter }),
    )
    expect(model.localTodo.map((card) => card.taskId)).toEqual(['mine'])
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['2001', null])
    // A record kept in spite of the filter is neither a match nor a casualty.
    expect(model.filter?.matched).toBe(1)
    expect(model.filter?.hidden).toBe(0)
  })

  it('never filters the hunts themselves — the filter\'s own control lives there', () => {
    const filter = huntFilterFor(huntModel().hunts.cards[0]!)
    const model = buildBoardModel(
      input({
        queue: withFind([]),
        loops: loops([statusRow({ loop: 'find', topic: 'codemap', instructions: [instruction()] })]),
        filter,
      }),
    )
    expect(model.hunts.cards).toHaveLength(1)
    expect(model.filter?.matched).toBe(0)
  })

  it('shows the whole board when no filter is given', () => {
    const model = buildBoardModel(input({ queue: withFind([filed()]), tasks: [task({ id: 'mine' })] }))
    expect(model.filter).toBeNull()
    expect(model.localTodo.map((card) => card.taskId)).toEqual(['mine'])
  })

  // ── The filter narrows the window, never the records ──────────────────
  //
  // The regression these guard: `joined.add` runs before the filter test, and
  // the local-records pass skips anything joined — so a record whose item failed
  // the filter used to be drawn by NEITHER pass and left every lane. Nothing
  // covered a joined record under a filter, which is how it shipped green.

  /** The exact H2 case: `t1` in Doing on a HAND-FILED issue, under `find`'s filter. */
  const handFiledInDoing = (lane: TaskSummary['lane'] = 'doing'): BoardModelInput =>
    input({
      // `item()` is the hand-filed shape verified against this repo's own queue:
      // id 1533, loop `fix`, `fingerprint: ''` — it fails test 1 AND test 2.
      queue: queue({ loops: [group({ loop: 'find', items: [item()] })] }),
      tasks: [joinedRecord({ id: 't1', lane })],
      filter: huntFilterFor(huntModel().hunts.cards[0]!),
    })

  it('keeps a record in Doing whose item fails the filter — work in flight never vanishes', () => {
    const model = buildBoardModel(handFiledInDoing())
    expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['t1'])
    expect(model.lanes.doing[0]?.itemId).toBe('1533')
    // Drawn as the JOINED card, not as an orphan local one: it kept its queue.
    expect(model.lanes.doing[0]?.queueKey).toBe('github::dev/plan-flow')
  })

  it('keeps an approval-gated item under a filter — the reader is the blocker, and it has no record to save it', () => {
    // The same defect as hiding work in Doing, in the one costume where it is
    // worst: a gated item has NO record by definition (nothing may claim it
    // until a human clears the gate), so the record exemption cannot rescue it.
    // Before the gate was computed ahead of the filter drop, pressing another
    // hunt's count took the amber card off the board entirely.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ loop: 'find', items: [item({ approved: false })] })] }),
        tasks: [],
        filter: huntFilterFor(huntModel().hunts.cards[0]!),
      }),
    )
    expect(model.lanes.blocked.map((card) => card.itemId)).toEqual(['1533'])
    expect(model.lanes.blocked[0]?.attention).toBe(true)
    // Kept, so it is not a casualty of the filter either.
    expect(model.filter?.hidden).toBe(0)
  })

  it('draws that record ONCE — the joined bookkeeping still forbids a second pass', () => {
    const model = buildBoardModel(handFiledInDoing())
    const all = [...model.lanes.todo, ...model.lanes.doing, ...model.lanes.blocked, ...model.lanes.done]
    expect(all.filter((card) => card.taskId === 't1')).toHaveLength(1)
    expect(new Set(all.map((card) => card.key)).size).toBe(all.length)
    expect(model.localTodo).toEqual([])
  })

  it('keeps a failing record in Done too — every lane, not just Doing', () => {
    expect(buildBoardModel(handFiledInDoing('done')).lanes.done.map((c) => c.taskId)).toEqual(['t1'])
    expect(buildBoardModel(handFiledInDoing('blocked')).lanes.blocked.map((c) => c.taskId)).toEqual([
      't1',
    ])
  })

  it('counts a kept record as neither matched nor hidden', () => {
    const model = buildBoardModel(handFiledInDoing())
    expect(model.filter?.matched).toBe(0)
    expect(model.filter?.hidden).toBe(0)
  })

  it('still filters an unclaimed item — no record means no exemption', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ loop: 'find', items: [item(), filed({ id: 'keep' })] })] }),
        filter: huntFilterFor(huntModel().hunts.cards[0]!),
      }),
    )
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['keep'])
    expect(model.filter?.hidden).toBe(1)
  })

  it('never blames the filter for a closed item nobody here worked on', () => {
    const model = buildBoardModel(
      input({
        queue: withFind([filed({ id: 'gone', fingerprint: '', state: 'closed' })]),
        filter: huntFilterFor(huntModel().hunts.cards[0]!),
      }),
    )
    // Off the board either way — clearing the filter would not bring it back,
    // so counting it hidden would offer the reader a card that does not exist.
    expect(model.lanes.todo).toEqual([])
    expect(model.filter?.hidden).toBe(0)
  })
})

// ── Phase 4: the active-thread filter ───────────────────────────────────
//
// THE ONE DECISION THESE GUARD (plan Q1, discovery option (b)). A thread filter's
// obvious reading — "show this conversation and nothing else" — would take
// another thread's work in flight off the board, which is exactly what review
// finding H2 forbade. What is implemented instead is the general policy in
// board-model.ts's header: a filter may remove a card only when nobody has
// started it (it is in TODO) and the card itself answers the filter's question
// (it NAMES a producing thread). Every test below is one half of that sentence.

describe('the thread filter (Phase 4)', () => {
  const THIS_THREAD = 'th-active'
  const OTHER_THREAD = 'th-elsewhere'
  const threadFilter = { threadId: THIS_THREAD, label: 'Board filter work' }

  /** A card an agent mirrored out of a conversation: a local record with a producer. */
  const mirrored = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
    task({ id: 'm1', originThreadId: OTHER_THREAD, ...overrides })

  it('is absent until a conversation is open — the board is exactly today\'s board (FR-7)', () => {
    const tasks = [mirrored(), mirrored({ id: 'm2', originThreadId: THIS_THREAD })]
    const before = buildBoardModel(input({ tasks }))
    expect(before.threadFilter).toBeNull()
    expect(before.lanes.todo.map((card) => card.taskId)).toEqual(['m1', 'm2'])
  })

  it('hides an unstarted card from another conversation, and counts it', () => {
    const model = buildBoardModel(input({ tasks: [mirrored({ lane: 'todo' })], threadFilter }))
    expect(model.lanes.todo).toEqual([])
    expect(model.localTodo).toEqual([])
    expect(model.threadFilter?.hidden).toBe(1)
    expect(model.threadFilter?.matched).toBe(0)
  })

  it('keeps this conversation\'s unstarted card, and counts it as the answer', () => {
    const model = buildBoardModel(
      input({ tasks: [mirrored({ id: 'mine', originThreadId: THIS_THREAD })], threadFilter }),
    )
    expect(model.lanes.todo.map((card) => card.taskId)).toEqual(['mine'])
    expect(model.threadFilter?.matched).toBe(1)
    expect(model.threadFilter?.hidden).toBe(0)
  })

  // ── The H2 half: work in flight never disappears ──────────────────────
  //
  // MUTATION-CHECKED (plan task 6.3): dropping the `lane === 'todo'` clause from
  // `threadFilterHides` — the single edit that makes this filter hide everything
  // it does not match — turns all three of these red, naming the lost lane.

  it.each(['doing', 'blocked', 'done'] as const)(
    'keeps a %s card from another conversation — work already started never vanishes',
    (lane) => {
      const model = buildBoardModel(input({ tasks: [mirrored({ lane })], threadFilter }))
      expect(model.lanes[lane].map((card) => card.taskId)).toEqual(['m1'])
      expect(model.threadFilter?.hidden).toBe(0)
      // Kept in spite of the filter, so it is not the filter's answer either.
      expect(model.threadFilter?.matched).toBe(0)
    },
  )

  it('keeps an approval-gated item — the reader is the blocker, and it has no record at all', () => {
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item({ approved: false })] })] }),
        threadFilter,
      }),
    )
    expect(model.lanes.blocked.map((card) => card.itemId)).toEqual(['1533'])
    expect(model.lanes.blocked[0]?.attention).toBe(true)
    expect(model.threadFilter?.hidden).toBe(0)
  })

  // ── The second half: silence is not a denial ──────────────────────────

  it('never hides the shared backlog — an unclaimed item names no conversation', () => {
    const model = buildBoardModel(
      input({ queue: queue({ loops: [group({ items: [item()] })] }), threadFilter }),
    )
    expect(model.lanes.todo.map((card) => card.itemId)).toEqual(['1533'])
    expect(model.threadFilter?.hidden).toBe(0)
  })

  it('never hides a card whose origin is unrecorded — null is "we do not know"', () => {
    // A manual card, an import, or a row written before provenance existed.
    // Treating the unknown as "somebody else's" would empty an existing
    // project's board the moment any conversation was open (NFR-5).
    const model = buildBoardModel(
      input({ tasks: [task({ id: 'legacy', originThreadId: null, lane: 'todo' })], threadFilter }),
    )
    expect(model.lanes.todo.map((card) => card.taskId)).toEqual(['legacy'])
    expect(model.threadFilter?.hidden).toBe(0)
  })

  it('reads provenance, NOT the thread a card owns', () => {
    // `threadId` is the conversation the card OPENS; `originThreadId` is the one
    // that produced it. Reading the first here would hide every card that owns a
    // conversation other than the open one — most of an existing board.
    const model = buildBoardModel(
      input({
        tasks: [task({ id: 'owns-another', threadId: OTHER_THREAD, originThreadId: null })],
        threadFilter,
      }),
    )
    expect(model.lanes.todo.map((card) => card.taskId)).toEqual(['owns-another'])
    expect(model.threadFilter?.hidden).toBe(0)
  })

  it('hides a joined record in Todo, and does not redraw it as a local card', () => {
    // The bookkeeping H2 exposed, from the other side: `joined` is stamped
    // before any filter runs, so a queue card removed here can never come back
    // through the local-records pass wearing a different key.
    const model = buildBoardModel(
      input({
        queue: queue({ loops: [group({ items: [item()] })] }),
        tasks: [joinedRecord({ id: 'run-1', lane: 'todo', originThreadId: OTHER_THREAD })],
        threadFilter,
      }),
    )
    const all = [...model.lanes.todo, ...model.lanes.doing, ...model.lanes.blocked, ...model.lanes.done]
    expect(all).toEqual([])
    expect(model.localTodo).toEqual([])
    expect(model.threadFilter?.hidden).toBe(1)
  })

  it('clearing restores everything, exactly', () => {
    const tasks = [
      mirrored({ id: 'theirs', lane: 'todo' }),
      mirrored({ id: 'theirs-doing', lane: 'doing' }),
      mirrored({ id: 'mine', originThreadId: THIS_THREAD }),
      task({ id: 'legacy', originThreadId: null }),
    ]
    const narrowed = buildBoardModel(input({ tasks, threadFilter }))
    const cleared = buildBoardModel(input({ tasks }))
    expect(narrowed.lanes.todo.map((card) => card.taskId)).toEqual(['mine', 'legacy'])
    expect(cleared.lanes.todo.map((card) => card.taskId)).toEqual(['theirs', 'mine', 'legacy'])
    // Clearing is a VIEW change, not a reload: every card that survived the
    // filter is identical to the one the whole board draws, and the ones that
    // did not come back unchanged beside them.
    expect(cleared.threadFilter).toBeNull()
    for (const card of [...narrowed.lanes.todo, ...narrowed.lanes.doing]) {
      expect([...cleared.lanes.todo, ...cleared.lanes.doing]).toContainEqual(card)
    }
    expect(cleared.lanes.doing.map((card) => card.taskId)).toEqual(['theirs-doing'])
  })

  // ── Composition with the hunt filter ──────────────────────────────────

  describe('composed with a hunt filter', () => {
    const filed = (overrides: Partial<LoopQueueItem> = {}): LoopQueueItem =>
      item({ id: '2001', loop: 'find', fingerprint: 'abc123', labels: ['codemap'], ...overrides })

    const huntFilter = (): ReturnType<typeof huntFilterFor> =>
      huntFilterFor(
        buildBoardModel(
          input({
            loops: loops([
              statusRow({ loop: 'find', topic: 'codemap', instructions: [instruction()] }),
            ]),
          }),
        ).hunts.cards[0]!,
      )

    it('counts one reason per card, so the two hidden numbers sum to what left', () => {
      const model = buildBoardModel(
        input({
          // Two backlog items the hunt filter refuses, and one it keeps.
          queue: queue({
            loops: [group({ loop: 'find', items: [filed(), item({ id: 'by-hand' }), item({ id: 'other' })] })],
          }),
          // Two mirrored cards the thread filter refuses, one it keeps.
          tasks: [
            mirrored({ id: 'theirs-1' }),
            mirrored({ id: 'theirs-2' }),
            mirrored({ id: 'mine', originThreadId: THIS_THREAD }),
          ],
          filter: huntFilter(),
          threadFilter,
        }),
      )
      expect(model.filter?.hidden).toBe(2)
      expect(model.threadFilter?.hidden).toBe(2)
      const drawn = model.lanes.todo.map((card) => card.itemId ?? card.taskId)
      expect(drawn).toEqual(['2001', 'mine'])
      // 3 backlog items + 3 records = 6 cards a board with no filter would draw;
      // 2 + 2 left, and the two counts describe disjoint sets rather than
      // double-claiming a casualty.
      expect(buildBoardModel(input({
        queue: queue({
          loops: [group({ loop: 'find', items: [filed(), item({ id: 'by-hand' }), item({ id: 'other' })] })],
        }),
        tasks: [
          mirrored({ id: 'theirs-1' }),
          mirrored({ id: 'theirs-2' }),
          mirrored({ id: 'mine', originThreadId: THIS_THREAD }),
        ],
      })).lanes.todo).toHaveLength(6)
    })

    it('never lets the hunt filter claim a card the thread filter never saw', () => {
      // A record the hunt filter removed is not offered to the thread filter at
      // all — the hunt is asked first, and one reason per card is what makes the
      // bar's two lines addable.
      const model = buildBoardModel(
        input({
          queue: queue({ loops: [group({ loop: 'find', items: [item({ id: 'by-hand' })] })] }),
          filter: huntFilter(),
          threadFilter,
        }),
      )
      expect(model.filter?.hidden).toBe(1)
      expect(model.threadFilter?.hidden).toBe(0)
    })

    it('keeps a record in Doing under BOTH filters — neither may take work in flight', () => {
      const model = buildBoardModel(
        input({
          queue: queue({ loops: [group({ loop: 'find', items: [item()] })] }),
          tasks: [joinedRecord({ id: 't1', lane: 'doing', originThreadId: OTHER_THREAD })],
          filter: huntFilter(),
          threadFilter,
        }),
      )
      expect(model.lanes.doing.map((card) => card.taskId)).toEqual(['t1'])
      expect(model.filter?.hidden).toBe(0)
      expect(model.threadFilter?.hidden).toBe(0)
    })
  })
})

/**
 * WORK A CARD IS STILL WAITING ON.
 *
 * A card's `threadStatus` is about its thread's TURN. An agent that
 * backgrounded four review passes finishes its turn cleanly and rests, so the
 * status alone says "nothing is happening" while four agents run — which is
 * what left a Doing card looking abandoned on a live board.
 */
describe('buildBoardModel — background work', () => {
  const cardsOf = (model: ReturnType<typeof buildBoardModel>): BoardCard[] =>
    Object.values(model.lanes).flat()

  it('reads a card’s background work off the map, by its thread', () => {
    const model = buildBoardModel(
      input({
        tasks: [task({ threadId: 'th1' })],
        backgroundTasksById: new Map([['th1', 4]]),
      }),
    )
    expect(cardsOf(model).find((card) => card.taskId === 't1')?.backgroundTasks).toBe(4)
  })

  it('reads 0 for a thread with nothing running', () => {
    const model = buildBoardModel(
      input({ tasks: [task({ threadId: 'th1' })], backgroundTasksById: new Map() }),
    )
    expect(cardsOf(model).find((card) => card.taskId === 't1')?.backgroundTasks).toBe(0)
  })

  it('reads 0 for a card with no thread at all, rather than undefined', () => {
    // The render layer asks "is this live" of every card; a missing number
    // there is a card that draws by accident.
    const model = buildBoardModel(input({ tasks: [task({ threadId: null })] }))
    expect(cardsOf(model).find((card) => card.taskId === 't1')?.backgroundTasks).toBe(0)
  })

  it('is independent of the turn status — a resting thread can still be busy', () => {
    const model = buildBoardModel(
      input({
        tasks: [task({ threadId: 'th1' })],
        threadStatusById: new Map([['th1', 'done' as const]]),
        backgroundTasksById: new Map([['th1', 2]]),
      }),
    )
    const card = cardsOf(model).find((entry) => entry.taskId === 't1')
    expect(card?.threadStatus).toBe('done')
    expect(card?.backgroundTasks).toBe(2)
  })
})
