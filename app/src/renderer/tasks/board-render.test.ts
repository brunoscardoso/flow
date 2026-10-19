// The board's render plan — lanes, group headings, banners, chips and empty
// states (loops-on-the-board, Phase 6, tasks 6.1/6.2).
//
// THE MUTATION THIS FILE EXISTS FOR is the one the whole feature was asked to
// stop: a read that failed rendering as "Nothing here yet". Every assertion
// about a banner below is really an assertion that the empty state is ABSENT.

import { buildBoardModel, huntFilterFor, type BoardModel } from './board-model'
import {
  cardChips,
  filterCountLabel,
  planBoardRender,
  threadFilterCountLabel,
  threadFilterText,
  CLEAR_FILTERS_LABEL,
  THREAD_FILTER_KEPT_NOTE,
  HUNT_FILTER_APPROXIMATE_NOTE,
  HUNT_FILTER_DEAD,
  HUNT_FILTER_HINT,
  LOCAL_SECTION_LABEL,
  NO_LIST_TEXT,
  SET_UP_LIST_HINT,
  UNREADABLE_FALLBACK,
} from './board-render'
import { queueFailureSentence } from '../loops/queue-failure'
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

/**
 * A queue group.
 *
 * `ledger` BY DEFAULT SINCE THE REMOTE COLUMN LANDED. A github group is a
 * REMOTE list now — it draws in its own column before Todo, not as a Todo
 * section — so a fixture that wants to exercise Todo's sections has to be a
 * list this project owns. Every case that is really about the remote says
 * `queueKind: 'github'` explicitly, which is also how it reads.
 */
function group(overrides: Partial<LoopQueueGroup> = {}): LoopQueueGroup {
  return {
    loop: 'fix',
    queueKind: 'ledger',
    queueLocation: 'flow/loops/queue.jsonl',
    items: [],
    ...overrides,
  }
}

function queue(overrides: Partial<LoopQueueSnapshot> = {}): LoopQueueSnapshot {
  return { available: true, reason: null, state: 'open', loops: [], generatedAt: iso(0), ...overrides }
}

function statusRow(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'fix',
    pause: null,
    locks: [],
    queue: {
      open: 1,
      closed: 0,
      claimed: 0,
      awaitingApproval: 0,
      parked: 0,
      claimable: 1,
      maxOpenIssues: 20,
      capReached: false,
    },
    queueKind: 'github',
    queueLocation: 'dev/plan-flow',
    awaitingApprovalIds: [],
    ...overrides,
  }
}

function loopsSnapshot(rows: LoopStatusRow[]): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows,
    globalPause: null,
    digest: null,
    generatedAt: iso(0),
  }
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    projectRoot: '/tmp/proj',
    title: 'Local card',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'thread-1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: false,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: iso(3_600_000),
    updatedAt: iso(3_600_000),
    ...overrides,
  }
}

function model(input: {
  queue?: LoopQueueSnapshot
  loops?: LoopsSnapshot | null
  tasks?: TaskSummary[]
}): BoardModel {
  return buildBoardModel({
    queue: input.queue ?? queue(),
    loops: input.loops ?? null,
    tasks: input.tasks ?? [],
    now: NOW,
  })
}

const laneOf = (plan: ReturnType<typeof planBoardRender>, lane: string) =>
  plan.lanes.find((entry) => entry.lane === lane)!

