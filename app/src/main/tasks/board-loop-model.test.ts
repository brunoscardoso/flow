import { nextBoardStep, boardLoopPrompt } from './board-loop-model'
import type { TaskRecord, TaskLane } from '../store/task-store'

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Fix the thing',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo' as TaskLane,
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    // TICKED BY DEFAULT IN THIS FIXTURE, because every test below is about what
    // the loop does with the cards it is allowed to work. The opt-in itself has
    // its own describe block, which sets it explicitly both ways.
    autoFix: true,
    agentBlockedFrom: null,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

describe('nextBoardStep', () => {
  it('takes the oldest Todo card', () => {
    const step = nextBoardStep(
      [
        task({ id: 'new', createdAt: '2026-09-03T00:00:00.000Z' }),
        task({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      ],
      null,
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'old' } })
  })

  it('orders by creation, not by the clock the board sorts on', () => {
    // `updatedAt` moves when a brief lands or a lane is nudged; a card that was
    // merely touched must not jump in front of work that has been waiting.
    const step = nextBoardStep(
      [
        task({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }),
        task({ id: 'new', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }),
      ],
      null,
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'old' } })
  })

  it('is deterministic when two cards were created in the same millisecond', () => {
    const both = [task({ id: 'b' }), task({ id: 'a' })]
    expect(nextBoardStep(both, null)).toMatchObject({ kind: 'work', task: { id: 'a' } })
    expect(nextBoardStep([...both].reverse(), null)).toMatchObject({ kind: 'work', task: { id: 'a' } })
  })

  it('WAITS while its own card is in flight, whatever lane that card reads', () => {
    // The turn-start hook moves it to Doing, but the runner may look before
    // that lands — the dispatch record is the authority, not the lane.
    for (const lane of ['todo', 'doing'] as TaskLane[]) {
      const step = nextBoardStep([task({ id: 'sent', lane }), task({ id: 'other', lane: 'todo' })], 'sent')
      expect(step).toEqual({ kind: 'wait', reason: 'a card is being worked' })
    }
  })

  it('stops caring about an in-flight card that has been archived away', () => {
    const step = nextBoardStep(
      [task({ id: 'sent', archivedAt: '2026-09-04T00:00:00.000Z' }), task({ id: 'next' })],
      'sent',
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'next' } })
  })

  it('stops only when nothing it may work is left — the user\'s own end condition', () => {
    expect(nextBoardStep([task({ lane: 'done' }), task({ id: 'b', lane: 'blocked' })], null)).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
    expect(nextBoardStep([], null)).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
  })

  it('HOLDS rather than stopping while a ticked card is still open', () => {
    // Somebody dragged it there, or a previous run left it there. Either way
    // the loop's work is not finished, and switching the button off here would
    // report the run as done while a card it owns is open.
    expect(nextBoardStep([task({ lane: 'doing' })], null)).toEqual({
      kind: 'wait',
      reason: 'nothing left to take, and a card is still open',
    })
  })

  it('never takes an archived card', () => {
    expect(
      nextBoardStep([task({ archivedAt: '2026-09-04T00:00:00.000Z' })], null),
    ).toEqual({ kind: 'stop', reason: 'Nothing left that is set to be worked.' })
  })
})

describe('the opt-in — a board is also a notebook', () => {
  it('leaves an unticked card alone, however long it sits in Todo', () => {
    // "sometime the user wanna create some item manually just to track, but no
    // fix or implement at that moment."
    expect(nextBoardStep([task({ autoFix: false })], null)).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
  })

  it('takes the oldest TICKED card, not the oldest card', () => {
    const step = nextBoardStep(
      [
        task({ id: 'note', autoFix: false, createdAt: '2026-09-01T00:00:00.000Z' }),
        task({ id: 'work', autoFix: true, createdAt: '2026-09-02T00:00:00.000Z' }),
      ],
      null,
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'work' } })
  })

  it('an unticked card in Doing does not hold the loop open', () => {
    // Somebody is working it by hand. That is not the loop's business, and
    // treating it as one would leave the button on for ever.
    expect(nextBoardStep([task({ lane: 'doing', autoFix: false })], null)).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
  })

  it('un-ticking the card in flight releases the loop to take the next one', () => {
    const step = nextBoardStep(
      [task({ id: 'sent', autoFix: false }), task({ id: 'next', autoFix: true })],
      'sent',
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'next' } })
  })
})

