import { boardLoopButton, loopCardsForTheLoop, readyForTheLoop } from './board-loop-button'
import type { BoardLoopState, TaskSummary, ThreadSummary } from '../../shared/ipc-contract'
import type { BoardCard } from './board-model'

function task(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Fix the dropdown',
    source: 'manual',
    externalKey: null,
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: 'th1',
    originThreadId: null,
    description: null,
    images: null,
    autoFix: true,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function state(over: Partial<BoardLoopState> = {}): BoardLoopState {
  return { projectRoot: '/repo', running: false, taskId: null, stoppedReason: null, ...over }
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    key: 'queue:g#i1',
    title: 'Loop-filed bug',
    origin: 'loop',
    lane: 'todo',
    taskId: null,
    itemId: 'i1',
    queueKey: 'g',
    loop: 'fix',
    url: null,
    prUrl: null,
    attention: false,
    blockedReason: null,
    heldBy: null,
    missingReason: null,
    ageLabel: null,
    autoFix: false,
    threadStatus: null,
    backgroundTasks: 0,
    ...over,
  }
}

describe('readyForTheLoop', () => {
  it('counts only ticked, live cards in Todo', () => {
    expect(
      readyForTheLoop([
        task({ id: 'a' }),
        task({ id: 'note', autoFix: false }),
        task({ id: 'doing', lane: 'doing' }),
        task({ id: 'gone', archivedAt: '2026-09-02T00:00:00.000Z' }),
      ]).map((t) => t.id),
    ).toEqual(['a'])
  })
})

describe('loopCardsForTheLoop', () => {
  it('takes loop-filed Todo cards and nothing else', () => {
    expect(
      loopCardsForTheLoop([
        card({ key: 'a' }),
        card({ key: 'you', origin: 'you' }), // a note a person typed — the notebook
        card({ key: 'doing', lane: 'doing' }), // already being worked
        card({ key: 'gh', origin: 'github' }), // a remote item, not the loop's own
      ]).map((c) => c.key),
    ).toEqual(['a'])
  })
})

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id: 'th1', status: 'working', ...over } as ThreadSummary
}

describe('boardLoopButton', () => {
  it('offers a play with the count when there is work to take', () => {
    const plan = boardLoopButton(state(), [task({ id: 'a' }), task({ id: 'b' })])
    expect(plan).toMatchObject({ glyph: '▶', start: true, disabled: false })
    expect(plan.title).toBe('Work 2 cards, one at a time.')
  })

  it('counts one card in the singular', () => {
    expect(boardLoopButton(state(), [task()]).title).toBe('Work 1 card, one at a time.')
  })

  it('is inert with nothing ticked, and names the remedy rather than the field', () => {
    const plan = boardLoopButton(state(), [task({ autoFix: false })])
    expect(plan.disabled).toBe(true)
    expect(plan.label).toBe('Nothing is set to be worked')
    // Forbidden-pattern #12: the way out is the thing on screen, never a
    // config key or a column name.
    expect(plan.title).toContain('tick “Let the loop work this”')
    expect(plan.title).not.toMatch(/autoFix|flowconfig|queue/)
  })

  it('names the card it is on while running', () => {
    const plan = boardLoopButton(state({ running: true, taskId: 't1' }), [task({ id: 't1' })])
    expect(plan).toMatchObject({ glyph: '⏸', start: false, disabled: false })
    expect(plan.label).toBe('Stop working through the list')
    expect(plan.title).toBe('Working “Fix the dropdown”. Press to stop after this card.')
  })

  it('still offers the stop when the card it is on is not on this board yet', () => {
    // The loop is holding between cards — running, nothing dispatched.
    const plan = boardLoopButton(state({ running: true, taskId: null }), [task()])
    expect(plan.start).toBe(false)
    expect(plan.title).toBe('Working through the list. Press to stop after this card.')
  })

  it('SAYS WHAT HAPPENED after a run that worked everything', () => {
    // A finished run leaves every card out of Todo, which lands in the same
    // branch as "nothing was ever ticked" — and answering "tick a card" to
    // somebody who just watched it work six of them reads as though the run
    // never happened.
    const plan = boardLoopButton(
      state({ stoppedReason: 'Nothing left that is set to be worked.' }),
      [task({ lane: 'doing' })],
    )
    expect(plan.disabled).toBe(true)
    expect(plan.title).toBe(
      'Nothing left that is set to be worked. Tick another card to work more.',
    )
  })

  it('carries the reason it stopped into the next press, when work remains', () => {
    const plan = boardLoopButton(state({ stoppedReason: 'No agent account.' }), [task()])
    expect(plan.title).toBe('No agent account. Press to work 1 card.')
  })

  it('SAYS WHEN THE CARD IS WAITING ON A HUMAN, not "working"', () => {
    // A permission prompt puts the thread in `needs-decision` and does not end
    // the turn, so the loop holds — correctly — for as long as nobody answers.
    // A stall that reads identically to progress is the one failure a loop you
    // walk away from must never have.
    for (const status of ['needs-decision', 'blocked'] as const) {
      const plan = boardLoopButton(
        state({ running: true, taskId: 't1' }),
        [task({ id: 't1', threadId: 'th1' })],
        [thread({ id: 'th1', status })],
      )
      expect(plan.title).toBe('“Fix the dropdown” is waiting on you — open its chat to answer.')
      // Still stoppable: the way out is not taken away by the stall.
      expect(plan.disabled).toBe(false)
      expect(plan.start).toBe(false)
    }
  })

  it('says "working" for a thread that is simply working', () => {
    const plan = boardLoopButton(
      state({ running: true, taskId: 't1' }),
      [task({ id: 't1', threadId: 'th1' })],
      [thread({ id: 'th1', status: 'working' })],
    )
    expect(plan.title).toContain('Working “Fix the dropdown”')
  })

  it('has no opinion before the loop has been read', () => {
    expect(boardLoopButton(null, [task()])).toMatchObject({ start: true, disabled: false })
  })

  it('offers a play for a loop-filed card even when nothing is ticked', () => {
    // The bug: a loop-filed card was neither a ticked record nor tickable, so ▶
    // sat disabled over work the loop itself had filed.
    const plan = boardLoopButton(state(), [], [], [card()])
    expect(plan).toMatchObject({ glyph: '▶', start: true, disabled: false })
    expect(plan.title).toBe('Work 1 card, one at a time.')
  })

  it('counts loop cards alongside ticked records', () => {
    const plan = boardLoopButton(state(), [task({ id: 'a' })], [], [card({ key: 'x' })])
    expect(plan.title).toBe('Work 2 cards, one at a time.')
  })

  it('does not double-count a loop card already ticked as its record', () => {
    // A re-claimed loop card carries the record's taskId; the record IS the work.
    const plan = boardLoopButton(state(), [task({ id: 'rec' })], [], [card({ key: 'x', taskId: 'rec' })])
    expect(plan.title).toBe('Work 1 card, one at a time.')
  })

  it('stays inert for a human note with no loop card (notebook guarantee)', () => {
    const plan = boardLoopButton(state(), [task({ autoFix: false })], [], [card({ origin: 'you' })])
    expect(plan.disabled).toBe(true)
    expect(plan.label).toBe('Nothing is set to be worked')
  })
})