describe('planBoardRender', () => {
  describe('lanes and cards (6.1)', () => {
    it('draws the five lanes in board order, counted off the model', () => {
      const plan = planBoardRender(
        model({ queue: queue({ loops: [group({ items: [item()] })] }), tasks: [task({ lane: 'done' })] }),
      )
      expect(plan.lanes.map((entry) => entry.lane)).toEqual([
        'todo',
        'doing',
        'blocked',
        'review',
        'done',
      ])
      expect(plan.lanes.map((entry) => entry.count)).toEqual([1, 0, 0, 0, 1])
    })

    it('gives each card its origin chip, and no chip when nothing named one', () => {
      const filed = item({ id: '1', fingerprint: 'abc123' })
      const person = item({ id: '2' })
      const unknown = item({ id: '3' })
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [filed, person] }),
              // A directive that named no kind — the model leaves origin null.
              group({ loop: 'orphan', queueKind: undefined, queueLocation: undefined, items: [unknown] }),
            ],
          }),
        }),
      )
      const ORIGINS = ['loop', 'you', 'github', 'jira', 'azure']
      const chips = laneOf(plan, 'todo').sections.flatMap((section) =>
        section.cards.map((card) => card.chips.find((chip) => ORIGINS.includes(chip.text))?.text ?? null),
      )
      // The third card's group named no kind, so it renders NO chip rather than
      // a guessed one — the model left `origin` null and this respects it.
      expect(chips).toEqual(['loop', 'you', null])
    })

    it('heads Todo per queue only when there is more than one list', () => {
      const one = planBoardRender(model({ queue: queue({ loops: [group({ items: [item()] })] }) }))
      expect(laneOf(one, 'todo').sections.map((section) => section.label)).toEqual([null])

      const two = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [item()] }),
              group({ loop: 'ops', queueLocation: 'flow/loops/ops.jsonl', items: [item({ id: '7' })] }),
            ],
          }),
        }),
      )
      // The heading names the LIST, not the file it lives in — a ledger's raw
      // path in a column heading is forbidden pattern #12, and the loops panel
      // settled this vocabulary first (queueLabelFor).
      expect(laneOf(two, 'todo').sections.map((section) => section.label)).toEqual([
        'This project · queue',
        'This project · ops',
      ])
    })

    it('heads the local cards separately once the lists are named', () => {
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [item()] }),
              group({ loop: 'ops', queueLocation: 'flow/loops/ops.jsonl', items: [] }),
            ],
          }),
          tasks: [task()],
        }),
      )
      const labels = laneOf(plan, 'todo').sections.map((section) => section.label)
      expect(labels[labels.length - 1]).toBe(LOCAL_SECTION_LABEL)
    })

    it('draws no local heading when every configured list was skipped', () => {
      // #1789 — "Not on a list" is a CONTRAST, so it needs something to contrast
      // with. Two lists are configured, both readable, both empty: every queue
      // section is skipped at the zero-cards rule, so the lone local section had
      // no named list beside it and the heading became a distinction with
      // nothing on its far side — the exact state the comment above it forbids.
      // The old condition tested `model.groups.length > 0` (configured), which
      // is still 2 here; what matters is how many sections were RENDERED.
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [] }),
              group({ loop: 'ops', queueLocation: 'flow/loops/ops.jsonl', items: [] }),
            ],
          }),
          tasks: [task()],
        }),
      )
      const sections = laneOf(plan, 'todo').sections
      expect(sections.map((section) => section.label)).toEqual([null])
    })

    it('offers "Set up a task list" only when no list is configured', () => {
      const none = planBoardRender(model({ queue: queue({ loops: [] }) }))
      expect(laneOf(none, 'todo').empty).toEqual({ text: NO_LIST_TEXT, action: 'set-up-task-list' })

      // The hint must not send the reader to a terminal to run the command THIS
      // APP already runs for every project it manages (provisioner spawns
      // `init --claude --force --yes`, whose step 11 seeds `loops/`). It said
      // "Run `planflow-ai init` in this project", which asked the user to do the
      // app's own job — in an app whose premise is zero terminal interaction.
      // No command, no file path, no config key — the panel describes what a
      // task list IS and offers a real action, rather than narrating the app's
      // internals at a reader who cannot act on them.
      expect(SET_UP_LIST_HINT).not.toContain('planflow-ai')
      expect(SET_UP_LIST_HINT).not.toContain('loops/')
      expect(SET_UP_LIST_HINT).not.toContain('paused:')
      expect(SET_UP_LIST_HINT).toContain('Flow normally sets one up')

      // A project with no directives but with its own cards keeps today's board:
      // cards, no empty state, no affordance interrupting them (Task 8.4).
      const local = planBoardRender(model({ queue: queue({ loops: [] }), tasks: [task()] }))
      expect(laneOf(local, 'todo').empty).toBeNull()
      expect(laneOf(local, 'todo').sections[0]?.cards).toHaveLength(1)
    })

    it('keeps today’s empty sentence for a readable, genuinely clear list', () => {
      const plan = planBoardRender(model({ queue: queue({ loops: [group({ items: [] })] }) }))
      expect(laneOf(plan, 'todo').empty).toEqual({ text: 'Nothing here yet', action: null })
      expect(laneOf(plan, 'doing').empty).toEqual({ text: '—', action: null })
    })
  })

  describe('an unreadable list is never an empty one (6.2, NFR-2)', () => {
    it('banners the snapshot’s reason verbatim and refuses the empty state', () => {
      const plan = planBoardRender(
        model({ queue: queue({ available: false, reason: 'gh: could not resolve host', loops: [] }) }),
      )
      const todo = laneOf(plan, 'todo')
      expect(todo.banner).toEqual({ text: 'gh: could not resolve host' })
      expect(todo.empty).toBeNull()
    })

    it('falls back to a group’s own reason when the snapshot gave none', () => {
      const plan = planBoardRender(
        model({ queue: queue({ loops: [group({ items: null, queueError: 'gh auth: not logged in' })] }) }),
      )
      expect(laneOf(plan, 'todo').banner).toEqual({ text: 'gh auth: not logged in' })
      expect(laneOf(plan, 'todo').empty).toBeNull()
    })

    it('still banners when nothing said why — silence is not "nothing to do"', () => {
      const plan = planBoardRender(model({ queue: queue({ loops: [group({ items: null })] }) }))
      expect(laneOf(plan, 'todo').banner).toEqual({ text: UNREADABLE_FALLBACK })
      expect(laneOf(plan, 'todo').empty).toBeNull()
    })

    it('says why ONCE — the banner carries it, so the section does not repeat it (#1790)', () => {
      // The whole board failed, so `bannerFor` promotes the one group's reason.
      // `todoSections` used to keep that same group's section carrying the same
      // sentence, and #renderLane draws both — so Todo stacked the identical
      // line twice and read as two problems. That is the convention huntsFor
      // already states for its own note ("repeating it in two columns would read
      // as two problems"); it just was not honoured across banner and section.
      const plan = planBoardRender(
        model({ queue: queue({ loops: [group({ items: null, queueError: 'gh auth: not logged in' })] }) }),
      )
      const todo = laneOf(plan, 'todo')
      expect(todo.banner).toEqual({ text: 'gh auth: not logged in' })
      expect(todo.sections.map((section) => section.note)).not.toContain('gh auth: not logged in')
      // ...and dropping the note must not trade a duplicate for the empty Todo
      // that NFR-2 forbids. The banner is what keeps the lane honest.
      expect(todo.empty).toBeNull()
    })

    it('does not repeat the fallback either — silence said twice is still twice (#1790)', () => {
      // Both paths fall back independently, so a failure with no sentence at all
      // printed "Couldn't read this project's task list." twice.
      const plan = planBoardRender(model({ queue: queue({ loops: [group({ items: null })] }) }))
      const todo = laneOf(plan, 'todo')
      expect(todo.banner).toEqual({ text: UNREADABLE_FALLBACK })
      expect(todo.sections.map((section) => section.note)).not.toContain(UNREADABLE_FALLBACK)
    })

    it('keeps a SECOND list\'s different reason — dedupe drops repeats, never information (#1790)', () => {
      // Both lists failed for different reasons. The banner can only carry one;
      // the other is the only place its list's failure is stated, so suppressing
      // it would trade a duplicate for a silence.
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: null, queueError: 'gh auth: not logged in' }),
              group({
                loop: 'ops',
                queueLocation: 'flow/loops/ops.jsonl',
                items: null,
                queueError: 'ENOENT: flow/loops/ops.jsonl',
              }),
            ],
          }),
        }),
      )
      const todo = laneOf(plan, 'todo')
      expect(todo.banner).toEqual({ text: 'gh auth: not logged in' })
      const notes = todo.sections.map((section) => section.note)
      expect(notes).not.toContain('gh auth: not logged in')
      expect(notes).toContain('ENOENT: flow/loops/ops.jsonl')
    })

    it('keeps a half-failed board honest: the working list draws, the broken one says so', () => {
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [item()] }),
              group({
                loop: 'ops',
                queueLocation: 'flow/loops/ops.jsonl',
                items: null,
                queueError: 'ENOENT: flow/loops/ops.jsonl',
              }),
            ],
          }),
        }),
      )
      const todo = laneOf(plan, 'todo')
      // No whole-board banner — one queue answered, and the rest of the board is true.
      expect(todo.banner).toBeNull()
      const broken = todo.sections.find((section) => section.label === 'This project · ops')
      expect(broken?.note).toBe('ENOENT: flow/loops/ops.jsonl')
      expect(broken?.cards).toHaveLength(0)
      expect(todo.sections[0]?.cards).toHaveLength(1)
    })

    it('never says "Nothing here yet" under a failed list when the readable sibling is empty (#1757)', () => {
      const plan = planBoardRender(
        model({
          queue: queue({
            loops: [
              group({ items: [] }),
              group({
                loop: 'ops',
                queueLocation: 'flow/loops/ops.jsonl',
                items: null,
                queueError: 'ENOENT: flow/loops/ops.jsonl',
              }),
            ],
          }),
        }),
      )
      const todo = laneOf(plan, 'todo')
      // Partial state: no whole-board banner, the failed list carries its note —
      // and the note IS the answer. An empty state beneath it puts the lie back.
      expect(todo.banner).toBeNull()
      const broken = todo.sections.find((section) => section.note !== null)
      expect(broken?.note).toBe('ENOENT: flow/loops/ops.jsonl')
      expect(todo.empty).toBeNull()
    })
  })

  describe('chips read the model, never a second decision', () => {
    it('carries the blocked reason and its amber straight off the card', () => {
      const gated = item({ approved: false })
      const built = model({
        queue: queue({ loops: [group({ items: [gated] })] }),
        loops: loopsSnapshot([statusRow({ awaitingApprovalIds: ['1533'] })]),
      })
      const card = built.lanes.blocked[0]!
      const chips = cardChips(card)
      expect(chips.map((chip) => chip.text)).toContain('waiting for approval')
      expect(chips.find((chip) => chip.text === 'waiting for approval')?.attention).toBe(true)
      expect(card.attention).toBe(true)
    })

    it('does not paint another engineer’s claim amber', () => {
      const held = item({ claimedBy: '@someone-else' })
      const built = model({ queue: queue({ loops: [group({ items: [held] })] }) })
      const chips = cardChips(built.lanes.todo[0]!)
      expect(chips.map((chip) => chip.text)).toContain('held by @someone-else')
      expect(chips.every((chip) => !chip.attention)).toBe(true)
    })

    it('does not call the reader a stranger for holding their own claim (H1)', () => {
      // `heldBy` is set only when the queue says claimed and this machine has no
      // record — which since H1 is exactly a claim this installation made and
      // failed to record. Naming the raw id there tells the reader that someone
      // called flow-ide-3f2a9c1b7e04 took their card.
      const mine = item({ claimedBy: 'flow-ide-3f2a9c1b7e04' })
      const built = model({ queue: queue({ loops: [group({ items: [mine] })] }) })
      const card = built.lanes.todo[0]!

      const asStranger = cardChips(card)
      expect(asStranger.map((chip) => chip.text)).toContain('held by flow-ide-3f2a9c1b7e04')

      const asSelf = cardChips(card, 'flow-ide-3f2a9c1b7e04')
      expect(asSelf.map((chip) => chip.text)).toContain('held by you')
      expect(asSelf.map((chip) => chip.text)).not.toContain('held by flow-ide-3f2a9c1b7e04')
      // Still not amber: your own unrecorded claim has a Release control, which
      // is not the same as wanting a human's attention.
      expect(asSelf.every((chip) => !chip.attention)).toBe(true)
      // A different installation's id is still a stranger.
      expect(cardChips(card, 'flow-ide-000000000000').map((chip) => chip.text)).toContain(
        'held by flow-ide-3f2a9c1b7e04',
      )
    })
  })

  it('rides a refused claim’s reason back with the card (6.3)', () => {
    const built = model({ queue: queue({ loops: [group({ items: [item()] })] }) })
    const key = built.lanes.todo[0]!.key
    const plan = planBoardRender(built, { notes: new Map([[key, "item 1533 is held by '@rival'"]]) })
    expect(laneOf(plan, 'todo').sections[0]?.cards[0]?.note).toBe("item 1533 is held by '@rival'")
  })
})