describe('boardLoopPrompt', () => {
  it('no longer tells the thread to chain itself — the runner does that now', () => {
    // The sentence this replaces read "Autopilot is ON for this thread: chain
    // the flow's commands through to the end". It was an instruction because
    // nothing ran the chain; now `BoardLoop` puts the thread under one
    // (`beginChain`, proven in `../drive/board-loop-chaining.test.ts`), and two
    // things telling a thread to chain is how one of them does it twice. The
    // project's own `autopilot` key is still left alone either way.
    const prompt = boardLoopPrompt(task())
    expect(prompt).not.toContain('Autopilot is ON')
    expect(prompt).not.toContain('autopilot-mode.md')
    expect(prompt).toContain("You are working this task from the board's loop")
  })

  it('hands over the ticket the agent is already holding', () => {
    const prompt = boardLoopPrompt(
      task({
        title: 'Chat: no spacing',
        externalKey: 'ACME-3442',
        externalUrl: 'https://acme.atlassian.net/browse/ACME-3442',
        description: 'Steps to reproduce: …',
      }),
    )
    expect(prompt).toContain('## Chat: no spacing')
    expect(prompt).toContain('ACME-3442')
    expect(prompt).toContain('https://acme.atlassian.net/browse/ACME-3442')
    expect(prompt).toContain('Steps to reproduce: …')
  })

  it('leaves out what the task does not have, rather than printing empty rows', () => {
    const prompt = boardLoopPrompt(task({ externalKey: null, externalUrl: null, description: '  ' }))
    expect(prompt).not.toContain('Tracker reference:')
    expect(prompt).not.toContain('Link:')
    expect(prompt).not.toContain('What the ticket says')
  })

  it('asks for the reproduce-first discipline, since nobody is watching', () => {
    expect(boardLoopPrompt(task())).toContain('Reproduce it end to end')
  })
})

describe('a run never revisits its own cards', () => {
  it('does not hold open on a card it already handed over', () => {
    // FOUND LIVE, not in a test. A turn that fails leaves its card in Doing —
    // `makeOnTurnComplete` only suggests Done on success — so counting every
    // open card as work-in-progress meant one bad card stalled the loop for
    // ever, waiting on a turn that had already ended.
    expect(nextBoardStep([task({ id: 'tried', lane: 'doing' })], null, new Set(['tried']))).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
  })

  it('still holds for a card SOMEBODY ELSE is working', () => {
    expect(nextBoardStep([task({ id: 'theirs', lane: 'doing' })], null, new Set())).toEqual({
      kind: 'wait',
      reason: 'nothing left to take, and a card is still open',
    })
  })

  it('does not hand the same failing card over twice in one run', () => {
    // Without this the loop spends the night re-running the one thing that
    // does not work: a failed card returns to Todo's front and is picked again.
    expect(nextBoardStep([task({ id: 'tried' })], null, new Set(['tried']))).toEqual({
      kind: 'stop',
      reason: 'Nothing left that is set to be worked.',
    })
  })

  it('moves past an attempted card to the next untried one', () => {
    const step = nextBoardStep(
      [
        task({ id: 'tried', createdAt: '2026-09-01T00:00:00.000Z' }),
        task({ id: 'fresh', createdAt: '2026-09-02T00:00:00.000Z' }),
      ],
      null,
      new Set(['tried']),
    )
    expect(step).toMatchObject({ kind: 'work', task: { id: 'fresh' } })
  })
})