// ── Task 7.1 / 7.2: the hunt block and the filter bar ───────────────────

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

function hunting(overrides: Partial<LoopStatusRow> = {}): LoopsSnapshot {
  return loopsSnapshot([
    statusRow({ loop: 'find', topic: 'codemap', instructions: [instruction()], ...overrides }),
  ])
}

function planWith(loops: LoopsSnapshot, filter?: ReturnType<typeof huntFilterFor>) {
  const model = buildBoardModel({
    queue: queue(),
    loops,
    tasks: [],
    now: NOW,
    ...(filter === undefined ? {} : { filter }),
  })
  return { model, plan: planBoardRender(model, { loops }) }
}

const doing = (plan: ReturnType<typeof planBoardRender>) =>
  plan.lanes.find((lane) => lane.lane === 'doing')!

const done = (plan: ReturnType<typeof planBoardRender>) =>
  plan.lanes.find((lane) => lane.lane === 'done')!

describe('planBoardRender — hunts (Task 7.1)', () => {
  it('draws the hunt in DOING, and in no other lane', () => {
    const { plan } = planWith(hunting())
    expect(doing(plan).hunts?.cards).toHaveLength(1)
    for (const lane of plan.lanes) {
      if (lane.lane !== 'doing') expect(lane.hunts).toBeNull()
    }
  })

  it('joins the two numbers the store holds, and derives no third', () => {
    const { plan } = planWith(hunting())
    const hunt = doing(plan).hunts?.cards[0]
    expect(hunt?.filedLabel).toBe('filed 7/20')
    // No percentage, no "13 remaining" — the card shows what was reported.
    expect(hunt?.detail).not.toMatch(/%|remaining/)
    // And no budget: `loop status` does not report one at all.
    expect(hunt?.detail).not.toMatch(/budget|min|left/)
  })

  it('glosses the CLI\'s status word without replacing it', () => {
    const { plan } = planWith(
      loopsSnapshot([
        statusRow({ loop: 'find', instructions: [instruction({ status: 'capped', filed: 20 })] }),
      ]),
    )
    // Capped is over, so the card is in Done — the gloss travels with it.
    expect(done(plan).hunts?.cards[0]?.detail).toContain('capped')
  })

  it('moves a FINISHED hunt to Done, and leaves the running ones in Doing', () => {
    // Ending a hunt used to leave it in the in-flight column wearing a
    // "stopped" gloss, or — once removed from the store — take it off the board
    // entirely, with nothing to show for the work it did. Neither is what
    // finishing something looks like.
    const { plan } = planWith(
      loopsSnapshot([
        statusRow({
          loop: 'find',
          instructions: [
            instruction({ text: 'still going', status: 'active' }),
            instruction({ text: 'somebody ended this', status: 'stopped' }),
            instruction({ text: 'nothing left to find', status: 'dry' }),
          ],
        }),
      ]),
    )
    expect(doing(plan).hunts?.cards.map((card) => card.hunt.text)).toEqual(['still going'])
    expect(done(plan).hunts?.cards.map((card) => card.hunt.text)).toEqual([
      'somebody ended this',
      'nothing left to find',
    ])
    // Never in two places, and never in a lane that is neither.
    for (const lane of plan.lanes) {
      if (lane.lane !== 'doing' && lane.lane !== 'done') expect(lane.hunts).toBeNull()
    }
  })

  it('keeps the unreadable-store note in Doing only — it is not finished work', () => {
    const { plan } = planWith(
      loopsSnapshot([statusRow({ loop: 'find', instructionsError: 'unreadable' })]),
    )
    expect(doing(plan).hunts?.note).toBe('unreadable')
    expect(done(plan).hunts).toBeNull()
  })

  it('a lane holding a hunt is not an empty lane', () => {
    const { plan } = planWith(hunting())
    expect(doing(plan).empty).toBeNull()
    // …and the count still counts WORK, which a hunt is not.
    expect(doing(plan).count).toBe(0)
  })

  it('carries the unreadable-store reason as the block\'s note', () => {
    const { plan } = planWith(
      loopsSnapshot([statusRow({ loop: 'find', instructionsError: 'malformed instructions.json' })]),
    )
    expect(doing(plan).hunts?.cards).toEqual([])
    expect(doing(plan).hunts?.note).toBe('malformed instructions.json')
  })

  it('draws no hunt block at all when there is nothing to say', () => {
    const { plan } = planWith(loopsSnapshot([statusRow()]))
    expect(doing(plan).hunts).toBeNull()
  })

  it('draws no chip strip on a hunt — the only chip it ever carried is gone', () => {
    // The hunt card's `chips` array had exactly ONE producer: the tripped
    // breaker's label. The breaker went with the supervision layer
    // (loops-native-runtime, Phase 6), so the array could only ever be empty —
    // and an always-empty render slot is a shape the reader has to keep
    // reasoning about for a thing that cannot happen.
    const { plan } = planWith(
      loopsSnapshot([statusRow({ loop: 'find', instructions: [instruction()] })]),
    )
    const card = doing(plan).hunts?.cards[0]
    expect(card).not.toBeUndefined()
    expect(Object.keys(card ?? {})).not.toContain('chips')
  })
})

describe('planBoardRender — the filter bar (Task 7.2)', () => {
  it('is absent until a filter is on', () => {
    expect(planWith(hunting()).plan.filter).toBeNull()
  })

  it('says "approximate" in the VISIBLE text, not only in a tooltip', () => {
    const { model } = planWith(hunting())
    const { plan } = planWith(hunting(), huntFilterFor(model.hunts.cards[0]!))
    expect(plan.filter?.note).toBe(HUNT_FILTER_APPROXIMATE_NOTE)
    expect(plan.filter?.note).toContain('approximate')
    expect(plan.filter?.text).toContain('find UI gaps in the blueprint board')
  })

  it('names an empty result as the HUNT\'s answer, not as a zero and not as the board\'s', () => {
    // Since H2 a filter narrows the window and never the records, so "matched"
    // and "what is on the board" are different sets: the old copy ("Nothing on
    // the board matched") could sit over a board visibly full of cards the
    // reader has work in flight on, and read as a broken filter.
    const { model } = planWith(hunting())
    const { plan } = planWith(hunting(), huntFilterFor(model.hunts.cards[0]!))
    expect(plan.filter?.countLabel).toBe('Nothing this loop filed is still on the list')
    expect(plan.filter?.countLabel).not.toContain('on the board')
  })

  it('reports what the filter actually removed, rather than leaving it to be inferred', () => {
    expect(filterCountLabel(3, 0)).toBe('3 cards')
    expect(filterCountLabel(1, 0)).toBe('1 card')
    expect(filterCountLabel(2, 4)).toBe('2 cards · 4 cards hidden')
    expect(filterCountLabel(1, 1)).toBe('1 card · 1 card hidden')
    // Zero matched but something hidden is the honest pairing the old copy
    // could not express at all.
    expect(filterCountLabel(0, 5)).toBe('Nothing this loop filed is still on the list · 5 cards hidden')
  })

  it('the filed count\'s hover text admits the approximation too', () => {
    const { plan } = planWith(hunting())
    expect(doing(plan).hunts?.cards[0]?.filedTitle).toBe(HUNT_FILTER_HINT)
    expect(HUNT_FILTER_HINT).toContain('approximate')
  })

  it('a dead filed count carries the reason, never the promise (#1769)', () => {
    // Present-but-dead is the board's stated convention: a disabled control
    // hovers the reason it cannot act, like the resume control beside it.
    const { model } = planWith(hunting())
    const hunt = model.hunts.cards[0]!
    const orphaned = { ...model, hunts: { ...model.hunts, cards: [{ ...hunt, loops: [] }] } }
    const card = doing(planBoardRender(orphaned, {})).hunts?.cards[0]
    expect(card?.filterable).toBe(false)
    expect(card?.filedTitle).toBe(HUNT_FILTER_DEAD)
    expect(card?.filedTitle).not.toContain('Show what this loop filed')
  })
})

describe('planBoardRender — the hunt\'s resume control (Task 7.5)', () => {
  it('is absent while the hunt is running, and present once it is not', () => {
    const running = planWith(hunting())
    expect(doing(running.plan).hunts?.cards[0]?.resume).toBeNull()

    const capped = planWith(
      loopsSnapshot([
        statusRow({ loop: 'find', instructions: [instruction({ status: 'capped', filed: 20 })] }),
      ]),
    )
    // A capped hunt is over, so its card — and its resume — are in Done now.
    expect(done(capped.plan).hunts?.cards[0]?.resume?.actionable).toBe(true)
  })

  it('routes through the ONE instruction-building path, consequence and all', () => {
    const { plan } = planWith(
      loopsSnapshot([
        statusRow({ loop: 'find', instructions: [instruction({ status: 'dry' })] }),
      ]),
    )
    const resume = done(plan).hunts?.cards[0]?.resume
    expect(resume?.intent?.loop).toBe('find')
    expect(resume?.intent?.focus).not.toBe('')
    expect(resume?.title).toContain("lifts find's pause")
  })
})

// ── Phase 4: the thread filter's line in the same bar ────────────────────

describe('planBoardRender — the thread filter bar (Phase 4)', () => {
  const THIS_THREAD = 'th-active'
  const OTHER_THREAD = 'th-elsewhere'

  const narrowed = (
    tasks: TaskSummary[],
    label: string | null = 'Board filter work',
    filter?: ReturnType<typeof huntFilterFor>,
  ): ReturnType<typeof planBoardRender> => {
    const built = buildBoardModel({
      queue: queue(),
      loops: null,
      tasks,
      now: NOW,
      threadFilter: { threadId: THIS_THREAD, label },
      ...(filter === undefined ? {} : { filter }),
    })
    return planBoardRender(built)
  }

  it('is absent with no conversation open — the board is exactly today\'s board (FR-7)', () => {
    const plan = planBoardRender(model({ tasks: [task({ originThreadId: OTHER_THREAD })] }))
    expect(plan.threadFilter).toBeNull()
    expect(plan.filter).toBeNull()
  })

  it('NAMES the conversation, because "this conversation" is a pronoun', () => {
    const plan = narrowed([task({ originThreadId: THIS_THREAD })])
    expect(plan.threadFilter?.text).toBe('In this conversation: Board filter work')
  })

  it('says so in its own words rather than showing an id when nothing named the thread', () => {
    const plan = narrowed([task({ originThreadId: THIS_THREAD })], null)
    expect(plan.threadFilter?.text).toBe('In this conversation')
    expect(plan.threadFilter?.text).not.toContain(THIS_THREAD)
    // A blank title is the same silence as no title at all.
    expect(threadFilterText('   ')).toBe('In this conversation')
  })

  it('says out loud that work in flight was left alone', () => {
    const plan = narrowed([task({ originThreadId: THIS_THREAD })])
    expect(plan.threadFilter?.note).toBe(THREAD_FILTER_KEPT_NOTE)
    expect(plan.threadFilter?.note).toContain('started')
  })

  it('reports what it hid, and names an empty result as this conversation\'s answer', () => {
    expect(threadFilterCountLabel(3, 0)).toBe('3 cards')
    expect(threadFilterCountLabel(1, 0)).toBe('1 card')
    expect(threadFilterCountLabel(2, 4)).toBe('2 cards · 4 cards hidden')
    expect(threadFilterCountLabel(1, 1)).toBe('1 card · 1 card hidden')
    // Zero is a sentence about the conversation, never a bare "0 cards" over a
    // board still holding everybody else's work.
    expect(threadFilterCountLabel(0, 5)).toBe(
      'Nothing on the board came from this conversation · 5 cards hidden',
    )
  })

  it('counts what the model counted — the line never re-derives it', () => {
    const plan = narrowed([
      task({ id: 'mine', originThreadId: THIS_THREAD }),
      task({ id: 'theirs', originThreadId: OTHER_THREAD }),
    ])
    expect(plan.threadFilter?.countLabel).toBe('1 card · 1 card hidden')
  })

  it('offers the same one way out as the hunt\'s line, so one control can clear both', () => {
    const { model: hunted } = planWith(hunting())
    const both = narrowed([task({ originThreadId: OTHER_THREAD })], 'Board filter work',
      huntFilterFor(hunted.hunts.cards[0]!))
    expect(both.threadFilter).not.toBeNull()
    expect(both.filter).not.toBeNull()
    expect(both.threadFilter?.clearLabel).toBe(CLEAR_FILTERS_LABEL)
    expect(both.filter?.clearLabel).toBe(CLEAR_FILTERS_LABEL)
  })
})

describe('queueFailureSentence — the board says it, rather than relaying gh', () => {
  // Reported live on Windows: the board showed "Command failed: gh issue list
  // --repo owner/name --state open --limit 100 --json number,title,body,…" to
  // someone who had never configured GitHub. gh's own diagnosis is no better in
  // a window — it ends "please run: gh auth login", which is a command the
  // reader cannot press (forbidden-pattern #12).
  it('names the problem in the board\'s terms, with no command in it', () => {
    const text = queueFailureSentence('signed-out', 'owner/name')
    expect(text).toBe("Flow isn't signed in to GitHub, so it can't read owner/name's list.")
    expect(text).not.toMatch(/gh |--repo|Command failed/)
  })

  it('keys off the CLI\'s classification, not its prose, so rewording is free', () => {
    expect(queueFailureSentence('not-installed', 'owner/name')).toContain('GitHub CLI')
    expect(queueFailureSentence('unreachable', 'owner/name')).toContain('private, renamed or gone')
    expect(queueFailureSentence('rate-limited', 'owner/name')).toContain('rate-limiting')
  })

  it('says nothing for a failure the CLI could not name — the reason survives instead', () => {
    expect(queueFailureSentence('unknown', 'owner/name')).toBeNull()
    expect(queueFailureSentence(undefined, 'owner/name')).toBeNull()
  })

  it('still names the list when the group never reported a location', () => {
    expect(queueFailureSentence('signed-out', null)).toContain("this project's list")
  })
})

// ── the queue groups and Todo ────────────────────────────
//
// A REMOTE COLUMN WAS BUILT ON THESE AND IT WAS THE WRONG SOURCE. A loop's queue
// is a repository's list somebody pointed a loop at, in a committed file — so a
// project reading a local list could never show the column, no matter how many
// trackers were connected, which is exactly what the user hit. The column reads
// the INTEGRATIONS now (remote-list-model.ts), and Todo went back to drawing
// every list a loop is pointed at, whatever its backend.

describe('Todo draws every list a loop is pointed at', () => {
  it('draws a github queue as a Todo section, like any other list', () => {
    const m = model({
      queue: queue({
        loops: [group({ queueKind: 'github', queueLocation: 'acme/widgets', items: [item()] })],
      }),
    })
    expect(laneOf(planBoardRender(m), 'todo').sections[0]?.cards).toHaveLength(1)
  })

  it('draws a ledger queue the same way', () => {
    const m = model({ queue: queue({ loops: [group({ items: [item()] })] }) })
    expect(laneOf(planBoardRender(m), 'todo').sections[0]?.cards).toHaveLength(1)
  })

  it('counts what the lane DRAWS, so a badge cannot disagree with the cards', () => {
    const m = model({
      queue: queue({
        loops: [
          group({ items: [item()] }),
          group({ loop: 'ops', queueLocation: 'flow/loops/ops.jsonl', items: [item({ id: '9' })] }),
        ],
      }),
    })
    const todo = laneOf(planBoardRender(m), 'todo')
    expect(todo.count).toBe(todo.sections.reduce((n, s) => n + s.cards.length, 0))
  })
})
